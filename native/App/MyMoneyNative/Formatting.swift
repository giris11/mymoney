// Text that is not money.
//
// THE RULE THIS FILE EXISTS TO KEEP: no `NumberFormatter` is constructed
// anywhere in this app. Every figure on every screen goes through
// `MyMoneyKit.Money` -- `format` for what is shown, `spoken`/`spokenFlow` for
// what is said -- which is one implementation, already held to 284 oracle cases
// and to the owner's real book. A second formatter in a view would be a second
// answer to "what is this amount", and the first symptom would be a headline
// that disagreed with the list beneath it by a penny.
//
// What IS here is dates and counts, which are not money and have no oracle.
// The formatters are created ONCE: a `DateFormatter` costs roughly a millisecond
// to build, and a register that built one per row would spend longer formatting
// dates than reading the database.
import Foundation
import MyMoneyKit

enum Display {
    // MARK: - Dates

    /// "3 Sep 2026" in en-GB. The register's date column.
    private static let medium: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "d MMM yyyy"
        // A calendar date has no timezone (see `Records.swift`); UTC is chosen
        // so the same stored string always renders as the same day, wherever
        // the phone happens to be. A transaction that moved a day when the
        // owner flew somewhere would be a real bug in a real finance app.
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    /// "3 September 2026" -- what a screen reader should say, because "Sep"
    /// is read aloud inconsistently and the abbreviation buys nothing in speech.
    private static let spokenDate: DateFormatter = {
        let f = DateFormatter()
        f.locale = Locale(identifier: "en_GB")
        f.dateFormat = "d MMMM yyyy"
        f.timeZone = TimeZone(identifier: "UTC")
        return f
    }()

    private static func date(fromISO iso: String) -> Date? {
        guard let calendarDate = CalendarDate(iso: iso) else { return nil }
        var components = DateComponents()
        components.year = calendarDate.year
        components.month = calendarDate.month
        components.day = calendarDate.day
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC")!
        return calendar.date(from: components)
    }

    /// The date as shown. An unparseable string is shown AS IT IS rather than
    /// blanked: a row whose date this app cannot read is still the owner's
    /// money, and hiding the field would hide the problem too.
    static func dateText(_ iso: String) -> String {
        guard let date = date(fromISO: iso) else { return iso }
        return medium.string(from: date)
    }

    /// The date as spoken.
    static func dateSpoken(_ iso: String) -> String {
        guard let date = date(fromISO: iso) else { return iso }
        return spokenDate.string(from: date)
    }

    /// "3 Sep 2026, 14:22" from an ISO instant -- used only for "imported at"
    /// and "exported at", which ARE instants rather than calendar dates.
    static func timestampText(_ iso: String) -> String {
        let parser = ISO8601DateFormatter()
        parser.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        let date = parser.date(from: iso) ?? ISO8601DateFormatter().date(from: iso)
        guard let date else { return iso }
        let f = DateFormatter()
        f.locale = Locale.current
        f.dateStyle = .medium
        f.timeStyle = .short
        return f.string(from: date)
    }

    // MARK: - Counts

    /// "5,127 transactions" -- grouped, and singular when it should be.
    ///
    /// A count is not money: it has no currency and no minor units, so it does
    /// not belong in `Money`. It is grouped with `Locale.current` because it is
    /// a plain integer and the platform's grouping is right for it.
    static func count(_ n: Int, _ singular: String, _ plural: String? = nil) -> String {
        let word = n == 1 ? singular : (plural ?? singular + "s")
        return "\(grouped(n)) \(word)"
    }

    static func grouped(_ n: Int) -> String {
        n.formatted(.number.grouping(.automatic))
    }

    // MARK: - Money, always through the kit

    /// The one call every visible figure makes. It exists so that a search for
    /// "Money.format" in this app finds one place per screen rather than
    /// tempting somebody to write a formatter beside it.
    static func money(_ minor: Int64, _ currency: String) -> String {
        Money.format(minor, currency: currency)
    }

    static func moneySpoken(_ minor: Int64, _ currency: String) -> String {
        Money.spoken(minor, currency: currency)
    }

    static func moneyFlowSpoken(_ minor: Int64, _ currency: String) -> String {
        Money.spokenFlow(minor, currency: currency)
    }

    // MARK: - The sentence the web app uses, kept identical

    /// The "not counted" line, worded exactly as `notCountedSummary()` in
    /// src/ui/settings/NetWorthCount.tsx words it.
    ///
    /// The same sentence about the same number in both apps, deliberately. When
    /// the amount is unknown it says so rather than printing a figure that
    /// quietly leaves an account out.
    static func notCountedSummary(
        count: Int, baseMinor: Int64?, baseCurrency: String
    ) -> String? {
        guard count > 0 else { return nil }
        let accounts = "\(count) account\(count == 1 ? "" : "s")"
        guard let baseMinor else {
            return "\(accounts) not counted \u{2014} no exchange rate, so the amount can\u{2019}t be shown"
        }
        return "\(money(baseMinor, baseCurrency)) in \(accounts) not counted"
    }

    /// The label beside an account that is shown but not counted. Same words as
    /// the web app's `NOT_COUNTED_LABEL`.
    static let notCountedLabel = "Not counted"
}
