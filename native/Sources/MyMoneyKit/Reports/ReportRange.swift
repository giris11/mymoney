// The date ranges the report screens offer, ported from the web app's
// `presetRange` (src/ui/kit/DateRangePicker.tsx), `matchPreset`
// (src/ui/reports/reportParams.ts) and the two ranges the dashboard cards
// compute inline (src/ui/dashboard/shared.tsx, NetWorthCard.tsx).
//
// WHY THESE ARE IN THE KIT AND NOT IN A VIEW. Every one of them is a RULE
// about which days a figure covers, and a report that covers the wrong days is
// wrong in a way nobody notices: the number is plausible, the label says
// "last 3 months", and it is quietly off by a day. The web app's definitions
// are not the obvious ones --
//
//   * "last 3 months" is `today − 3 months + 1 DAY … today`, so the range is
//     inclusive of both ends and still spans three months rather than three
//     months and a day;
//   * "this month" ends TODAY on the reports picker but at the END OF THE
//     MONTH on the dashboard's cards, and those are two different ranges with
//     the same name;
//   * the net-worth sparkline starts at the beginning of the month FIVE months
//     back, so it covers six calendar months including this one.
//
// -- and each of those is a decision somebody made once. A view that recomputed
// them would recompute them slightly differently, and the phone would disagree
// with the browser about what "this month" spent.
//
// MONTH ARITHMETIC IS `CalendarDate`'s, which is dayjs's: move the month, then
// clamp the day. 31 March − 1 month is 28/29 February, not 3 March. That is
// why `addingMonths` exists and why nothing here reaches for `Calendar`.
import Foundation

/// The preset chips, in the order the web app lists them.
public enum RangePreset: String, Sendable, Hashable, CaseIterable {
    case thisMonth = "this_month"
    case lastMonth = "last_month"
    case last3Months = "last_3_months"
    case last12Months = "last_12_months"
    case thisYear = "this_year"
    case allTime = "all_time"

    /// The chip's label, matching the web app's word for word.
    public var label: String {
        switch self {
        case .thisMonth: return "This month"
        case .lastMonth: return "Last month"
        case .last3Months: return "Last 3 months"
        case .last12Months: return "Last 12 months"
        case .thisYear: return "This year"
        case .allTime: return "All time"
        }
    }
}

extension DateRange {
    /// The range a preset chip means, as of `today`.
    ///
    /// `earliestTransactionDate` is consulted only by `.allTime`, and only
    /// because that range has no closed form: it starts at the first
    /// transaction there is. When the book has none it falls back to the start
    /// of this year, exactly as the TypeScript does -- an empty book gets a
    /// range that is short rather than one that stretches to 1970 and makes
    /// every chart a flat line at zero.
    public static func preset(
        _ preset: RangePreset, today: String, earliestTransactionDate: String? = nil
    ) throws -> DateRange {
        guard let t = CalendarDate(iso: today) else { throw DomainError.invalidDate(today) }
        switch preset {
        case .thisMonth:
            return DateRange(from: t.startOfMonth.iso, to: today)
        case .lastMonth:
            let lastMonth = t.addingMonths(-1)
            return DateRange(from: lastMonth.startOfMonth.iso, to: lastMonth.endOfMonth.iso)
        case .last3Months:
            // − 3 months and then + ONE DAY. Both ends are inclusive, so
            // without the extra day the range would be three months plus one
            // extra day of spending.
            return DateRange(from: t.addingMonths(-3).addingDays(1).iso, to: today)
        case .last12Months:
            return DateRange(from: t.addingMonths(-12).addingDays(1).iso, to: today)
        case .thisYear:
            return DateRange(from: t.startOfYear.iso, to: today)
        case .allTime:
            return DateRange(
                from: earliestTransactionDate ?? t.startOfYear.iso,
                to: today
            )
        }
    }

    /// Which chip should be lit for a range that arrived from somewhere else
    /// (a restored screen, a link, a hand-set pair of dates).
    ///
    /// `.allTime` is deliberately never returned, matching the TypeScript:
    /// recognising it would need the earliest transaction date, this is a pure
    /// comparison, and an all-time range simply reads as custom -- which is
    /// what it is once the owner has scrolled off it.
    public static func matchingPreset(_ range: DateRange, today: String) -> RangePreset? {
        for preset in RangePreset.allCases where preset != .allTime {
            guard let candidate = try? DateRange.preset(preset, today: today) else { continue }
            if candidate == range { return preset }
        }
        return nil
    }

    /// The reports screen's opening range when nothing else says otherwise:
    /// this year to date. (`thisYearRange` in src/ui/pages/Reports.tsx.)
    public static func thisYearToDate(today: String) throws -> DateRange {
        try preset(.thisYear, today: today)
    }

    /// THE DASHBOARD'S "this month", which is NOT the picker's.
    ///
    /// It runs to the END of the calendar month rather than to today
    /// (`thisMonthRange` in src/ui/dashboard/shared.tsx). For income and spend
    /// the two give the same figures -- there are no transactions dated after
    /// today unless the owner entered one -- and where they differ, a future
    /// transaction the owner has already logged SHOULD appear in "this month".
    public static func thisCalendarMonth(today: String) throws -> DateRange {
        guard let t = CalendarDate(iso: today) else { throw DomainError.invalidDate(today) }
        return DateRange(from: t.startOfMonth.iso, to: t.endOfMonth.iso)
    }

    /// The net-worth sparkline's window: the start of the month five months
    /// back, to today -- six calendar months counting this one.
    /// (`sparklineRange` in src/ui/dashboard/NetWorthCard.tsx.)
    public static func lastSixMonths(today: String) throws -> DateRange {
        guard let t = CalendarDate(iso: today) else { throw DomainError.invalidDate(today) }
        return DateRange(from: t.addingMonths(-5).startOfMonth.iso, to: today)
    }
}
