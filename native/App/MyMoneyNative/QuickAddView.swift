// The fast path. Amount, category, done.
//
// THIS SCREEN DECIDES WHETHER THE APP GETS USED. A finance app is only ever as
// good as the last time somebody bothered to log a coffee in a queue, and the
// difference between three seconds and fifteen is not polish -- it is whether
// the ledger is complete a month later. Everything here is arranged around
// removing taps:
//
//   * THE AMOUNT IS FIRST AND HAS ITS OWN KEYPAD. It is the one field that
//     always has to be typed, so it is what the sheet opens on, with digits
//     that are minor units -- "3", "5", "0" is £3.50, no decimal point to find.
//   * THE ACCOUNT IS ALREADY RIGHT. It defaults to the one last written to
//     (`settings.lastUsedAccountId`, which every save updates), so the common
//     case is no tap at all.
//   * THE DATE IS ALREADY RIGHT. Today, and behind a disclosure so it is not in
//     the way of the ninety-nine per cent of entries that are today's.
//   * THE CATEGORY IS ONE TAP. The row of buttons is what this book actually
//     uses, counted from its own recent history, not a fixed list somebody
//     guessed at.
//   * THE PAYEE FILLS THE CATEGORY IN. Choosing a completed payee sets the
//     category it is usually filed under, so the second tap disappears too.
//
// SAVE IS NEVER OFFERED FOR AN AMOUNT OF NOTHING. Zero is a real amount and a
// £0.00 row is almost always a slip, so the button is disabled until digits
// have been typed -- the only field the fast path insists on.
import MyMoneyKit
import SwiftUI

struct QuickAddView: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let context: QuickAddContext

    @State private var digits = ""
    @State private var direction: MoneyDirection = .out
    @State private var accountId: String
    @State private var categoryId: String?
    @State private var payeeName = ""
    @State private var date: String
    @State private var notes = ""
    @State private var showingMore = false
    @State private var refusal: EditRefusal?
    @State private var saving = false

    init(context: QuickAddContext) {
        self.context = context
        _accountId = State(
            initialValue: context.defaultAccountId ?? context.accounts.first?.id ?? ""
        )
        _date = State(initialValue: todayISO())
    }

    private var currency: String {
        context.accounts.first { $0.id == accountId }?.currency ?? "GBP"
    }

    private var magnitude: Int64 { AmountKeypad.magnitude(digits) }

    private var canSave: Bool { !saving && !digits.isEmpty && !accountId.isEmpty }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 18) {
                    AmountKeypad(currency: currency, digits: $digits, direction: $direction)
                        .padding(.horizontal)

                    categoryButtons

                    accountAndDate

                    DisclosureGroup("Payee, category and note", isExpanded: $showingMore) {
                        VStack(alignment: .leading, spacing: 12) {
                            PayeeField(
                                index: context.payees, name: $payeeName,
                                categoryId: $categoryId, categoryName: categoryPath
                            )
                            NavigationLink {
                                CategoryPicker(
                                    categories: context.categories,
                                    frequentIds: context.frequentCategoryIds,
                                    selection: $categoryId
                                )
                            } label: {
                                HStack {
                                    Text("All categories")
                                    Spacer()
                                    Text(categoryId.flatMap(categoryPath) ?? "None")
                                        .foregroundStyle(.secondary)
                                        .lineLimit(1)
                                        .truncationMode(.head)
                                }
                            }
                            TextField("Note", text: $notes, axis: .vertical)
                                .lineLimit(1...3)
                                .textFieldStyle(.roundedBorder)
                        }
                        .padding(.top, 6)
                    }
                    .padding(.horizontal)

                    if let refusal {
                        RefusalNotice(refusal: refusal)
                            .padding(.horizontal)
                    }
                }
                .padding(.vertical)
            }
            .navigationTitle("Quick add")
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
                        .fontWeight(.semibold)
                }
            }
        }
    }

    /// The one-tap categories: what this book actually uses, counted from its
    /// own recent transactions.
    @ViewBuilder private var categoryButtons: some View {
        let quick = context.frequentCategoryIds.compactMap { id in
            context.categories.first { $0.id == id }
        }
        if !quick.isEmpty {
            ScrollView(.horizontal, showsIndicators: false) {
                HStack(spacing: 8) {
                    ForEach(quick) { choice in
                        Button {
                            categoryId = categoryId == choice.id ? nil : choice.id
                        } label: {
                            Text(choice.name)
                                .font(.callout)
                                .lineLimit(1)
                        }
                        .buttonStyle(.bordered)
                        .tint(categoryId == choice.id ? .accentColor : .secondary)
                        .accessibilityAddTraits(categoryId == choice.id ? [.isSelected] : [])
                    }
                }
                .padding(.horizontal)
            }
        }
    }

    private var accountAndDate: some View {
        VStack(spacing: 10) {
            AccountPicker(accounts: context.accounts, title: "Account", selection: $accountId)
            CalendarDateField(title: "Date", iso: $date)
        }
        .padding(.horizontal)
    }

    private func categoryPath(_ id: String) -> String? {
        context.categories.first { $0.id == id }?.path
    }

    private func save() async {
        saving = true
        defer { saving = false }
        let draft = TransactionDraft(
            accountId: accountId,
            date: date,
            amountMinor: direction.signed(magnitude),
            payeeName: payeeName,
            categoryId: categoryId,
            notes: notes
        )
        let outcome = await app.save(draft)
        if outcome.didSave {
            dismiss()
        } else {
            refusal = outcome.refusal
        }
    }
}
