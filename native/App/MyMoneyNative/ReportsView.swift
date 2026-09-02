// The six reports, behind one switcher and one date range.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY MARK IS DIRECT-LABELLED. See Charts.swift for why that is
// non-negotiable rather than a preference. Nothing on this screen requires a
// hover, a tap or a colour key to read: category, payee and tag spend are
// labelled bar lists; income against expense is a labelled pair of bars per
// month; cash flow is a labelled bar either side of a centre line; net worth is
// a line with its ends printed on it.
//
// THE RANGE IS SHARED ACROSS ALL SIX, as it is in the browser, so switching
// report keeps the period you were reading. The drill level is NOT shared: it
// belongs to "by category" alone, and switching away from that report drops it
// rather than carrying a category id to a screen with no meaning for it.
//
// A MISSING RATE IS ALWAYS ON SCREEN when there is one (SPEC §6). Every report
// carries its own count, and this file prints it under every one of them --
// there is no report here that can quietly leave a transaction out.
import MyMoneyKit
import SwiftUI

struct ReportsView: View {
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

    @State private var kind: ReportKind = .netWorth
    /// The range the OWNER chose. `nil` means "the default", and nothing but a
    /// tap on a chip or the custom sheet ever writes it.
    @State private var range: DateRange?
    /// The range a report was actually built over, for the line under the chips.
    ///
    /// Kept apart from `range` because `load()` used to resolve the default and
    /// write it back into `range` -- which is half of this view's `.task(id:)`.
    /// A loader that writes its own trigger re-enters itself: the first load
    /// cancelled and restarted itself, and from then on the screen could be
    /// left showing the previous report's chart under the new report's lit
    /// chip and new date line. The resolved range is display-only, so it is
    /// deliberately NOT part of `LoadKey`.
    @State private var shownRange: DateRange?
    @State private var parentId: String?
    @State private var screen: ReportScreen?
    @State private var failure: String?
    @State private var earliest: String?
    @State private var showingRangeEditor = false

    var body: some View {
        ScrollView {
            LazyVStack(alignment: .leading, spacing: 14) {
                switcher
                rangeBar
                if let screen {
                    report(screen)
                    footnotes(screen)
                } else if let failure {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This report could not be built",
                        message: failure, tone: .problem,
                        action: ("Try again", { Task { await load() } })
                    )
                    .frame(maxWidth: .infinity)
                } else {
                    ProgressView().frame(maxWidth: .infinity).padding(40)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.background)
        .navigationTitle("Reports")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
        #endif
        .sheet(isPresented: $showingRangeEditor) {
            if let range = shownRange ?? range {
                CustomRangeSheet(range: range) { self.range = $0 }
            }
        }
        .task(id: LoadKey(revision: revision, kind: kind, range: range, parentId: parentId)) {
            await load()
        }
    }

    private struct LoadKey: Equatable {
        let revision: Int
        let kind: ReportKind
        let range: DateRange?
        let parentId: String?
    }

    // MARK: - Choosing what to look at

    private var switcher: some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 8) {
                ForEach(ReportKind.allCases) { option in
                    Button {
                        // The drill level belongs to the report you are leaving.
                        if option != kind { parentId = nil }
                        kind = option
                    } label: {
                        Label(option.label, systemImage: option.symbol)
                            .font(.footnote.weight(kind == option ? .semibold : .regular))
                            .labelStyle(.titleAndIcon)
                            .padding(.horizontal, 11)
                            .padding(.vertical, 7)
                            .background(
                                kind == option ? AnyShapeStyle(Color.accentColor.opacity(0.16)) : AnyShapeStyle(.quaternary),
                                in: Capsule()
                            )
                            .foregroundStyle(kind == option ? AnyShapeStyle(Color.accentColor) : AnyShapeStyle(.primary))
                    }
                    .buttonStyle(.plain)
                    .accessibilityAddTraits(kind == option ? [.isSelected] : [])
                }
            }
            .padding(.horizontal, 1)
        }
    }

    private var rangeBar: some View {
        VStack(alignment: .leading, spacing: 8) {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(RangePreset.allCases, id: \.self) { preset in
                        Button(preset.label) { choose(preset) }
                            .font(.caption.weight(active == preset ? .semibold : .regular))
                            .buttonStyle(.plain)
                            .padding(.horizontal, 10)
                            .padding(.vertical, 5)
                            .background(
                                active == preset ? AnyShapeStyle(Color.accentColor.opacity(0.16)) : AnyShapeStyle(.quaternary),
                                in: Capsule()
                            )
                            .accessibilityAddTraits(active == preset ? [.isSelected] : [])
                    }
                    Button("Custom\u{2026}") { showingRangeEditor = true }
                        .font(.caption)
                        .buttonStyle(.plain)
                        .padding(.horizontal, 10)
                        .padding(.vertical, 5)
                        .background(.quaternary, in: Capsule())
                }
                .padding(.horizontal, 1)
            }
            if let range = shownRange ?? range {
                // The dates in words, always. A lit chip says which button was
                // pressed; this says what the figures below actually cover, and
                // that is the thing somebody reading a total needs.
                Text("\(Display.dateText(range.from)) \u{2013} \(Display.dateText(range.to))")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
        }
    }

    /// Which chip to light, derived from the RANGE rather than remembered from
    /// the last tap -- so a range restored from anywhere else still lights the
    /// right one, and a custom range lights none.
    private var active: RangePreset? {
        guard let range = shownRange ?? range else { return nil }
        return DateRange.matchingPreset(range, today: todayISO())
    }

    private func choose(_ preset: RangePreset) {
        range = try? DateRange.preset(
            preset, today: todayISO(), earliestTransactionDate: earliest
        )
    }

    // MARK: - The reports

    @ViewBuilder private func report(_ screen: ReportScreen) -> some View {
        switch screen.data {
        case .netWorth(let series, let headline):
            netWorthReport(series, headline: headline, currency: screen.baseCurrency)
        case .category(let report, let trail):
            categoryReport(report, trail: trail, currency: screen.baseCurrency)
        case .incomeExpense(let report):
            incomeExpenseReport(report, currency: screen.baseCurrency)
        case .cashFlow(let report):
            cashFlowReport(report, currency: screen.baseCurrency)
        case .payee(let report):
            entityReport(
                title: "Spending by payee",
                items: payeeItems(report, currency: screen.baseCurrency),
                total: report.rows.reduce(0) { $0 + $1.spentMinor },
                currency: screen.baseCurrency,
                emptyMessage: "No spending with a payee in this range."
            )
        case .tag(let report):
            tagReport(report, currency: screen.baseCurrency)
        }
    }

    private func netWorthReport(
        _ series: NetWorthSeries, headline: NetWorth, currency: String
    ) -> some View {
        CardSection(title: "Net worth over time") {
            if let last = series.points.last {
                VStack(alignment: .leading, spacing: 4) {
                    Text(Display.money(last.totalBaseMinor, currency))
                        .font(.system(.title, design: .rounded).weight(.semibold))
                        .monospacedDigit()
                    Text("as at \(Display.dateText(last.date))")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                if let note = Display.notCountedSummary(
                    count: headline.excludedCount,
                    baseMinor: headline.excludedBaseMinor,
                    baseCurrency: currency
                ) {
                    Text(note).font(.caption).foregroundStyle(.secondary)
                }
                NetWorthChart(points: series.points, currency: currency, height: 180)
                    .padding(.top, 6)
            } else {
                Text("No data in this range. Pick a wider one to see your net worth over time.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            }
        }
    }

    private func categoryReport(
        _ report: CategorySpendReport, trail: [CategoryCrumb], currency: String
    ) -> some View {
        CardSection(
            title: "Spending by category",
            caption: "Total \(Display.money(report.totalMinor, currency))"
        ) {
            breadcrumb(trail)
            if report.rows.isEmpty {
                Text(
                    parentId == nil
                        ? "No spending recorded in this date range."
                        : "No spending in this category for the range."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
            } else {
                BarList(
                    items: categoryItems(report, currency: currency),
                    label: "Spending by category"
                )
            }
        }
    }

    /// The trail, with every level above the current one a way back up.
    private func breadcrumb(_ trail: [CategoryCrumb]) -> some View {
        ScrollView(.horizontal, showsIndicators: false) {
            HStack(spacing: 4) {
                Button("All categories") { parentId = nil }
                    .font(.caption.weight(parentId == nil ? .semibold : .regular))
                    .buttonStyle(.plain)
                    .foregroundStyle(parentId == nil ? AnyShapeStyle(.primary) : AnyShapeStyle(Color.accentColor))
                    .disabled(parentId == nil)
                ForEach(Array(trail.enumerated()), id: \.element.id) { index, crumb in
                    Text("\u{203A}").font(.caption).foregroundStyle(.tertiary)
                    if index == trail.count - 1 {
                        Text(crumb.name).font(.caption.weight(.semibold)).lineLimit(1)
                    } else {
                        Button(crumb.name) { parentId = crumb.id }
                            .font(.caption)
                            .buttonStyle(.plain)
                            .foregroundStyle(Color.accentColor)
                            .lineLimit(1)
                    }
                }
            }
        }
        .accessibilityLabel("Category level")
    }

    private func categoryItems(_ report: CategorySpendReport, currency: String) -> [BarItem] {
        let largest = report.rows.map(\.spentMinor).max() ?? 0
        return report.rows.map { row in
            // The row for money logged ON the parent itself, when drilled in.
            // Without it, drilling into a category would show less than the row
            // you drilled from and the difference would be invisible.
            let isSelfRow = parentId != nil && row.categoryId == parentId
            let canDrill = row.hasChildren && row.categoryId != nil && !isSelfRow
            let id = row.categoryId
            return BarItem(
                id: id ?? "uncategorised",
                name: row.name,
                value: Display.money(row.spentMinor, currency),
                spokenValue: Display.moneySpoken(row.spentMinor, currency),
                fraction: largest > 0 ? Double(row.spentMinor) / Double(largest) : 0,
                share: report.totalMinor > 0
                    ? percentText(Double(row.spentMinor) / Double(report.totalMinor)) : nil,
                colourHex: row.colour,
                chip: isSelfRow ? "directly" : spendChip(row.spentMinor),
                drill: canDrill ? { parentId = id } : nil
            )
        }
    }

    private func incomeExpenseReport(
        _ report: MonthlyReport<MonthlyIncomeExpense>, currency: String
    ) -> some View {
        // One scale across every month, so the bars can be compared down the
        // list. Per-month scaling would make a £20 month look like a £2,000 one.
        let scale = report.rows.flatMap { [$0.incomeMinor, $0.expenseMinor] }.max() ?? 0
        let empty = report.rows.allSatisfy { $0.incomeMinor == 0 && $0.expenseMinor == 0 }
        return CardSection(title: "Income vs expense", caption: "By month") {
            if report.rows.isEmpty || empty {
                Text("No income or spending in this range.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(report.rows, id: \.month) { row in
                        MonthFlowRow(
                            month: row.month,
                            incomeMinor: row.incomeMinor,
                            expenseMinor: row.expenseMinor,
                            currency: currency,
                            scaleMinor: scale
                        )
                    }
                }
            }
        }
    }

    private func cashFlowReport(
        _ report: MonthlyReport<MonthlyCashFlow>, currency: String
    ) -> some View {
        let scale = report.rows.map { abs($0.netMinor) }.max() ?? 0
        return CardSection(
            title: "Cash flow",
            caption: report.rows.last.map {
                "Across this range, \(Display.money($0.cumulativeMinor, currency))"
            }
        ) {
            if report.rows.isEmpty {
                Text("No months in this range.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(report.rows, id: \.month) { row in
                        CashFlowRow(
                            month: row.month,
                            netMinor: row.netMinor,
                            cumulativeMinor: row.cumulativeMinor,
                            currency: currency,
                            scaleMinor: scale
                        )
                    }
                }
            }
        }
    }

    private func payeeItems(_ report: PayeeSpendReport, currency: String) -> [BarItem] {
        let largest = report.rows.map(\.spentMinor).max() ?? 0
        let total = report.rows.reduce(Int64(0)) { $0 + $1.spentMinor }
        return report.rows.map { row in
            BarItem(
                id: row.payeeId ?? "none",
                name: row.name,
                value: Display.money(row.spentMinor, currency),
                spokenValue: Display.moneySpoken(row.spentMinor, currency),
                fraction: largest > 0 ? Double(row.spentMinor) / Double(largest) : 0,
                share: total > 0 ? percentText(Double(row.spentMinor) / Double(total)) : nil,
                colourHex: nil,
                chip: spendChip(row.spentMinor) ?? Display.count(row.txCount, "transaction"),
                drill: nil
            )
        }
    }

    private func tagReport(_ report: TagSpendReport, currency: String) -> some View {
        let largest = report.rows.map(\.spentMinor).max() ?? 0
        let items = report.rows.map { row in
            BarItem(
                id: row.tagId,
                name: row.name,
                value: Display.money(row.spentMinor, currency),
                spokenValue: Display.moneySpoken(row.spentMinor, currency),
                fraction: largest > 0 ? Double(row.spentMinor) / Double(largest) : 0,
                // NO PERCENTAGES HERE, deliberately. A transaction with two
                // tags counts in full under each, so tag totals do not add up
                // to the spend total -- and a column of percentages summing to
                // 140% would look like a bug rather than like the question
                // being asked.
                share: nil,
                colourHex: nil,
                chip: spendChip(row.spentMinor) ?? Display.count(row.txCount, "transaction"),
                drill: nil
            )
        }
        return CardSection(title: "Spending by tag") {
            if items.isEmpty {
                Text("No tagged spending in this range.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                BarList(items: items, label: "Spending by tag")
                Text(
                    "A transaction with several tags counts in full under each, so these do not "
                        + "add up to your total spending."
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    private func entityReport(
        title: String, items: [BarItem], total: Int64, currency: String, emptyMessage: String
    ) -> some View {
        CardSection(title: title, caption: "Total \(Display.money(total, currency))") {
            if items.isEmpty {
                Text(emptyMessage).font(.footnote).foregroundStyle(.secondary)
            } else {
                BarList(items: items, label: title)
            }
        }
    }

    private func footnotes(_ screen: ReportScreen) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            MissingRateNote(
                count: screen.missingRateCount, currencies: screen.missingRateCurrencies
            )
            // The rule that surprises people most, said once per screen rather
            // than not at all: a transfer is not spending.
            if screen.kind != .netWorth {
                Text("Transfers between your own accounts are not counted as income or spending.")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .padding(.horizontal, 4)
    }

    // MARK: - Loading

    /// `@MainActor`, and it has to be said out loud.
    ///
    /// A `View`'s `body` is main-actor isolated but a plain `private func` on
    /// the same struct is NOT, so an `async` loader without this annotation
    /// resumes on a background executor after its first `await` -- and the
    /// `@State` writes that follow land off the main actor. `State`'s setter is
    /// `nonisolated`, so Swift 6 does not complain and the compiler cannot save
    /// you: the write happens, the value is correct, and SwiftUI simply never
    /// re-renders.
    ///
    /// Found on a real screen. Tapping a different report lit the chip, changed
    /// the date line, ran the query and produced the right rows -- and left the
    /// previous report's chart on screen. Diagnosed by logging: the data was
    /// always right, the view was never told.
    @MainActor private func load() async {
        do {
            if earliest == nil { earliest = try await app.service.earliestTransactionDate() }
            let resolved = try resolvedRange()
            shownRange = resolved
            screen = try await app.service.report(kind, range: resolved, parentId: parentId)
            failure = nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }

    /// The opening range is THIS YEAR TO DATE, which is what the web app's
    /// reports page opens on.
    private func resolvedRange() throws -> DateRange {
        if let range { return range }
        return try DateRange.thisYearToDate(today: todayISO())
    }
}

/// Two dates, typed.
///
/// AN INVERTED RANGE IS NOT AN ERROR AND IS NOT SWAPPED. `DateRange` treats
/// from > to as empty, and this sheet says so rather than quietly reordering
/// what somebody typed -- a picker that silently swapped the dates would hide
/// a mis-typed year.
struct CustomRangeSheet: View {
    @Environment(\.dismiss) private var dismiss
    @State private var from: String
    @State private var to: String
    let apply: (DateRange) -> Void

    init(range: DateRange, apply: @escaping (DateRange) -> Void) {
        _from = State(initialValue: range.from)
        _to = State(initialValue: range.to)
        self.apply = apply
    }

    private var inverted: Bool { from > to }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    CalendarDateField(title: "From", iso: $from)
                    CalendarDateField(title: "To", iso: $to)
                } footer: {
                    if inverted {
                        Text(
                            "The end is before the start, so this range covers no days at all. "
                                + "Swap them to see figures."
                        )
                        .foregroundStyle(.orange)
                    } else {
                        Text("Both days are included.")
                    }
                }
            }
            .navigationTitle("Date range")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                ActionBar {
                    PrimaryAction(title: "Apply") {
                        apply(DateRange(from: from, to: to))
                        dismiss()
                    }
                    .reachProbe("Date range \u{2014} Apply")
                }
            }
            .toolbar {
                // Cancel stays top-left. See `ActionBar`.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }
}
