// How often a thing happens, and what that costs in a year.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE ARITHMETIC FACT THIS FILE EXISTS FOR: FORTNIGHTLY IS 26 A YEAR AND
// FOUR-WEEKLY IS 13. They are not the same cadence and they are not the same
// annual cost. A four-weekly £120 bill is £1,560 a year; calling it fortnightly
// makes it £3,120, and calling it monthly makes it £1,440. Every one of those
// is a plausible-looking number, and two of them are wrong.
//
// The multipliers here are WHOLE NUMBERS ON A 364-DAY YEAR: 52 weeks, 26
// fortnights, 13 four-week periods. A calendar year is 365.2425 days, so a
// strictly weekly bill is paid 52.18 times in an average year and this
// understates it by about a fifth of a payment. That is a deliberate choice and
// not an oversight:
//
//   * 52 / 26 / 13 are exactly consistent with each other. 365.2425/7,
//     /14 and /28 are consistent too, but they are 52.18 / 26.09 / 13.04, and
//     an annual figure carrying two decimal places of a payment invites the
//     reader to think the answer is more precise than the thing it describes.
//   * The figure is presented as "about £X a year at this amount", never as a
//     total that was paid. It is a multiplication the owner can do in their
//     head and check, which is the property that matters.
//
// MONTH ARITHMETIC IS `CalendarDate`'s (dayjs's): move the month, then clamp
// the day. A bill on the 31st is expected on the 28th in February and on the
// 31st again in March -- it does not drift to the 3rd, and a series anchored
// after the 28th does not slowly fall out of its own pattern.
import Foundation

/// The rhythms this app can recognise. Not "every N days" in general: these six
/// are the ones a real bill is actually billed on, and offering an inferred
/// "every 19 days" would be fitting noise.
public enum Cadence: String, Sendable, Hashable, CaseIterable {
    case weekly
    case fortnightly
    case fourWeekly = "four_weekly"
    case monthly
    case quarterly
    case annual

    /// How many payments a year. See the file header: whole numbers on a
    /// 364-day year for the week-based ones.
    public var occurrencesPerYear: Int {
        switch self {
        case .weekly: return 52
        case .fortnightly: return 26
        case .fourWeekly: return 13
        case .monthly: return 12
        case .quarterly: return 4
        case .annual: return 1
        }
    }

    /// The gap in days, near enough for ranking and for "how late is this".
    /// NEVER used to compute an expected date -- `date(from:steps:)` is, and it
    /// is calendar-aware where the cadence is.
    public var nominalDays: Int {
        switch self {
        case .weekly: return 7
        case .fortnightly: return 14
        case .fourWeekly: return 28
        case .monthly: return 30
        case .quarterly: return 91
        case .annual: return 365
        }
    }

    /// How far from the expected day a payment may land and still be that
    /// payment.
    ///
    /// Real bills slip. A direct debit due on a Sunday is taken on the Monday;
    /// "the last working day" moves by up to three days; a card payment posted
    /// over a bank holiday weekend can be four. So the tolerance has to be
    /// wide enough to survive a weekend and narrow enough that it cannot reach
    /// the next slot: every value here is comfortably under HALF the cadence's
    /// own period, which is what stops one payment being claimed by two slots.
    public var toleranceDays: Int {
        switch self {
        case .weekly: return 2
        case .fortnightly: return 3
        case .fourWeekly: return 3
        case .monthly: return 4
        case .quarterly: return 7
        case .annual: return 14
        }
    }

    /// The cadence's own name, for a sentence: "billed monthly".
    public var phrase: String {
        switch self {
        case .weekly: return "weekly"
        case .fortnightly: return "every 2 weeks"
        case .fourWeekly: return "every 4 weeks"
        case .monthly: return "monthly"
        case .quarterly: return "every 3 months"
        case .annual: return "yearly"
        }
    }

    /// The chip's label, capitalised.
    public var label: String {
        switch self {
        case .weekly: return "Weekly"
        case .fortnightly: return "Every 2 weeks"
        case .fourWeekly: return "Every 4 weeks"
        case .monthly: return "Monthly"
        case .quarterly: return "Every 3 months"
        case .annual: return "Yearly"
        }
    }

    /// "26 payments a year" -- said out loud on the screen beside every annual
    /// figure, because it is the number the reader has to agree with before the
    /// total means anything.
    public var perYearPhrase: String {
        occurrencesPerYear == 1 ? "1 payment a year" : "\(occurrencesPerYear) payments a year"
    }

    /// The date `steps` periods away from `from`. Negative steps go back.
    ///
    /// WEEK-BASED CADENCES ARE DAY ARITHMETIC and month-based ones are CALENDAR
    /// arithmetic, and that difference is the whole reason this function exists
    /// rather than a `nominalDays * steps`. A four-weekly bill genuinely walks
    /// backwards through the calendar -- 28 days is not a month -- while a
    /// monthly one stays on its day of the month. Treating either as the other
    /// makes a well-behaved series look like a drifting one within a year.
    public func date(from: CalendarDate, steps: Int) -> CalendarDate {
        switch self {
        case .weekly: return from.addingDays(7 * steps)
        case .fortnightly: return from.addingDays(14 * steps)
        case .fourWeekly: return from.addingDays(28 * steps)
        case .monthly: return from.addingMonths(steps)
        case .quarterly: return from.addingMonths(3 * steps)
        case .annual: return from.addingYears(steps)
        }
    }

    /// Is `to` one period after `from`, within tolerance? The question a PAIR
    /// of payments is asked -- two payments have one gap, and one gap is not a
    /// pattern, but it can still be described.
    public func joins(_ from: CalendarDate, _ to: CalendarDate) -> Bool {
        abs(to.daysSince(date(from: from, steps: 1))) <= toleranceDays
    }

    /// The cadence a single gap looks like, or nil.
    ///
    /// NEAREST WINS, and it has to: the tolerance bands of two cadences CAN
    /// overlap even though neither can reach its own next slot. A 31-day gap is
    /// four weeks plus three days and is also exactly one month, and both are
    /// inside their tolerances. Taking the first match in declaration order
    /// would call every monthly bill in a 31-day month "every 4 weeks", which is
    /// wrong 12 times a year and changes the annual figure from 12 payments to
    /// 13.
    ///
    /// So the answer is the cadence whose expected day is CLOSEST to the day the
    /// payment actually landed on, and a tie -- which needs a gap equidistant
    /// between two cadences -- goes to the shorter period, so the answer is
    /// never arbitrary. A gap that is not near any of them gets no name at all.
    public static func matching(from: CalendarDate, to: CalendarDate) -> Cadence? {
        var best: (cadence: Cadence, slip: Int)? = nil
        for cadence in allCases {
            let slip = abs(to.daysSince(cadence.date(from: from, steps: 1)))
            guard slip <= cadence.toleranceDays else { continue }
            if best == nil || slip < best!.slip { best = (cadence, slip) }
        }
        return best?.cadence
    }
}
