// The account editor, and the two switches that decide what a total counts.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TWO SWITCHES ARE THE POINT OF THIS SCREEN, and their footers are not
// decoration. "Archived" and "Not counted" both take an account out of net
// worth and NEITHER hides it: the account keeps its transactions, keeps its
// real balance, and stays on the accounts list. A person who believes
// "archived" means "gone" will archive an account and think they have lost it,
// so the screen says what actually happens, next to the switch, in a sentence.
//
// THE CURRENCY IS THE ONE FIELD THAT CAN BE LOCKED. Every amount already
// recorded in this account IS an amount in its current currency; relabelling
// the account would silently re-denominate all of them. The store refuses it
// and explains; this screen greys the field and says so BEFORE the owner types,
// because a refusal you could have been warned about is a refusal that feels
// like a bug.
import MyMoneyKit
import SwiftUI

struct AccountEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let groups: [AccountGroup]
    /// The account being edited, with its live balance -- nil to create.
    let existing: AccountBalance?

    @State private var name: String
    @State private var type: AccountType
    @State private var currency: String
    @State private var openingText: String
    @State private var colour: String
    @State private var groupId: String
    @State private var archived: Bool
    @State private var excluded: Bool
    @State private var refusal: EditRefusal?
    @State private var saving = false
    @State private var confirmingDelete = false

    private static let noGroup = "__none"

    /// A small, legible palette. A free-form colour picker would let somebody
    /// choose a dot invisible against their own background; these are all
    /// readable in light and dark.
    private static let palette = [
        "#2563eb", "#0891b2", "#059669", "#65a30d", "#ca8a04",
        "#ea580c", "#dc2626", "#db2777", "#7c3aed", "#64748b",
    ]

    init(groups: [AccountGroup], existing: AccountBalance?) {
        self.groups = groups
        self.existing = existing
        let account = existing?.account
        _name = State(initialValue: account?.name ?? "")
        _type = State(initialValue: account?.type ?? .current)
        _currency = State(initialValue: account?.currency ?? "GBP")
        _openingText = State(
            initialValue: account.map {
                Money.formatPlain($0.openingBalanceMinor, currency: $0.currency)
            } ?? "0"
        )
        _colour = State(initialValue: account?.colour ?? Self.palette[0])
        _groupId = State(initialValue: account?.groupId ?? Self.noGroup)
        _archived = State(initialValue: account?.archived ?? false)
        _excluded = State(initialValue: account?.excludeFromNetWorth == true)
    }

    /// The currency cannot change once there is history. Known here from the
    /// balance the accounts screen already read, so no extra query is needed
    /// to say it out loud.
    private var currencyLocked: Bool { (existing?.txCount ?? 0) > 0 }

    private var openingMinor: Int64? {
        Money.parseToMinor(openingText, currency: currency)
    }

    private var canSave: Bool {
        !saving && !Names.isBlank(name) && openingMinor != nil
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                    Picker("Type", selection: $type) {
                        ForEach(AccountType.allCases, id: \.self) { type in
                            Text(Self.typeName(type)).tag(type)
                        }
                    }
                }

                Section {
                    if currencyLocked {
                        LabeledContent("Currency", value: currency)
                    } else {
                        TextField("Currency (e.g. GBP)", text: $currency)
                            #if os(iOS)
                                .textInputAutocapitalization(.characters)
                                .autocorrectionDisabled()
                            #endif
                    }
                    HStack {
                        Text("Opening balance")
                        Spacer(minLength: 12)
                        TextField("0", text: $openingText)
                            .multilineTextAlignment(.trailing)
                            .monospacedDigit()
                            #if os(iOS)
                                .keyboardType(.numbersAndPunctuation)
                            #endif
                    }
                    if let openingMinor {
                        Text(Display.money(openingMinor, currency))
                            .font(.footnote)
                            .foregroundStyle(amountColour(openingMinor))
                    } else if !openingText.isEmpty {
                        Text("Not an amount this app can read.")
                            .font(.footnote)
                            .foregroundStyle(.orange)
                    }
                } footer: {
                    if currencyLocked, let existing {
                        Text(
                            "The currency cannot be changed: this account already holds "
                                + "\(Display.count(existing.txCount, "transaction")) recorded in "
                                + "\(currency), and every one of those amounts IS a \(currency) "
                                + "amount. Make a new account in the other currency instead."
                        )
                    } else {
                        Text(
                            "The opening balance is what the account held before the first "
                                + "transaction in this book. Negative for money owed."
                        )
                    }
                }

                Section("Colour") {
                    colourPalette
                }

                Section {
                    Picker("Group", selection: $groupId) {
                        Text("No group").tag(Self.noGroup)
                        ForEach(groups) { group in Text(group.name).tag(group.id) }
                    }
                } footer: {
                    Text("Groups only decide how the accounts list is arranged. No balance moves.")
                }

                if existing != nil {
                    Section {
                        Toggle("Archived", isOn: $archived)
                        Toggle(Display.notCountedLabel, isOn: $excluded)
                    } header: {
                        Text("In your totals")
                    } footer: {
                        Text(
                            "Both of these take the account out of net worth and NEITHER hides "
                                + "it. It stays on your accounts list with its real balance, and "
                                + "every transaction in it is untouched \u{2014} \u{201C}not "
                                + "counted\u{201D} is not \u{201C}not there\u{201D}."
                        )
                    }
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }

                if let existing {
                    Section {
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            Label("Delete this account", systemImage: "trash")
                        }
                        .disabled(existing.txCount > 0)
                        .confirmationDialog(
                            "Delete \u{201C}\(existing.account.name)\u{201D}?",
                            isPresented: $confirmingDelete, titleVisibility: .visible
                        ) {
                            Button("Delete", role: .destructive) {
                                Task { await delete(existing.account.id) }
                            }
                            Button("Keep it", role: .cancel) {}
                        }
                    } footer: {
                        if existing.txCount > 0 {
                            Text(
                                "This account has \(Display.count(existing.txCount, "transaction")) "
                                    + "in it, so it cannot be deleted. Archive it instead \u{2014} "
                                    + "an archived account keeps its history and its balance and "
                                    + "drops out of your totals."
                            )
                        }
                    }
                }
            }
            .navigationTitle(existing == nil ? "New account" : "Edit account")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .toolbar {
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
                ToolbarItem(placement: .confirmationAction) {
                    Button("Save") { Task { await save() } }.disabled(!canSave)
                }
            }
        }
    }

    private var colourPalette: some View {
        LazyVGrid(columns: [GridItem(.adaptive(minimum: 44))], spacing: 12) {
            ForEach(Self.palette, id: \.self) { hex in
                Button {
                    colour = hex
                } label: {
                    Circle()
                        .fill(Color(hex: hex) ?? .secondary)
                        .frame(width: 30, height: 30)
                        .overlay(
                            Circle().strokeBorder(
                                Color.primary, lineWidth: colour.lowercased() == hex ? 3 : 0
                            )
                        )
                }
                .buttonStyle(.plain)
                .accessibilityLabel("Colour \(hex)")
                .accessibilityAddTraits(colour.lowercased() == hex ? [.isSelected] : [])
            }
        }
        .padding(.vertical, 4)
    }

    static func typeName(_ type: AccountType) -> String {
        switch type {
        case .current: return "Current account"
        case .savings: return "Savings"
        case .creditCard: return "Credit card"
        case .cash: return "Cash"
        case .loan: return "Loan"
        case .investment: return "Investment"
        }
    }

    @MainActor private func save() async {
        guard let openingMinor else { return }
        saving = true
        defer { saving = false }

        let draft = AccountDraft(
            id: existing?.account.id,
            name: name,
            type: type,
            currency: currency,
            openingBalanceMinor: openingMinor,
            colour: colour,
            groupId: groupId == Self.noGroup ? nil : groupId,
            // Archived is carried through the same save; excluded is a separate
            // call because the store writes that column and only that column,
            // and keeping it that way is what makes "not counted" impossible to
            // change by accident from anywhere else.
            archived: archived
        )
        let outcome = await app.save(draft)
        guard outcome.didSave else {
            refusal = outcome.refusal
            return
        }
        if let id = existing?.account.id, (existing?.account.excludeFromNetWorth == true) != excluded {
            let flagged = await app.setAccountExcluded(id: id, excluded: excluded)
            guard flagged.didSave else {
                refusal = flagged.refusal
                return
            }
        }
        dismiss()
    }

    @MainActor private func delete(_ id: String) async {
        let outcome = await app.deleteAccount(id: id)
        if outcome.didSave { dismiss() } else { refusal = outcome.refusal }
    }
}

/// Account groups: create, rename, reorder, remove.
///
/// ORGANISATIONAL ONLY, and the footer says so. Nothing on this screen can move
/// a balance; deleting a group never deletes or moves an account, which is why
/// it is refused while one is still in it.
struct AccountGroupsView: View {
    @Environment(AppModel.self) private var app

    let groups: [AccountGroup]
    /// How many accounts each group holds, so the screen can say why a delete
    /// is refused before it is attempted.
    let counts: [String: Int]

    @State private var newName = ""
    @State private var renaming: AccountGroup?
    @State private var renameText = ""
    @State private var refusal: EditRefusal?

    var body: some View {
        List {
            if let refusal {
                Section { RefusalNotice(refusal: refusal) }
            }
            Section {
                ForEach(groups) { group in
                    HStack {
                        Text(group.name)
                        Spacer()
                        Text(Display.count(counts[group.id] ?? 0, "account"))
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                    }
                    .contentShape(Rectangle())
                    .onTapGesture {
                        renameText = group.name
                        renaming = group
                    }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { await delete(group) }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                    }
                    .swipeActions(edge: .leading) {
                        Button {
                            Task { await move(group, .up) }
                        } label: {
                            Label("Up", systemImage: "arrow.up")
                        }
                        .tint(.indigo)
                        Button {
                            Task { await move(group, .down) }
                        } label: {
                            Label("Down", systemImage: "arrow.down")
                        }
                        .tint(.indigo)
                    }
                }
            } header: {
                Text("Groups")
            } footer: {
                Text(
                    "Groups decide only how your accounts list is arranged. Deleting a group "
                        + "never deletes or moves an account, so a group has to be empty first."
                )
            }

            Section("Add a group") {
                HStack {
                    TextField("Name", text: $newName)
                    Button("Add") { Task { await add() } }
                        .disabled(Names.isBlank(newName))
                }
            }
        }
        .navigationTitle("Account groups")
        .alert("Rename group", isPresented: Binding(
            get: { renaming != nil }, set: { if !$0 { renaming = nil } }
        )) {
            TextField("Name", text: $renameText)
            Button("Save") { Task { await rename() } }
            Button("Cancel", role: .cancel) { renaming = nil }
        }
    }

    @MainActor private func add() async {
        let outcome = await app.save(AccountGroupDraft(name: newName))
        if outcome.didSave {
            newName = ""
            refusal = nil
        } else {
            refusal = outcome.refusal
        }
    }

    @MainActor private func rename() async {
        guard let group = renaming else { return }
        renaming = nil
        let outcome = await app.save(AccountGroupDraft(id: group.id, name: renameText))
        refusal = outcome.refusal
    }

    @MainActor private func delete(_ group: AccountGroup) async {
        refusal = (await app.deleteAccountGroup(id: group.id)).refusal
    }

    @MainActor private func move(_ group: AccountGroup, _ direction: MoveDirection) async {
        // Groups reorder through the same store call accounts do; the arrows
        // are swipe actions so the list itself stays a plain list.
        refusal = (await app.save(
            AccountGroupDraft(
                id: group.id, name: group.name,
                sortOrder: max(0, group.sortOrder + (direction == .up ? -1 : 1))
            )
        )).refusal
    }
}
