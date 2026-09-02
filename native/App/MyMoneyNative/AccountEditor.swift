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

                // NO DISABLED DELETE BUTTON ANY MORE, and that is the better
                // screen rather than a compromise. The delete lives in the
                // bottom bar now, and a greyed-out control down there with the
                // sentence explaining it stranded up here would be a question
                // and its answer at opposite ends of the screen. So when the
                // account cannot be deleted there is no button at all -- only
                // the sentence saying why, and what to do instead.
                if let existing, existing.txCount > 0 {
                    Section {
                        // A row rather than a section footer: a `Section` with
                        // no rows in it is free to draw no footer either, and
                        // this sentence is the only thing standing between
                        // "why is there no delete" and a support question to
                        // nobody.
                        Text(
                            "This account has \(Display.count(existing.txCount, "transaction")) "
                                + "in it, so it cannot be deleted. Archive it instead \u{2014} "
                                + "an archived account keeps its history and its balance and "
                                + "drops out of your totals."
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }
            .navigationTitle(existing == nil ? "New account" : "Edit account")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                SaveBar(
                    title: "Save",
                    isEnabled: canSave,
                    probe: "Account editor \u{2014} Save",
                    save: { Task { await save() } },
                    delete: canDelete
                        ? (title: "Delete this account", run: { confirmingDelete = true })
                        : nil
                )
            }
            .confirmationDialog(
                "Delete \u{201C}\(existing?.account.name ?? "")\u{201D}?",
                isPresented: $confirmingDelete, titleVisibility: .visible
            ) {
                if let existing {
                    Button("Delete", role: .destructive) {
                        Task { await delete(existing.account.id) }
                    }
                }
                Button("Keep it", role: .cancel) {}
            } message: {
                Text("Only this device is changed. Your web app is untouched.")
            }
            .toolbar {
                // Cancel stays top-left. See `ActionBar`.
                ToolbarItem(placement: .cancellationAction) { Button("Cancel") { dismiss() } }
            }
        }
    }

    /// An account can be deleted only while nothing has been recorded in it.
    /// The store enforces this; the screen simply does not offer the button.
    private var canDelete: Bool {
        guard let existing else { return false }
        return existing.txCount == 0
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

        }
        .navigationTitle("Account groups")
        // ADDING A GROUP IS A FIELD AND A BUTTON, AND BOTH BELONG DOWN HERE.
        // In the list it was a section whose position depended on how many
        // groups there already were, and typing into it put the keyboard over
        // the button that submits it. As a bottom bar the pair is always in the
        // same place, and the system lifts both above the keyboard together.
        .safeAreaInset(edge: .bottom) {
            ActionBar {
                HStack(spacing: 12) {
                    TextField("New group name", text: $newName)
                        .textFieldStyle(.roundedBorder)
                    PrimaryAction(title: "Add", isEnabled: !Names.isBlank(newName)) {
                        Task { await add() }
                    }
                    .frame(maxWidth: 120)
                    .reachProbe("Account groups \u{2014} Add")
                }
            }
        }
        // RENAME IS A SHEET RATHER THAN AN ALERT. An alert draws itself across
        // the middle of the screen, which puts its Save at about half height --
        // the same reach problem as a navigation bar, in the other direction.
        // A short sheet sits on the bottom edge with its Save in the bar.
        .sheet(item: $renaming) { group in
            RenameGroupSheet(name: $renameText, save: { Task { await rename(group) } })
        }
        // The one sheet a measurement can ask for here. Cannot fire without
        // MYMONEY_REACH=1; see `Reach.opening`.
        .task {
            if Reach.isOpening("groups.rename"), let first = groups.first {
                renameText = first.name
                renaming = first
            }
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

    @MainActor private func rename(_ group: AccountGroup) async {
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

/// Renaming a group: a short sheet, with the Save where the thumb is.
///
/// It replaces an `.alert` carrying a text field. The alert worked, and its
/// buttons sat halfway down a 956pt screen -- past the fold for a thumb, for a
/// rename that is one word and a tap. A sheet at a fixed small height puts the
/// field and the button on the bottom edge, and the keyboard pushes the button
/// up rather than over it.
private struct RenameGroupSheet: View {
    @Environment(\.dismiss) private var dismiss
    @Binding var name: String
    let save: () -> Void

    var body: some View {
        NavigationStack {
            Form {
                TextField("Name", text: $name)
            }
            .navigationTitle("Rename group")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                ActionBar {
                    PrimaryAction(title: "Save", isEnabled: !Names.isBlank(name)) {
                        save()
                        dismiss()
                    }
                    .reachProbe("Rename group \u{2014} Save")
                }
            }
            .toolbar {
                // Cancel stays top-left. See `ActionBar`.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
        #if os(iOS)
            .presentationDetents([.height(260)])
        #endif
    }
}
