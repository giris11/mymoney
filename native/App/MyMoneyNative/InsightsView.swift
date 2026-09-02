// The screen that says something the owner did not ask for.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE THIS FILE IS BUILT AROUND: EVERY CLAIM IS INSPECTABLE, AND LOW
// CONFIDENCE LOOKS LOW.
//
// Three things follow from it, and they are the reason this screen is laid out
// the way it is rather than as one ranked list:
//
//   1. THE SECTIONS ARE THE CONFIDENCE. A "possible" pattern is not a "clear"
//      one with a smaller chip on it -- it is under a different heading, with a
//      sentence saying why it is uncertain. Somebody skimming must not be able
//      to mistake one for the other, because the whole value of the confident
//      rows is that they are not mixed in with guesses.
//   2. EVERY ROW OPENS. Tapping a recurring payment shows the payments behind
//      it, which of them landed late, which expected day is missing, and what
//      this app has NOT taken into account. An app that asserts things about
//      somebody's money and cannot show its working is asking to be trusted
//      blindly, and it has not earned that.
//   3. THE SCREEN SAYS WHAT IT DID NOT LOOK AT. The last card is a plain-English
//      count of the payments that were skipped -- transfers, money in, anything
//      with no payee. Without it, a reader would reasonably assume the screen
//      covered everything.
//
// AND NOTHING HERE IS EVER CALLED A SUBSCRIPTION. Whether a repeating payment
// is a subscription, a rent or a standing order to a relative is a fact about a
// contract; this app has seen a ledger. "Recurring payment" is true of all of
// them, so that is the only phrase used.
//
// NO ARITHMETIC IN THIS FILE. Every figure comes from `Insights.report`, and
// every one of them is formatted by `Display`, which goes through the kit's
// `Money`. A percentage or a total computed here would be a second answer to a
// question the kit already answers under test.
import MyMoneyKit
import SwiftUI

struct InsightsView: View {
    @Environment(AppModel.self) private var app

    /// The book's revision, passed IN rather than read from `app` inside the
    /// `.task(id:)` below.
    ///
    /// This is load-bearing and was a real bug. When the ONLY read of
    /// `app.revision` was the `.task(id:)` argument, Observation did not
    /// register this view's body as a dependent of it: the body was never
    /// invalidated, so the id never changed, so the task never restarted and
    /// the screen kept the figures it had before the edit. Saving a budget
    /// left "No budgets yet" on screen -- and the natural response to that is
    /// to save it again, which is how one budget becomes two.
    ///
    /// Taking it as a parameter makes the dependency structural: `RootView`'s
    /// body reads `app.revision`, so a mutation rebuilds this view with a new
    /// value, and `.task(id:)` restarts because its id genuinely changed.
    let revision: Int

    /// Opening a transaction is the shell's job -- it owns the editor sheets.
    let onSelectTransaction: (String) -> Void

    @State private var screen: InsightsScreen?
    @State private var failure: String?

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                if let screen {
                    content(screen.report, transactionCount: screen.transactionCount)
                } else if let failure {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This screen could not be built",
                        message: failure
                            + "\n\nYour web app is unaffected \u{2014} it holds the real ledger.",
                        tone: .problem,
                        action: ("Try again", { Task { await load() } })
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    ProgressView("Looking for patterns\u{2026}")
                        .frame(maxWidth: .infinity)
                        .padding(40)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.background)
        .navigationTitle("Recurring & insights")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
        #endif
        .task(id: revision) { await load() }
    }

    @ViewBuilder private func content(_ report: InsightsReport, transactionCount: Int)
        -> some View
    {
        provenance
        if report.isEmpty {
            Notice(
                symbol: "magnifyingglass",
                title: "Nothing to report yet",
                message:
                    "Nothing in this copy repeats often enough to describe, and no account has "
                    + "been sitting untouched. That is a finding, not a failure.",
                tone: .neutral
            )
            .frame(maxWidth: .infinity)
        } else {
            recurringCard(report)
            uncertainCard(report)
            lapsedCard(report)
            pairsCard(report)
            priceChangesCard(report)
            duplicatesCard(report)
            dormantCard(report)
        }
        coverageCard(report, transactionCount: transactionCount)
    }

    /// Said once, at the top, before any of it: where this comes from.
    private var provenance: some View {
        HStack(alignment: .firstTextBaseline, spacing: 8) {
            Image(systemName: "info.circle")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(
                "Everything here is worked out from the transactions in this copy \u{2014} "
                    + "nothing is a statement about your bank. Tap any row to see the payments "
                    + "behind it."
            )
            .font(.caption)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 4)
        .accessibilityElement(children: .combine)
    }

    // MARK: - Recurring payments

    private func recurringCard(_ report: InsightsReport) -> some View {
        let rows = report.live.filter { $0.confidence >= .medium }
        return Group {
            if !rows.isEmpty {
                CardSection(
                    title: "Recurring payments",
                    caption: annualCaption(report.annual)
                ) {
                    ForEach(rows) { series in
                        seriesLink(report, series)
                    }
                    annualNotes(report.annual)
                }
            }
        }
    }

    /// The headline sentence: what a year of these costs, and how many of them
    /// that covers. The count is part of the sentence rather than a detail --
    /// "£1,240 a year" over a list of nine rows invites the reader to assume it
    /// covers all nine.
    private func annualCaption(_ annual: AnnualRecurringCost) -> String {
        guard let total = annual.totalMinor, annual.seriesCounted > 0 else {
            return "Still running"
        }
        let money = Display.money(total, annual.baseCurrency)
        let count = Display.count(annual.seriesCounted, "payment")
        return "About \(money) a year across \(count) still running"
    }

    @ViewBuilder private func annualNotes(_ annual: AnnualRecurringCost) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            if annual.containsEstimates {
                footnote(
                    "Some of these vary from one payment to the next, so the yearly figure uses "
                        + "the typical payment and is an estimate."
                )
            }
            if annual.seriesWithoutRate > 0 {
                MissingRateNote(
                    count: annual.seriesWithoutRate, currencies: annual.missingRateCurrencies
                )
            }
            if annual.seriesLapsed > 0 {
                // Written out both ways rather than with a bolted-on "(s)":
                // "1 payment that look stopped are listed below" was on screen
                // for the length of one simulator run and read like a machine.
                footnote(
                    annual.seriesLapsed == 1
                        ? "1 payment that looks stopped is listed below and is not in that figure."
                        : "\(annual.seriesLapsed) payments that look stopped are listed below and "
                            + "are not in that figure."
                )
            }
        }
        .padding(.top, 2)
    }

    /// The low-confidence ones, under their own heading and their own sentence.
    /// This separation IS the "low confidence must look low confidence" rule.
    private func uncertainCard(_ report: InsightsReport) -> some View {
        let rows = report.live.filter { $0.confidence == .low }
        return Group {
            if !rows.isEmpty {
                CardSection(
                    title: "Might be recurring",
                    caption: "Not enough to be sure"
                ) {
                    Text(
                        "These have too few payments, or too many that do not fit, to call a "
                            + "pattern. They are not counted in the yearly figure above."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    ForEach(rows) { series in
                        seriesLink(report, series)
                    }
                }
            }
        }
    }

    private func lapsedCard(_ report: InsightsReport) -> some View {
        let rows = report.lapsed
        return Group {
            if !rows.isEmpty {
                CardSection(title: "These look like they stopped", caption: "Worth a check") {
                    Text(
                        "A payment that used to come regularly and has not for a while. This app "
                            + "cannot see a cancellation \u{2014} only that nothing has been "
                            + "recorded since."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    ForEach(rows) { series in
                        seriesLink(report, series)
                    }
                }
            }
        }
    }

    private func pairsCard(_ report: InsightsReport) -> some View {
        Group {
            if !report.pairs.isEmpty {
                CardSection(title: "Twice, so far", caption: "Two payments is not a pattern") {
                    Text(
                        "Each of these happened exactly twice, at an interval that could be a "
                            + "rhythm. One gap is a coincidence until it happens again, so no "
                            + "next payment is predicted."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    ForEach(report.pairs) { series in
                        seriesLink(report, series)
                    }
                }
            }
        }
    }

    private func seriesLink(_ report: InsightsReport, _ series: RecurringSeries) -> some View {
        NavigationLink {
            SeriesDetailView(
                series: series,
                annualInBase: report.annualCostInBase[series.id],
                baseCurrency: report.baseCurrency,
                onSelectTransaction: onSelectTransaction
            )
        } label: {
            SeriesRow(
                series: series,
                annualInBase: report.annualCostInBase[series.id],
                baseCurrency: report.baseCurrency
            )
        }
        .buttonStyle(.plain)
    }

    // MARK: - Price changes

    private func priceChangesCard(_ report: InsightsReport) -> some View {
        Group {
            if !report.priceChanges.isEmpty {
                CardSection(
                    title: "Price changes",
                    caption: "In your recurring payments"
                ) {
                    ForEach(report.priceChanges) { change in
                        PriceChangeRow(change: change)
                    }
                    footnote(
                        "A change is only shown when every payment after it is on one side of "
                            + "every payment before it, and the step is bigger than the usual "
                            + "wobble \u{2014} so a cold month on a variable bill does not count "
                            + "as a price rise."
                    )
                }
            }
        }
    }

    // MARK: - Duplicates

    private func duplicatesCard(_ report: InsightsReport) -> some View {
        let findings = report.duplicates
        return Group {
            if !findings.unusual.isEmpty || !findings.routine.isEmpty {
                CardSection(
                    title: "Same amount, same day",
                    caption: "Matching payments in your own records"
                ) {
                    // THE SENTENCE THAT MAKES THIS SAFE TO SHOW. It is first,
                    // before any row, because a reader who takes one of these to
                    // their bank on the strength of a heading has been misled by
                    // this app.
                    Text(
                        "These are payments in this copy that match each other. That can mean a "
                            + "file was imported twice, a row was entered twice, or the thing "
                            + "genuinely happened twice. The app cannot see your bank, so it "
                            + "does not say which."
                    )
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)

                    ForEach(findings.unusual) { match in
                        DuplicateRow(match: match, onSelectTransaction: onSelectTransaction)
                    }

                    if !findings.routine.isEmpty {
                        DisclosureGroup {
                            ForEach(findings.routine) { match in
                                DuplicateRow(
                                    match: match, onSelectTransaction: onSelectTransaction
                                )
                            }
                        } label: {
                            Text(
                                "\(Display.count(findings.routine.count, "match", "matches")) at "
                                    + "payees where this happens routinely"
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }
                }
            }
        }
    }

    // MARK: - Dormant money

    private func dormantCard(_ report: InsightsReport) -> some View {
        let dormant = report.dormant
        return Group {
            if !dormant.accounts.isEmpty || !dormant.archived.isEmpty {
                CardSection(title: "Sitting still", caption: dormantCaption(dormant)) {
                    ForEach(dormant.accounts) { row in
                        DormantRow(row: row)
                    }
                    if dormant.accountsWithoutRate > 0 {
                        MissingRateNote(
                            count: dormant.accountsWithoutRate,
                            currencies: dormant.missingRateCurrencies
                        )
                    }
                    if !dormant.archived.isEmpty {
                        DisclosureGroup {
                            ForEach(dormant.archived) { row in
                                DormantRow(row: row)
                            }
                        } label: {
                            Text(
                                "\(Display.count(dormant.archived.count, "archived account")) with "
                                    + "a balance"
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        .padding(.top, 4)
                    }
                    footnote("An account with money in it and no activity for over a year.")
                }
            }
        }
    }

    private func dormantCaption(_ dormant: DormantFindings) -> String? {
        guard let total = dormant.totalBaseMinor, dormant.accountsCounted > 0 else { return nil }
        return "\(Display.money(total, dormant.baseCurrency)) in "
            + "\(Display.count(dormant.accountsCounted, "account"))"
    }

    // MARK: - What was looked at

    /// The card that stops the rest of the screen from implying it saw
    /// everything.
    private func coverageCard(_ report: InsightsReport, transactionCount: Int) -> some View {
        let coverage = report.coverage
        return CardSection(title: "What this looked at") {
            VStack(alignment: .leading, spacing: 6) {
                FigureRow(
                    label: "Payments considered",
                    value: Display.grouped(coverage.paymentsConsidered)
                )
                FigureRow(label: "Payees", value: Display.grouped(coverage.payeesSeen))
                if let earliest = coverage.earliestDate, let latest = coverage.latestDate {
                    FigureRow(
                        label: "Covering",
                        value: "\(Display.dateText(earliest)) \u{2013} \(Display.dateText(latest))"
                    )
                }
                Divider().padding(.vertical, 2)
                skipped(coverage, transactionCount: transactionCount)
            }
            .font(.footnote)
        }
    }

    private func skipped(_ coverage: RecurrenceCoverage, transactionCount: Int) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Not looked at").font(.caption.weight(.semibold)).foregroundStyle(.secondary)
            if coverage.transfersSkipped > 0 {
                footnote(
                    "\(Display.count(coverage.transfersSkipped, "transfer leg")) \u{2014} moving "
                        + "money between your own accounts is not a payment to anyone."
                )
            }
            if coverage.moneyInSkipped > 0 {
                footnote(
                    "\(Display.count(coverage.moneyInSkipped, "payment")) in \u{2014} a salary is "
                        + "regular, and it is not something you pay."
                )
            }
            if coverage.withoutPayeeSkipped > 0 {
                footnote(
                    "\(Display.count(coverage.withoutPayeeSkipped, "payment")) with no payee "
                        + "\u{2014} there is no name to group them by, so they cannot be matched "
                        + "up. This is the gap most likely to hide something."
                )
            }
            if coverage.unreadableSkipped > 0 {
                footnote(
                    "\(Display.count(coverage.unreadableSkipped, "payment")) this app could not "
                        + "read \u{2014} an unrecognisable date or amount. Worth looking at in "
                        + "your web app."
                )
            }
            if coverage.payeesWithNoPattern > 0 {
                footnote(
                    "\(Display.count(coverage.payeesWithNoPattern, "payee")) with enough payments "
                        + "to have a pattern, where nothing fitted well enough to claim one."
                )
            }
            footnote("This copy holds \(Display.count(transactionCount, "transaction")) in total.")
        }
    }

    private func footnote(_ text: String) -> some View {
        Text(text)
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
    }

    /// `@MainActor` for the reason spelled out in `ReportsView.load`: a plain
    /// `async` method on a `View` resumes off the main actor, and the `@State`
    /// writes after the first `await` then never reach SwiftUI.
    @MainActor private func load() async {
        do {
            screen = try await app.service.insights(today: todayISO())
            failure = screen == nil ? "There is no book on this device yet." : nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }
}

// MARK: - One recurring payment

/// The row: who, how often, how much, and how sure -- in that order, because
/// that is the order somebody reads it in.
struct SeriesRow: View {
    let series: RecurringSeries
    /// This series' yearly cost in the book's base currency, when it is not
    /// already in it and a rate exists.
    var annualInBase: Int64? = nil
    var baseCurrency: String = ""

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(series.payeeName)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                ConfidenceChip(confidence: series.confidence)
                Image(systemName: "chevron.right")
                    .font(.caption2.weight(.semibold))
                    .foregroundStyle(.tertiary)
                    .accessibilityHidden(true)
            }
            Text(InsightsWording.amountLine(series))
                .font(.subheadline)
                .monospacedDigit()
            Text(InsightsWording.statusLine(series))
                .font(.caption)
                .foregroundStyle(statusColour)
                .fixedSize(horizontal: false, vertical: true)
            Text(InsightsWording.evidenceLine(series))
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            // A euro subscription in a sterling book: without this the reader
            // has a row in one currency and a total in another and no way to
            // join them.
            if let note = InsightsWording.baseYearlyNote(
                series, inBase: annualInBase, baseCurrency: baseCurrency
            ) {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(series.payeeName), \(series.confidence.label)")
        .accessibilityValue(
            "\(InsightsWording.amountSpoken(series)). \(InsightsWording.statusLine(series)). "
                + InsightsWording.evidenceLine(series)
        )
        .accessibilityHint("Shows the payments behind this")
    }

    private var statusColour: Color {
        switch series.status {
        case .active: return .secondary
        case .due: return .orange
        case .lapsed: return .secondary
        }
    }
}

/// The confidence, as a chip that LOOKS like what it says.
///
/// A filled chip for a clear pattern, a tinted one for a likely one, and a
/// hollow outline for anything the app is guessing at. The word is always
/// there too: colour is emphasis, never the only signal.
struct ConfidenceChip: View {
    let confidence: SeriesConfidence

    var body: some View {
        Text(confidence.label)
            .font(.caption2.weight(confidence == .high ? .semibold : .regular))
            .padding(.horizontal, 7)
            .padding(.vertical, 2)
            .background(background, in: Capsule())
            .overlay(
                Capsule().strokeBorder(
                    confidence <= .low ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.clear),
                    lineWidth: 1
                )
            )
            .foregroundStyle(foreground)
            .accessibilityHidden(true)
    }

    private var background: AnyShapeStyle {
        switch confidence {
        case .high: return AnyShapeStyle(Color.accentColor.opacity(0.18))
        case .medium: return AnyShapeStyle(.quaternary)
        case .low, .pair: return AnyShapeStyle(.clear)
        }
    }

    private var foreground: AnyShapeStyle {
        switch confidence {
        case .high: return AnyShapeStyle(Color.accentColor)
        case .medium: return AnyShapeStyle(.secondary)
        case .low, .pair: return AnyShapeStyle(.tertiary)
        }
    }
}

// MARK: - One price change

struct PriceChangeRow: View {
    let change: SeriesPriceChange

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(change.payeeName)
                    .font(.callout.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(InsightsWording.changeAmount(change))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(change.change.isRise ? Color.orange : Color.secondary)
            }
            Text(InsightsWording.changeLine(change))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if !change.change.confirmed {
                Text(
                    "One payment at the new amount so far \u{2014} it may be a rise, or one odd "
                        + "month."
                )
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One duplicate match

struct DuplicateRow: View {
    let match: DuplicateSuspicion
    let onSelectTransaction: (String) -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(match.payeeName).font(.callout.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                Text(Display.money(match.amountMinor, match.currency))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
            }
            Text(InsightsWording.duplicateSummary(match))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)

            // The rows themselves, each one a way into the transaction. This is
            // the whole claim, laid out: no summary, the actual records.
            ForEach(match.transactions) { side in
                Button {
                    onSelectTransaction(side.id)
                } label: {
                    HStack(alignment: .firstTextBaseline, spacing: 8) {
                        Text(Display.dateText(side.date)).font(.caption).monospacedDigit()
                        Text(side.accountName).font(.caption).foregroundStyle(.secondary)
                            .lineLimit(1)
                        Spacer(minLength: 6)
                        if side.status == .pending {
                            Text("Pending").font(.caption2).foregroundStyle(.orange)
                        }
                        Text(Display.money(side.amountMinor, side.currency))
                            .font(.caption)
                            .monospacedDigit()
                            .foregroundStyle(amountColour(side.amountMinor))
                    }
                    .contentShape(Rectangle())
                }
                .buttonStyle(.plain)
                .accessibilityHint("Opens this transaction")
            }

            if let provenance = InsightsWording.duplicateProvenance(match) {
                Text(provenance)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.vertical, 7)
    }
}

// MARK: - One dormant account

struct DormantRow: View {
    let row: DormantAccount

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            HStack(alignment: .firstTextBaseline, spacing: 8) {
                AccountDot(hex: row.account.colour)
                Text(row.account.name).font(.callout.weight(.medium)).lineLimit(1)
                Spacer(minLength: 8)
                Text(Display.money(row.balanceMinor, row.account.currency))
                    .font(.callout.weight(.semibold))
                    .monospacedDigit()
                    .foregroundStyle(amountColour(row.balanceMinor))
            }
            Text(InsightsWording.dormantLine(row))
                .font(.caption)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            if row.excludedFromNetWorth {
                Text(Display.notCountedLabel)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(row.account.name)
        .accessibilityValue(
            "\(Display.moneySpoken(row.balanceMinor, row.account.currency)). "
                + InsightsWording.dormantLine(row)
        )
    }
}
