// A calendar date, and only a calendar date.
//
// WHY NOT `Date` (OR `Calendar`, OR `DateComponents`). A `Date` is an instant
// on a timeline, and an instant has a timezone. Every money rule in this
// package that touches a date -- which budget window a transaction falls in,
// which month a report row belongs to, whether a near-duplicate is within a
// day -- is a question about the CALENDAR, and answering it through an instant
// is how a transaction dated the 1st becomes the 31st of the previous month
// when the phone is in Sydney. That bug moves money between budget periods and
// between tax years, silently, and only for people who travel.
//
// So this type is three integers. It has no timezone because there is nothing
// for a timezone to do. `Foundation.Calendar` is not used at all: it is
// locale-sensitive (a Persian or Buddhist calendar is a legitimate user
// setting, and would give different answers for the same ledger), and the
// TypeScript this is ported from uses dayjs, which is proleptic Gregorian
// always.
//
// WHAT IT REPRODUCES, AND WHY THAT PARTICULAR BEHAVIOUR. `addingMonths` and
// `addingYears` clamp the day to the length of the target month, because that
// is what dayjs does (`$set` sets the day to 1, moves the month, then takes
// `min(originalDay, daysInMonth)`), and because `src/domain/budgets.ts` leans
// on the clamping to make budget windows tile the timeline with no gaps: both
// ends of a window derive from the SAME anchor, so 31 Jan + 1 month = 28/29
// Feb never accumulates into drift. Changing the clamp would silently move
// every monthly budget window anchored after the 28th.
import Foundation

/// A proleptic-Gregorian calendar date. Comparable in the obvious order, which
/// is also the lexicographic order of its ISO string -- the TypeScript compares
/// 'YYYY-MM-DD' strings directly in places, and the two orders agreeing is what
/// makes that safe.
public struct CalendarDate: Sendable, Hashable, Comparable, CustomStringConvertible {
    public let year: Int
    public let month: Int  // 1...12
    public let day: Int    // 1...daysInMonth

    /// Fails for anything that is not a real date: "2026-02-30", "2026-13-01",
    /// "not a date". A refusal, never a nearest guess -- see
    /// `Import.parseDateString`, which is the one place a bad date is allowed
    /// to arrive and where it becomes a row error rather than a wrong day.
    public init?(iso: String) {
        let parts = iso.split(separator: "-", omittingEmptySubsequences: false)
        guard parts.count == 3,
              parts[0].count == 4, parts[1].count == 2, parts[2].count == 2,
              parts.allSatisfy({ $0.allSatisfy { $0.isASCII && $0.isNumber } }),
              let y = Int(parts[0]), let m = Int(parts[1]), let d = Int(parts[2])
        else { return nil }
        self.init(year: y, month: m, day: d)
    }

    public init?(year: Int, month: Int, day: Int) {
        guard month >= 1, month <= 12 else { return nil }
        guard day >= 1, day <= Self.daysInMonth(year: year, month: month) else { return nil }
        self.year = year
        self.month = month
        self.day = day
    }

    /// Internal, total constructor for arithmetic that has already clamped.
    private init(unchecked year: Int, _ month: Int, _ day: Int) {
        self.year = year
        self.month = month
        self.day = day
    }

    public static func isLeapYear(_ y: Int) -> Bool {
        (y % 4 == 0 && y % 100 != 0) || y % 400 == 0
    }

    public static func daysInMonth(year: Int, month: Int) -> Int {
        switch month {
        case 1, 3, 5, 7, 8, 10, 12: return 31
        case 4, 6, 9, 11: return 30
        case 2: return isLeapYear(year) ? 29 : 28
        default: return 0
        }
    }

    /// 'YYYY-MM-DD'. Years are padded to four digits, matching dayjs's
    /// `format('YYYY-MM-DD')`, so string comparison stays date comparison.
    public var iso: String {
        let y = year < 0 ? "-" + Self.pad(-year, 4) : Self.pad(year, 4)
        return "\(y)-\(Self.pad(month, 2))-\(Self.pad(day, 2))"
    }

    /// 'YYYY-MM' -- the month key every report row is grouped by.
    public var monthKey: String { String(iso.prefix(7)) }

    public var description: String { iso }

    private static func pad(_ n: Int, _ width: Int) -> String {
        let s = String(n)
        return s.count >= width ? s : String(repeating: "0", count: width - s.count) + s
    }

    // MARK: - Day arithmetic

    /// Days since 1970-01-01. Howard Hinnant's `days_from_civil`, which is
    /// exact for every year in Int and involves no floating point and no
    /// timezone. The TypeScript reaches the same number via
    /// `Date.parse("YYYY-MM-DDT00:00:00Z") / 86400000`; that expression is
    /// pinned to UTC for exactly this reason, and this is the same arithmetic
    /// without the round trip through an instant.
    public var epochDay: Int {
        let y = month <= 2 ? year - 1 : year
        let era = (y >= 0 ? y : y - 399) / 400
        let yoe = y - era * 400                                   // [0, 399]
        let doy = (153 * (month + (month > 2 ? -3 : 9)) + 2) / 5 + day - 1
        let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy           // [0, 146096]
        return era * 146_097 + doe - 719_468
    }

    /// The inverse of `epochDay` (`civil_from_days`).
    public init(epochDay: Int) {
        let z = epochDay + 719_468
        let era = (z >= 0 ? z : z - 146_096) / 146_097
        let doe = z - era * 146_097                                // [0, 146096]
        let yoe = (doe - doe / 1460 + doe / 36524 - doe / 146_096) / 365
        let y = yoe + era * 400
        let doy = doe - (365 * yoe + yoe / 4 - yoe / 100)          // [0, 365]
        let mp = (5 * doy + 2) / 153                               // [0, 11]
        let d = doy - (153 * mp + 2) / 5 + 1
        let m = mp + (mp < 10 ? 3 : -9)
        self.init(unchecked: m <= 2 ? y + 1 : y, m, d)
    }

    public func addingDays(_ n: Int) -> CalendarDate {
        CalendarDate(epochDay: epochDay + n)
    }

    /// Whole days from `other` to `self` (negative when earlier).
    public func daysSince(_ other: CalendarDate) -> Int {
        epochDay - other.epochDay
    }

    // MARK: - Month and year arithmetic (dayjs semantics)

    /// dayjs `add(n, 'month')`: move the month, then CLAMP the day to the last
    /// day of the month it landed in. 31 Jan + 1 month is 28 Feb (29 in a leap
    /// year), not 2 or 3 March.
    ///
    /// The rejected alternative is rolling over into the next month, which is
    /// what naive day-count arithmetic does. It would make a monthly budget
    /// anchored on the 31st drift a day or two later every February until it no
    /// longer means "the 31st", and windows computed from a drifting anchor
    /// stop tiling: some days would fall in two windows and some in none.
    public func addingMonths(_ n: Int) -> CalendarDate {
        let zeroBased = (year * 12 + (month - 1)) + n
        // Swift's `/` truncates toward zero and `%` follows it, so negative
        // months need a floored division to land in the right year.
        let newYear = Int((Double(zeroBased) / 12).rounded(.down))
        let newMonth = zeroBased - newYear * 12 + 1
        let clamped = min(day, Self.daysInMonth(year: newYear, month: newMonth))
        return CalendarDate(unchecked: newYear, newMonth, clamped)
    }

    /// dayjs `add(n, 'year')`: same clamp, so 29 Feb + 1 year is 28 Feb.
    public func addingYears(_ n: Int) -> CalendarDate {
        let newYear = year + n
        let clamped = min(day, Self.daysInMonth(year: newYear, month: month))
        return CalendarDate(unchecked: newYear, month, clamped)
    }

    public var startOfMonth: CalendarDate { CalendarDate(unchecked: year, month, 1) }

    public var endOfMonth: CalendarDate {
        CalendarDate(unchecked: year, month, Self.daysInMonth(year: year, month: month))
    }

    public static func < (lhs: CalendarDate, rhs: CalendarDate) -> Bool {
        if lhs.year != rhs.year { return lhs.year < rhs.year }
        if lhs.month != rhs.month { return lhs.month < rhs.month }
        return lhs.day < rhs.day
    }
}
