// What is due, what it comes to, and the warning the whole feature is for.
//
// EVERY FIGURE, NAME AND ID HERE IS INVENTED. None of it touches a database:
// `Upcoming.plan` is a pure function of some schedules, some accounts and a
// date, which is what makes the interesting cases -- an account that dips below
// zero on the third of five payments, an occurrence whose transaction was
// deleted, a schedule anchored two years before it was set up -- assertable as
// arithmetic instead of as a screenshot.
import Foundation
import Testing

@testable import MyMoneyKit

struct UpcomingTests {

    // MARK: - Fixtures

    static func schedule(
        id: String = "s1",
        name: String = "Rent",
        account: String = "a-current",
        amountMinor: Int64 = -45000,
        payee: String = "Landlord",
        category: String? = "c-home",
        cadence: Cadence = .monthly,
        start: String = "2026-09-03",
        end: ScheduleEnd = .never,
        expectsFrom: String? = nil,
        autoPost: Bool = false,
        autoPostFrom: String? = nil,
        paused: Bool = false,
        remind: Bool = true
    ) -> Schedule {
        Schedule(
            id: id, name: name, accountId: account, amountMinor: amountMinor, payeeName: payee,
            categoryId: category, notes: "", cadence: cadence, startDate: start, end: end,
            expectsFrom: expectsFrom ?? start, autoPost: autoPost, autoPostFrom: autoPostFrom,
            paused: paused, remind: remind, createdAt: "2026-09-01T09:00:00.000Z",
            updatedAt: "2026-09-01T09:00:00.000Z"
        )
    }

    static func account(
        id: String = "a-current",
        name: String = "Everyday",
        type: AccountType = .current,
        currency: String = "GBP",
        balance: Int64 = 100_000,
        later: [DatedAmount] = []
    ) -> ProjectedAccount {
        ProjectedAccount(
            id: id, name: name, type: type, currency: currency, balanceTodayMinor: balance,
            laterDated: later
        )
    }

    private func plan(
        _ schedules: [ScheduleWithDecisions],
        _ accounts: [ProjectedAccount] = [UpcomingTests.account()],
        today: String = "2026-09-02",
        horizon: Int = 30,
        categories: Set<String>? = nil
    ) throws -> UpcomingPlan {
        try Upcoming.plan(
            schedules: schedules, accounts: accounts, today: today, horizonDays: horizon,
            knownCategoryIds: categories
        )
    }

    private func entry(
        _ schedule: Schedule, _ decisions: [String: ScheduleOccurrenceState] = [:]
    ) -> ScheduleWithDecisions {
        ScheduleWithDecisions(schedule: schedule, decisions: decisions)
    }

    // MARK: - What is due

    @Test("the window is today to the horizon, inclusive, and nothing beyond it")
    func windowIsTheHorizon() throws {
        let weekly = Self.schedule(amountMinor: -1200, cadence: .weekly, start: "2026-09-03")
        let result = try plan([entry(weekly)], horizon: 30)
        #expect(
            result.due.map(\.date)
                == ["2026-09-03", "2026-09-10", "2026-09-17", "2026-09-24", "2026-10-01"]
        )
        #expect(result.throughDate == "2026-10-02")
        #expect(result.overdue.isEmpty)

        // A horizon of nothing is today only, which is what the auto-post run
        // asks for.
        let todayOnly = try plan(
            [entry(Self.schedule(cadence: .weekly, start: "2026-09-02"))], horizon: 0
        )
        #expect(todayOnly.due.map(\.date) == ["2026-09-02"])
    }

    @Test("what is dated before today is OVERDUE, oldest first")
    func overdueComesFirst() throws {
        let monthly = Self.schedule(start: "2026-06-03", expectsFrom: "2026-06-03")
        let result = try plan([entry(monthly)])
        #expect(result.overdue.map(\.date) == ["2026-06-03", "2026-07-03", "2026-08-03"])
        #expect(result.overdue.allSatisfy { $0.isOverdue })
        #expect(result.overdue.first?.daysAway == -91)
        // The October one is a day past the 30-day horizon, and is not here.
        #expect(result.due.map(\.date) == ["2026-09-03"])
    }

    @Test("A SCHEDULE ANCHORED IN THE PAST DOES NOT ARRIVE WITH A YEAR OF OVERDUE PAYMENTS")
    func theExpectationFloor() throws {
        // The anchor is 2024 because that is how you get "the 3rd of the
        // month". The app was told about it today, and it does not conclude
        // that twenty-two rent payments are missing.
        let old = Self.schedule(start: "2024-11-03", expectsFrom: "2026-09-02")
        let result = try plan([entry(old)])
        #expect(result.overdue.isEmpty)
        #expect(result.due.map(\.date) == ["2026-09-03"])
        // And the occurrence index is still counted from the real anchor, so a
        // "twelve payments" end still means twelve from 2024.
        #expect(result.due.first?.index == 22)
    }

    @Test("posted and skipped occurrences drop out; one whose transaction went away comes back")
    func decisionsRemoveOccurrences() throws {
        let weekly = Self.schedule(cadence: .weekly, start: "2026-09-03")
        let result = try plan([
            entry(
                weekly,
                [
                    "2026-09-03": .posted(transactionId: "t1"),
                    "2026-09-10": .skipped,
                    "2026-09-17": .postedButGone(transactionId: "t2"),
                ]
            )
        ])
        #expect(result.due.map(\.date) == ["2026-09-17", "2026-09-24", "2026-10-01"])
        // THE ONE THAT MATTERS: it was entered, the transaction is not in the
        // book any more (deleted, or an import replaced the book), so it is due
        // again -- and the row says why rather than looking like a duplicate.
        #expect(result.due.first?.reopened == true)
        #expect(result.due.last?.reopened == false)
    }

    @Test("a paused schedule is not due, and is not a problem either")
    func pausedIsSilent() throws {
        let result = try plan([entry(Self.schedule(paused: true))])
        #expect(result.isEmpty)
        #expect(result.problems.isEmpty)
    }

    // MARK: - Totals

    @Test("totals are per currency, and out and in are never netted into one figure")
    func totalsAreHonest() throws {
        let rent = Self.schedule(id: "s1", name: "Rent", amountMinor: -45000, start: "2026-09-03")
        let salary = Self.schedule(
            id: "s2", name: "Salary", amountMinor: 250_000, start: "2026-09-05"
        )
        let euro = Self.schedule(
            id: "s3", name: "A euro bill", account: "a-euro", amountMinor: -1999,
            start: "2026-09-04"
        )
        let result = try plan(
            [entry(rent), entry(salary), entry(euro)],
            [Self.account(), Self.account(id: "a-euro", name: "Euro", currency: "EUR")]
        )
        #expect(result.totals.count == 2)
        let gbp = try #require(result.totals.first { $0.currency == "GBP" })
        #expect(gbp.outMinor == 45000)
        #expect(gbp.inMinor == 250_000)
        #expect(gbp.count == 2)
        #expect(gbp.netMinor == 205_000)
        let eur = try #require(result.totals.first { $0.currency == "EUR" })
        #expect(eur.outMinor == 1999)
        #expect(eur.inMinor == 0)
        // NO SINGLE FIGURE ACROSS CURRENCIES. Adding 45000 pence to 1999 cents
        // would be a number nobody could check, and converting would need a
        // rate this screen has no business inventing.
        #expect(result.totals.map(\.currency) == ["EUR", "GBP"])
    }

    // MARK: - The warning

    @Test("A SCHEDULED PAYMENT THAT TAKES AN ACCOUNT BELOW ZERO IS NAMED, WITH THE DAY")
    func belowZeroIsNamed() throws {
        // £600 in the account, £450 of rent on the 3rd and a £200 bill on the
        // 10th. The rent is fine; the bill is not.
        let rent = Self.schedule(id: "s1", name: "Rent", amountMinor: -45000, start: "2026-09-03")
        let card = Self.schedule(
            id: "s2", name: "Card bill", amountMinor: -20000, start: "2026-09-10"
        )
        let result = try plan([entry(rent), entry(card)], [Self.account(balance: 60000)])
        let warning = try #require(result.warnings.first)
        #expect(warning.accountName == "Everyday")
        #expect(warning.date == "2026-09-10")
        #expect(warning.projectedMinor == -5000)
        #expect(warning.scheduleName == "Card bill")
        #expect(warning.occurrenceId == "s2@2026-09-10")
        #expect(warning.alreadyBelowZero == false)
        #expect(warning.balanceTodayMinor == 60000)
        #expect(warning.dueCount == 2)
    }

    @Test("A SALARY ALREADY ENTERED FOR NEXT WEEK COUNTS, so the app does not cry wolf")
    func laterDatedTransactionsCount() throws {
        // The same £600 and the same two payments, with a £1,000 salary the
        // owner has already typed in, dated the 5th. Nothing goes below zero,
        // and a projection that ignored entered transactions would have said it
        // did.
        let rent = Self.schedule(id: "s1", name: "Rent", amountMinor: -45000, start: "2026-09-03")
        let card = Self.schedule(
            id: "s2", name: "Card bill", amountMinor: -20000, start: "2026-09-10"
        )
        let account = Self.account(
            balance: 60000, later: [DatedAmount(date: "2026-09-05", amountMinor: 100_000)]
        )
        let result = try plan([entry(rent), entry(card)], [account])
        #expect(result.warnings.isEmpty)
    }

    @Test("an account already below zero is reported as ALREADY below, not blamed on a schedule")
    func alreadyOverdrawn() throws {
        let rent = Self.schedule(amountMinor: -45000, start: "2026-09-03")
        let result = try plan([entry(rent)], [Self.account(balance: -1500)])
        let warning = try #require(result.warnings.first)
        #expect(warning.alreadyBelowZero)
        #expect(warning.occurrenceId == nil)
        #expect(warning.scheduleName == nil)
        #expect(warning.date == "2026-09-02")
        #expect(warning.projectedMinor == -1500)
    }

    @Test("A CREDIT CARD IS NOT WARNED ABOUT, because below zero is where a credit card lives")
    func creditCardsAreNotWarnedAbout() throws {
        let card = Self.schedule(account: "a-card", amountMinor: -45000, start: "2026-09-03")
        let result = try plan(
            [entry(card)],
            [Self.account(id: "a-card", name: "Card", type: .creditCard, balance: -120_000)]
        )
        #expect(result.warnings.isEmpty)
        // The same arrangement on a current account does warn -- so the silence
        // above is about the KIND of account and not about the figures.
        let current = Self.schedule(amountMinor: -45000, start: "2026-09-03")
        #expect(try plan([entry(current)], [Self.account(balance: -120_000)]).warnings.count == 1)
    }

    @Test("an overdue payment is projected as happening now, not ignored for being late")
    func overdueCountsInTheProjection() throws {
        // £500 in the account and a £600 payment that was due last week. It has
        // not happened; it is about to.
        let late = Self.schedule(
            amountMinor: -60000, cadence: .annual, start: "2026-08-26", expectsFrom: "2026-08-26"
        )
        let result = try plan([entry(late)], [Self.account(balance: 50000)])
        let warning = try #require(result.warnings.first)
        #expect(warning.date == "2026-09-02", "an overdue payment lands today in the projection")
        #expect(warning.projectedMinor == -10000)
    }

    @Test("accounts with nothing scheduled are not warned about at all")
    func untouchedAccountsAreSilent() throws {
        let rent = Self.schedule(start: "2026-09-03")
        let result = try plan(
            [entry(rent)],
            [Self.account(balance: 100_000), Self.account(id: "a-other", name: "Other", balance: -5000)]
        )
        #expect(result.warnings.isEmpty)
    }

    @Test("the deepest projected shortfall is listed first")
    func warningsAreOrderedByDepth() throws {
        let one = Self.schedule(id: "s1", account: "a1", amountMinor: -10000, start: "2026-09-03")
        let two = Self.schedule(id: "s2", account: "a2", amountMinor: -90000, start: "2026-09-03")
        let result = try plan(
            [entry(one), entry(two)],
            [
                Self.account(id: "a1", name: "One", balance: 5000),
                Self.account(id: "a2", name: "Two", balance: 5000),
            ]
        )
        #expect(result.warnings.map(\.accountName) == ["Two", "One"])
        #expect(result.warnings.map(\.projectedMinor) == [-85000, -5000])
    }

    // MARK: - Auto-post

    @Test("AUTO-POST CANNOT REACH BACK PAST THE DAY IT WAS SWITCHED ON")
    func autoPostFloor() throws {
        // Switched on today, on a schedule that has been running since June.
        // The three payments it missed are offered for confirmation like any
        // others; only the ones from today forward enter themselves.
        let monthly = Self.schedule(
            cadence: .monthly, start: "2026-06-03", expectsFrom: "2026-06-03",
            autoPost: true, autoPostFrom: "2026-09-02"
        )
        let result = try plan([entry(monthly)])
        #expect(result.overdue.count == 3)
        #expect(result.overdue.allSatisfy { !$0.postsItself })
        #expect(result.autoPosting.map(\.date) == ["2026-09-03"])
    }

    @Test("auto-post with no floor stamped, and a paused schedule, post nothing")
    func autoPostNeedsItsFloor() throws {
        let noFloor = Self.schedule(id: "s1", autoPost: true, autoPostFrom: nil)
        let paused = Self.schedule(id: "s2", autoPost: true, autoPostFrom: "2026-01-01", paused: true)
        let result = try plan([entry(noFloor), entry(paused)])
        #expect(result.autoPosting.isEmpty)
    }

    // MARK: - Problems

    @Test("a schedule whose account is gone is REPORTED, not quietly dropped")
    func missingAccountIsAProblem() throws {
        let orphan = Self.schedule(account: "a-vanished")
        let result = try plan([entry(orphan)])
        #expect(result.due.isEmpty)
        #expect(result.problems.map(\.kind) == [.accountMissing])
        #expect(result.problems.first?.scheduleName == "Rent")
    }

    @Test("a missing category is said BEFORE the owner taps Enter, not after")
    func missingCategoryIsAProblem() throws {
        let result = try plan([entry(Self.schedule(category: "c-gone"))], categories: ["c-home"])
        #expect(result.problems.map(\.kind) == [.categoryMissing])
        // And it is still due: the payment is real, the filing is what is
        // broken.
        #expect(result.due.isEmpty == false)
    }

    @Test("a schedule that has run out says so once")
    func finishedIsAProblem() throws {
        let done = Self.schedule(
            cadence: .monthly, start: "2026-01-03", end: .afterOccurrences(3),
            expectsFrom: "2026-01-03"
        )
        let result = try plan([entry(done)])
        #expect(result.problems.map(\.kind) == [.finished])
        #expect(result.due.isEmpty)
    }

    @Test("unreadable dates are a problem rather than a crash or an empty screen")
    func unreadableDates() throws {
        let broken = Schedule(
            id: "s1", name: "Broken", accountId: "a-current", amountMinor: -100,
            payeeName: "", categoryId: nil, notes: "", cadence: .monthly,
            startDate: "the third", end: .never, expectsFrom: "2026-09-02", autoPost: false,
            autoPostFrom: nil, paused: false, remind: true,
            createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z"
        )
        let result = try plan([entry(broken)])
        #expect(result.problems.map(\.kind) == [.unreadableDates])
    }

    @Test("a today that is not a date is refused, in the words the owner reads")
    func badToday() {
        let error = editError { try Upcoming.plan(schedules: [], accounts: [], today: "2026-13-40") }
        #expect(error == .badDate("2026-13-40"))
    }

    // MARK: - What must never enter itself

    @Test("AN OCCURRENCE THAT CAME BACK IS NEVER ENTERED AUTOMATICALLY, however trusted")
    func reopenedIsNeverAutomatic() throws {
        // Auto-post has been on since June, and the 3 September payment was
        // entered once -- but that transaction is no longer in the book. There
        // are exactly two ways that happens and NEITHER is a reason to write it
        // again without asking:
        //
        //   * the owner deleted it on purpose, and an app that quietly put it
        //     back would be overruling him with his own money;
        //   * a fresh import replaced the book, and the file may well already
        //     contain that payment -- so writing it again makes a duplicate.
        //
        // The owner trusted the SCHEDULE. He did not trust the app to re-enter
        // something that has already been through the book once.
        let monthly = Self.schedule(
            cadence: .monthly, start: "2026-09-03", expectsFrom: "2026-09-01",
            autoPost: true, autoPostFrom: "2026-06-01"
        )
        let decisions: [String: ScheduleOccurrenceState] = [
            "2026-09-03": .postedButGone(transactionId: "t-gone")
        ]
        let result = try plan([entry(monthly, decisions)])
        let occurrence = try #require(result.due.first { $0.date == "2026-09-03" })
        #expect(occurrence.reopened)
        #expect(occurrence.postsItself == false)
        #expect(result.autoPosting.isEmpty)

        // And the NEXT one still enters itself. The refusal is about this
        // occurrence, not about the schedule -- one deleted payment does not
        // switch auto-post off behind the owner's back either.
        let wider = try plan([entry(monthly, decisions)], horizon: 45)
        #expect(wider.autoPosting.map(\.date) == ["2026-10-03"])
    }

    @Test("THE PROJECTION STOPS AT THE HORIZON, so nothing beyond it can raise a warning")
    func projectionStopsAtTheHorizon() throws {
        // A large payment the owner has already entered, dated next June. It is
        // real and it is in the book, and it is not in this window. A warning
        // here naming a date in 2027 -- with no schedule behind it, since no
        // schedule reaches that far -- would be this screen warning about
        // something it is not showing, on a screen whose own footer says it is
        // counting what is scheduled BELOW.
        let far = Self.account(
            balance: 100_000, later: [DatedAmount(date: "2027-06-01", amountMinor: -500_000)]
        )
        let result = try plan([entry(Self.schedule(amountMinor: -1000))], [far])
        #expect(result.due.count == 1)
        #expect(result.warnings.isEmpty)

        // The same payment inside the window DOES warn, so this is a boundary
        // rather than the projection quietly ignoring the book.
        let near = Self.account(
            balance: 100_000, later: [DatedAmount(date: "2026-09-20", amountMinor: -500_000)]
        )
        let warned = try plan([entry(Self.schedule(amountMinor: -1000))], [near])
        #expect(warned.warnings.map(\.date) == ["2026-09-20"])
    }

    @Test("A PAUSED SCHEDULE IS SILENT: not due, and not in the problems either")
    func pausedIsSilentAboutProblemsToo() throws {
        // Each of these is a real problem for a schedule that is RUNNING. A
        // paused one is not running: it will enter nothing, so a row telling
        // the owner to go and fix it is a job with no consequence attached --
        // and a "needs attention" list is worth reading exactly as long as
        // nothing in it can safely be ignored. Unpausing puts every one back.
        let goneAccount = Self.schedule(id: "s1", account: "a-vanished", paused: true)
        let goneCategory = Self.schedule(id: "s2", category: "c-gone", paused: true)
        let unreadable = Schedule(
            id: "s3", name: "Broken", accountId: "a-current", amountMinor: -100,
            payeeName: "", categoryId: nil, notes: "", cadence: .monthly,
            startDate: "the third", end: .never, expectsFrom: "2026-09-02", autoPost: false,
            autoPostFrom: nil, paused: true, remind: true,
            createdAt: "2026-09-01T09:00:00.000Z", updatedAt: "2026-09-01T09:00:00.000Z"
        )
        let result = try plan(
            [entry(goneAccount), entry(goneCategory), entry(unreadable)],
            categories: ["c-home"]
        )
        #expect(result.problems.isEmpty)
        #expect(result.isEmpty)

        // The same three, running, are all three reported -- so the silence
        // above is the pause and not a hole in the checking.
        let running = try plan(
            [
                entry(Self.schedule(id: "s1", account: "a-vanished")),
                entry(Self.schedule(id: "s2", category: "c-gone")),
            ],
            categories: ["c-home"]
        )
        #expect(Set(running.problems.map(\.kind)) == [.accountMissing, .categoryMissing])
    }

}
