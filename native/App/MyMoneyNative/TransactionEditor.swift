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
    /// Which schedule entered this row, when one did. Read when the sheet
    /// opens: a transaction cannot work this out for itself, and "where did
    /// this come from" is exactly the question somebody asks of a row they do
    /// not remember typing.
    @State private var origin: ScheduleOrigin?

    init(context: QuickAddContext, draft: TransactionDraft) {
        self.context = context
        self.editing = draft.id
        let currency = context.accounts.first { $0.id == draft.accountId }?.currency ?? "GBP"
        _draft = State(initialValue: draft)
        // A NEW row starts with the field EMPTY, not with a formatted zero.
        // `TypedAmount(signed: 0)` renders "0.00", which is real text rather
        // than a placeholder: tapping the field and typing "42.50" leaves
        // "0.0042.50", two decimal points, which the parser correctly refuses.
        // The owner's first act on this screen is to type an amount, so the
        // seed has to be the empty string that `TextField`'s own "0" prompt
        // sits behind. An EXISTING row that really is zero still shows "0.00",
        // because there the figure is a fact rather than a starting point --
        // which is the same rule `TransferEditor` already follows.
        _amount = State(
            initialValue: draft.id == nil && draft.amountMinor == 0
                ? TypedAmount()
                : TypedAmount(signed: draft.amountMinor, currency: currency)
        )
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

    /// Why Save will not run, or nil when it will. A sentence rather than a
    /// boolean -- see `PrimaryAction` in `ActionBar.swift`.
    private var saveProblem: PrimaryAction.DisabledReason? {
        if saving { return .working }
        if draft.accountId.isEmpty {
            return .because(
                context.accounts.isEmpty
                    ? "There are no accounts in your book yet, and a transaction has to land in "
                        + "one. Add an account first and this will be waiting."
                    : "Choose the account this belongs to. It fixes the currency the amount is "
                        + "stored in, so it is never assumed."
            )
        }
        if amountMinor == nil {
            return .because(
                amount.text.isEmpty
                    ? "Type the amount."
                    : "\u{201C}\(amount.text)\u{201D} is not an amount \(currency) can hold."
            )
        }
        // Every typed line has to BE a number before Save is offered -- not
        // treated as zero, which would silently save a different split.
        if lines.splits(currency: currency) == nil {
            return .because(
                "One of the split lines does not have an amount yet. Finish it, or remove the "
                    + "line."
            )
        }
        if let tally, !tally.isSavable {
            return .because(
                (tally.message ?? "The split does not add up to the transaction.")
                    + " A split has to add up to the transaction exactly."
            )
        }
        return nil
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

                if let origin {
                    Section {
                        Label {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(origin.scheduleName)
                                Text(
                                    "The payment due \(Display.dateText(origin.occurrenceDate))."
                                )
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                            }
                        } icon: {
                            Image(systemName: "calendar.badge.clock")
                        }
                    } header: {
                        Text("Entered from a schedule")
                    } footer: {
                        // Both directions of the link matter: this row came
                        // from that schedule, and deleting this row makes that
                        // occurrence due again.
                        Text(
                            "Editing this transaction changes only the transaction. Deleting it "
                                + "makes that payment due again on the schedule."
                        )
                    }
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }

            }
            .task {
                if let editing {
                    origin = try? await app.service.scheduleOrigin(forTransactionId: editing)
                }
            }
            .navigationTitle(editing == nil ? "New transaction" : "Edit transaction")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                SaveBar(
                    title: saving ? "Saving\u{2026}" : "Save",
                    disabledReason: saveProblem,
                    probe: "Transaction editor \u{2014} Save",
                    save: { Task { await save() } },
                    delete: editing == nil
                        ? nil
                        : (title: "Delete this transaction", run: { confirmingDelete = true })
                )
            }
            .confirmationDialog(
                "Delete this transaction?",
                isPresented: $confirmingDelete, titleVisibility: .visible
            ) {
                if let editing {
                    Button("Delete", role: .destructive) { Task { await delete(editing) } }
                }
                Button("Keep it", role: .cancel) {}
            } message: {
                // THE TWO SENTENCES THAT USED TO BE A FORM FOOTER, said here
                // instead. With the button in the bottom bar the footer would
                // have been an explanation on a different part of the screen
                // from the thing it explains; in the dialog they are read at
                // the moment the decision is actually made.
                Text(
                    "It is kept in this copy so it can be brought back, and you will be offered "
                        + "an undo. Deleting here changes only this device \u{2014} your web app "
                        + "is untouched."
                )
            }
            .toolbar {
                // Cancel stays top-left: rarely pressed, and swipe-down already
                // does it. See `ActionBar`.
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    private func categoryPath(_ id: String) -> String? {
        context.categories.first { $0.id == id }?.path
    }

    @MainActor private func save() async {
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

    @MainActor private func delete(_ id: String) async {
        let outcome = await app.deleteTransaction(id: id)
        if outcome.didSave {
            dismiss()
        } else {
            refusal = outcome.refusal
        }
    }
}
