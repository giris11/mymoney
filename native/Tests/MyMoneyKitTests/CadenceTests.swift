// The multipliers, and the calendar.
//
// EVERY EXPECTATION IN THIS FILE IS HAND-CALCULATED. The oracle has no cadence
// cases -- it is about money, balances, budget windows and imports -- so each
// figure below was worked out on paper and written down, with the sum in the
// comment beside it.
//
// The first suite is the one that matters most in the whole insights layer: if
// fortnightly and four-weekly are not 26 and 13, then every annual figure on
// the screen is wrong, and wrong by an amount that looks entirely plausible.
import Testing

@testable import MyMoneyKit

struct CadenceTests {

    // MARK: - Annualisation

    @Test("26 and 13 are different numbers, hand-calculated")
    func fortnightlyIsNotFourWeekly() {
        #expect(Cadence.fortnightly.occurrencesPerYear == 26)
        #expect(Cadence.fourWeekly.occurrencesPerYear == 13)

        // A £120 bill. 120 × 13 = £1,560 four-weekly; 120 × 26 = £3,120
        // fortnightly; 120 × 12 = £1,440 monthly. Three plausible answers to
        // "what does this cost me a year", and two of them are wrong.
        let bill: Int64 = 12_000
        #expect(bill * Int64(Cadence.fourWeekly.occurrencesPerYear) == 156_000)
        #expect(bill * Int64(Cadence.fortnightly.occurrencesPerYear) == 312_000)
        #expect(bill * Int64(Cadence.monthly.occurrencesPerYear) == 144_000)
    }

    @Test("every multiplier, hand-calculated")
    func multipliers() {
        #expect(Cadence.weekly.occurrencesPerYear == 52)
        #expect(Cadence.fortnightly.occurrencesPerYear == 26)
        #expect(Cadence.fourWeekly.occurrencesPerYear == 13)
        #expect(Cadence.monthly.occurrencesPerYear == 12)
        #expect(Cadence.quarterly.occurrencesPerYear == 4)
        #expect(Cadence.annual.occurrencesPerYear == 1)

        // The week-based three are consistent with each other on a 364-day
        // year: 52 weeks = 26 fortnights = 13 four-week periods.
        #expect(52 * 7 == 364)
        #expect(26 * 14 == 364)
        #expect(13 * 28 == 364)
    }

    @Test("no tolerance can reach its own next slot")
    func tolerancesCannotReachTheNextSlot() {
        // If a tolerance were half a period or more, one payment could satisfy
        // two slots of the SAME cadence and the whole grid would stop meaning
        // anything. (Two DIFFERENT cadences can overlap -- 31 days is four
        // weeks plus three and also one month -- which is why `matching` takes
        // the nearest rather than the first.)
        for cadence in Cadence.allCases {
            #expect(
                cadence.toleranceDays * 2 < cadence.nominalDays,
                "\(cadence) tolerance \(cadence.toleranceDays) vs period \(cadence.nominalDays)"
            )
        }
    }

    // MARK: - The calendar

    @Test("a monthly bill on the 31st, hand-calculated")
    func monthlyClampsTheDay() throws {
        let jan31 = try #require(CalendarDate(iso: "2026-01-31"))
        // dayjs semantics, which CalendarDate reproduces: move the month, then
        // clamp. 31 Jan + 1 month is 28 Feb in 2026, and + 2 months is 31 Mar
        // -- the clamp does not stick, because both are measured from the same
        // anchor.
        #expect(Cadence.monthly.date(from: jan31, steps: 1).iso == "2026-02-28")
        #expect(Cadence.monthly.date(from: jan31, steps: 2).iso == "2026-03-31")
        #expect(Cadence.monthly.date(from: jan31, steps: 3).iso == "2026-04-30")
    }

    @Test("four-weekly walks backwards through the calendar, hand-calculated")
    func fourWeeklyIsNotMonthly() throws {
        let jan31 = try #require(CalendarDate(iso: "2026-01-31"))
        // 31 Jan + 28 days = 28 Feb (31 Jan + 28 = 28 Feb, because January has
        // 31 days: 31 + 28 = 59, and 59 − 31 = 28 February). The same as the
        // monthly answer, by coincidence, this once.
        #expect(Cadence.fourWeekly.date(from: jan31, steps: 1).iso == "2026-02-28")
        // And then they part company: +56 days is 28 March, not 31 March.
        #expect(Cadence.fourWeekly.date(from: jan31, steps: 2).iso == "2026-03-28")
        #expect(Cadence.fourWeekly.date(from: jan31, steps: 3).iso == "2026-04-25")
    }

    @Test("a yearly bill on 29 February, hand-calculated")
    func annualClamps() throws {
        let leapDay = try #require(CalendarDate(iso: "2028-02-29"))
        #expect(Cadence.annual.date(from: leapDay, steps: 1).iso == "2029-02-28")
        // And back to the 29th at the next leap year, because every step is
        // measured from the anchor rather than from the last answer.
        #expect(Cadence.annual.date(from: leapDay, steps: 4).iso == "2032-02-29")
    }

    @Test("steps go backwards too, hand-calculated")
    func negativeSteps() throws {
        let march31 = try #require(CalendarDate(iso: "2026-03-31"))
        #expect(Cadence.monthly.date(from: march31, steps: -1).iso == "2026-02-28")
        #expect(Cadence.weekly.date(from: march31, steps: -1).iso == "2026-03-24")
        #expect(Cadence.quarterly.date(from: march31, steps: -1).iso == "2025-12-31")
    }

    // MARK: - Naming a single gap

    @Test("one gap gets one name, or none")
    func matchingASingleGap() throws {
        let day = try #require(CalendarDate(iso: "2026-03-02"))

        #expect(Cadence.matching(from: day, to: day.addingDays(7)) == .weekly)
        #expect(Cadence.matching(from: day, to: day.addingDays(14)) == .fortnightly)
        // 28 days lands exactly on the four-weekly day and three days early for
        // monthly, so the nearer one wins.
        #expect(Cadence.matching(from: day, to: day.addingDays(28)) == .fourWeekly)
        // 2 March + 1 month = 2 April, which is 31 days later -- exact for
        // monthly, three days late for four-weekly. THE ONE THAT WOULD BE
        // WRONG TWELVE TIMES A YEAR if the first match won instead of the
        // nearest.
        #expect(Cadence.matching(from: day, to: day.addingDays(31)) == .monthly)
        #expect(Cadence.matching(from: day, to: day.addingDays(91)) == .quarterly)
        #expect(Cadence.matching(from: day, to: day.addingDays(365)) == .annual)

        // 19 days is not a cadence anybody bills on. Refused rather than
        // rounded to the nearest one.
        #expect(Cadence.matching(from: day, to: day.addingDays(19)) == nil)
        // And 45 days, which is between four-weekly and monthly and is neither.
        #expect(Cadence.matching(from: day, to: day.addingDays(45)) == nil)
    }

    @Test("a weekend slip still has the same name")
    func slipIsToleratedWhenNamingAGap() throws {
        let friday = try #require(CalendarDate(iso: "2026-03-06"))
        // A monthly bill due 6 April taken on the 8th: two days late, still
        // monthly.
        #expect(Cadence.matching(from: friday, to: friday.addingDays(33)) == .monthly)
        // Five days late is past the monthly tolerance of four, and this
        // function has only one gap to go on -- so it says nothing rather than
        // guessing. A SERIES tolerates more, because it has other gaps to
        // corroborate.
        #expect(Cadence.matching(from: friday, to: friday.addingDays(36)) == nil)
    }
}
