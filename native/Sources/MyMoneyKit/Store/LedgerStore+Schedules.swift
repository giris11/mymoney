// Schedules in the store: keeping them, and turning one into money.
//
// ─────────────────────────────────────────────────────────────────────────────
// POSTING GOES THROUGH `saveTransaction`. ALWAYS, AND THERE IS NO OTHER PATH.
//
// `postScheduled` builds a `TransactionDraft` and hands it to the same function
// Quick Add, the transaction editor and the Siri intent all use. It gets the
// same validation, the same payee resolution, the same dedupe hash, the same
// currency-from-the-account rule and the same divergence count -- because it IS
// that function, not a copy of it that happens to agree today.
//
// The alternative -- an INSERT here, "just for schedules" -- is how an app
// acquires transactions with no dedupe hash, or in the wrong currency, or that
// the local-edit counter never saw. It would work perfectly until the first
// import collided with one.
//
// ─────────────────────────────────────────────────────────────────────────────
// ENTERING A DUE ITEM IS A DELIBERATE ACT.
//
// Nothing in this file posts anything on its own. `postScheduled` is called
// because somebody tapped Enter. `postDue` -- the auto-post path -- posts only
// occurrences of schedules whose owner switched auto-post ON, and only ones
// dated on or after the day he switched it on (`Schedule.autoPostFrom`), and
// never more than `autoPostRunLimit` in one go. There is no state in which
// opening this app for the first time writes a transaction the owner did not
// ask for.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DIVERGENCE COUNT, AND WHY A SCHEDULE DOES NOT MOVE IT.
//
// The banner counts "changes here that your web app does not have", and it is
// the most important number in the app. A POSTED TRANSACTION COUNTS -- it is a
// row in the ledger the browser has never seen, and `saveTransaction` counts it
// exactly as it counts a typed one. A SCHEDULE ITSELF DOES NOT. It is a plan:
// it is in no balance, no report and no backup file, and it changes no figure
// anywhere. Counting it would make the number mean "things I did on my phone"
// instead of "transactions your web app is missing", and the moment it means
// the vaguer thing it stops being worth reading.
//
// The schedules screen says the other half out loud -- that schedules live on
// this device only -- because that is the fact a count could not have conveyed
// anyway.
import Foundation

/// A request to enter one occurrence.
///
/// THE OCCURRENCE'S DATE AND THE TRANSACTION'S DATE ARE TWO DIFFERENT THINGS,
/// and this is the type where that becomes visible. `occurrenceDate` is the day
/// on the schedule's grid: it names WHICH occurrence this is, and it is what
/// the decision is recorded against. `date` is the day the money actually
/// moved, which is often the same and is sometimes two days later because the
/// 1st was a Sunday. Recording the second as the first would put the payment in
/// the wrong week; recording the first as the second would make the schedule
/// lose track of which occurrence had been dealt with.
public struct SchedulePosting: Sendable, Hashable {
    public let scheduleId: String
    /// The occurrence being entered, as a date on the schedule's own grid.
    public let occurrenceDate: String
    /// The transaction's date. nil means the occurrence's own date.
    public let date: String?
    /// What actually came out, when it is not what the schedule says. nil means
    /// the schedule's amount. Signed, like every amount in the book.
    public let amountMinor: Int64?
    /// nil means the schedule's notes.
    public let notes: String?

    public init(
        scheduleId: String,
        occurrenceDate: String,
        date: String? = nil,
        amountMinor: Int64? = nil,
        notes: String? = nil
    ) {
        self.scheduleId = scheduleId
        self.occurrenceDate = occurrenceDate
        self.date = date
        self.amountMinor = amountMinor
        self.notes = notes
    }
}

/// A transaction that came from a schedule, and which occurrence it was.
///
/// The traceability the register shows: "From Rent, the payment due on 3
/// September". Read by transaction id, in one indexed seek.
public struct ScheduleOrigin: Sendable, Hashable {
    public let scheduleId: String
    public let scheduleName: String
    public let occurrenceDate: String
    public let postedAt: String
}

/// One line of a schedule's history.
public struct ScheduleHistoryRow: Sendable, Hashable, Identifiable {
    public var id: String { "\(occurrenceDate):\(kind.rawValue)" }
    public let occurrenceDate: String
    public let kind: ScheduleEvent.Kind
    public let transactionId: String?
    /// The transaction is still in the book. False for one that was deleted, or
    /// that a fresh import replaced the book without.
    public let transactionIsPresent: Bool
    /// This date is still an occurrence of the schedule as it now stands.
    ///
    /// FALSE IS NOT A BUG AND NOT A DELETION. Changing a schedule's start date
    /// or cadence moves the whole grid, and decisions taken under the old one
    /// no longer line up with it. The transaction they made is still in the
    /// book and still the owner's; the history says which rows those are rather
    /// than hiding them, and the editor warns before it moves a grid that has
    /// history on it.
    public let isOnTheGrid: Bool
    public let at: String

    /// Can this decision be undone from the history?
    ///
    /// ONLY A SKIP, AND ONLY ONE THE SCHEDULE STILL FALLS ON.
    ///
    ///   * A POSTING IS NOT UNDONE BY UN-SKIPPING IT. It made a transaction,
    ///     and deleting that transaction is what makes the occurrence due
    ///     again -- the same rule `skipOccurrence` enforces when it refuses to
    ///     skip something already entered. A button here would look like a
    ///     second way to remove money from the book, which it is not.
    ///   * AN OFF-GRID SKIP HAS NOTHING TO GO BACK TO. The schedule's dates
    ///     were changed after the decision was taken, so putting it back would
    ///     revive an occurrence that no longer exists: a button that visibly
    ///     does nothing, which is worse than no button.
    public var canBeTakenBack: Bool { kind == .skipped && isOnTheGrid }
}

/// What one auto-post run did.
public struct AutoPostResult: Sendable {
    public let posted: [String]
    /// Occurrences that were eligible and were NOT posted because the run hit
    /// its limit. Reported rather than swallowed: they are still due, and the
    /// screen says so.
    public let heldBack: Int
    /// Anything that refused, with the sentence it refused with. An auto-post
    /// that fails silently is the worst version of this feature.
    public let refusals: [String]

    public var isEmpty: Bool { posted.isEmpty && heldBack == 0 && refusals.isEmpty }

    public init(posted: [String], heldBack: Int, refusals: [String]) {
        self.posted = posted
        self.heldBack = heldBack
        self.refusals = refusals
    }
}

extension LedgerStore {

    /// The most occurrences one automatic run will enter.
    ///
    /// NOT A PERFORMANCE LIMIT -- a safety one. Auto-post already cannot reach
    /// back before the day it was switched on, so the backlog is bounded by how
    /// long the app went unopened; twenty-four weekly occurrences is nearly six
    /// months of that. What this stops is the case that bound cannot: a device
    /// clock that jumps forward years, which would otherwise write hundreds of
    /// transactions dated into the future before anybody could look at the
    /// screen. Anything past the limit stays due, visible, and is reported.
    public static let autoPostRunLimit = 24

    // MARK: - Reading

    /// Every schedule in this copy, newest arrangement first is NOT the order:
    /// they come back by name, because a list of standing arrangements is
    /// something you look things up in.
    public func schedules(includingPaused: Bool = true) throws -> [Schedule] {
        let sql = """
            SELECT id, name, account_id, amount_minor, payee_name, category_id, notes, cadence,
                   start_date, end_kind, end_date, end_count, expects_from, auto_post,
                   auto_post_from, paused, remind, created_at, updated_at
            FROM live_schedules
            \(includingPaused ? "" : "WHERE paused = 0")
            ORDER BY name, id
            """
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        var out: [Schedule] = []
        while try statement.step() { out.append(try Self.decodeSchedule(statement)) }
        return out
    }

    public func schedule(id: String) throws -> Schedule? {
        let statement = try connection.prepare(
            """
            SELECT id, name, account_id, amount_minor, payee_name, category_id, notes, cadence,
                   start_date, end_kind, end_date, end_count, expects_from, auto_post,
                   auto_post_from, paused, remind, created_at, updated_at
            FROM live_schedules WHERE id = ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return try Self.decodeSchedule(statement)
    }

    private static func decodeSchedule(_ statement: SQLiteStatement) throws -> Schedule {
        let kind = try statement.text(9)
        let endDate = try statement.optionalText(10)
        let endCount = try statement.optionalInt(11)
        guard let end = ScheduleEnd.from(kind: kind, date: endDate, count: endCount) else {
            throw StoreError.corrupt(
                "a schedule says it ends \"\(kind)\" without saying when or how many"
            )
        }
        guard let cadence = Cadence(rawValue: try statement.text(7)) else {
            throw StoreError.corrupt("a schedule has a cadence this build does not know")
        }
        return Schedule(
            id: try statement.text(0),
            name: try statement.text(1),
            accountId: try statement.text(2),
            amountMinor: try statement.minorUnits(3),  // MONEY: the Int64 accessor
            payeeName: try statement.text(4),
            categoryId: try statement.optionalText(5),
            notes: try statement.text(6),
            cadence: cadence,
            startDate: try statement.text(8),
            end: end,
            expectsFrom: try statement.text(12),
            autoPost: try statement.flag(13),
            autoPostFrom: try statement.optionalText(14),
            paused: try statement.flag(15),
            remind: try statement.flag(16),
            createdAt: try statement.text(17),
            updatedAt: try statement.text(18)
        )
    }

    /// Every decision taken, for every schedule, WITH the answer to whether the
    /// book still contains what a posting claims it does.
    ///
    /// ONE QUERY, AND THE JOIN IS THE WHOLE IDEA. `live_transactions` carries
    /// the tombstone filter in its own definition, so a transaction the owner
    /// deleted simply is not there to join to, and the occurrence comes back
    /// `postedButGone` without anything here having to remember to ask.
    func scheduleDecisions() throws -> [String: [String: ScheduleOccurrenceState]] {
        let statement = try connection.prepare(
            """
            SELECT e.schedule_id, e.occurrence_date, e.kind, e.transaction_id,
                   CASE WHEN t.id IS NULL THEN 0 ELSE 1 END
            FROM live_schedule_events e
            LEFT JOIN live_transactions t ON t.id = e.transaction_id
            """
        )
        defer { statement.finalize() }
        var out: [String: [String: ScheduleOccurrenceState]] = [:]
        while try statement.step() {
            let scheduleId = try statement.text(0)
            let date = try statement.text(1)
            let kind = try statement.text(2)
            let transactionId = try statement.optionalText(3)
            let present = try statement.flag(4)
            let state: ScheduleOccurrenceState
            if kind == ScheduleEvent.Kind.skipped.rawValue {
                state = .skipped
            } else if let transactionId {
                state = present ? .posted(transactionId: transactionId)
                    : .postedButGone(transactionId: transactionId)
            } else {
                // The schema's CHECK makes this unreachable: a 'posted' row
                // without a transaction id cannot be written. Treated as due
                // rather than trusted, because the alternative is an occurrence
                // that can never be entered and never says why.
                state = .due
            }
            out[scheduleId, default: [:]][date] = state
        }
        return out
    }

    /// One schedule's history, newest first, with the two facts a row needs to
    /// be honest: is the transaction still there, and is this date still on the
    /// schedule's calendar.
    public func scheduleHistory(id: String) throws -> [ScheduleHistoryRow] {
        let calendar = try schedule(id: id)?.calendar
        let statement = try connection.prepare(
            """
            SELECT e.occurrence_date, e.kind, e.transaction_id,
                   CASE WHEN t.id IS NULL THEN 0 ELSE 1 END, e.at
            FROM live_schedule_events e
            LEFT JOIN live_transactions t ON t.id = e.transaction_id
            WHERE e.schedule_id = ?
            ORDER BY e.occurrence_date DESC
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        var out: [ScheduleHistoryRow] = []
        while try statement.step() {
            let date = try statement.text(0)
            let kind = ScheduleEvent.Kind(rawValue: try statement.text(1)) ?? .skipped
            let onGrid = CalendarDate(iso: date).flatMap { calendar?.index(on: $0) } != nil
            out.append(
                ScheduleHistoryRow(
                    occurrenceDate: date,
                    kind: kind,
                    transactionId: try statement.optionalText(2),
                    transactionIsPresent: try statement.flag(3),
                    isOnTheGrid: onGrid,
                    at: try statement.text(4)
                )
            )
        }
        return out
    }

    /// Which schedule a transaction came from, if any.
    ///
    /// THE TRACEABILITY REQUIREMENT, in one seek: `idx_schedule_events_transaction`
    /// is on exactly this column. The register asks it once per row it draws a
    /// badge on, and a book with no schedules pays for a single index probe
    /// that finds nothing.
    public func scheduleOrigin(forTransactionId id: String) throws -> ScheduleOrigin? {
        let statement = try connection.prepare(
            """
            SELECT s.id, s.name, e.occurrence_date, e.at
            FROM live_schedule_events e
            JOIN live_schedules s ON s.id = e.schedule_id
            WHERE e.transaction_id = ?
            LIMIT 1
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: id)
        guard try statement.step() else { return nil }
        return ScheduleOrigin(
            scheduleId: try statement.text(0),
            scheduleName: try statement.text(1),
            occurrenceDate: try statement.text(2),
            postedAt: try statement.text(3)
        )
    }

    // MARK: - Writing a schedule

    /// Create or update a schedule.
    ///
    /// Every refusal below is thrown from INSIDE the transaction, so "nothing
    /// was saved" is a fact by the time anybody reads it -- the same contract
    /// every other editor in this package keeps.
    @discardableResult
    public func saveSchedule(_ draft: ScheduleDraft) throws -> Schedule {
        try connection.transaction {
            let name = Names.clean(draft.name)
            guard !name.isEmpty else { throw EditError.blankName(what: "schedule") }
            guard let start = CalendarDate(iso: draft.startDate) else {
                throw EditError.badDate(draft.startDate)
            }
            guard draft.amountMinor != 0 else { throw EditError.scheduleAmountIsZero }
            switch draft.end {
            case .never:
                break
            case .onDate(let iso):
                guard let end = CalendarDate(iso: iso) else { throw EditError.badDate(iso) }
                guard end >= start else {
                    throw EditError.scheduleEndsBeforeItStarts(start: start.iso, end: end.iso)
                }
            case .afterOccurrences(let count):
                guard count >= 1 else { throw EditError.scheduleCountNotPositive(count) }
            }
            guard try liveRowExists("accounts", id: draft.accountId) else {
                throw EditError.unknownAccount(draft.accountId)
            }
            if let categoryId = draft.categoryId {
                guard try liveRowExists("categories", id: categoryId) else {
                    throw EditError.unknownCategory(categoryId)
                }
            }
            if let expects = draft.expectsFrom, CalendarDate(iso: expects) == nil {
                throw EditError.badDate(expects)
            }

            var existing: Schedule? = nil
            if let id = draft.id {
                guard let found = try schedule(id: id) else {
                    throw EditError.unknownSchedule(id)
                }
                existing = found
            }
            let now = environment.now()

            // AUTO-POST'S FLOOR IS STAMPED WHEN IT IS SWITCHED ON, and kept
            // while it stays on. Re-saving an unrelated field must not move it
            // forward (that would make the app forget occurrences it was
            // already entitled to enter) and switching auto-post off and on
            // again must move it (the owner is making a fresh decision, and it
            // should not reach back over the period it was off).
            let autoPostFrom: String?
            if draft.autoPost {
                autoPostFrom = existing?.autoPost == true
                    ? existing?.autoPostFrom ?? Self.dayOf(now)
                    : Self.dayOf(now)
            } else {
                autoPostFrom = nil
            }

            let saved = Schedule(
                id: existing?.id ?? environment.newId(),
                name: name,
                accountId: draft.accountId,
                amountMinor: draft.amountMinor,
                payeeName: Names.clean(draft.payeeName),
                categoryId: draft.categoryId,
                notes: draft.notes,
                cadence: draft.cadence,
                startDate: start.iso,
                end: draft.end,
                // The expectation floor is set once, when the schedule is made.
                // Moving it on a later save would make a row of overdue items
                // disappear without anybody deciding they should.
                expectsFrom: existing?.expectsFrom ?? draft.expectsFrom ?? start.iso,
                autoPost: draft.autoPost,
                autoPostFrom: autoPostFrom,
                paused: draft.paused,
                remind: draft.remind,
                createdAt: existing?.createdAt ?? now,
                updatedAt: now
            )
            try upsertScheduleRow(saved, isNew: existing == nil)
            return saved
        }
    }

    /// Suspend or resume. Kept separate from `saveSchedule` because it is one
    /// switch on a list row, and routing it through a whole draft would mean a
    /// list that had to hold every field of every schedule to toggle one.
    public func setSchedulePaused(id: String, paused: Bool) throws {
        try connection.transaction {
            guard try schedule(id: id) != nil else { throw EditError.unknownSchedule(id) }
            let statement = try connection.prepare(
                "UPDATE schedules SET paused = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
            )
            defer { statement.finalize() }
            statement.bind(1, flag: paused)
            statement.bind(2, text: environment.now())
            statement.bind(3, text: id)
            try statement.run()
        }
    }

    /// Switch auto-post on or off, stamping the floor it may not reach back
    /// past. See `Schedule.autoPostFrom`.
    public func setScheduleAutoPost(id: String, autoPost: Bool) throws {
        try connection.transaction {
            guard let existing = try schedule(id: id) else { throw EditError.unknownSchedule(id) }
            let now = environment.now()
            let from: String? = autoPost
                ? (existing.autoPost ? existing.autoPostFrom ?? Self.dayOf(now) : Self.dayOf(now))
                : nil
            let statement = try connection.prepare(
                """
                UPDATE schedules SET auto_post = ?, auto_post_from = ?, updated_at = ?
                WHERE id = ? AND deleted_at IS NULL
                """
            )
            defer { statement.finalize() }
            statement.bind(1, flag: autoPost)
            statement.bind(2, optionalText: from)
            statement.bind(3, text: now)
            statement.bind(4, text: id)
            try statement.run()
        }
    }

    public func setScheduleRemind(id: String, remind: Bool) throws {
        try connection.transaction {
            guard try schedule(id: id) != nil else { throw EditError.unknownSchedule(id) }
            let statement = try connection.prepare(
                "UPDATE schedules SET remind = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL"
            )
            defer { statement.finalize() }
            statement.bind(1, flag: remind)
            statement.bind(2, text: environment.now())
            statement.bind(3, text: id)
            try statement.run()
        }
    }

    /// Tombstone a schedule, and hand back the receipt that puts it back.
    ///
    /// THE TRANSACTIONS IT POSTED ARE NOT TOUCHED. They are ordinary
    /// transactions that happened; deleting the arrangement does not un-happen
    /// them, and an app that removed them would be deleting real entries to
    /// tidy up a plan. Its history is not touched either, so an undo brings
    /// back a schedule that still knows exactly which occurrences were dealt
    /// with.
    @discardableResult
    public func deleteSchedule(id: String) throws -> DeletedRecord {
        try connection.transaction {
            guard let existing = try schedule(id: id) else {
                throw EditError.unknownSchedule(id)
            }
            let now = environment.now()
            try softDelete(table: "schedules", id: id, at: now)
            return DeletedRecord(table: "schedules", id: id, deletedAt: now, name: existing.name)
        }
    }

    private func upsertScheduleRow(_ schedule: Schedule, isNew: Bool) throws {
        let sql = isNew
            ? """
            INSERT INTO schedules (
                id, name, account_id, amount_minor, payee_name, category_id, notes, cadence,
                start_date, end_kind, end_date, end_count, expects_from, auto_post,
                auto_post_from, paused, remind, created_at, updated_at, deleted_at
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17,
                      ?18, ?19, NULL)
            """
            : """
            UPDATE schedules SET
                name = ?2, account_id = ?3, amount_minor = ?4, payee_name = ?5, category_id = ?6,
                notes = ?7, cadence = ?8, start_date = ?9, end_kind = ?10, end_date = ?11,
                end_count = ?12, expects_from = ?13, auto_post = ?14, auto_post_from = ?15,
                paused = ?16, remind = ?17, created_at = ?18, updated_at = ?19
            WHERE id = ?1 AND deleted_at IS NULL
            """
        let statement = try connection.prepare(sql)
        defer { statement.finalize() }
        statement.bind(1, text: schedule.id)
        statement.bind(2, text: schedule.name)
        statement.bind(3, text: schedule.accountId)
        statement.bind(4, minorUnits: schedule.amountMinor)  // MONEY
        statement.bind(5, text: schedule.payeeName)
        statement.bind(6, optionalText: schedule.categoryId)
        statement.bind(7, text: schedule.notes)
        statement.bind(8, text: schedule.cadence.rawValue)
        statement.bind(9, text: schedule.startDate)
        statement.bind(10, text: schedule.end.storageKind)
        statement.bind(11, optionalText: schedule.end.endDate)
        statement.bind(12, optionalInteger: schedule.end.occurrenceCount)
        statement.bind(13, text: schedule.expectsFrom)
        statement.bind(14, flag: schedule.autoPost)
        statement.bind(15, optionalText: schedule.autoPostFrom)
        statement.bind(16, flag: schedule.paused)
        statement.bind(17, flag: schedule.remind)
        statement.bind(18, text: schedule.createdAt)
        statement.bind(19, text: schedule.updatedAt)
        try statement.run()
        if !isNew, try changedRows() == 0 { throw EditError.unknownSchedule(schedule.id) }
    }

    /// The calendar day of an ISO-8601 instant: its first ten characters.
    ///
    /// The instants this package writes are UTC (`timestampNow`), so this is a
    /// UTC day, and it is used for exactly one thing: the floor under
    /// auto-post. A floor that is out by a day at the edges either lets one
    /// more occurrence post itself or holds one back for confirmation, and the
    /// second is what happens at the only edge that exists here (a floor a few
    /// hours late). Nothing about a MONEY figure is decided by it, which is why
    /// it is allowed to be this simple -- see CalendarDate's header for why
    /// nothing that IS money is.
    static func dayOf(_ timestamp: String) -> String { String(timestamp.prefix(10)) }

    // MARK: - What is due

    /// The upcoming screen, from one read of the book.
    ///
    /// Everything that decides anything is in `Upcoming.plan`, which is pure.
    /// This assembles its inputs, and the only interesting one is the balance:
    /// it comes from `Balances.accountBalances` -- the very function the
    /// accounts screen uses -- fed only the transactions dated today or
    /// earlier. One implementation of "what is this account worth", asked a
    /// question with a date on it.
    public func upcoming(
        today: String, horizonDays: Int = Upcoming.defaultHorizonDays
    ) throws -> UpcomingPlan {
        let schedules = try schedules()
        let decisions = try scheduleDecisions()
        let accounts = try readAccounts(from: "live_accounts")
        let asOfToday = try Balances.accountBalances(
            accounts: accounts, contributions: try balanceContributions(onOrBefore: today)
        )
        var laterDated: [String: [DatedAmount]] = [:]
        for row in try laterDatedAmounts(after: today) {
            laterDated[row.accountId, default: []].append(
                DatedAmount(date: row.date, amountMinor: row.amountMinor)
            )
        }
        let projected = asOfToday.map { balance in
            ProjectedAccount(
                id: balance.account.id,
                name: balance.account.name,
                type: balance.account.type,
                currency: balance.account.currency,
                balanceTodayMinor: balance.balanceMinor,
                laterDated: laterDated[balance.account.id] ?? []
            )
        }
        var categoryIds: Set<String> = []
        let statement = try connection.prepare("SELECT id FROM live_categories")
        defer { statement.finalize() }
        while try statement.step() { categoryIds.insert(try statement.text(0)) }

        return try Upcoming.plan(
            schedules: schedules.map {
                ScheduleWithDecisions(schedule: $0, decisions: decisions[$0.id] ?? [:])
            },
            accounts: projected,
            today: today,
            horizonDays: horizonDays,
            knownCategoryIds: categoryIds
        )
    }

    /// Balance contributions from transactions dated on or before a day.
    ///
    /// The same three columns and the same predicate as `balanceContributions`,
    /// with a date on it. Deliberately NOT a second aggregation: it feeds
    /// `Balances.accountBalances`, which is where adding money up happens.
    func balanceContributions(onOrBefore date: String) throws -> [BalanceContribution] {
        let statement = try connection.prepare(
            "SELECT account_id, amount_minor, status FROM live_transactions WHERE date <= ?"
        )
        defer { statement.finalize() }
        statement.bind(1, text: date)
        var rows: [BalanceContribution] = []
        while try statement.step() {
            rows.append(
                BalanceContribution(
                    accountId: try statement.text(0),
                    amountMinor: try statement.minorUnits(1),
                    cleared: try statement.text(2) == TxStatus.cleared.rawValue
                )
            )
        }
        return rows
    }

    /// Transactions the owner has already entered with a date in the future.
    ///
    /// They are part of the projection because they are part of what will
    /// happen: an app that warned about the rent while ignoring the salary
    /// somebody had already typed in would be wrong in the most alarming
    /// direction available.
    func laterDatedAmounts(after date: String) throws -> [(accountId: String, date: String, amountMinor: Int64)] {
        let statement = try connection.prepare(
            """
            SELECT account_id, date, amount_minor FROM live_transactions
            WHERE date > ? ORDER BY date, id
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: date)
        var rows: [(String, String, Int64)] = []
        while try statement.step() {
            rows.append((try statement.text(0), try statement.text(1), try statement.minorUnits(2)))
        }
        return rows
    }

    // MARK: - Entering one

    /// Enter one occurrence in the book.
    ///
    /// ONE TRANSACTION AROUND BOTH WRITES. The ledger row and the decision that
    /// records it commit together or not at all -- a posted transaction with no
    /// event would be offered for posting again next time, and an event with no
    /// transaction would leave a hole the schedule believed it had filled.
    @discardableResult
    public func postScheduled(_ posting: SchedulePosting) throws -> Transaction {
        try connection.transaction {
            guard let schedule = try schedule(id: posting.scheduleId) else {
                throw EditError.unknownSchedule(posting.scheduleId)
            }
            guard !schedule.paused else {
                throw EditError.scheduleIsPaused(name: schedule.name)
            }
            guard let occurrence = CalendarDate(iso: posting.occurrenceDate) else {
                throw EditError.badDate(posting.occurrenceDate)
            }
            guard let calendar = schedule.calendar, calendar.index(on: occurrence) != nil else {
                throw EditError.notAnOccurrence(
                    scheduleName: schedule.name, date: posting.occurrenceDate
                )
            }
            // ALREADY DEALT WITH? Asked against the BOOK, not against a stored
            // flag: an occurrence whose transaction was deleted is due again,
            // and refusing to re-enter it would leave the owner unable to
            // correct their own mistake.
            if let existing = try scheduleEvent(
                scheduleId: schedule.id, occurrenceDate: posting.occurrenceDate
            ) {
                switch existing.kind {
                case .skipped:
                    throw EditError.occurrenceAlreadySettled(
                        scheduleName: schedule.name, date: posting.occurrenceDate, posted: false
                    )
                case .posted:
                    if let id = existing.transactionId, try liveRowExists("transactions", id: id) {
                        throw EditError.occurrenceAlreadySettled(
                            scheduleName: schedule.name, date: posting.occurrenceDate, posted: true
                        )
                    }
                }
            }

            let draft = TransactionDraft(
                id: nil,
                accountId: schedule.accountId,
                date: posting.date ?? posting.occurrenceDate,
                amountMinor: posting.amountMinor ?? schedule.amountMinor,
                payeeName: schedule.payeeName,
                categoryId: schedule.categoryId,
                tagNames: [],
                notes: posting.notes ?? schedule.notes,
                status: .cleared,
                splits: []
            )
            // THE ONE WRITE PATH. Validation, currency, payee, dedupe hash and
            // the divergence count all happen in there.
            let transaction = try saveTransaction(draft)
            try recordScheduleEvent(
                scheduleId: schedule.id,
                occurrenceDate: posting.occurrenceDate,
                kind: .posted,
                transactionId: transaction.id
            )
            return transaction
        }
    }

    /// Deliberately not entering one, without deleting the schedule.
    ///
    /// A SKIP IS A DECISION AND IS RECORDED AS ONE. The occurrence stops being
    /// due, the schedule carries on, and the count-limited end is unaffected --
    /// skipping the March payment of a twelve-month plan does not add a
    /// thirteenth month, because the count describes the arrangement rather
    /// than this app's record of it.
    public func skipOccurrence(scheduleId: String, occurrenceDate: String) throws {
        try connection.transaction {
            guard let schedule = try schedule(id: scheduleId) else {
                throw EditError.unknownSchedule(scheduleId)
            }
            guard let date = CalendarDate(iso: occurrenceDate) else {
                throw EditError.badDate(occurrenceDate)
            }
            guard let calendar = schedule.calendar, calendar.index(on: date) != nil else {
                throw EditError.notAnOccurrence(scheduleName: schedule.name, date: occurrenceDate)
            }
            if let existing = try scheduleEvent(
                scheduleId: scheduleId, occurrenceDate: occurrenceDate
            ), existing.kind == .posted,
                let id = existing.transactionId, try liveRowExists("transactions", id: id)
            {
                // Skipping something already entered would leave the
                // transaction in the book with the schedule claiming it never
                // happened. Delete the transaction instead -- which is what
                // makes the occurrence due again, at which point it can be
                // skipped.
                throw EditError.occurrenceAlreadySettled(
                    scheduleName: schedule.name, date: occurrenceDate, posted: true
                )
            }
            try recordScheduleEvent(
                scheduleId: scheduleId, occurrenceDate: occurrenceDate, kind: .skipped,
                transactionId: nil
            )
        }
    }

    /// Take a skip back: the occurrence becomes due again.
    ///
    /// A TOMBSTONE, NOT A DELETE, like everything else here. The row that
    /// recorded the decision stays, so a store that one day syncs sees a
    /// conflict-protected change rather than a row that quietly vanished.
    public func unskipOccurrence(scheduleId: String, occurrenceDate: String) throws {
        try connection.transaction {
            let statement = try connection.prepare(
                """
                UPDATE schedule_events SET deleted_at = ?
                WHERE schedule_id = ? AND occurrence_date = ? AND kind = 'skipped'
                  AND deleted_at IS NULL
                """
            )
            defer { statement.finalize() }
            statement.bind(1, text: environment.now())
            statement.bind(2, text: scheduleId)
            statement.bind(3, text: occurrenceDate)
            try statement.run()
            guard try changedRows() > 0 else {
                throw EditError.nothingToRestore(what: "skipped payment")
            }
        }
    }

    /// The schedules that enter themselves, entered.
    ///
    /// CALLED WHEN THE APP OPENS AND AFTER EVERY CHANGE, which is the honest
    /// shape of "automatic" on a phone: there is no background execution here,
    /// no server, and nothing that runs at midnight. The screens say so --
    /// "entered the next time you open the app" -- rather than implying a
    /// daemon that does not exist.
    @discardableResult
    public func postDue(today: String, limit: Int = LedgerStore.autoPostRunLimit) throws
        -> AutoPostResult
    {
        let plan = try upcoming(today: today, horizonDays: 0)
        let eligible = plan.autoPosting
        var posted: [String] = []
        var refusals: [String] = []
        for occurrence in eligible.prefix(limit) {
            do {
                let transaction = try postScheduled(
                    SchedulePosting(
                        scheduleId: occurrence.scheduleId, occurrenceDate: occurrence.date
                    )
                )
                posted.append(transaction.id)
            } catch let error as EditError {
                // Reported, never swallowed. One schedule with a missing
                // category must not stop the other four from posting, and it
                // must not be silent either.
                refusals.append("\(occurrence.scheduleName): \(error.problem)")
            }
        }
        return AutoPostResult(
            posted: posted, heldBack: max(0, eligible.count - limit), refusals: refusals
        )
    }

    // MARK: - Events

    func scheduleEvent(scheduleId: String, occurrenceDate: String) throws -> ScheduleEvent? {
        let statement = try connection.prepare(
            """
            SELECT schedule_id, occurrence_date, kind, transaction_id, at
            FROM live_schedule_events WHERE schedule_id = ? AND occurrence_date = ?
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: scheduleId)
        statement.bind(2, text: occurrenceDate)
        guard try statement.step() else { return nil }
        return ScheduleEvent(
            scheduleId: try statement.text(0),
            occurrenceDate: try statement.text(1),
            kind: ScheduleEvent.Kind(rawValue: try statement.text(2)) ?? .skipped,
            transactionId: try statement.optionalText(3),
            at: try statement.text(4)
        )
    }

    /// Record a decision. Upsert, because a decision about one occurrence is
    /// one fact and the latest one stands -- including one that revives a
    /// tombstoned row (un-skipped, then skipped again).
    private func recordScheduleEvent(
        scheduleId: String, occurrenceDate: String, kind: ScheduleEvent.Kind,
        transactionId: String?
    ) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO schedule_events
                (schedule_id, occurrence_date, kind, transaction_id, at, deleted_at)
            VALUES (?1, ?2, ?3, ?4, ?5, NULL)
            ON CONFLICT(schedule_id, occurrence_date) DO UPDATE SET
                kind = excluded.kind, transaction_id = excluded.transaction_id,
                at = excluded.at, deleted_at = NULL
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: scheduleId)
        statement.bind(2, text: occurrenceDate)
        statement.bind(3, text: kind.rawValue)
        statement.bind(4, optionalText: transactionId)
        statement.bind(5, text: environment.now())
        try statement.run()
    }
}
