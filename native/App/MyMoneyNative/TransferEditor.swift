// A transfer: one thing to edit, two rows in the book.
//
// THE TWO AMOUNTS ARE BOTH ENTERED, ALWAYS, and the second one is not derived
// from a rate (SPEC 5). When the accounts share a currency the second field
// follows the first as you type, because retyping the same number is a tax on
// the common case -- but it is a FIELD, not a calculation, and the moment the
// currencies differ it stops following and asks, because what left one account
// and what arrived in the other are two separate facts about what the bank did.
// A figure derived from a stored rate would change value every time the rate
// table was edited, which is not what happened in the world.
//
// BOTH FIGURES ARE MAGNITUDES. Which way the money goes is decided by which
// account is which, so there is no sign to get wrong and no way to write a
// "transfer" that destroys money.
import MyMoneyKit
import SwiftUI

struct TransferEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let context: QuickAddContext
    /// nil to create a new transfer; a group id to edit an existing pair.
    let editingGroupId: String?

    @State private var fromAccountId: String
    @State private var toAccountId: String
    @State private var date: String
    @State private var sentText: String
    @State private var receivedText: String
    @State private var notes: String
    @State private var status: TxStatus
    @State private var refusal: EditRefusal?
    @State private var saving = false
    @State private var confirmingDelete = false
    /// The leg the sheet was opened from, so Delete has something to name.
    let legId: String?

    init(context: QuickAddContext, draft: TransferDraft?, legId: String? = nil) {
        self.context = context
        self.editingGroupId = draft?.transferGroupId
        self.legId = legId
        let accounts = context.accounts.filter { !$0.archived }
        let first = draft?.fromAccountId ?? context.defaultAccountId ?? accounts.first?.id ?? ""
        let second =
            draft?.toAccountId
            ?? accounts.first { $0.id != first }?.id
            ?? context.accounts.first { $0.id != first }?.id
            ?? ""
        _fromAccountId = State(initialValue: first)
        _toAccountId = State(initialValue: second)
        _date = State(initialValue: draft?.date ?? todayISO())
        let fromCurrency = context.accounts.first { $0.id == first }?.currency ?? "GBP"
        let toCurrency = context.accounts.first { $0.id == second }?.currency ?? "GBP"
        _sentText = State(
            initialValue: draft.map { Money.formatPlain($0.amountFromMinor, currency: fromCurrency) }
                ?? ""
        )
        _receivedText = State(
            initialValue: draft.map { Money.formatPlain($0.amountToMinor, currency: toCurrency) }
                ?? ""
        )
        _notes = State(initialValue: draft?.notes ?? "")
        _status = State(initialValue: draft?.status ?? .cleared)
    }

    private var fromCurrency: String {
        context.accounts.first { $0.id == fromAccountId }?.currency ?? "GBP"
    }
    private var toCurrency: String {
        context.accounts.first { $0.id == toAccountId }?.currency ?? "GBP"
    }
    private var sameCurrency: Bool { fromCurrency == toCurrency }

    private var sentMinor: Int64? { Money.parseToMinor(sentText, currency: fromCurrency) }
    private var receivedMinor: Int64? { Money.parseToMinor(receivedText, currency: toCurrency) }

    private var canSave: Bool {
        guard !saving, fromAccountId != toAccountId else { return false }
        guard let sent = sentMinor, sent > 0 else { return false }
        guard let received = receivedMinor, received > 0 else { return false }
        return true
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    AccountPicker(
                        accounts: context.accounts, title: "From", selection: $fromAccountId
                    )
                    AccountPicker(accounts: context.accounts, title: "To", selection: $toAccountId)
                    CalendarDateField(title: "Date", iso: $date)
                } footer: {
                    if fromAccountId == toAccountId {
                        Text("A transfer needs two different accounts \u{2014} money cannot move to itself.")
                            .foregroundStyle(.orange)
                    }
                }

                Section {
                    amountRow(
                        "Amount sent", text: $sentText, currency: fromCurrency, minor: sentMinor
                    )
                    amountRow(
                        "Amount received", text: $receivedText, currency: toCurrency,
                        minor: receivedMinor
                    )
                } footer: {
                    if sameCurrency {
                        Text(
                            "Both accounts are in \(fromCurrency), so the amount received follows "
                                + "the amount sent. Change it if a fee was taken."
                        )
                    } else {
                        Text(
                            "These accounts are in different currencies, so both figures are "
                                + "entered: what left in \(fromCurrency) and what arrived in "
                                + "\(toCurrency). Neither is calculated from an exchange rate "
                                + "\u{2014} both are what actually happened."
                        )
                    }
                }
                .onChange(of: sentText) { _, newValue in
                    if sameCurrency { receivedText = newValue }
                }
                .onChange(of: toAccountId) { _, _ in
                    if sameCurrency { receivedText = sentText }
                }

                Section {
                    Picker("Status", selection: $status) {
                        Text("Cleared").tag(TxStatus.cleared)
                        Text("Pending").tag(TxStatus.pending)
                    }
                    TextField("Notes", text: $notes, axis: .vertical)
                        .lineLimit(1...5)
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }

                if let legId {
                    Section {
                        Button(role: .destructive) { confirmingDelete = true } label: {
                            Label("Delete this transfer", systemImage: "trash")
                        }
                        .confirmationDialog(
                            "Delete this transfer?", isPresented: $confirmingDelete,
                            titleVisibility: .visible
                        ) {
                            Button("Delete both halves", role: .destructive) {
                                Task { await delete(legId) }
                            }
                            Button("Keep it", role: .cancel) {}
                        } message: {
                            Text(
                                "Both halves go together \u{2014} half a transfer is money that "
                                    + "appears to have vanished. You will be offered an undo."
                            )
                        }
                    }
                }
            }
            .navigationTitle(editingGroupId == nil ? "New transfer" : "Edit transfer")
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

    private func amountRow(
        _ title: String, text: Binding<String>, currency: String, minor: Int64?
    ) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack {
                Text("\(title) (\(currency))")
                Spacer(minLength: 12)
                TextField("0", text: text)
                    .multilineTextAlignment(.trailing)
                    .monospacedDigit()
                    #if os(iOS)
                        .keyboardType(.decimalPad)
                    #endif
            }
            if let minor, minor > 0 {
                Text(Display.money(minor, currency))
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .monospacedDigit()
            } else if !text.wrappedValue.isEmpty {
                Text("Enter how much moved, as a positive figure.")
                    .font(.footnote)
                    .foregroundStyle(.orange)
            }
        }
    }

    private func save() async {
        guard let sent = sentMinor, let received = receivedMinor else { return }
        saving = true
        defer { saving = false }
        let draft = TransferDraft(
            transferGroupId: editingGroupId,
            fromAccountId: fromAccountId,
            toAccountId: toAccountId,
            date: date,
            amountFromMinor: sent,
            amountToMinor: received,
            notes: notes,
            status: status
        )
        let outcome = await app.save(draft)
        if outcome.didSave { dismiss() } else { refusal = outcome.refusal }
    }

    private func delete(_ id: String) async {
        let outcome = await app.deleteTransaction(id: id)
        if outcome.didSave { dismiss() } else { refusal = outcome.refusal }
    }
}
