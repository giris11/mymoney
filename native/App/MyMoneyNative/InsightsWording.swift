// The sentences.
//
// ─────────────────────────────────────────────────────────────────────────────
// ON THIS SCREEN THE WORDING IS THE FEATURE, so it is written down in one place
// rather than scattered through four views. Three rules govern every string
// below, and they are the reason some of these sentences are longer than a
// designer would like:
//
//   1. NOTHING IS ASSERTED THAT THE DATA DOES NOT SUPPORT. "This may have been
//      cancelled", never "cancelled". "These match", never "you were charged
//      twice". "About £119.88 a year", never "£119.88 a year", when the figure
//      is a multiplication of a typical payment rather than a total that was
//      actually paid.
//   2. EVERY FIGURE CARRIES WHAT IT IS OF. "Up £412" is meaningless without
//      "since April"; "£2.00 more" is meaningless without "a month, so £24.00 a
//      year". The second half is never dropped to make a line fit.
//   3. NO ARITHMETIC HERE. Every number in every sentence arrives already
//      computed from `MyMoneyKit`, and every one of them is rendered by
//      `Display`, which goes through the kit's `Money`. A `/` or a `*` in this
//      file would be a second implementation of money in the layer with no
//      tests under it.
//
// The one thing that IS decided here is which of several true sentences to
// print, and that is decided by the model's own enums -- `SeriesStatus`,
// `AmountStability`, `SeriesConfidence` -- so a state the kit can produce
// cannot fall through to no sentence at all.
import MyMoneyKit
import SwiftUI

enum InsightsWording {

    // MARK: - A recurring payment

    /// "Monthly · £9.99", and the four ways an amount can be less certain than
    /// that.
    static func amountLine(_ series: RecurringSeries) -> String {
        "\(series.cadence.label) \u{00B7} \(amountPhrase(series))"
    }

    static func amountPhrase(_ series: RecurringSeries) -> String {
        let typical = Display.money(series.typicalAmountMinor, series.currency)
        switch series.stability {
        case .exact:
            return typical
        case .steady:
            // Within a few percent -- a foreign card fee, a rounding. Saying
            // "£9.99" flat would be wrong by pennies every month.
            return "about \(typical)"
        case .varies:
            guard let level = series.currentLevel else { return "about \(typical)" }
            let low = Display.money(level.lowMinor, series.currency)
            let high = Display.money(level.highMinor, series.currency)
            return "\(low)\u{2013}\(high), typically \(typical)"
        case .unsettled:
            return "\(typical), paid once at that amount"
        }
    }

    static func amountSpoken(_ series: RecurringSeries) -> String {
        "\(series.cadence.phrase), \(Display.moneySpoken(series.typicalAmountMinor, series.currency))"
    }

    /// Where this payment stands today. The lapsed case is the one that has to
    /// be worded most carefully: this app cannot see a cancellation.
    static func statusLine(_ series: RecurringSeries) -> String {
        if series.confidence == .pair { return pairLine(series) }
        switch series.status {
        case .active:
            guard let next = series.nextExpectedDate else {
                return "Last payment \(Display.dateText(series.lastDate))"
            }
            return "Next expected around \(Display.dateText(next))"
        case .due(let daysLate):
            let next = series.nextExpectedDate.map(Display.dateText) ?? "recently"
            return "Expected around \(next) \u{2014} \(days(daysLate)) ago"
        case .lapsed(_, let missedPayments):
            let since = Display.dateText(series.lastDate)
            let missed =
                missedPayments == 1
                ? "One payment would have been due since"
                : "\(missedPayments) payments would have been due since"
            return "Nothing since \(since). \(missed)."
        }
    }

    /// Two payments, and no third one predicted. The sentence says both halves
    /// because the second is the point.
    private static func pairLine(_ series: RecurringSeries) -> String {
        "\(Display.dateText(series.firstDate)) and \(Display.dateText(series.lastDate)) "
            + "\u{2014} \(series.cadence.phrase) apart, once. No next payment is predicted."
    }

    /// The counts, and the yearly figure, in the smallest type on the row.
    static func evidenceLine(_ series: RecurringSeries) -> String {
        var parts: [String] = ["\(Display.count(series.evidence.matched, "payment"))"]
        if series.evidence.missed > 0 {
            parts.append("\(series.evidence.missed) missed")
        }
        if series.evidence.extras > 0 {
            parts.append("\(series.evidence.extras) that do not fit")
        }
        // NEVER a yearly figure for a pair: multiplying one gap by twelve is
        // the exact guess this screen refuses to make.
        if series.confidence != .pair, let yearly = yearlyPhrase(series) {
            parts.append(yearly)
        }
        return parts.joined(separator: " \u{00B7} ")
    }

    /// "£119.88 a year", or "about £528.00 a year at the typical payment" when
    /// the amount is not a fixed price.
    static func yearlyPhrase(_ series: RecurringSeries) -> String? {
        let amount = Display.money(series.annualCostMinor, series.currency)
        switch series.stability {
        case .exact:
            return "\(amount) a year"
        case .steady:
            return "about \(amount) a year"
        case .varies:
            return "about \(amount) a year at the typical payment"
        case .unsettled:
            return "\(amount) a year if it stays at that"
        }
    }

    /// "about £122.40 a year in your base currency", for a series that is not
    /// denominated in it. nil when there is nothing to add: same currency, or
    /// no rate -- and in the second case the screen's missing-rate note is what
    /// says so, rather than a figure appearing from nowhere.
    static func baseYearlyNote(
        _ series: RecurringSeries, inBase: Int64?, baseCurrency: String
    ) -> String? {
        guard series.currency != baseCurrency, let inBase else { return nil }
        return "about \(Display.money(inBase, baseCurrency)) a year in \(baseCurrency)"
    }

    // MARK: - A price change

    /// "+£2.00" / "-£3.00".
    static func changeAmount(_ change: SeriesPriceChange) -> String {
        let amount = Display.money(change.change.changeMinor, change.change.currency)
        return change.change.isRise ? "+\(amount)" : amount
    }

    /// The whole claim in one sentence: from what, to what, when -- and what
    /// that does to a year, which is the part that decides whether it matters.
    static func changeLine(_ change: SeriesPriceChange) -> String {
        let from = Display.money(change.change.fromMinor, change.change.currency)
        let to = Display.money(change.change.toMinor, change.change.currency)
        let when = Display.dateText(change.change.onDate)
        let yearly = Display.money(abs(change.annualisedChangeMinor), change.change.currency)
        let direction = change.change.isRise ? "more" : "less"
        // The cadence and its multiplier are BOTH named. A yearly figure whose
        // multiplier the reader cannot check is a figure they have to take on
        // trust, and 26 and 13 are exactly the two people get wrong.
        return "\(from) to \(to), first seen \(when) \u{00B7} \(change.cadence.label.lowercased()), "
            + "\(change.cadence.perYearPhrase), so about \(yearly) a year \(direction)"
    }

    // MARK: - A duplicate match

    /// What matched. A statement of fact with no verdict in it.
    static func duplicateSummary(_ match: DuplicateSuspicion) -> String {
        let count = match.count
        let amount = Display.money(match.amountMinor, match.currency)
        let dates: String
        if match.spanDays == 0 {
            dates = "on \(Display.dateText(match.transactions[0].date))"
        } else {
            let first = Display.dateText(match.transactions[0].date)
            let last = Display.dateText(match.transactions[match.transactions.count - 1].date)
            dates = "on \(first) and \(last)"
        }
        return "\(count) payments of \(amount) \(dates), all in \(match.accountName)."
    }

    /// Where the rows came from, which is the evidence that actually
    /// distinguishes a double import from a thing that happened twice. Nil when
    /// the book carries nothing to say.
    static func duplicateProvenance(_ match: DuplicateSuspicion) -> String? {
        var sentences: [String] = []
        if match.differentImportBatches {
            sentences.append(
                "They came from two different imports \u{2014} which is what importing the same "
                    + "statement twice looks like."
            )
        } else if match.sameImportBatch {
            sentences.append(
                "They both came from the same import, so that one file contained both rows."
            )
        }
        if match.someEnteredByHand {
            sentences.append("At least one was entered by hand rather than imported.")
        }
        if match.sameDedupeKey {
            sentences.append("An import would not be able to tell these two rows apart.")
        }
        if match.routineForThisPayee {
            sentences.append(
                "This payee has \(match.otherOccasionsForThisPayee) other days like this, so it "
                    + "may simply be what happens here."
            )
        }
        return sentences.isEmpty ? nil : sentences.joined(separator: " ")
    }

    // MARK: - Dormant money

    static func dormantLine(_ row: DormantAccount) -> String {
        guard let days = row.daysSinceActivity, let last = row.lastActivityDate else {
            // No transactions at all. "How long since something that never
            // happened" has no answer, so the sentence does not pretend to one.
            return "No transactions recorded at all \u{2014} this is its opening balance."
        }
        let owed = row.isOwed ? "still owed" : "sitting there"
        return "\(quiet(days)) with no activity \u{2014} last on \(Display.dateText(last)), "
            + "and \(owed) since."
    }

    /// A rough phrase for a long time, always beside the exact date it is
    /// derived from, so the rounding cannot mislead anybody.
    private static func quiet(_ days: Int) -> String {
        if days >= 730 { return "Over \(days / 365) years" }
        return "Over a year"
    }

    private static func days(_ count: Int) -> String {
        count == 1 ? "1 day" : "\(count) days"
    }
}
