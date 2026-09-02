// Showing the working.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS SCREEN IS THE PRICE OF THE PREVIOUS ONE. An app that tells somebody
// "this is a monthly payment of £9.99 and it costs you £119.88 a year" has made
// a claim about their money, and a claim that cannot be checked is a claim that
// asks to be believed. So every single thing the row said is opened up here:
//
//   * WHICH payments it is talking about, with their dates and amounts, and
//     which of them arrived late and by how many days;
//   * which expected day has NOTHING on it, named by date rather than counted;
//   * which payments to the same payee it is NOT talking about, and why;
//   * what the amount has been over time, and when it changed;
//   * and the arithmetic behind the yearly figure, written out as the
//     multiplication it is.
//
// Nothing here is a summary of the row above. It is the evidence, and the row
// is the summary.
//
// EVERY PAYMENT IS A BUTTON that opens the transaction itself, because the last
// step of checking a claim about a transaction is looking at the transaction.
import MyMoneyKit
import SwiftUI

struct SeriesDetailView: View {
    let series: RecurringSeries
    /// The yearly cost in the book's base currency, when this series is not in
    /// it. Passed in rather than computed: the conversion happens once, in
    /// `Insights`, where the rates are.
    let annualInBase: Int64?
    let baseCurrency: String
    let onSelectTransaction: (String) -> Void

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                headline
                reasoning
                if !series.levels.isEmpty { priceHistory }
                payments
                caveat
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.background)
        .navigationTitle(series.payeeName)
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    // MARK: - What it says

    private var headline: some View {
        CardSection(
            title: series.payeeName,
            caption: series.accountNames.isEmpty
                ? nil
                : "Paid from \(series.accountNames.joined(separator: ", "))",
            trailing: AnyView(ConfidenceChip(confidence: series.confidence))
        ) {
            VStack(alignment: .leading, spacing: 6) {
                Text(InsightsWording.amountLine(series))
                    .font(.system(.title3, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                Text(InsightsWording.statusLine(series))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                if series.confidence != .pair, let yearly = InsightsWording.yearlyPhrase(series) {
                    // The multiplication, written out. A yearly figure whose
                    // sum the reader cannot check is a figure they have to take
                    // on trust -- and 26 against 13 is exactly where a plausible
                    // wrong answer comes from.
                    Text(
                        "\(Display.money(series.typicalAmountMinor, series.currency)) "
                            + "\u{00D7} \(series.cadence.perYearPhrase) = \(yearly)"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
                    .fixedSize(horizontal: false, vertical: true)
                }
                if let note = InsightsWording.baseYearlyNote(
                    series, inBase: annualInBase, baseCurrency: baseCurrency
                ) {
                    Text("That is \(note), at the rate in your book.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if !series.alsoKnownAs.isEmpty {
                    Text(
                        "Earlier payments were recorded as "
                            + series.alsoKnownAs.joined(separator: ", ")
                            + " \u{2014} folded in because the dates carry on where they stopped "
                            + "and the amounts agree."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    // MARK: - Why the app believes it

    private var reasoning: some View {
        CardSection(title: "Why this is here", caption: series.confidence.label) {
            VStack(alignment: .leading, spacing: 7) {
                ForEach(Array(reasons.enumerated()), id: \.offset) { _, reason in
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Image(systemName: reason.symbol)
                            .font(.caption)
                            .foregroundStyle(reason.warning ? Color.orange : Color.secondary)
                            .frame(width: 16)
                            .accessibilityHidden(true)
                        Text(reason.text)
                            .font(.footnote)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .accessibilityElement(children: .combine)
                }
            }
        }
    }

    private struct Reason {
        let symbol: String
        let text: String
        var warning = false
    }

    /// The evidence, as sentences. Every one of them is a count or a date the
    /// kit produced; none is a judgement made here.
    private var reasons: [Reason] {
        let evidence = series.evidence
        var out: [Reason] = []

        if series.confidence == .pair {
            out.append(
                Reason(
                    symbol: "2.circle",
                    text:
                        "Two payments, \(series.cadence.phrase) apart, for the same amount. Three "
                        + "would be a pattern; two is a coincidence until it happens again.",
                    warning: true
                )
            )
            return out
        }

        let expected = evidence.matched + evidence.missed
        out.append(
            Reason(
                symbol: "checkmark.circle",
                text:
                    "\(evidence.matched) of the \(expected) expected days between "
                    + "\(Display.dateText(series.firstDate)) and "
                    + "\(Display.dateText(series.lastDate)) have a payment on them."
            )
        )

        out.append(
            Reason(
                symbol: "calendar",
                text: evidence.worstSlipDays == 0
                    ? "Every payment landed on the expected day."
                    : "Payments land within \(evidence.worstSlipDays) "
                        + "day\(evidence.worstSlipDays == 1 ? "" : "s") of the expected day "
                        + "(anything up to \(evidence.toleranceDays) counts as the same payment)."
            )
        )

        if !evidence.missedDates.isEmpty {
            let named = evidence.missedDates.map(Display.dateText).joined(separator: ", ")
            out.append(
                Reason(
                    symbol: "questionmark.circle",
                    text: "Nothing was recorded on \(named), when a payment was expected.",
                    warning: true
                )
            )
        }

        if evidence.extras > 0 {
            out.append(
                Reason(
                    symbol: "exclamationmark.circle",
                    text:
                        "\(Display.count(evidence.extras, "payment")) to this payee inside these "
                        + "dates \(evidence.extras == 1 ? "does" : "do") not fit the pattern. "
                        + "\(evidence.extras == 1 ? "It is" : "They are") listed below.",
                    warning: true
                )
            )
        }

        if evidence.earlierPayments > 0 {
            out.append(
                Reason(
                    symbol: "clock.arrow.circlepath",
                    text:
                        "\(Display.count(evidence.earlierPayments, "earlier payment")) to this "
                        + "payee \(evidence.earlierPayments == 1 ? "is" : "are") not part of this "
                        + "run \u{2014} the pattern describes what has been happening since "
                        + "\(Display.dateText(series.firstDate)).",
                    warning: true
                )
            )
        }

        if series.foundAmongOtherSpending {
            out.append(
                Reason(
                    symbol: "line.3.horizontal.decrease.circle",
                    text:
                        "This was picked out of other spending at the same payee by its amount"
                        + (evidence.otherPaymentsInRun > 0
                            ? ", and there \(evidence.otherPaymentsInRun == 1 ? "is" : "are") "
                                + "\(Display.count(evidence.otherPaymentsInRun, "other payment")) "
                                + "here it is not about."
                            : "."),
                    warning: true
                )
            )
        }

        if series.accountIds.count > 1 {
            out.append(
                Reason(
                    symbol: "creditcard",
                    text:
                        "The payments came from \(series.accountIds.count) accounts: "
                        + series.accountNames.joined(separator: ", ")
                        + ". Usually that means a card was replaced."
                )
            )
        }

        switch series.stability {
        case .exact:
            out.append(Reason(symbol: "equal.circle", text: "Every payment is the same amount."))
        case .steady:
            out.append(
                Reason(
                    symbol: "equal.circle",
                    text: "The amount moves by a few pence between payments."
                )
            )
        case .varies:
            out.append(
                Reason(
                    symbol: "waveform.path.ecg",
                    text:
                        "The amount varies, so the yearly figure is an estimate built from the "
                        + "typical payment rather than a fixed price.",
                    warning: true
                )
            )
        case .unsettled:
            out.append(
                Reason(
                    symbol: "waveform.path.ecg",
                    text:
                        "The most recent amount has been paid once. It may be the new price, or "
                        + "it may be one odd payment.",
                    warning: true
                )
            )
        }

        return out
    }

    // MARK: - What it has cost over time

    private var priceHistory: some View {
        CardSection(
            title: series.levels.count > 1 ? "What it has cost" : "What it costs",
            caption: series.levels.count > 1
                ? "\(series.levels.count) prices since \(Display.dateText(series.firstDate))" : nil
        ) {
            VStack(alignment: .leading, spacing: 8) {
                ForEach(Array(series.levels.enumerated()), id: \.offset) { _, level in
                    levelRow(level)
                }
                ForEach(series.changes) { change in
                    Text(changeSentence(change))
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
        }
    }

    private func levelRow(_ level: PriceLevel) -> some View {
        VStack(alignment: .leading, spacing: 1) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Display.money(level.amountMinor, series.currency))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                if level.lowMinor != level.highMinor {
                    Text(
                        "\(Display.money(level.lowMinor, series.currency))\u{2013}"
                            + "\(Display.money(level.highMinor, series.currency))"
                    )
                    .font(.caption)
                    .foregroundStyle(.tertiary)
                    .monospacedDigit()
                }
                Spacer(minLength: 8)
                Text(Display.count(level.count, "payment"))
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            Text(
                level.fromDate == level.toDate
                    ? Display.dateText(level.fromDate)
                    : "\(Display.dateText(level.fromDate)) \u{2013} \(Display.dateText(level.toDate))"
            )
            .font(.caption2)
            .foregroundStyle(.tertiary)
        }
        .accessibilityElement(children: .combine)
    }

    private func changeSentence(_ change: PriceChange) -> String {
        let from = Display.money(change.fromMinor, series.currency)
        let to = Display.money(change.toMinor, series.currency)
        let direction = change.isRise ? "up" : "down"
        let size = Display.money(abs(change.changeMinor), series.currency)
        let confirmed =
            change.confirmed
            ? "\(change.paymentsAtNewLevel) payments at the new amount since."
            : "Only one payment at the new amount so far."
        return "\(direction.capitalized) \(size), from \(from) to \(to), first seen "
            + "\(Display.dateText(change.onDate)) (the one before was "
            + "\(Display.dateText(change.previousDate))). \(confirmed)"
    }

    // MARK: - The payments themselves

    private var payments: some View {
        CardSection(
            title: "The payments",
            // WHAT IS ACTUALLY IN THE LIST, which is not always the same thing.
            // A series picked out of a payee's other spending by amount holds
            // only that amount's payments, and this caption said "to this
            // payee" over a list of twenty when the payee had forty. Caught by
            // reading the screen rather than by a test, because the number was
            // right and the words around it were not.
            caption: series.foundAmongOtherSpending
                ? "\(Display.count(series.occurrences.count, "payment")) at this amount"
                : "\(Display.count(series.occurrences.count, "payment")) to this payee"
        ) {
            VStack(spacing: 0) {
                ForEach(series.occurrences) { occurrence in
                    Button {
                        onSelectTransaction(occurrence.id)
                    } label: {
                        OccurrenceRow(occurrence: occurrence)
                    }
                    .buttonStyle(.plain)
                    .accessibilityHint("Opens this transaction")
                }
            }
        }
    }

    private var caveat: some View {
        Text(
            "This is what the records in this copy say. The app has never seen your bank, and a "
                + "pattern here is a description of what has happened, not a promise about what "
                + "will."
        )
        .font(.caption2)
        .foregroundStyle(.tertiary)
        .fixedSize(horizontal: false, vertical: true)
        .padding(.horizontal, 4)
    }
}

/// One payment in the list, with its role and its slip stated rather than
/// implied by position or colour.
struct OccurrenceRow: View {
    let occurrence: SeriesOccurrence

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(Display.dateText(occurrence.date))
                    .font(.callout)
                    .monospacedDigit()
                if let chip {
                    Text(chip)
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .background(.quaternary, in: Capsule())
                }
                Spacer(minLength: 8)
                Text(Display.money(occurrence.amountMinor, occurrence.currency))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(amountColour(occurrence.amountMinor))
            }
            if let detail {
                Text(detail)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(Display.dateSpoken(occurrence.date) + (chip.map { ", \($0)" } ?? ""))
        .accessibilityValue(
            Display.moneySpoken(occurrence.amountMinor, occurrence.currency)
                + (detail.map { ". \($0)" } ?? "")
        )
    }

    private var chip: String? {
        switch occurrence.role {
        case .onSchedule: return nil
        case .extra: return "does not fit"
        case .earlier: return "earlier"
        }
    }

    /// The slip, in words, and never as a bare number: "3 days late" says what
    /// the sign means without the reader having to work out which end it is
    /// measured from.
    private var detail: String? {
        var parts: [String] = []
        if occurrence.role == .onSchedule, occurrence.slipDays != 0,
            let expected = occurrence.expectedDate
        {
            let count = abs(occurrence.slipDays)
            let word = count == 1 ? "day" : "days"
            parts.append(
                "\(count) \(word) \(occurrence.slipDays > 0 ? "late" : "early") "
                    + "\u{2014} expected \(Display.dateText(expected))"
            )
        }
        if !occurrence.accountName.isEmpty { parts.append(occurrence.accountName) }
        return parts.isEmpty ? nil : parts.joined(separator: " \u{00B7} ")
    }
}
