// "How am I doing?" -- the one screen that has to answer it without scrolling
// far and without a tap.
//
// EVERY FIGURE ON THIS SCREEN COMES OUT OF `Dashboard.summary` ALREADY
// DECIDED. There is no arithmetic in this file: not a subtraction, not a
// percentage, not a `max`. That is not tidiness. A view is the one layer with
// no tests behind it, and a headline computed here would be a second answer to
// a question `MyMoneyKit` already answers under 284 oracle cases -- and the
// first symptom of the two disagreeing would be a net worth on the dashboard
// that differs by a penny from the one on the accounts screen.
//
// THE ORDER OF THE CARDS IS THE WEB APP'S: net worth, this month, budgets,
// recent transactions, top categories. The owner already knows where things
// are; a phone that rearranged them would make him look for each one.
//
// AND THE COPY BANNER IS ABOVE ALL OF IT, unscrollable, as it is everywhere
// else. This screen shows the most authoritative-looking number in the app, so
// it is the screen that most needs to say whose number it is.
import MyMoneyKit
import SwiftUI

struct DashboardView: View {
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

    /// The shell's route binding, so a card's "see all" is a real navigation
    /// rather than a dead link.
    @Binding var selection: Route?
    /// Opening a recent transaction is the shell's job -- it owns the sheets.
    let onSelectTransaction: (String) -> Void

    @State private var screen: DashboardScreen?
    @State private var failure: String?

    var body: some View {
        ScrollView {
            LazyVStack(spacing: 14) {
                if let screen {
                    netWorthCard(screen.summary)
                    thisMonthCard(screen.summary)
                    budgetsCard(screen.summary)
                    recentCard(screen)
                    topCategoriesCard(screen.summary)
                } else if let failure {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This screen could not be built",
                        message: failure
                            + "\n\nYour web app is unaffected \u{2014} it holds the real ledger.",
                        tone: .problem,
                        action: ("Try again", { Task { await load() } })
                    )
                } else {
                    ProgressView().padding(40)
                }
            }
            .padding(16)
            .frame(maxWidth: 760)
            .frame(maxWidth: .infinity)
        }
        .background(.background)
        .navigationTitle("Dashboard")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.large)
        #endif
        .task(id: revision) { await load() }
    }

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
            screen = try await app.service.dashboard(today: todayISO())
            failure = screen == nil ? "There is no book on this device yet." : nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }

    // MARK: - Net worth

    private func netWorthCard(_ summary: DashboardSummary) -> some View {
        CardSection(title: "Net worth") {
            VStack(alignment: .leading, spacing: 10) {
                Text(Display.money(summary.netWorth.totalBaseMinor, summary.baseCurrency))
                    .font(.system(.largeTitle, design: .rounded).weight(.semibold))
                    .monospacedDigit()
                    .minimumScaleFactor(0.6)
                    .lineLimit(1)
                    .accessibilityLabel("Net worth")
                    .accessibilityValue(
                        Display.moneySpoken(summary.netWorth.totalBaseMinor, summary.baseCurrency)
                    )

                if let trend = summary.trend {
                    trendLine(trend, currency: summary.baseCurrency)
                }

                // The same sentence the accounts screen and the web app use, so
                // the big number never quietly means something different from
                // the list of accounts it came from.
                if let note = Display.notCountedSummary(
                    count: summary.netWorth.excludedCount,
                    baseMinor: summary.netWorth.excludedBaseMinor,
                    baseCurrency: summary.baseCurrency
                ) {
                    Text(note)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
                MissingRateNote(currencies: summary.netWorth.missingRateCurrencies)

                NetWorthChart(points: summary.sparkline, currency: summary.baseCurrency)
                    .padding(.top, 4)
                laterDatedNote(summary)
            }
        }
    }

    /// THE HEADLINE AND THE LINE END ON DIFFERENT DAYS when the owner has
    /// entered a transaction dated ahead. Both figures are on this card, six
    /// points apart, and they differ -- so the card says why rather than
    /// leaving somebody to wonder which of the two is broken.
    @ViewBuilder private func laterDatedNote(_ summary: DashboardSummary) -> some View {
        if let later = summary.laterDatedMinor, later != 0 {
            Text(
                "The line runs to today. "
                    + "\(Display.money(abs(later), summary.baseCurrency)) of the figure above is "
                    + (later > 0
                        ? "dated later and is not on it yet."
                        : "dated later and comes off it.")
            )
            .font(.caption2)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// "Up £412.00 since 30 April" -- the change, and WHAT SINCE.
    ///
    /// The date is not decoration. "Up £412" on its own is a number the reader
    /// has to guess the period of, and the guess is usually "this month", which
    /// is wrong here: the window is six months.
    private func trendLine(_ trend: NetWorthTrend, currency: String) -> some View {
        let rising = trend.changeMinor > 0
        let flat = trend.changeMinor == 0
        let word = flat ? "Level" : (rising ? "Up" : "Down")
        let amount = Display.money(abs(trend.changeMinor), currency)
        return HStack(spacing: 6) {
            Image(
                systemName: flat
                    ? "arrow.right" : (rising ? "arrow.up.right" : "arrow.down.right")
            )
            .font(.caption.weight(.bold))
            .accessibilityHidden(true)
            Text(
                flat
                    ? "Level since \(Display.dateText(trend.fromDate))"
                    : "\(word) \(amount) since \(Display.dateText(trend.fromDate))"
            )
            .font(.subheadline)
        }
        .foregroundStyle(flat ? AnyShapeStyle(.secondary) : AnyShapeStyle(rising ? Color.green : Color.red))
        .accessibilityElement(children: .combine)
        .accessibilityLabel(
            flat
                ? "Level since \(Display.dateSpoken(trend.fromDate))"
                : "\(word) \(Display.moneySpoken(abs(trend.changeMinor), currency)) since "
                    + Display.dateSpoken(trend.fromDate)
        )
    }

    // MARK: - This month

    private func thisMonthCard(_ summary: DashboardSummary) -> some View {
        let month = summary.thisMonth
        return CardSection(title: "This month", caption: monthLabel(month.month)) {
            VStack(alignment: .leading, spacing: 12) {
                HStack(alignment: .top, spacing: 24) {
                    figure("In", month.incomeMinor, summary.baseCurrency, .green)
                    figure("Out", month.expenseMinor, summary.baseCurrency, .red)
                }
                // The two-colour bar is decoration for the two figures above,
                // which is why it is hidden from a screen reader rather than
                // described: it says nothing they do not. It is drawn ONLY when
                // there is a share to draw -- a month whose refunds beat its
                // spending has no meaningful split, and a bar drawn anyway
                // would be a picture of a month that did not happen.
                if let share = month.incomeShare {
                    GeometryReader { geometry in
                        HStack(spacing: 2) {
                            Capsule().fill(Color.green.opacity(0.85))
                                .frame(width: max(0, geometry.size.width * share - 1))
                            Capsule().fill(Color.red.opacity(0.85))
                        }
                    }
                    .frame(height: 8)
                    .accessibilityHidden(true)
                }
                Text(netSentence(month, currency: summary.baseCurrency))
                    .font(.subheadline)
                    .foregroundStyle(.secondary)
                if month.isEmpty {
                    Text("Nothing logged this month yet.")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                }
                // The two sentences that stop a negative figure reading as a
                // bug. Both are rare and both are real.
                if month.refundsExceededSpending {
                    Text(
                        "Refunds this month came to more than the spending, so \u{201C}Out\u{201D} "
                            + "is money that came back."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                if month.clawbacksExceededIncome {
                    Text(
                        "More was taken back from income this month than came in, so "
                            + "\u{201C}In\u{201D} is negative."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                MissingRateNote(count: month.missingRateCount)
            }
        }
    }

    private func figure(_ label: String, _ minor: Int64, _ currency: String, _ colour: Color)
        -> some View
    {
        VStack(alignment: .leading, spacing: 2) {
            Text(label)
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(Display.money(minor, currency))
                .font(.title2.weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(colour)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label == "In" ? "Money in" : "Money out")
        .accessibilityValue(Display.moneySpoken(minor, currency))
    }

    private func netSentence(_ month: MonthFlow, currency: String) -> String {
        let sign = month.netMinor > 0 ? "+" : ""
        return "Net \(sign)\(Display.money(month.netMinor, currency))"
    }

    // MARK: - Budgets

    private func budgetsCard(_ summary: DashboardSummary) -> some View {
        CardSection(
            title: "Budgets",
            caption: summary.budgetCount > summary.budgets.count
                ? "The \(summary.budgets.count) closest to their limit of \(summary.budgetCount)"
                : nil,
            trailing: AnyView(
                Button("All budgets") { selection = .budgets }
                    .font(.footnote)
            )
        ) {
            if summary.budgets.isEmpty {
                VStack(alignment: .leading, spacing: 8) {
                    Text(
                        "A budget sets a spending limit for chosen categories each week, month or "
                            + "year, and tracks how you are doing against it."
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    Button("Create a budget") { selection = .budgets }
                        .font(.footnote.weight(.medium))
                }
            } else {
                VStack(spacing: 14) {
                    ForEach(summary.budgets) { line in
                        VStack(alignment: .leading, spacing: 5) {
                            HStack {
                                Text(line.budget.name)
                                    .font(.callout.weight(.medium))
                                    .lineLimit(1)
                                Spacer(minLength: 8)
                                if line.progress.over {
                                    Text("Over")
                                        .font(.caption2.weight(.semibold))
                                        .foregroundStyle(.red)
                                        .padding(.horizontal, 6)
                                        .padding(.vertical, 1)
                                        .overlay(Capsule().stroke(.red, lineWidth: 1))
                                }
                            }
                            BudgetBar(progress: line.progress, currency: summary.baseCurrency)
                            BudgetStatusLine(
                                progress: line.progress, currency: summary.baseCurrency
                            )
                        }
                        .accessibilityElement(children: .contain)
                    }
                }
                MissingRateNote(count: summary.budgetMissingRateCount)
            }
        }
    }

    // MARK: - Recent transactions

    private func recentCard(_ screen: DashboardScreen) -> some View {
        CardSection(
            title: "Recent",
            trailing: AnyView(
                Button("All \(Display.grouped(screen.transactionCount))") {
                    selection = .allTransactions
                }
                .font(.footnote)
            )
        ) {
            if screen.recent.isEmpty {
                Text("No transactions yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                VStack(spacing: 0) {
                    ForEach(screen.recent) { row in
                        Button {
                            onSelectTransaction(row.id)
                        } label: {
                            RecentRow(row: row)
                        }
                        .buttonStyle(.plain)
                        if row.id != screen.recent.last?.id { Divider() }
                    }
                }
            }
        }
    }

    // MARK: - Top categories

    private func topCategoriesCard(_ summary: DashboardSummary) -> some View {
        CardSection(
            title: "Top categories",
            caption: monthLabel(summary.thisMonth.month),
            trailing: AnyView(
                Button("Reports") { selection = .reports }
                    .font(.footnote)
            )
        ) {
            if summary.topCategories.isEmpty {
                Text("No spending this month yet.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                BarList(
                    items: categoryItems(summary),
                    label: "Top spending categories this month"
                )
                MissingRateNote(count: summary.categoryMissingRateCount)
            }
        }
    }

    private func categoryItems(_ summary: DashboardSummary) -> [BarItem] {
        // The scale is the biggest row ON SCREEN; the SHARE is of the whole
        // month, including the categories that did not make the card. A share
        // of the five shown would add to 100% and be a lie.
        let largest = summary.topCategories.map(\.spentMinor).max() ?? 0
        return summary.topCategories.map { row in
            BarItem(
                id: row.categoryId ?? "uncategorised",
                name: row.name,
                value: Display.money(row.spentMinor, summary.baseCurrency),
                spokenValue: Display.moneySpoken(row.spentMinor, summary.baseCurrency),
                fraction: largest > 0 ? Double(row.spentMinor) / Double(largest) : 0,
                share: summary.categoryTotalMinor > 0
                    ? percentText(Double(row.spentMinor) / Double(summary.categoryTotalMinor))
                    : nil,
                colourHex: row.colour,
                chip: spendChip(row.spentMinor),
                drill: nil
            )
        }
    }
}

/// A compact register row for the dashboard, using the register's own words.
struct RecentRow: View {
    let row: RegisterRow

    var body: some View {
        HStack(spacing: 10) {
            AccountDot(hex: row.accountColour)
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.callout)
                    .foregroundStyle(row.titleIsPlaceholder ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                Text(Register.categoryText(row.categoryLine))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(Display.money(row.amountMinor, row.currency))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(amountColour(row.amountMinor))
                    .lineLimit(1)
                Text(Display.dateText(row.date))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 8)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title), \(Register.categoryText(row.categoryLine))")
        .accessibilityValue(
            "\(Display.moneyFlowSpoken(row.amountMinor, row.currency)), "
                + "\(Display.dateSpoken(row.date)), \(row.accountName)"
        )
    }
}
