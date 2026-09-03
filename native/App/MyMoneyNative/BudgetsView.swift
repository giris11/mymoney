// Budgets: the list, and one budget's own period.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE THINGS THIS SCREEN HAS TO GET RIGHT, all of them in the kit:
//
//   1. A BUDGET COVERS ITS CATEGORIES AND EVERYTHING BENEATH THEM (D16). A
//      budget over "Food" counts what was filed under "Food › Groceries" too.
//      That is `Categories.descendantIds`, held to the oracle, and it is why
//      the editor's picker says so in words underneath.
//   2. THE PERIOD GRID TILES THE TIMELINE. Every date is in exactly one window,
//      including dates before the budget started, and a monthly budget anchored
//      on the 31st does not drift a day earlier every February. Stepping
//      backwards and forwards here is `Budgets.shiftWindow`, which moves the
//      INDEX on the grid rather than the dates -- see Budgets.swift for the bug
//      that stops.
//   3. AN EXCLUDED TRANSACTION IS COUNTED AND NAMED, never guessed at a rate
//      nobody set (SPEC §6).
//
// THE LIST IS IN NAME ORDER AND STAYS THERE while you look at it. Sorting by
// "most over" would be more useful for a second and would then reorder itself
// under your thumb every time a transaction landed.
//
// ARCHIVED BUDGETS ARE LISTED, not hidden. Deleting is a tombstone with an
// undo, because a budget is a set of decisions and re-entering them is exactly
// the small loss that makes somebody stop trusting an app.
import MyMoneyKit
import SwiftUI

/// Where the budgets screen is pointed. A value, so the list and the detail are
/// one `NavigationStack` and Back works without any state of its own.
struct BudgetRoute: Hashable {
    let id: String
}

struct BudgetsView: View {
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

    @State private var screen: BudgetsScreen?
    @State private var failure: String?
    @State private var editing: BudgetEditorSheet?
    @State private var confirmingDelete: Budget?
    @State private var refusal: EditRefusal?

    var body: some View {
        // A MEASUREMENT ASKING FOR THE DETAIL SCREEN gets it in the same
        // navigation stack a push would have used, so its bottom bar composes
        // with the same insets. False in every launch that is not a
        // measurement; see `Reach.opening`.
        if Reach.isOpening("budgets.detail"), let first = screen?.lines.first {
            BudgetDetailView(budgetId: first.budget.id, revision: revision)
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if let refusal {
                Section { RefusalNotice(refusal: refusal) }
            }
            if let screen {
                if screen.isEmpty {
                    Section {
                        Notice(
                            symbol: "chart.pie",
                            title: "No budgets yet",
                            message:
                                "A budget sets a spending limit for chosen categories each week, "
                                + "month or year, and tracks how you are doing against it. "
                                + "Subcategories count towards it too."
                            // NO BUTTON IN THIS NOTICE. It used to carry
                            // "Create your first budget", which now sits in the
                            // bar at the bottom of the screen -- and a centred
                            // button halfway up saying the same thing would be
                            // both a duplicate and the one of the two that a
                            // thumb cannot reach.
                        )
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    liveSection(screen)
                    archivedSection(screen)
                }
            } else if let failure {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "Budgets could not be read",
                        message: failure,
                        tone: .problem,
                        action: ("Try again", { Task { await load() } })
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Budgets")
        // The "+" that used to sit in the navigation bar. It is the only thing
        // this screen is for other than reading, so it goes where the thumb is.
        .safeAreaInset(edge: .bottom) {
            if screen != nil {
                ActionBar {
                    PrimaryAction(
                        title: "New budget", systemImage: "plus",
                        probe: "Budgets \u{2014} New budget"
                    ) {
                        editing = .creating
                    }
                }
            }
        }
        .navigationDestination(for: BudgetRoute.self) { route in
            BudgetDetailView(budgetId: route.id, revision: revision)
        }
        .sheet(item: $editing) { which in
            BudgetEditor(
                categories: screen?.categories ?? [],
                baseCurrency: screen?.baseCurrency ?? "GBP",
                existing: which.budget
            )
        }
        .confirmationDialog(
            "Delete \u{201C}\(confirmingDelete?.name ?? "")\u{201D}?",
            isPresented: Binding(
                get: { confirmingDelete != nil },
                set: { if !$0 { confirmingDelete = nil } }
            ),
            titleVisibility: .visible
        ) {
            Button("Delete budget", role: .destructive) {
                if let budget = confirmingDelete {
                    confirmingDelete = nil
                    Task { await delete(budget) }
                }
            }
            Button("Cancel", role: .cancel) { confirmingDelete = nil }
        } message: {
            // The sentence that matters: no money is involved. A confirmation
            // that did not say so would make people archive when they meant to
            // delete, for ever.
            Text("No transaction is changed. You can undo this straight afterwards.")
        }
        .task(id: revision) {
            await load()
            // The one sheet a measurement can ask for here. Cannot fire
            // without MYMONEY_REACH=1.
            if Reach.isOpening("budgets.new") { editing = .creating }
        }
    }

    // MARK: - Sections

    private func liveSection(_ screen: BudgetsScreen) -> some View {
        Section {
            ForEach(screen.lines) { line in
                NavigationLink(value: BudgetRoute(id: line.budget.id)) {
                    BudgetRow(line: line, currency: screen.baseCurrency)
                }
                .swipeActions(edge: .trailing) {
                    Button(role: .destructive) {
                        confirmingDelete = line.budget
                    } label: {
                        Label("Delete", systemImage: "trash")
                    }
                    Button {
                        Task { await archive(line.budget.id, true) }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    .tint(.orange)
                }
                .contextMenu {
                    Button {
                        editing = .editing(line.budget)
                    } label: {
                        Label("Edit\u{2026}", systemImage: "pencil")
                    }
                    Button {
                        Task { await archive(line.budget.id, true) }
                    } label: {
                        Label("Archive", systemImage: "archivebox")
                    }
                    Divider()
                    Button(role: .destructive) {
                        confirmingDelete = line.budget
                    } label: {
                        Label("Delete\u{2026}", systemImage: "trash")
                    }
                }
            }
        }
        // NO SECTION-WIDE MISSING-RATE NOTE. Each row carries its own, which
        // says WHICH budget is short a figure; a total underneath repeated the
        // same sentence a second time and named nothing.
    }

    @ViewBuilder private func archivedSection(_ screen: BudgetsScreen) -> some View {
        if !screen.archived.isEmpty {
            Section {
                ForEach(screen.archived) { budget in
                    HStack {
                        Text(budget.name)
                            .foregroundStyle(.secondary)
                        Spacer(minLength: 8)
                        Button("Unarchive") { Task { await archive(budget.id, false) } }
                            .buttonStyle(.borderless)
                            .font(.footnote)
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            confirmingDelete = budget
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                }
            } header: {
                Text("Archived")
            } footer: {
                Text(
                    "An archived budget keeps its limit and its categories, and stops counting "
                        + "towards how this month is going."
                )
            }
        }
    }

    // MARK: - Doing things

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
            screen = try await app.service.budgetsScreen(today: todayISO())
            failure = nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }

    @MainActor private func archive(_ id: String, _ archived: Bool) async {
        refusal = await app.setBudgetArchived(id: id, archived: archived).refusal
    }

    @MainActor private func delete(_ budget: Budget) async {
        refusal = await app.deleteBudget(id: budget.id, named: budget.name).refusal
    }
}

/// One row of the list: name, bar, and the sentence.
struct BudgetRow: View {
    let line: BudgetLine
    let currency: String

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack {
                Text(line.budget.name)
                    .font(.body.weight(.medium))
                    .lineLimit(1)
                Spacer(minLength: 8)
                Text(periodWord(line.budget.period))
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
            BudgetBar(progress: line.progress, currency: currency)
            BudgetStatusLine(progress: line.progress, currency: currency)
            Text(windowLabel(line.progress.window))
                .font(.caption2)
                .foregroundStyle(.tertiary)
            MissingRateNote(count: line.progress.missingRateCount)
        }
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

// MARK: - One budget

struct BudgetDetailView: View {
    @Environment(AppModel.self) private var app
    let budgetId: String
    /// See `BudgetsView.revision`.
    let revision: Int

    /// Periods away from the one containing today. The window is derived from
    /// it rather than stored, so a window that is not on the grid cannot be
    /// reached: `Budgets.shiftWindow` moves the INDEX, never the dates.
    @State private var offset = 0
    @State private var screen: BudgetDetailScreen?
    @State private var failure: String?
    @State private var editing: BudgetEditorSheet?

    /// Roughly fifty years of monthly windows. A bound, so a stuck finger on
    /// the chevron cannot walk the grid into the year 20,000.
    private let maximumSteps = 600

    var body: some View {
        List {
            if let screen {
                Section {
                    periodBar(screen)
                    headline(screen)
                }
                categoriesSection(screen)
                rowsSection(screen)
            } else if let failure {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This budget could not be read", message: failure, tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle(screen?.budget.name ?? "Budget")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .bottom) {
            if let budget = screen?.budget {
                ActionBar {
                    PrimaryAction(
                        title: "Edit this budget", systemImage: "pencil",
                        probe: "Budget detail \u{2014} Edit"
                    ) {
                        editing = .editing(budget)
                    }
                }
            }
        }
        .sheet(item: $editing) { which in
            BudgetEditor(
                categories: [], baseCurrency: screen?.baseCurrency ?? "GBP",
                existing: which.budget
            )
        }
        .task(id: TaskKey(revision: revision, offset: offset)) { await load() }
    }

    private struct TaskKey: Equatable {
        let revision: Int
        let offset: Int
    }

    // MARK: Period navigation

    private func periodBar(_ screen: BudgetDetailScreen) -> some View {
        HStack {
            Button {
                offset = max(-maximumSteps, offset - 1)
            } label: {
                Image(systemName: "chevron.left")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Previous period")

            Spacer(minLength: 8)
            VStack(spacing: 1) {
                Text(windowLabel(screen.progress.window))
                    .font(.subheadline.weight(.medium))
                    .lineLimit(1)
                    .minimumScaleFactor(0.7)
                if !screen.isCurrentPeriod {
                    Button("Back to this \(periodNoun(screen.budget.period))") { offset = 0 }
                        .font(.caption2)
                        .buttonStyle(.borderless)
                }
            }
            Spacer(minLength: 8)

            Button {
                offset = min(maximumSteps, offset + 1)
            } label: {
                Image(systemName: "chevron.right")
            }
            .buttonStyle(.borderless)
            .accessibilityLabel("Next period")
        }
    }

    private func headline(_ screen: BudgetDetailScreen) -> some View {
        VStack(alignment: .leading, spacing: 8) {
            Text(Display.money(screen.progress.spentMinor, screen.baseCurrency))
                .font(.system(.title, design: .rounded).weight(.semibold))
                .monospacedDigit()
                .accessibilityLabel("Spent this period")
                .accessibilityValue(
                    Display.moneySpoken(screen.progress.spentMinor, screen.baseCurrency)
                )
            BudgetBar(progress: screen.progress, currency: screen.baseCurrency)
            BudgetStatusLine(progress: screen.progress, currency: screen.baseCurrency)
            MissingRateNote(count: screen.progress.missingRateCount)
        }
        .padding(.vertical, 4)
    }

    @ViewBuilder private func categoriesSection(_ screen: BudgetDetailScreen) -> some View {
        Section {
            ForEach(Array(screen.categoryNames.enumerated()), id: \.offset) { _, name in
                Text(name).font(.callout)
            }
        } header: {
            Text("Categories")
        } footer: {
            // D16, stated where it is being relied on. Somebody looking at a
            // figure bigger than they expected should find the reason here.
            Text("Spending in any subcategory of these counts towards the budget.")
        }
    }

    @ViewBuilder private func rowsSection(_ screen: BudgetDetailScreen) -> some View {
        Section {
            if screen.rows.isEmpty {
                Text("Nothing counted towards this budget in this period.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(screen.rows) { row in
                    BudgetContributionRow(row: row)
                }
            }
        } header: {
            Text("What counted")
        } footer: {
            if screen.rows.contains(where: \.isPartOfASplit) {
                // Without this line a split row looks like a wrong number: the
                // register shows the whole transaction, and this screen shows
                // the part of it this budget actually counted.
                Text(
                    "A split transaction shows the part of it this budget counted, not its whole "
                        + "amount."
                )
            }
        }
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
            screen = try await app.service.budgetDetail(
                id: budgetId, offset: offset, today: todayISO()
            )
            failure = screen == nil ? "This budget is no longer in this copy of the book." : nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }
}

struct BudgetContributionRow: View {
    let row: BudgetContribution

    var body: some View {
        HStack(spacing: 10) {
            VStack(alignment: .leading, spacing: 1) {
                Text(row.title)
                    .font(.callout)
                    .foregroundStyle(row.titleIsPlaceholder ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                    .lineLimit(1)
                Text(row.categoryText)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 1) {
                Text(Display.money(row.countedMinor, row.currency))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                    .foregroundStyle(amountColour(row.countedMinor))
                if row.isPartOfASplit {
                    Text("of \(Display.money(row.amountMinor, row.currency))")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                }
                Text(Display.dateText(row.date))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
        .padding(.vertical, 2)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(row.title), \(row.categoryText)")
        .accessibilityValue(
            "\(Display.moneyFlowSpoken(row.countedMinor, row.currency))"
                + (row.isPartOfASplit
                    ? ", part of \(Display.moneySpoken(row.amountMinor, row.currency))" : "")
                + ", \(Display.dateSpoken(row.date))"
        )
    }
}

// MARK: - Wording shared by both screens

/// "1–31 Aug 2026", "28 Jul – 3 Aug 2026", "28 Dec 2026 – 3 Jan 2027".
/// The same three shapes the web app's `windowLabel` produces.
func windowLabel(_ window: PeriodWindow) -> String {
    let start = window.start
    let end = window.end
    guard start.count == 10, end.count == 10 else { return "\(start) \u{2013} \(end)" }
    if start == end { return Display.dateText(start) }
    let sameYear = start.prefix(4) == end.prefix(4)
    let sameMonth = sameYear && start.prefix(7) == end.prefix(7)
    if sameMonth {
        // "1–31 Aug 2026": the day alone, then the full end.
        let day = String(Int(start.suffix(2)) ?? 1)
        return "\(day)\u{2013}\(Display.dateText(end))"
    }
    if sameYear {
        // "28 Jul – 3 Aug 2026": the year said once, at the end.
        let startText = Display.dateText(start)
        let withoutYear = startText.split(separator: " ").dropLast().joined(separator: " ")
        return "\(withoutYear) \u{2013} \(Display.dateText(end))"
    }
    return "\(Display.dateText(start)) \u{2013} \(Display.dateText(end))"
}

func periodWord(_ period: BudgetPeriod) -> String {
    switch period {
    case .weekly: return "Weekly"
    case .monthly: return "Monthly"
    case .yearly: return "Yearly"
    }
}

func periodNoun(_ period: BudgetPeriod) -> String {
    switch period {
    case .weekly: return "week"
    case .monthly: return "month"
    case .yearly: return "year"
    }
}
