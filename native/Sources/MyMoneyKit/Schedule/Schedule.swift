// A standing arrangement: this amount, to this payee, out of this account,
// every so often.
//
// ─────────────────────────────────────────────────────────────────────────────
// A SCHEDULE IS NOT A TRANSACTION AND MUST NEVER BE MISTAKEN FOR ONE.
//
// It is a PLAN. Nothing in this file is money that has moved, nothing here is
// in any balance, and nothing here appears in a report. The only way a schedule
// becomes money is `LedgerStore.post`, which writes an ordinary transaction
// through `saveTransaction` -- the same validated, local-edit-counting door
// Quick Add uses. There is no second writer.
//
// That separation is what makes the honest answer to "what is my balance"
// possible at all. A finance app that folded expected payments into the
// balance would be showing a figure that is part fact and part forecast, with
// no way for the reader to tell which pennies are which. So the projection in
// `Upcoming.swift` is drawn as a separate, labelled thing, and the balance
// stays what it has always been: the transactions that exist.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ARITHMETIC IS NOT HERE, AND THAT IS THE POINT.
//
// "When is the next one" is answered by `Cadence.date(from:steps:)` in
// Insights/Cadence.swift -- the same function the recurrence detector uses to
// decide whether a run of real payments fits a pattern. Two implementations of
// that question would eventually disagree, and the day they disagreed the app
// would be telling the owner that a bill it had just detected as monthly was
// next due on a different day from the schedule that pays it.
//
// `ScheduleCalendar` is the only thing that turns a schedule into dates, and it
// is a thin wrapper over `Cadence`. See its header for the one decision that
// matters (occurrence n is measured from the anchor, never from occurrence
// n-1).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT A SCHEDULE DELIBERATELY CANNOT DO, IN THIS PHASE.
//
//   * IT CANNOT BE A TRANSFER. `saveTransfer` exists and would take the write,
//     so the temptation is real; what does not exist is the rest of it -- a
//     second account, two amounts for the cross-currency case, and a
//     below-zero projection that has to move money out of one account and into
//     another on the same day. Half of that shipped for real money is worse
//     than none of it, and the screens say so in words rather than offering a
//     transfer schedule that quietly posts one leg.
//   * IT CANNOT BE SPLIT. A split has to sum exactly to its parent (SPEC 6);
//     an amount that varies per occurrence and a split list that does not
//     follow it is a refusal at post time, months after the mistake was made.
//   * IT CANNOT VARY THE AMOUNT. A schedule states one figure. A bill that
//     changes is entered by hand, or posted and then edited -- and editing a
//     posted transaction is an ordinary edit of an ordinary row, which is
//     exactly what it should be.
import Foundation

/// When a schedule stops.
///
/// THREE CASES RATHER THAN TWO NULLABLE FIELDS. "end date is null and count is
/// null" and "end date is null and count is 12" and "end date is 2027-01-01 and
/// count is 12" are three rows a nullable pair can hold and only two of them
/// mean anything; the third has to be resolved by a rule nobody can see. The
/// schema carries the same three cases as a checked `end_kind`, so a row that
/// says "after 12" without a 12 in it cannot be written.
public enum ScheduleEnd: Sendable, Hashable {
    /// It carries on. The overwhelmingly common case: rent, a season ticket, a
    /// subscription.
    case never
    /// The last occurrence is on or before this date, inclusive.
    case onDate(String)
    /// Exactly this many occurrences, counting from the first.
    ///
    /// SKIPPED OCCURRENCES COUNT. A twelve-payment plan whose March payment is
    /// skipped still finishes in twelve months, because the count describes the
    /// ARRANGEMENT and not the app's record of it. Deciding it the other way
    /// would mean skipping an occurrence silently extended the schedule past
    /// the end of the thing it represents.
    case afterOccurrences(Int)

    /// How the row spells it.
    public var storageKind: String {
        switch self {
        case .never: return "never"
        case .onDate: return "on_date"
        case .afterOccurrences: return "after_count"
        }
    }

    public var endDate: String? {
        if case .onDate(let date) = self { return date }
        return nil
    }

    public var occurrenceCount: Int? {
        if case .afterOccurrences(let count) = self { return count }
        return nil
    }

    /// Rebuild from the three columns. `nil` when they do not agree with each
    /// other, which the schema's CHECK constraints already prevent -- this is
    /// the reader's half of that promise, and a store handed over by another
    /// tool is the case it is here for.
    public static func from(kind: String, date: String?, count: Int?) -> ScheduleEnd? {
        switch kind {
        case "never": return .never
        case "on_date": return date.map { .onDate($0) }
        case "after_count": return count.map { .afterOccurrences($0) }
        default: return nil
        }
    }
}

/// A standing arrangement, as the store holds it.
public struct Schedule: Sendable, Hashable, Identifiable {
    public let id: String
    /// What the owner calls it. Separate from the payee because two schedules
    /// can pay the same payee ("Car insurance" and "Home insurance" are both
    /// paid to one insurer) and a list that showed only payees could not tell
    /// them apart.
    public let name: String
    public let accountId: String
    /// SIGNED minor units, in the ACCOUNT's currency -- negative is money out,
    /// the same convention as every transaction in the book. Never zero: a
    /// schedule for nothing is refused by `saveSchedule` and by the schema.
    public let amountMinor: Int64
    /// A NAME, not an id, for the same reason `TransactionDraft` carries one: a
    /// schedule that survives a re-import of the book must not depend on the
    /// payee row keeping its id, and posting goes through `getOrCreatePayee`
    /// exactly as typing the name by hand would.
    public let payeeName: String
    public let categoryId: String?
    public let notes: String
    public let cadence: Cadence
    /// The anchor. Every occurrence is measured from this date, so a schedule
    /// anchored on the 31st is on the 31st for ever (see `ScheduleCalendar`).
    public let startDate: String
    public let end: ScheduleEnd
    /// The first date this schedule is EXPECTED to have been entered from.
    ///
    /// WHY THIS IS NOT THE START DATE. The anchor is often deliberately in the
    /// past: "the rent has been due on the 3rd since 2024" is how you get the
    /// 3rd, and the app must not conclude from it that twenty-two rent payments
    /// are overdue. So the grid runs from `startDate` and the app's
    /// EXPECTATIONS run from here, which the editor sets to today when a
    /// schedule is created. Occurrences before it are history the owner already
    /// has; they are never due, never overdue, and can never be auto-posted.
    public let expectsFrom: String
    /// Post without asking. Off by default, everywhere, always.
    public let autoPost: Bool
    /// The date auto-post was switched on, and the floor under it.
    ///
    /// AUTO-POST CANNOT REACH BACKWARDS. Switching it on for a schedule
    /// anchored two years ago must not fill the register with two years of
    /// transactions nobody asked for -- so an occurrence dated before this is
    /// offered for confirmation like any other, however trusted the schedule
    /// is. nil when auto-post has never been on.
    public let autoPostFrom: String?
    /// Suspended by the owner: no occurrence is due, nothing posts, and the
    /// schedule is still there with all its history.
    public let paused: Bool
    /// Include this schedule in the local reminders.
    public let remind: Bool
    public let createdAt: String
    public let updatedAt: String

    public init(
        id: String,
        name: String,
        accountId: String,
        amountMinor: Int64,
        payeeName: String,
        categoryId: String?,
        notes: String,
        cadence: Cadence,
        startDate: String,
        end: ScheduleEnd,
        expectsFrom: String,
        autoPost: Bool,
        autoPostFrom: String?,
        paused: Bool,
        remind: Bool,
        createdAt: String,
        updatedAt: String
    ) {
        self.id = id
        self.name = name
        self.accountId = accountId
        self.amountMinor = amountMinor
        self.payeeName = payeeName
        self.categoryId = categoryId
        self.notes = notes
        self.cadence = cadence
        self.startDate = startDate
        self.end = end
        self.expectsFrom = expectsFrom
        self.autoPost = autoPost
        self.autoPostFrom = autoPostFrom
        self.paused = paused
        self.remind = remind
        self.createdAt = createdAt
        self.updatedAt = updatedAt
    }

    /// The dates this schedule falls on. The one door from a schedule to a
    /// calendar; nil only when the stored dates are not dates, which the
    /// editor and the store both refuse before a row is written.
    public var calendar: ScheduleCalendar? {
        guard let start = CalendarDate(iso: startDate) else { return nil }
        return ScheduleCalendar(cadence: cadence, start: start, end: end)
    }

    /// Money out, in the plain sense: the sign convention of the book, asked
    /// once so no screen has to remember it.
    public var isMoneyOut: Bool { amountMinor < 0 }

    /// "£450.00 monthly", the phrase both the list and the widget use.
    public func headline(currency: String) -> String {
        "\(Money.format(abs(amountMinor), currency: currency)) \(cadence.phrase)"
    }

    /// About what this costs in a year, at this amount.
    ///
    /// `Cadence.occurrencesPerYear`'s whole numbers, and its header explains
    /// why they are whole (52 / 26 / 13 on a 364-day year, consistent with each
    /// other and checkable in the reader's head). An overflow is not money, so
    /// it is nil rather than a wrapped figure.
    public var annualMinor: Int64? {
        let (product, overflowed) = amountMinor.multipliedReportingOverflow(
            by: Int64(cadence.occurrencesPerYear)
        )
        return overflowed ? nil : product
    }
}

/// A schedule as a form holds it.
///
/// The same split as `TransactionDraft`: what a person decides, in a person's
/// vocabulary. `currency`, `createdAt`, `updatedAt` and the auto-post floor are
/// the store's to fill in, and a form that supplied them would get the currency
/// wrong first -- it belongs to the account.
public struct ScheduleDraft: Sendable, Hashable {
    /// nil to create; present to update THAT schedule.
    public var id: String?
    public var name: String
    public var accountId: String
    /// Signed minor units, in the account's currency. Negative is money out.
    public var amountMinor: Int64
    public var payeeName: String
    public var categoryId: String?
    public var notes: String
    public var cadence: Cadence
    public var startDate: String
    public var end: ScheduleEnd
    /// nil on create means "expect entries from the start date" -- a deliberate
    /// backlog. The editor passes today instead, which is what almost everybody
    /// means. Ignored on update: moving the expectation floor after the fact
    /// would silently make a row of overdue items disappear.
    public var expectsFrom: String?
    public var autoPost: Bool
    public var paused: Bool
    public var remind: Bool

    public init(
        id: String? = nil,
        name: String,
        accountId: String,
        amountMinor: Int64,
        payeeName: String = "",
        categoryId: String? = nil,
        notes: String = "",
        cadence: Cadence,
        startDate: String,
        end: ScheduleEnd = .never,
        expectsFrom: String? = nil,
        autoPost: Bool = false,
        paused: Bool = false,
        remind: Bool = true
    ) {
        self.id = id
        self.name = name
        self.accountId = accountId
        self.amountMinor = amountMinor
        self.payeeName = payeeName
        self.categoryId = categoryId
        self.notes = notes
        self.cadence = cadence
        self.startDate = startDate
        self.end = end
        self.expectsFrom = expectsFrom
        self.autoPost = autoPost
        self.paused = paused
        self.remind = remind
    }
}

/// What the app decided about one occurrence, and when.
///
/// ONE ROW PER (SCHEDULE, DATE). A decision about the payment due on the 3rd of
/// September is a single fact, and the last one made is the one that stands.
public struct ScheduleEvent: Sendable, Hashable {
    public enum Kind: String, Sendable, Hashable {
        /// It was entered in the book. `transactionId` names the row.
        case posted
        /// It was deliberately not entered, and the schedule carries on.
        case skipped
    }

    public let scheduleId: String
    /// The occurrence's own date, "YYYY-MM-DD" -- the date on the GRID, which
    /// is not necessarily the date the transaction carries if the owner edited
    /// it afterwards.
    public let occurrenceDate: String
    public let kind: Kind
    public let transactionId: String?
    /// When the decision was taken, in this app's clock.
    public let at: String

    public init(
        scheduleId: String, occurrenceDate: String, kind: Kind, transactionId: String?, at: String
    ) {
        self.scheduleId = scheduleId
        self.occurrenceDate = occurrenceDate
        self.kind = kind
        self.transactionId = transactionId
        self.at = at
    }
}

/// What an occurrence is, once the decisions and the book have both been
/// consulted.
///
/// `postedButGone` IS THE INTERESTING ONE, and it is why this is derived on
/// every read rather than stored. A posting is a CLAIM -- "the 3 September rent
/// is in the book as transaction t" -- and a claim can stop being true:
///
///   * the owner deleted the transaction, or
///   * a fresh import replaced the whole book with the file, and a transaction
///     typed on this device was never in that file.
///
/// Both are ordinary, both leave the book WITHOUT the payment, and in both the
/// honest answer is that the occurrence is due again. Storing the state instead
/// of deriving it would leave the app insisting a payment had been entered
/// while the register showed it had not.
public enum ScheduleOccurrenceState: Sendable, Hashable {
    case due
    case posted(transactionId: String)
    case skipped
    /// Posted once, and the transaction is no longer in the book.
    case postedButGone(transactionId: String)

    /// Does the book contain this occurrence?
    public var isSettled: Bool {
        switch self {
        case .posted, .skipped: return true
        case .due, .postedButGone: return false
        }
    }
}

extension ScheduleDraft {

    /// A schedule prefilled from a pattern the app already detected.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    /// THIS IS WHERE THE "ONE CADENCE ARITHMETIC" RULE PAYS FOR ITSELF. The
    /// insights screen says "Northgate Streaming, monthly, next expected on the
    /// 12th"; the schedule made from it must fall on exactly that day, and not
    /// a day near it. It does, structurally rather than by coincidence:
    ///
    ///   * `RecurringSeries.nextExpectedDate` is `cadence.date(from: lastDate,
    ///     steps: 1)`;
    ///   * this anchors the schedule at `lastDate`, so its occurrence 1 is the
    ///     same expression;
    ///   * and `ScheduleCalendarTests` asserts the two agree.
    ///
    /// Two payments do not make a pattern, so a `pair` gets NO prefilled
    /// schedule -- `nextExpectedDate` is nil for one, and offering a start date
    /// anyway would be this file inventing the prediction the detector
    /// deliberately refused to make.
    ///
    /// THE AMOUNT IS ALWAYS MONEY OUT. `Recurrence` never looks at money in
    /// (a salary is the most regular thing in most books and is not something
    /// you pay), so `typicalAmountMinor` is a positive magnitude of a payment,
    /// and the sign is put on here.
    public static func from(series: RecurringSeries, today: String) -> ScheduleDraft? {
        guard series.confidence != .pair, series.nextExpectedDate != nil,
            let accountId = series.accountIds.last
        else { return nil }
        return ScheduleDraft(
            name: series.payeeName,
            accountId: accountId,
            amountMinor: -series.typicalAmountMinor,
            payeeName: series.payeeName,
            categoryId: nil,
            notes: "",
            cadence: series.cadence,
            // ANCHORED AT THE LAST PAYMENT, which is also where the detector
            // anchors its grid -- so the schedule inherits the pattern rather
            // than starting a new one a few days off it.
            startDate: series.lastDate,
            end: .never,
            // The last payment is already in the book. Expecting entries from
            // today is what stops the app immediately claiming it is overdue.
            expectsFrom: today
        )
    }
}
