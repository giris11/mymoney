// The full transaction editor: everything a row can say, in one sheet.
//
// WHAT IT DOES NOT DO IS AS IMPORTANT AS WHAT IT DOES. It does not save a
// transfer leg -- there is no draft for one, and the store refuses it anyway --
// because a transfer written through this door would be half a transfer. It
// does not invent a currency: every figure on screen is in the SELECTED
// ACCOUNT's currency, and changing the account changes the currency the amounts
// are read in, which is stated on screen rather than left to be discovered.
//
// AND IT NEVER CLOSES ON A REFUSAL. A sheet that dismissed itself and left a
// message somewhere else would be a sheet that threw away everything typed into
// it. The refusal appears above the Save button, with the store's own two
// sentences, and every field is exactly where it was.
import MyMoneyKit
import SwiftUI

struct TransactionEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    /// The book's own lists, read once when the sheet opens.
    let context: QuickAddContext
    /// nil to create.
    let editing: String?

    @State private var draft: TransactionDraft
    @State private var amount: TypedAmount
    @State private var lines: [SplitLine]
    @State private var tagText: String
    @State private var refusal: EditRefusal?
    @State private var saving = false
    @State private var confirmingDelete = false

    init(context: QuickAddContext, draft: TransactionDraft) {
        self.context = context
        self.editing = draft.id
        let currency = context.accounts.first { $0.id == draft.accountId }?.currency ?? "GBP"
        _draft = State(initialValue: draft)
        _amount = State(initialValue: TypedAmount(signed: draft.amountMinor, currency: currency))
        _lines = State(initialValue: draft.splits.map { SplitLine($0, currency: currency) })
        _tagText = State(initialValue: draft.tagNames.joined(separator: ", "))
    }

    /// The currency every amount on this sheet is in: the selected account's,
    /// always. A transaction whose currency disagreed with its account would be
    /// a number that means something other than what it says.
    private var currency: String {
        context.accounts.first { $0.id == draft.accountId }?.currency ?? "GBP"
    }

    private var amountMinor: Int64? { amount.minor(currency: currency) }

    private var tally: SplitTally? {
        guard let amountMinor else { return nil }
        return SplitTally.of(
            amountMinor: amountMinor, splits: lines.tallyingSplits(currency: currency),
            currency: currency
        )
    }

    private var canSave: Bool {
        guard !saving, amountMinor != nil, !draft.accountId.isEmpty else { return false }
        // Every typed line has to BE a number before Save is offered -- not
        // treated as zero, which would silently save a different split.
        guard lines.splits(currency: currency) != nil else { return false }
        return tally?.isSavable ?? false
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    AmountField(title: "Amount", currency: currency, amount: $amount)
                }

                Section {
                    AccountPicker(
                        accounts: context.accounts, title: "Account", selection: $draft.accountId
                    )
                    CalendarDateField(title: "Date", iso: $draft.date)
                    Picker("Status", selection: $draft.status) {
                        Text("Cleared").tag(TxStatus.cleared)
                        Text("Pending").tag(TxStatus.pending)
                    }
                } footer: {
                    Text(
                        "Amounts on this screen are in \(currency), the account\u{2019}s own "
                            + "currency. Pending transactions still count towards the balance."
                    )
                }

                Section {
                    PayeeField(
                        index: context.payees, name: $draft.payeeName,
                        categoryId: $draft.categoryId, categoryName: categoryPath
                    )
                    if lines.isEmpty {
                        CategoryRow(
                            categories: context.categories,
                            frequentIds: context.frequentCategoryIds,
                            selection: $draft.categoryId
                        )
                    } else {
                        // A split transaction has no single category, and
                        // showing a stale one beside the lines would be a
                        // second answer to the same question.
                        LabeledContent("Category", value: "Split across the lines below")
                            .foregroundStyle(.secondary)
                    }
                    TextField("Tags, separated by commas", text: $tagText)
                        #if os(iOS)
                            .autocorrectionDisabled()
                        #endif
                    TextField("Notes", text: $draft.notes, axis: .vertical)
                        .lineLimit(1...5)
                }

                SplitEditor(
                    currency: currency,
                    parentMinor: amountMinor,
                    categories: context.categories,
                    frequentIds: context.frequentCategoryIds,
                    lines: $lines
                )

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }

                if let editing {
                    Section {
                        Button(role: .destructive) {
                            confirmingDelete = true
                        } label: {
                            Label("Delete this transaction", systemImage: "trash")
                        }
                        .confirmationDialog(
                            "Delete this transaction?",
                            isPresented: $confirmingDelete, titleVisibility: .visible
                        ) {
                            Button("Delete", role: .destructive) { Task { await delete(editing) } }
                            Button("Keep it", role: .cancel) {}
                        } message: {
                            Text(
                                "It is kept in this copy so it can be brought back, and you will "
                                    + "be offered an undo."
                            )
                        }
                    } footer: {
                        Text("Deleting here changes only this device. Your web app is untouched.")
                    }
                }
            }
            .navigationTitle(editing == nil ? "New transaction" : "Edit transaction")
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
        }
    }

    private func categoryPath(_ id: String) -> String? {
        context.categories.first { $0.id == id }?.path
    }

    private func save() async {
        guard let amountMinor, let splits = lines.splits(currency: currency) else { return }
        saving = true
        defer { saving = false }
        var toSave = draft
        toSave.amountMinor = amountMinor
        toSave.splits = splits
        // A split transaction carries no category of its own; the lines carry
        // them. Leaving a stale one on the row would show a category in the
        // register that nothing was actually filed under.
        if !splits.isEmpty { toSave.categoryId = nil }
        toSave.tagNames = tagText.split(separator: ",").map(String.init)

        let outcome = await app.save(toSave)
        if outcome.didSave {
            dismiss()
        } else {
            refusal = outcome.refusal
        }
    }

    private func delete(_ id: String) async {
        let outcome = await app.deleteTransaction(id: id)
        if outcome.didSave {
            dismiss()
        } else {
            refusal = outcome.refusal
        }
    }
}
