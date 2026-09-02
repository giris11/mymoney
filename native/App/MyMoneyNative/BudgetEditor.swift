// Making and changing a budget.
//
// A BUDGET IS FOUR DECISIONS -- a name, some categories, a limit, and the day
// its periods are anchored to -- and the last one is the one nobody expects to
// matter. It does: the anchor is what the whole window grid is built from, so a
// monthly budget started on the 15th runs 15th to 14th, not 1st to end of
// month. The form says so, in words, under the field, because the alternative
// is somebody wondering for a month why their figures look wrong.
//
// THE FORM VALIDATES NOTHING ITSELF. It disables Save while the draft cannot
// possibly be valid -- a blank name, no categories, an unreadable amount -- and
// otherwise sends it and shows what comes back. The store's refusals are the
// rules (`LedgerStore.saveBudget`), they are tested, and a second copy of them
// here would be a second set of rules to keep in step.
//
// AND THE AMOUNT IS IN THE BASE CURRENCY (D22), not in any account's. A budget
// spans accounts, so it cannot be denominated in one of them. The field says
// which currency it is in rather than assuming the reader knows.
import MyMoneyKit
import SwiftUI

/// Which budget editor is open. `Identifiable` so it can drive a sheet.
enum BudgetEditorSheet: Identifiable {
    case creating
    case editing(Budget)

    var id: String {
        switch self {
        case .creating: return "new"
        case .editing(let budget): return budget.id
        }
    }

    var budget: Budget? {
        if case .editing(let budget) = self { return budget }
        return nil
    }
}

struct BudgetEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let categories: [CategoryChoice]
    let baseCurrency: String
    let existing: Budget?

    @State private var name = ""
    @State private var chosen: [String] = []
    /// `.into` FROM THE START, and never anything else.
    ///
    /// `TypedAmount` defaults to money OUT, because almost everything typed
    /// into this app is an expense. A budget LIMIT is not an amount that moves
    /// in a direction at all -- it is a ceiling -- so the field hides the
    /// in/out control and the value has to be positive. Left at the default,
    /// the form read "-£450.00" back in red and refused to save, which is a
    /// correct refusal of a figure nobody typed.
    @State private var amount = TypedAmount(direction: .into)
    @State private var period: BudgetPeriod = .monthly
    @State private var startDate = todayISO()
    @State private var refusal: EditRefusal?
    @State private var saving = false
    @State private var loadedCategories: [CategoryChoice] = []

    /// Only EXPENSE categories are offered.
    ///
    /// A budget over an income category would count a salary as spending and
    /// report it as 3,000% over -- which is not a limit anybody can be under.
    /// The web app offers the whole tree; this narrows it, and the narrowing is
    /// the kind of thing that should be visible: an income category simply is
    /// not in the list, rather than being in it and behaving strangely.
    private var choices: [CategoryChoice] {
        (categories.isEmpty ? loadedCategories : categories)
            .filter { $0.kind == .expense && (!$0.archived || chosen.contains($0.id)) }
    }

    /// The limit as a positive figure, or nil while the field is not yet a
    /// number. `direction` is pinned to `.into` at every point it is set, so a
    /// negative can only arrive from a typed minus sign -- which
    /// `LedgerStore.saveBudget` refuses, in words.
    private var typedMinor: Int64? {
        amount.minor(currency: baseCurrency)
    }

    private var canSave: Bool {
        !Names.isBlank(name) && !chosen.isEmpty && (typedMinor ?? 0) > 0 && !saving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel("Budget name")
                } footer: {
                    Text("What you will recognise this by \u{2014} \u{201C}Eating out\u{201D}, \u{201C}Car\u{201D}.")
                }

                Section {
                    AmountField(
                        title: "Limit", currency: baseCurrency, amount: $amount,
                        showsDirection: false
                    )
                } footer: {
                    // D22, said plainly. A budget spans accounts, so it cannot
                    // be in one account's currency.
                    Text(
                        "In \(baseCurrency), your base currency. Spending in other currencies is "
                            + "converted at the rates you have set."
                    )
                }

                Section {
                    Picker("Period", selection: $period) {
                        ForEach(BudgetPeriod.allCases, id: \.self) { p in
                            Text(periodWord(p)).tag(p)
                        }
                    }
                    CalendarDateField(title: "Starting", iso: $startDate)
                } footer: {
                    Text(anchorExplanation)
                }

                Section {
                    NavigationLink {
                        BudgetCategoryPicker(choices: choices, chosen: $chosen)
                    } label: {
                        HStack {
                            Text("Categories")
                            Spacer()
                            Text(chosenSummary)
                                .foregroundStyle(chosen.isEmpty ? AnyShapeStyle(.tertiary) : AnyShapeStyle(.secondary))
                                .lineLimit(1)
                                .truncationMode(.head)
                        }
                    }
                } footer: {
                    // D16. Stated here because it is the single most common
                    // reason a budget figure surprises somebody.
                    Text("Spending in any subcategory of the ones you choose counts too.")
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }
            }
            .navigationTitle(existing == nil ? "New budget" : "Edit budget")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }
                        .disabled(!canSave)
                }
            }
            .task { await prepare() }
        }
    }

    /// "Monthly, anchored on the 15th, so each period runs from the 15th."
    private var anchorExplanation: String {
        let day = Int(startDate.suffix(2)) ?? 1
        switch period {
        case .weekly:
            return
                "Each period is seven days from the start date, and they carry on before and "
                + "after it."
        case .monthly:
            let ordinal = ordinalDay(day)
            return day > 28
                ? "Each period runs from the \(ordinal) of the month. In a short month it is "
                    + "the last day instead, and the following period still starts on the \(ordinal)."
                : "Each period runs from the \(ordinal) of the month."
        case .yearly:
            return "Each period runs a year from the start date."
        }
    }

    private var chosenSummary: String {
        if chosen.isEmpty { return "Choose" }
        let names = chosen.compactMap { id in choices.first { $0.id == id }?.name }
        if names.count == 1 { return names[0] }
        return "\(names.first ?? "") + \(names.count - 1) more"
    }

    /// `@MainActor` for the same reason every loader in this app is -- see
    /// `DashboardView.load`.
    @MainActor private func prepare() async {
        if let existing {
            name = existing.name
            chosen = existing.categoryIds
            amount = TypedAmount(signed: existing.amountMinor, currency: baseCurrency)
            amount.direction = .into  // a stored limit is positive; keep it so
            period = existing.period
            startDate = existing.startDate
        } else if categories.isEmpty {
            // The detail screen opens this editor without a category list --
            // it never had one. Read it rather than showing an empty picker.
            loadedCategories = (try? await app.service.budgetsScreen(today: todayISO()))?.categories ?? []
        }
    }

    @MainActor private func save() async {
        guard let minor = typedMinor else { return }
        saving = true
        defer { saving = false }
        let outcome = await app.save(
            BudgetDraft(
                id: existing?.id,
                name: name,
                categoryIds: chosen,
                amountMinor: minor,
                period: period,
                startDate: startDate,
                archived: existing?.archived
            )
        )
        // THE SHEET CLOSES ONLY ON A SAVE THAT HAPPENED. On a refusal it stays
        // open with the refusal on screen and every field still filled in --
        // nobody should have to retype a form to find out what was wrong.
        switch outcome {
        case .saved: dismiss()
        case .refused(let why): refusal = why
        }
    }
}

/// Choosing the categories a budget covers. Multi-select, searchable, and it
/// shows the full path so two categories called "Insurance" under different
/// parents are told apart.
struct BudgetCategoryPicker: View {
    let choices: [CategoryChoice]
    @Binding var chosen: [String]

    @State private var query = ""

    private var matches: [CategoryChoice] {
        let key = Names.key(query)
        guard !key.isEmpty else { return choices }
        return choices.filter { Names.key($0.path).contains(key) }
    }

    var body: some View {
        List {
            if !chosen.isEmpty {
                Section("Chosen") {
                    ForEach(chosen, id: \.self) { id in
                        if let choice = choices.first(where: { $0.id == id }) {
                            row(choice)
                        } else {
                            // A category the budget names that is no longer in
                            // this copy. Shown, not silently dropped: dropping
                            // it would quietly narrow the budget on the next
                            // save.
                            HStack {
                                Text("A category not in this copy")
                                    .foregroundStyle(.secondary)
                                Spacer()
                                Button("Remove") { chosen.removeAll { $0 == id } }
                                    .buttonStyle(.borderless)
                                    .font(.footnote)
                            }
                        }
                    }
                }
            }
            Section("All spending categories") {
                ForEach(matches) { choice in
                    row(choice)
                }
            }
        }
        .searchable(text: $query, prompt: "Find a category")
        .navigationTitle("Categories")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
    }

    private func row(_ choice: CategoryChoice) -> some View {
        let selected = chosen.contains(choice.id)
        return Button {
            if selected {
                chosen.removeAll { $0 == choice.id }
            } else {
                chosen.append(choice.id)
            }
        } label: {
            HStack {
                // Indentation shows the tree; the checkmark shows the choice.
                // Neither is a colour.
                Text(choice.name)
                    .padding(.leading, CGFloat(choice.depth) * 14)
                    .foregroundStyle(.primary)
                if choice.archived {
                    Text("Archived")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                Spacer()
                if selected {
                    Image(systemName: "checkmark")
                        .foregroundStyle(Color.accentColor)
                        .accessibilityHidden(true)
                }
            }
            .contentShape(Rectangle())
        }
        .buttonStyle(.plain)
        .accessibilityLabel(choice.path)
        .accessibilityAddTraits(selected ? [.isSelected] : [])
    }
}

/// "1st", "2nd", "23rd" -- English ordinals, for one sentence of explanation.
func ordinalDay(_ day: Int) -> String {
    let suffix: String
    switch (day % 10, day % 100) {
    case (1, 11), (2, 12), (3, 13): suffix = "th"
    case (1, _): suffix = "st"
    case (2, _): suffix = "nd"
    case (3, _): suffix = "rd"
    default: suffix = "th"
    }
    return "\(day)\(suffix)"
}
