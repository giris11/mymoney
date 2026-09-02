// The occurrence arithmetic, including the February that eats schedules.
//
// EVERY FIGURE HERE IS INVENTED, and none of it needs a database: turning a
// schedule into dates is a pure function of a cadence, an anchor and an end,
// which is exactly why it is the part worth proving hardest. A wrong date here
// is a payment on the wrong day, and after a year of them it is a schedule that
// no longer describes the arrangement it was set up for.
import Foundation
import Testing

@testable import MyMoneyKit

struct ScheduleCalendarTests {

    private func day(_ iso: String) -> CalendarDate {
        guard let date = CalendarDate(iso: iso) else {
            Issue.record("\(iso) is not a date")
            return CalendarDate(epochDay: 0)
        }
        return date
    }

    private func calendar(
        _ cadence: Cadence, _ start: String, _ end: ScheduleEnd = .never
    ) -> ScheduleCalendar {
        ScheduleCalendar(cadence: cadence, start: day(start), end: end)
    }

    // MARK: - The 31st

    @Test("MONTHLY ON THE 31ST IS THE LAST DAY OF EVERY MONTH, and comes back to the 31st")
    func monthlyOnTheThirtyFirst() {
        let schedule = calendar(.monthly, "2026-01-31")
        let dates = (0..<13).map { schedule.date(at: $0)?.iso }
        #expect(
            dates == [
                "2026-01-31",
                "2026-02-28",  // February takes what it can hold...
                "2026-03-31",  // ...and March gets the 31st back.
                "2026-04-30",
                "2026-05-31",
                "2026-06-30",
                "2026-07-31",
                "2026-08-31",
                "2026-09-30",
                "2026-10-31",
                "2026-11-30",
                "2026-12-31",
                "2027-01-31",
            ]
        )
    }

    @Test("a leap February gets the 29th, and the schedule still returns to the 31st")
    func leapFebruary() {
        let schedule = calendar(.monthly, "2028-01-31")
        #expect(schedule.date(at: 1)?.iso == "2028-02-29")
        #expect(schedule.date(at: 2)?.iso == "2028-03-31")
    }

    @Test("THE REJECTED ALTERNATIVE: stepping from the previous occurrence loses the 31st for ever")
    func steppingFromThePreviousDateRots() {
        // This is not how `ScheduleCalendar` works, and this test exists to
        // show what it would cost if it did. One clamp is harmless; a clamp fed
        // back into the next calculation is permanent.
        var walked = day("2026-01-31")
        var stepped: [String] = [walked.iso]
        for _ in 0..<4 {
            walked = Cadence.monthly.date(from: walked, steps: 1)
            stepped.append(walked.iso)
        }
        #expect(
            stepped == ["2026-01-31", "2026-02-28", "2026-03-28", "2026-04-28", "2026-05-28"],
            "step-by-step arithmetic turns a payment on the 31st into a payment on the 28th"
        )

        // Anchored, which is what the schedule actually does.
        let schedule = calendar(.monthly, "2026-01-31")
        #expect(
            (0..<5).map { schedule.date(at: $0)!.iso }
                == ["2026-01-31", "2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"]
        )
    }

    @Test("the 29th and the 30th clamp in February too, and nowhere else")
    func otherLateDays() {
        #expect(calendar(.monthly, "2027-01-29").date(at: 1)?.iso == "2027-02-28")
        #expect(calendar(.monthly, "2027-01-30").date(at: 1)?.iso == "2027-02-28")
        #expect(calendar(.monthly, "2027-01-30").date(at: 2)?.iso == "2027-03-30")
        #expect(calendar(.monthly, "2027-01-28").date(at: 1)?.iso == "2027-02-28")
    }

    // MARK: - The other cadences

    @Test("week-based cadences keep the weekday; month-based ones keep the day of the month")
    func weekAndMonthArithmeticDiffer() {
        let weekly = calendar(.weekly, "2026-09-03")
        #expect(weekly.date(at: 4)?.iso == "2026-10-01")
        let fortnightly = calendar(.fortnightly, "2026-09-03")
        #expect(fortnightly.date(at: 2)?.iso == "2026-10-01")
        // FOUR-WEEKLY IS NOT MONTHLY, and this is what that looks like on a
        // calendar: it walks backwards through the month, thirteen times a year.
        let fourWeekly = calendar(.fourWeekly, "2026-01-31")
        #expect(
            (0..<4).map { fourWeekly.date(at: $0)!.iso }
                == ["2026-01-31", "2026-02-28", "2026-03-28", "2026-04-25"]
        )
        let monthly = calendar(.monthly, "2026-01-31")
        #expect(monthly.date(at: 3)?.iso == "2026-04-30")
    }

    @Test("quarterly clamps once and recovers, and annual keeps a leap day's anchor")
    func quarterlyAndAnnual() {
        let quarterly = calendar(.quarterly, "2026-11-30")
        #expect(
            (0..<4).map { quarterly.date(at: $0)!.iso }
                == ["2026-11-30", "2027-02-28", "2027-05-30", "2027-08-30"]
        )
        let annual = calendar(.annual, "2028-02-29")
        #expect(annual.date(at: 1)?.iso == "2029-02-28")
        // Anchored arithmetic gets the 29th back in the next leap year. Stepping
        // would have lost it in 2029 and never found it again.
        #expect(annual.date(at: 4)?.iso == "2032-02-29")
    }

    @Test("THE DATES ARE `Cadence`'s, NOT A SECOND IMPLEMENTATION OF THEM")
    func everyDateComesFromCadence() {
        // The property the whole design rests on: this file adds an end and a
        // search, and NOTHING else. If a future edit computes a date here, this
        // fails.
        let start = day("2026-01-31")
        for cadence in Cadence.allCases {
            let schedule = ScheduleCalendar(cadence: cadence, start: start)
            for index in 0..<25 {
                #expect(
                    schedule.date(at: index) == cadence.date(from: start, steps: index),
                    "\(cadence.rawValue) occurrence \(index) is not Cadence's answer"
                )
            }
        }
    }

    // MARK: - Where it stops

    @Test("an end date ON an occurrence includes it; one between occurrences does not extend")
    func endDateIsInclusive() {
        let onIt = calendar(.monthly, "2026-01-31", .onDate("2026-04-30"))
        #expect(onIt.lastIndex == 3)
        #expect(onIt.date(at: 3)?.iso == "2026-04-30")
        #expect(onIt.date(at: 4) == nil)

        let between = calendar(.monthly, "2026-01-31", .onDate("2026-05-15"))
        #expect(between.lastIndex == 3)
        #expect(between.finalDate?.iso == "2026-04-30")
    }

    @Test("a count ends the series at exactly that many payments")
    func countedEnd() {
        let twelve = calendar(.monthly, "2026-03-15", .afterOccurrences(12))
        #expect(twelve.lastIndex == 11)
        #expect(twelve.date(at: 11)?.iso == "2027-02-15")
        #expect(twelve.date(at: 12) == nil)
        #expect(twelve.finalDate?.iso == "2027-02-15")
    }

    @Test("an end before the start is a schedule with nothing in it, not a schedule with one")
    func endBeforeStart() {
        let backwards = calendar(.monthly, "2026-03-15", .onDate("2026-01-01"))
        #expect(backwards.isEmpty)
        #expect(backwards.date(at: 0) == nil)
        #expect(
            backwards.occurrences(from: day("2020-01-01"), through: day("2030-01-01")).isEmpty
        )
    }

    @Test("AN UNREADABLE END DATE STOPS THE SCHEDULE rather than making it eternal")
    func unreadableEndDateFailsSafe() {
        // Cannot be written through `saveSchedule`, so this is about a row that
        // arrived some other way. Of the two ways to be wrong, an empty list is
        // visible and a schedule that never stops is not.
        let broken = calendar(.monthly, "2026-03-15", .onDate("not a date"))
        #expect(broken.isEmpty)
        #expect(broken.date(at: 0) == nil)
    }

    @Test("a negative index is not an occurrence -- schedules do not run backwards")
    func noNegativeOccurrences() {
        #expect(calendar(.monthly, "2026-03-15").date(at: -1) == nil)
    }

    // MARK: - Finding a date

    @Test("the index of a date is exact after decades, where an estimate would drift")
    func indexSearchIsExact() {
        // A monthly schedule anchored on the 31st in 1994. `nominalDays` is 30
        // for monthly, so an estimate-and-walk would be dozens of steps out by
        // now -- and a schedule that is dozens of steps out is one showing the
        // wrong day.
        let old = calendar(.monthly, "1994-01-31")
        // 32 years and 8 months of occurrences: 32 * 12 + 8 = 392.
        let index = old.firstIndex(onOrAfter: day("2026-09-02"))
        #expect(index == 392)
        #expect(old.date(at: 392)?.iso == "2026-09-30")
        #expect(old.date(at: 391)?.iso == "2026-08-31")

        // And the exact-match question, which is what a stored decision is
        // checked against.
        #expect(old.index(on: day("2026-09-30")) == 392)
        #expect(old.index(on: day("2026-09-29")) == nil)
    }

    @Test("a target before the start is occurrence 0, not a negative index")
    func targetBeforeStart() {
        let schedule = calendar(.weekly, "2026-09-03")
        #expect(schedule.firstIndex(onOrAfter: day("2020-01-01")) == 0)
    }

    @Test("a search that could run for ever stops at the cap instead")
    func searchTerminates() {
        // Past the millionth weekly occurrence, which is nineteen thousand
        // years. A date like this cannot be TYPED -- `CalendarDate(iso:)` takes
        // four digits of year -- but it can be arrived at by arithmetic, and
        // the promise being kept here is termination rather than accuracy: a
        // bounded wrong answer instead of a phone with its CPU flat.
        let schedule = calendar(.weekly, "2026-09-03")
        let absurd = CalendarDate(epochDay: 400_000_000)
        #expect(schedule.firstIndexRaw(onOrAfter: absurd) == ScheduleCalendar.indexCap)
    }

    @Test("a window returns the occurrences inside it, inclusive at both ends")
    func windows() {
        let schedule = calendar(.monthly, "2026-01-31")
        let window = schedule.occurrences(from: day("2026-02-28"), through: day("2026-05-31"))
        #expect(window.map(\.date.iso) == ["2026-02-28", "2026-03-31", "2026-04-30", "2026-05-31"])
        #expect(window.map(\.index) == [1, 2, 3, 4])

        // A window entirely before the schedule starts, and one entirely after
        // it ends.
        #expect(schedule.occurrences(from: day("2025-01-01"), through: day("2025-12-31")).isEmpty)
        let ended = calendar(.monthly, "2026-01-31", .afterOccurrences(2))
        #expect(ended.occurrences(from: day("2026-01-01"), through: day("2027-01-01")).count == 2)
    }

    @Test("a backwards window is empty rather than an infinite one")
    func backwardsWindow() {
        let schedule = calendar(.monthly, "2026-01-31")
        #expect(schedule.occurrences(from: day("2026-05-31"), through: day("2026-02-28")).isEmpty)
    }

    // MARK: - From a detected pattern

    @Test("A SCHEDULE MADE FROM A DETECTED PATTERN FALLS ON THE DAY THE DETECTOR PREDICTED")
    func fromASeries() throws {
        // The property that makes "one cadence arithmetic" more than a
        // sentence: the insights screen says a payment is next expected on a
        // day, and the schedule made from it must fall on exactly that day.
        let report = try Insights.report(book: DemoBookTests.book(), today: "2026-09-02")
        let patterns = report.recurring.filter { $0.confidence != .pair }
        #expect(!patterns.isEmpty, "the demo book must contain detected patterns")

        for series in patterns {
            let draft = try #require(ScheduleDraft.from(series: series, today: "2026-09-02"))
            #expect(draft.cadence == series.cadence)
            // The detector never looks at money in, so the amount is a payment.
            #expect(draft.amountMinor == -series.typicalAmountMinor)
            #expect(draft.amountMinor < 0)
            #expect(draft.startDate == series.lastDate)

            let anchor = try #require(CalendarDate(iso: draft.startDate))
            let calendar = ScheduleCalendar(
                cadence: draft.cadence, start: anchor, end: draft.end
            )
            #expect(
                calendar.date(at: 1)?.iso == series.nextExpectedDate,
                "\(series.payeeName): the schedule's next date is not the one the screen showed"
            )
        }
    }

    @Test("two payments do not become a schedule, because they did not become a prediction")
    func aPairIsNotOfferedAsASchedule() throws {
        let report = try Insights.report(book: DemoBookTests.book(), today: "2026-09-02")
        for pair in report.pairs {
            #expect(pair.nextExpectedDate == nil)
            #expect(
                ScheduleDraft.from(series: pair, today: "2026-09-02") == nil,
                "a pair produced a schedule, inventing the prediction the detector refused to make"
            )
        }
    }

    // MARK: - Moving the grid under decisions already taken

    @Test("MOVING A SCHEDULE'S DATES SAYS WHICH DECISIONS WOULD FALL OFF THE GRID")
    func datesLeavingTheGrid() throws {
        // Changing the cadence or the anchor moves every occurrence. The
        // decisions already taken -- entered, skipped -- were about dates on
        // the OLD grid, and the ones the new grid does not fall on become
        // orphans: still the owner's, still shown, and no longer attached to
        // anything the schedule will do again. That is worth being told BEFORE
        // saving rather than discovering afterwards in the history.
        let third = ScheduleCalendar(
            cadence: .monthly, start: try #require(CalendarDate(iso: "2026-03-03"))
        )
        let fifth = ScheduleCalendar(
            cadence: .monthly, start: try #require(CalendarDate(iso: "2026-03-05"))
        )
        let taken = ["2026-03-03", "2026-04-03", "2026-05-03"]
        #expect(third.datesOffTheGrid(taken).isEmpty)
        #expect(fifth.datesOffTheGrid(taken) == taken)

        // A cadence change keeps the anchor and loses what fell between.
        let quarterly = ScheduleCalendar(
            cadence: .quarterly, start: try #require(CalendarDate(iso: "2026-03-03"))
        )
        #expect(quarterly.datesOffTheGrid(taken) == ["2026-04-03", "2026-05-03"])

        // An end date that stops the series before a decision was taken puts
        // that decision off the grid too -- it is no longer an occurrence.
        let stopped = ScheduleCalendar(
            cadence: .monthly, start: try #require(CalendarDate(iso: "2026-03-03")),
            end: .onDate("2026-04-03")
        )
        #expect(stopped.datesOffTheGrid(taken) == ["2026-05-03"])

        // Something that is not a date is off the grid rather than a crash.
        #expect(third.datesOffTheGrid(["the third"]) == ["the third"])
    }

}
