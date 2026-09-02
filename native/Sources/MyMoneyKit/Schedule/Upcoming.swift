// What is due, when, what it comes to -- and which account it empties.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE WARNING IS THE POINT. Everything else on this screen is a list; the
// reason people want scheduled payments in a finance app at all is the sentence
// "the rent will take this account below zero on the 3rd". So the projection is
// not a decoration on the side of the feature, it is the feature, and it is
// built to be defensible rather than clever:
//
//   * IT COUNTS ONLY TWO THINGS: transactions that are already in the book, and
//     occurrences this app is going to offer to post. It does not model
//     spending, it does not extrapolate from history, and it does not know what
//     the owner is about to buy. Every screen that shows it says so in one
//     line, because a forecast whose inputs are not stated is a number people
//     either trust too much or ignore entirely.
//   * IT NEVER CONVERTS CURRENCY. The projection runs per ACCOUNT, in that
//     account's own currency, so no exchange rate is involved and there is no
//     "missing rate" hole to explain. Totals are likewise per currency: a
//     single "£1,240 due" over accounts in three currencies would be a figure
//     nobody could check.
//   * IT ONLY WARNS WHERE ZERO IS A FLOOR. A credit card sits below zero by
//     design and a loan is below zero for years; warning about either is
//     crying wolf every month, and an app that cries wolf about money gets
//     ignored about money. So: current, savings and cash accounts warn, and
//     `AccountType`'s other three do not. `warnsBelowZero` says it once.
//   * IT SEPARATES "ALREADY BELOW" FROM "THIS TAKES YOU BELOW". An account that
//     is overdrawn today is not something the rent did, and a warning that
//     blamed the rent for it would be false. Both are reported; they read
//     differently.
//
// ─────────────────────────────────────────────────────────────────────────────
// ARITHMETIC IS OVERFLOW-CHECKED, like every other total in this package. A
// projection that wrapped Int64 would produce a spectacular warning about an
// account that is fine.
import Foundation

extension AccountType {
    /// Is zero a floor for this kind of account?
    ///
    /// The three that say no are not oversights. A CREDIT CARD's balance is
    /// negative whenever anything is owed, a LOAN's is negative until it is
    /// repaid, and an INVESTMENT account can hold a position valued below its
    /// opening balance without anything being wrong. Warning on those is a
    /// warning that fires every month for no reason, and the cost of that is
    /// not noise -- it is that the warnings which matter stop being read.
    public var warnsBelowZero: Bool {
        switch self {
        case .current, .savings, .cash: return true
        case .creditCard, .loan, .investment: return false
        }
    }
}

/// One occurrence the app is offering to enter.
public struct DueOccurrence: Sendable, Hashable, Identifiable {
    /// Stable across reads: a schedule and a date name exactly one occurrence.
    public var id: String { "\(scheduleId)@\(date)" }

    public let scheduleId: String
    public let scheduleName: String
    /// The occurrence's date on the grid, "YYYY-MM-DD".
    public let date: String
    /// Which occurrence of the series this is, counting the first as 0.
    public let index: Int
    /// Signed minor units in the account's currency, exactly as the schedule
    /// states it.
    public let amountMinor: Int64
    public let currency: String
    public let accountId: String
    public let accountName: String
    public let payeeName: String
    public let categoryId: String?
    public let notes: String
    /// Would this one enter itself the next time the app opens? Shown on the
    /// row, because "this will happen without me" is not something to discover
    /// afterwards.
    public let postsItself: Bool
    /// Dated before today and still not in the book.
    public let isOverdue: Bool
    /// Days from today. Negative when overdue.
    public let daysAway: Int
    /// It WAS entered, and the transaction is no longer in the book -- deleted,
    /// or replaced by a fresh import. Offered again, with the reason on the
    /// row, because an app that silently re-offered it would look like it had
    /// lost count and one that silently did not would leave a hole in the book.
    public let reopened: Bool

    /// Money out, in the book's sign convention.
    public var isMoneyOut: Bool { amountMinor < 0 }
}

/// What is due in one currency. Per currency because there is no honest way to
/// add two.
public struct DueTotal: Sendable, Hashable, Identifiable {
    public var id: String { currency }
    public let currency: String
    /// A POSITIVE magnitude: what leaves.
    public let outMinor: Int64
    /// A POSITIVE magnitude: what arrives.
    public let inMinor: Int64
    public let count: Int

    /// Signed: what the window does to the total in this currency.
    public var netMinor: Int64 { inMinor - outMinor }
}

/// An account this window takes below zero, or one that is already there.
public struct BalanceWarning: Sendable, Hashable, Identifiable {
    public var id: String { accountId }
    public let accountId: String
    public let accountName: String
    public let currency: String
    /// The balance as things stand today, counting every transaction in the
    /// book dated today or earlier.
    public let balanceTodayMinor: Int64
    /// The day the projection first goes below zero.
    public let date: String
    /// What it is projected to be on that day. Negative, by construction.
    public let projectedMinor: Int64
    /// The due occurrence that crossed the line, when one did. nil when the
    /// account was already below zero before any scheduled payment.
    public let occurrenceId: String?
    /// The name of that occurrence's schedule, for the sentence.
    public let scheduleName: String?
    /// It was already below zero today. The schedule did not do this.
    public let alreadyBelowZero: Bool
    /// How many of the due occurrences in this window come out of this account.
    public let dueCount: Int
}

/// A schedule that cannot post as it stands.
///
/// SURFACED, NEVER SILENTLY SKIPPED. A schedule whose account was renamed away
/// by a fresh import would otherwise simply stop appearing, and the first sign
/// of it would be a missing payment.
public struct ScheduleProblem: Sendable, Hashable, Identifiable {
    public enum Kind: String, Sendable, Hashable {
        /// The account is not in this copy of the book.
        case accountMissing
        /// The category is not in this copy of the book. It would be refused at
        /// post time, so it is said here instead.
        case categoryMissing
        /// The dates in the row are not dates. Nothing can be computed from it.
        case unreadableDates
        /// Every occurrence has been and gone.
        case finished
    }

    public var id: String { "\(scheduleId):\(kind.rawValue)" }
    public let scheduleId: String
    public let scheduleName: String
    public let kind: Kind
}

/// Everything the upcoming screen shows, decided in one pass.
public struct UpcomingPlan: Sendable {
    public let today: String
    /// The last day this plan looked at, inclusive.
    public let throughDate: String
    /// Dated before today, not in the book. Newest LAST -- oldest first, so the
    /// thing that has been waiting longest is at the top of the list.
    public let overdue: [DueOccurrence]
    /// Today and after, in date order.
    public let due: [DueOccurrence]
    /// Over overdue and due together, because both are money that has not
    /// happened yet and both are about to.
    public let totals: [DueTotal]
    public let warnings: [BalanceWarning]
    public let problems: [ScheduleProblem]
    /// Occurrences that will enter themselves next time the app is opened.
    public let autoPosting: [DueOccurrence]

    public var isEmpty: Bool { overdue.isEmpty && due.isEmpty }
    public var count: Int { overdue.count + due.count }

    /// Every due occurrence, overdue first. The order the screen lists them in
    /// and the order the projection applies them in.
    public var all: [DueOccurrence] { overdue + due }
}

// MARK: - What the planner is fed

/// One account, as the projection needs it.
public struct ProjectedAccount: Sendable, Hashable {
    public let id: String
    public let name: String
    public let type: AccountType
    public let currency: String
    /// Every transaction in the book dated TODAY OR EARLIER, plus the opening
    /// balance.
    ///
    /// NOT the account's headline balance, which includes rows dated in the
    /// future -- the accounts screen shows "what I have got" and this is "what
    /// I have got today, before the future arrives". Adding a later-dated
    /// transaction to a balance that already contains it would count it twice,
    /// and the error would be invisible: the projection would simply be
    /// optimistic by exactly one salary.
    public let balanceTodayMinor: Int64
    /// Transactions already entered with a date after today: (date, signed
    /// amount). They land in the projection on their own day.
    public let laterDated: [DatedAmount]

    public init(
        id: String, name: String, type: AccountType, currency: String,
        balanceTodayMinor: Int64, laterDated: [DatedAmount]
    ) {
        self.id = id
        self.name = name
        self.type = type
        self.currency = currency
        self.balanceTodayMinor = balanceTodayMinor
        self.laterDated = laterDated
    }
}

/// A dated signed amount: the shape both halves of the projection share.
public struct DatedAmount: Sendable, Hashable {
    public let date: String
    public let amountMinor: Int64

    public init(date: String, amountMinor: Int64) {
        self.date = date
        self.amountMinor = amountMinor
    }
}

/// A schedule with every decision already taken about it, keyed by the
/// occurrence date those decisions were about.
public struct ScheduleWithDecisions: Sendable {
    public let schedule: Schedule
    /// Occurrence date -> what the app knows. Only settled occurrences appear;
    /// anything absent is due.
    public let decisions: [String: ScheduleOccurrenceState]

    public init(schedule: Schedule, decisions: [String: ScheduleOccurrenceState]) {
        self.schedule = schedule
        self.decisions = decisions
    }
}

// MARK: - The planner

public enum Upcoming {
    /// How far ahead to look. Thirty days by default: far enough to cover every
    /// cadence's next occurrence except the quarterly and annual ones, and
    /// close enough that the projection is not pretending to know what the
    /// account will hold in March.
    public static let defaultHorizonDays = 30

    /// Everything the upcoming screen shows.
    ///
    /// PURE, and every input is a value. The store's job is to read the rows;
    /// this decides what they mean, and it is the deciding that has to be
    /// testable without a database.
    public static func plan(
        schedules: [ScheduleWithDecisions],
        accounts: [ProjectedAccount],
        today todayISO: String,
        horizonDays: Int = defaultHorizonDays,
        /// The categories this copy of the book actually has. nil means the
        /// caller is not checking -- the pure tests do not need to, and a
        /// missing-category problem invented from an empty set would be a
        /// problem on every schedule.
        knownCategoryIds: Set<String>? = nil
    ) throws -> UpcomingPlan {
        guard let today = CalendarDate(iso: todayISO) else {
            throw EditError.badDate(todayISO)
        }
        let through = today.addingDays(max(0, horizonDays))
        // `uniquingKeysWith`, not `uniqueKeysWithValues`: the latter TRAPS on a
        // duplicate key, and this is a public function taking a caller's array.
        // The store cannot hand it two accounts with one id (it is a primary
        // key), but a crash is not the failure mode a money app should have if
        // one ever did.
        let accountsById = Dictionary(accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })

        var overdue: [DueOccurrence] = []
        var due: [DueOccurrence] = []
        var problems: [ScheduleProblem] = []

        for entry in schedules {
            let schedule = entry.schedule
            // A PAUSED SCHEDULE SAYS NOTHING AT ALL, and that includes its
            // problems. It is switched off: it will enter nothing, so a "needs
            // attention" row about its missing account is a job with no
            // consequence attached -- and that list is worth reading exactly as
            // long as nothing in it can safely be ignored. Everything below is
            // recomputed the moment it is unpaused, so nothing is lost by
            // waiting until it matters. It keeps every occurrence it has
            // already settled either way.
            if schedule.paused { continue }
            guard let calendar = schedule.calendar, CalendarDate(iso: schedule.expectsFrom) != nil
            else {
                problems.append(
                    ScheduleProblem(
                        scheduleId: schedule.id, scheduleName: schedule.name,
                        kind: .unreadableDates
                    )
                )
                continue
            }
            guard let account = accountsById[schedule.accountId] else {
                problems.append(
                    ScheduleProblem(
                        scheduleId: schedule.id, scheduleName: schedule.name,
                        kind: .accountMissing
                    )
                )
                continue
            }
            if let categoryId = schedule.categoryId, let known = knownCategoryIds,
                !known.contains(categoryId)
            {
                // Said HERE rather than discovered at post time. The store
                // would refuse the transaction with a clear sentence, but it
                // would refuse it after the owner tapped Enter, which is the
                // worst moment to find out.
                problems.append(
                    ScheduleProblem(
                        scheduleId: schedule.id, scheduleName: schedule.name,
                        kind: .categoryMissing
                    )
                )
            }
            if let final = calendar.finalDate, final < today {
                // Finished is worth saying once, on the schedule's own row,
                // rather than leaving a schedule in the list that will never
                // do anything again.
                problems.append(
                    ScheduleProblem(
                        scheduleId: schedule.id, scheduleName: schedule.name, kind: .finished
                    )
                )
            }

            // THE FLOOR. Occurrences before `expectsFrom` are history the owner
            // already has -- see `Schedule.expectsFrom` -- so a schedule
            // anchored in 2024 to get "the 3rd of the month" does not arrive
            // with twenty-two overdue payments.
            let floor = max(
                CalendarDate(iso: schedule.expectsFrom) ?? calendar.start, calendar.start
            )
            for (index, date) in calendar.occurrences(from: floor, through: through) {
                let state = entry.decisions[date.iso] ?? .due
                switch state {
                case .posted, .skipped:
                    continue
                case .due, .postedButGone:
                    break
                }
                let reopened: Bool
                if case .postedButGone = state { reopened = true } else { reopened = false }
                let daysAway = date.daysSince(today)
                let isOverdue = date < today
                let occurrence = DueOccurrence(
                    scheduleId: schedule.id,
                    scheduleName: schedule.name,
                    date: date.iso,
                    index: index,
                    amountMinor: schedule.amountMinor,
                    currency: account.currency,
                    accountId: account.id,
                    accountName: account.name,
                    payeeName: schedule.payeeName,
                    categoryId: schedule.categoryId,
                    notes: schedule.notes,
                    postsItself: postsItself(schedule, on: date, cameBack: reopened),
                    isOverdue: isOverdue,
                    daysAway: daysAway,
                    reopened: reopened
                )
                if isOverdue { overdue.append(occurrence) } else { due.append(occurrence) }
            }
        }

        overdue.sort(by: inDateOrder)
        due.sort(by: inDateOrder)

        return UpcomingPlan(
            today: todayISO,
            throughDate: through.iso,
            overdue: overdue,
            due: due,
            totals: try totals(overdue + due),
            warnings: try warnings(
                for: overdue + due, accounts: accounts, today: today, through: through
            ),
            problems: problems,
            autoPosting: (overdue + due).filter(\.postsItself)
        )
    }

    /// Two occurrences in the order a person reads them: soonest first, then
    /// biggest first, then by schedule so the list never reshuffles itself
    /// between reads.
    private static func inDateOrder(_ a: DueOccurrence, _ b: DueOccurrence) -> Bool {
        if a.date != b.date { return a.date < b.date }
        if a.amountMinor != b.amountMinor { return a.amountMinor < b.amountMinor }
        return a.id < b.id
    }

    /// Would this occurrence enter itself?
    ///
    /// THREE CONDITIONS, AND `cameBack` IS THE ONE THAT PROTECTS THE OWNER FROM
    /// HIS OWN APP. An occurrence is `postedButGone` when it was entered once
    /// and the transaction is no longer in the book, and there are exactly two
    /// ways that happens -- neither of which is a reason to write it again
    /// without asking:
    ///
    ///   * HE DELETED IT. Putting it straight back is the app overruling him
    ///     about his own money, and doing it silently at the next launch is the
    ///     worst available version of that.
    ///   * A FRESH IMPORT REPLACED THE BOOK. The file came from the web app,
    ///     which may well already contain that payment -- so re-entering it
    ///     makes a duplicate of a row that is already there.
    ///
    /// The owner switched auto-post on for the SCHEDULE. He did not ask the app
    /// to re-enter something that has already been through the book once, and
    /// the difference between the two cases is not something this code can see.
    /// So a reopened occurrence is always offered for confirmation, with the
    /// reason on the row; the occurrences after it are unaffected.
    ///
    /// The second condition is the one the header is about: auto-post cannot
    /// reach back past the day it was switched on. See `Schedule.autoPostFrom`.
    static func postsItself(_ schedule: Schedule, on date: CalendarDate, cameBack: Bool) -> Bool {
        guard !cameBack else { return false }
        guard schedule.autoPost, !schedule.paused else { return false }
        guard let from = schedule.autoPostFrom.flatMap(CalendarDate.init(iso:)) else { return false }
        return date >= from
    }

    // MARK: - Totals

    /// Per currency, out and in kept apart.
    ///
    /// KEPT APART BECAUSE THEY ANSWER DIFFERENT QUESTIONS. "£1,240 leaves this
    /// month" is a thing to plan around; a net figure of "£310 in" quietly
    /// hides a salary against three bills, and the reader cannot tell whether a
    /// small net means small payments or large ones that nearly cancel.
    static func totals(_ occurrences: [DueOccurrence]) throws -> [DueTotal] {
        var out: [String: Int64] = [:]
        var into: [String: Int64] = [:]
        var counts: [String: Int] = [:]
        for occurrence in occurrences {
            counts[occurrence.currency, default: 0] += 1
            let magnitude = occurrence.amountMinor.magnitude
            guard magnitude <= UInt64(Int64.max) else {
                throw MoneyError.overflow("a scheduled amount that is not money")
            }
            let value = Int64(magnitude)
            if occurrence.amountMinor < 0 {
                out[occurrence.currency] = try add(out[occurrence.currency] ?? 0, value)
            } else {
                into[occurrence.currency] = try add(into[occurrence.currency] ?? 0, value)
            }
        }
        return counts.keys.sorted().map { currency in
            DueTotal(
                currency: currency,
                outMinor: out[currency] ?? 0,
                inMinor: into[currency] ?? 0,
                count: counts[currency] ?? 0
            )
        }
    }

    private static func add(_ a: Int64, _ b: Int64) throws -> Int64 {
        let (sum, overflowed) = a.addingReportingOverflow(b)
        if overflowed { throw MoneyError.overflow("totalling what is due") }
        return sum
    }

    // MARK: - The projection

    /// Which accounts this window takes below zero.
    ///
    /// ONE PASS PER ACCOUNT, over a merged timeline of things already in the
    /// book and things about to be. Within one day the already-entered
    /// transactions are applied FIRST, because they are facts and the scheduled
    /// ones are not: if a salary and a bill land on the same day and the order
    /// decides whether the account dips, the honest answer is the one that does
    /// not blame the schedule for a dip the bank would never have seen.
    ///
    /// OVERDUE ITEMS ARE APPLIED AT TODAY. They have not happened yet and they
    /// are about to; leaving them out would produce a projection that is
    /// exactly as wrong as the backlog is big.
    ///
    /// AND IT STOPS AT `through`, WHICH IS THE SCREEN'S OWN WINDOW. A
    /// transaction the owner typed in with next June's date is real, and it is
    /// not in this window; without the bound it can produce a warning naming a
    /// date in 2027 with no schedule behind it, on a screen whose footer says
    /// it is counting what is scheduled below. Dropping those steps cannot
    /// change a crossing found inside the window either -- the timeline runs in
    /// date order, so everything removed comes strictly after everything kept.
    static func warnings(
        for occurrences: [DueOccurrence],
        accounts: [ProjectedAccount],
        today: CalendarDate,
        through: CalendarDate
    ) throws -> [BalanceWarning] {
        var byAccount: [String: [DueOccurrence]] = [:]
        for occurrence in occurrences { byAccount[occurrence.accountId, default: []].append(occurrence) }

        var out: [BalanceWarning] = []
        for account in accounts where account.type.warnsBelowZero {
            let mine = byAccount[account.id] ?? []
            // AN ACCOUNT WITH NOTHING SCHEDULED IS NOT THIS SCREEN'S BUSINESS,
            // even when it is overdrawn. This is the upcoming-payments screen,
            // and a warning here about an account no schedule touches is a
            // warning in the wrong place -- it belongs on the accounts screen,
            // which shows the figure itself.
            if mine.isEmpty { continue }

            var running = account.balanceTodayMinor
            var alreadyBelow = running < 0
            var crossing: BalanceWarning?

            if alreadyBelow {
                crossing = BalanceWarning(
                    accountId: account.id, accountName: account.name, currency: account.currency,
                    balanceTodayMinor: account.balanceTodayMinor,
                    date: today.iso, projectedMinor: running,
                    occurrenceId: nil, scheduleName: nil,
                    alreadyBelowZero: true, dueCount: mine.count
                )
            }

            // The merged timeline. Facts sort before plans on the same day,
            // which is what `isFact` does in the comparator.
            var timeline: [(date: String, amount: Int64, occurrence: DueOccurrence?)] = []
            for row in account.laterDated where row.date > today.iso && row.date <= through.iso {
                timeline.append((row.date, row.amountMinor, nil))
            }
            for occurrence in mine {
                // An overdue occurrence lands today rather than on its own past
                // date: the projection is about what happens from here.
                timeline.append((max(occurrence.date, today.iso), occurrence.amountMinor, occurrence))
            }
            timeline.sort { a, b in
                if a.date != b.date { return a.date < b.date }
                let aIsFact = a.occurrence == nil
                let bIsFact = b.occurrence == nil
                if aIsFact != bIsFact { return aIsFact }
                return (a.occurrence?.id ?? "") < (b.occurrence?.id ?? "")
            }

            for step in timeline {
                let (next, overflowed) = running.addingReportingOverflow(step.amount)
                if overflowed {
                    throw MoneyError.overflow("projecting the balance of account \(account.id)")
                }
                running = next
                if running < 0, !alreadyBelow {
                    alreadyBelow = true
                    crossing = BalanceWarning(
                        accountId: account.id, accountName: account.name,
                        currency: account.currency,
                        balanceTodayMinor: account.balanceTodayMinor,
                        date: step.date, projectedMinor: running,
                        occurrenceId: step.occurrence?.id,
                        scheduleName: step.occurrence?.scheduleName,
                        // An account that was positive today and is negative
                        // later was taken there by this timeline.
                        alreadyBelowZero: false,
                        dueCount: mine.count
                    )
                }
            }

            if let crossing { out.append(crossing) }
        }
        // Deepest first: the account in the most trouble is the one to read.
        return out.sorted { a, b in
            if a.projectedMinor != b.projectedMinor { return a.projectedMinor < b.projectedMinor }
            return a.accountId < b.accountId
        }
    }
}
