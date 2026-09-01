// What the oracle cannot reach about calendar arithmetic.
//
// The fixtures sample the window grid at the dates a human thought to write
// down — the 31st across February, a leap-day anniversary, a week two and a
// half years out. What they cannot state is the PROPERTY those samples are
// evidence for: that the windows tile the timeline with no gaps and no
// overlaps, for every date, for years on end. That property is what makes a
// budget mean anything, and it is checked here by exhaustion rather than by
// example.
import Testing

@testable import MyMoneyKit

struct CalendarDateTests {
    @Test("every day of a decade survives the epoch-day round trip")
    func epochDayRoundTrip() {
        var date = CalendarDate(iso: "2020-01-01")!
        for _ in 0..<3653 {
            #expect(CalendarDate(epochDay: date.epochDay) == date)
            date = date.addingDays(1)
        }
        // And the anchors the arithmetic is built on.
        #expect(CalendarDate(iso: "1970-01-01")!.epochDay == 0)
        #expect(CalendarDate(iso: "1969-12-31")!.epochDay == -1)
        #expect(CalendarDate(epochDay: -719_468).iso == "0000-03-01")
    }

    @Test("a date that is not a real day is refused, not rounded to a nearby one")
    func impossibleDatesAreRefused() {
        #expect(CalendarDate(iso: "2026-02-30") == nil)
        #expect(CalendarDate(iso: "2023-02-29") == nil)
        #expect(CalendarDate(iso: "2024-02-29") != nil)  // …and a real leap day is not
        #expect(CalendarDate(iso: "2026-13-01") == nil)
        #expect(CalendarDate(iso: "2026-00-10") == nil)
        #expect(CalendarDate(iso: "2026-1-01") == nil)   // padding is part of the format
        #expect(CalendarDate(iso: "not a date") == nil)
        #expect(CalendarDate(iso: "2026-01-0١") == nil)  // a non-ASCII digit is not a digit
    }

    @Test("month arithmetic clamps and never accumulates its clamping")
    func monthClamping() {
        let jan31 = CalendarDate(iso: "2024-01-31")!
        #expect(jan31.addingMonths(1).iso == "2024-02-29")  // leap
        #expect(jan31.addingMonths(2).iso == "2024-03-31")  // the anchor day returns
        #expect(jan31.addingMonths(13).iso == "2025-02-28") // non-leap
        #expect(CalendarDate(iso: "2023-01-31")!.addingMonths(1).iso == "2023-02-28")
        // Backwards across a year boundary, where truncating division would
        // land in the wrong year.
        #expect(jan31.addingMonths(-1).iso == "2023-12-31")
        #expect(jan31.addingMonths(-13).iso == "2022-12-31")
        #expect(CalendarDate(iso: "2024-02-29")!.addingYears(1).iso == "2025-02-28")
        #expect(CalendarDate(iso: "2024-02-29")!.addingYears(4).iso == "2028-02-29")
    }

    @Test("century leap years are the Gregorian ones, not the divisible-by-four ones")
    func centuryLeapYears() {
        #expect(CalendarDate.isLeapYear(2000))
        #expect(!CalendarDate.isLeapYear(1900))
        #expect(!CalendarDate.isLeapYear(2100))
        #expect(CalendarDate(iso: "2000-02-29") != nil)
        #expect(CalendarDate(iso: "1900-02-29") == nil)
    }
}

struct BudgetWindowGridTests {
    /// Every date in a long span falls in EXACTLY ONE window, and consecutive
    /// windows touch with no day in between.
    ///
    /// This is the property the whole `windowContaining` design exists to
    /// guarantee, and it is the one a naive "add a month to both ends"
    /// implementation breaks silently: a day that falls in no window vanishes
    /// from every budget, and a day in two windows is counted twice.
    func assertTiles(period: BudgetPeriod, anchor: String, from: String, days: Int) throws {
        var date = CalendarDate(iso: from)!
        var previous: PeriodWindow? = nil
        for _ in 0..<days {
            let w = try Budgets.windowContaining(period: period, startDate: anchor, date: date.iso)
            #expect(w.contains(date.iso), "\(date.iso) is not inside its own window \(w.start)…\(w.end)")
            #expect(w.start <= w.end, "window \(w.start)…\(w.end) is inside out")
            if let previous, previous != w {
                // The new window must start the day after the old one ended:
                // no gap, no overlap.
                #expect(
                    CalendarDate(iso: previous.end)!.addingDays(1).iso == w.start,
                    "gap or overlap between \(previous.end) and \(w.start)"
                )
            }
            previous = w
            date = date.addingDays(1)
        }
    }

    @Test("monthly windows anchored on the 31st tile ten years without a gap")
    func monthlyTiling() throws {
        try assertTiles(period: .monthly, anchor: "2024-01-31", from: "2022-01-01", days: 3653)
    }

    @Test("weekly and yearly grids tile too, including before the anchor")
    func weeklyAndYearlyTiling() throws {
        try assertTiles(period: .weekly, anchor: "2025-01-06", from: "2023-06-01", days: 1000)
        try assertTiles(period: .yearly, anchor: "2024-02-29", from: "2020-01-01", days: 3000)
    }

    /// Shifting by n and back by n is the identity — on a clamped window, which
    /// is where date arithmetic on the ENDS would drift.
    @Test("shifting a window out and back returns it unchanged, every month for a decade")
    func shiftRoundTrips() throws {
        let anchor = "2024-01-31"
        var window = try Budgets.windowContaining(period: .monthly, startDate: anchor, date: anchor)
        for n in 1...120 {
            let forward = try Budgets.shiftWindow(
                period: .monthly, startDate: anchor, window: window, by: n
            )
            let back = try Budgets.shiftWindow(
                period: .monthly, startDate: anchor, window: forward, by: -n
            )
            #expect(back == window, "shift by \(n) and back did not return \(window)")
            window = try Budgets.shiftWindow(period: .monthly, startDate: anchor, window: window, by: 1)
        }
    }

    @Test("a budget anchored on an impossible date is refused, not silently moved")
    func invalidAnchorIsRefused() {
        #expect(throws: DomainError.invalidDate("2026-02-30")) {
            try Budgets.windowContaining(period: .monthly, startDate: "2026-02-30", date: "2026-03-01")
        }
        #expect(throws: DomainError.invalidDate("nonsense")) {
            try Budgets.windowContaining(period: .weekly, startDate: "2026-03-01", date: "nonsense")
        }
    }
}
