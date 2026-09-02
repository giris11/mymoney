// The date ranges the report screens offer.
//
// EVERY EXPECTATION IN THIS FILE IS HAND-CALCULATED. The oracle has no
// date-preset cases -- its 284 cases are about money, balances, budget windows
// and imports -- so each range below was worked out on paper from the
// TypeScript's definition and written down, not read off an implementation.
//
// The cases that matter are the ones where "subtract three months" is not
// obvious: 31 May, 31 March, and a leap February. Those are the days the naive
// implementation gets wrong, and they are the days a real ledger has spending
// on.
import Testing

@testable import MyMoneyKit

struct ReportRangeTests {

    // MARK: - The straightforward day

    /// 2 September 2026: a Wednesday in a 30-day month, chosen because nothing
    /// about it is a special case. If these are wrong, everything is.
    @Test("every preset on an ordinary day, hand-calculated")
    func presetsOnAnOrdinaryDay() throws {
        let today = "2026-09-02"

        #expect(
            try DateRange.preset(.thisMonth, today: today)
                == DateRange(from: "2026-09-01", to: "2026-09-02")
        )
        #expect(
            try DateRange.preset(.lastMonth, today: today)
                == DateRange(from: "2026-08-01", to: "2026-08-31")
        )
        // 2026-09-02 − 3 months = 2026-06-02, + 1 day = 2026-06-03. The extra
        // day is what stops an inclusive range covering three months AND a day.
        #expect(
            try DateRange.preset(.last3Months, today: today)
                == DateRange(from: "2026-06-03", to: "2026-09-02")
        )
        #expect(
            try DateRange.preset(.last12Months, today: today)
                == DateRange(from: "2025-09-03", to: "2026-09-02")
        )
        #expect(
            try DateRange.preset(.thisYear, today: today)
                == DateRange(from: "2026-01-01", to: "2026-09-02")
        )
    }

    @Test("the two dashboard ranges are not the picker's, hand-calculated")
    func dashboardRanges() throws {
        // The picker's "this month" ends TODAY; the dashboard's ends at the end
        // of the month. Two ranges, one name, and the difference is deliberate.
        #expect(
            try DateRange.preset(.thisMonth, today: "2026-09-02")
                == DateRange(from: "2026-09-01", to: "2026-09-02")
        )
        #expect(
            try DateRange.thisCalendarMonth(today: "2026-09-02")
                == DateRange(from: "2026-09-01", to: "2026-09-30")
        )
        // February, so the end is a day the arithmetic has to know about.
        #expect(
            try DateRange.thisCalendarMonth(today: "2026-02-14")
                == DateRange(from: "2026-02-01", to: "2026-02-28")
        )
        #expect(
            try DateRange.thisCalendarMonth(today: "2028-02-14")
                == DateRange(from: "2028-02-01", to: "2028-02-29")
        )
        // Six calendar months INCLUDING this one: April … September.
        #expect(
            try DateRange.lastSixMonths(today: "2026-09-02")
                == DateRange(from: "2026-04-01", to: "2026-09-02")
        )
    }

    // MARK: - The days that break naive month arithmetic

    /// 31 May − 3 months is 28 February, because dayjs clamps the day to the
    /// month it lands in. + 1 day is then 1 March. A port that subtracted 92
    /// days would start the range on 28 February and quietly include three
    /// extra days of spending.
    @Test("31 May, and the clamp that lands in February -- hand-calculated")
    func clampedShortMonth() throws {
        #expect(
            try DateRange.preset(.last3Months, today: "2026-05-31")
                == DateRange(from: "2026-03-01", to: "2026-05-31")
        )
        // 2028 IS a leap year: the clamp lands on the 29th, so + 1 day is
        // still 1 March -- the same start date reached a different way.
        #expect(
            try DateRange.preset(.last3Months, today: "2028-05-31")
                == DateRange(from: "2028-03-01", to: "2028-05-31")
        )
    }

    @Test("\"last month\" from the 31st is the whole of February -- hand-calculated")
    func lastMonthFromTheThirtyFirst() throws {
        // 2026-03-31 − 1 month clamps to 2026-02-28, whose month runs
        // 1–28 February. The clamp must not leak into either end of the range.
        #expect(
            try DateRange.preset(.lastMonth, today: "2026-03-31")
                == DateRange(from: "2026-02-01", to: "2026-02-28")
        )
        #expect(
            try DateRange.preset(.lastMonth, today: "2026-01-15")
                == DateRange(from: "2025-12-01", to: "2025-12-31")
        )
    }

    @Test("the sparkline window starts at a month boundary, never a clamped day")
    func sparklineStartsAtAMonthBoundary() throws {
        // 2026-08-31 − 5 months = 2026-03-31, and the START OF that month is
        // 1 March. Taking the clamped day itself would drop 30 days of the
        // earliest month out of the chart.
        #expect(
            try DateRange.lastSixMonths(today: "2026-08-31")
                == DateRange(from: "2026-03-01", to: "2026-08-31")
        )
    }

    @Test("12 months back across a leap day -- hand-calculated")
    func twelveMonthsAcrossALeapDay() throws {
        // 2028-02-29 − 12 months = 2027-02-28 (2027 is not a leap year),
        // + 1 day = 2027-03-01.
        #expect(
            try DateRange.preset(.last12Months, today: "2028-02-29")
                == DateRange(from: "2027-03-01", to: "2028-02-29")
        )
    }

    // MARK: - All time

    @Test("\"all time\" starts at the first transaction, and says so when there is none")
    func allTime() throws {
        #expect(
            try DateRange.preset(
                .allTime, today: "2026-09-02", earliestTransactionDate: "2019-04-07"
            ) == DateRange(from: "2019-04-07", to: "2026-09-02")
        )
        // An empty book gets THIS YEAR, not 1970. A range back to the epoch
        // would make every chart a flat line at zero with one point on the end.
        #expect(
            try DateRange.preset(.allTime, today: "2026-09-02")
                == DateRange(from: "2026-01-01", to: "2026-09-02")
        )
    }

    // MARK: - Reading a range back

    @Test("every preset is recognised again from its own dates")
    func presetsRoundTrip() throws {
        let today = "2026-09-02"
        for preset in RangePreset.allCases where preset != .allTime {
            let range = try DateRange.preset(preset, today: today)
            #expect(
                DateRange.matchingPreset(range, today: today) == preset,
                "\(preset.rawValue) was not recognised from \(range)"
            )
        }
    }

    /// On 1 January "this month" and "this year" are THE SAME RANGE. The web
    /// app tests them in order and returns the first match, so the chip that
    /// lights is "This month". Reproduced rather than resolved: two chips lit,
    /// or neither, would both be worse than a defensible choice.
    @Test("on 1 January the ambiguous range reads as \"this month\", as the web app does")
    func newYearsDayPrecedence() throws {
        let today = "2026-01-01"
        let thisMonth = try DateRange.preset(.thisMonth, today: today)
        let thisYear = try DateRange.preset(.thisYear, today: today)
        #expect(thisMonth == thisYear)
        #expect(DateRange.matchingPreset(thisMonth, today: today) == .thisMonth)
    }

    @Test("a range nobody offered is not claimed as a preset")
    func customRangeMatchesNothing() {
        #expect(
            DateRange.matchingPreset(
                DateRange(from: "2026-03-14", to: "2026-07-09"), today: "2026-09-02"
            ) == nil
        )
        // An all-time range reads as custom, deliberately: recognising it would
        // need the earliest transaction date, which this pure function does not
        // have.
        #expect(
            DateRange.matchingPreset(
                DateRange(from: "2019-04-07", to: "2026-09-02"), today: "2026-09-02"
            ) == nil
        )
    }

    @Test("a date that is not a date is refused, never rolled to a nearby one")
    func invalidDatesAreRefused() {
        #expect(throws: DomainError.invalidDate("2026-02-30")) {
            try DateRange.preset(.thisMonth, today: "2026-02-30")
        }
        #expect(throws: DomainError.invalidDate("not a date")) {
            try DateRange.thisCalendarMonth(today: "not a date")
        }
        #expect(throws: DomainError.invalidDate("")) {
            try DateRange.lastSixMonths(today: "")
        }
    }
}
