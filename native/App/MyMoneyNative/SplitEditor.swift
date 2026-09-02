// Splits, with the remainder on screen the whole time.
//
// THE RULE IS THAT SPLITS SUM EXACTLY TO THE PARENT (SPEC 6), and the store
// enforces it -- but a rule enforced only at Save is a rule the owner meets as
// a rejection after they have finished typing. What makes an unbalanced split
// impossible to save BY ACCIDENT is that the amount still unallocated is
// visible on every keystroke, and that finishing the split is one tap.
//
// THE FIGURE ON SCREEN AND THE CHECK AT SAVE ARE THE SAME CALCULATION.
// `SplitTally` lives in MyMoneyKit, is tested there over a hundred integer
// cases, and is what both this view and `LedgerStore.saveTransaction` ask. A
// view that computed its own preview would eventually disagree with the store,
// and the owner would be shown "balanced" and told "not balanced".
import MyMoneyKit
import SwiftUI

/// One line, as the form holds it.
struct SplitLine: Identifiable, Equatable {
    let id = UUID()
    var categoryId: String?
    var amount: TypedAmount
    var notes: String = ""

    init(categoryId: String? = nil, amount: TypedAmount = TypedAmount(), notes: String = "") {
        self.categoryId = categoryId
        self.amount = amount
        self.notes = notes
    }

    init(_ split: Split, currency: String) {
        self.categoryId = split.categoryId
        self.amount = TypedAmount(signed: split.amountMinor, currency: currency)
        self.notes = split.notes ?? ""
    }
}

extension Array where Element == SplitLine {
    /// The lines as the store's `Split` values, or nil while any of them is not
    /// yet a number. Nil disables Save; it never guesses at a figure.
    func splits(currency: String) -> [Split]? {
        var out: [Split] = []
        for line in self {
            guard let minor = line.amount.minor(currency: currency) else { return nil }
            out.append(
                Split(
                    categoryId: line.categoryId, amountMinor: minor,
                    notes: line.notes.isEmpty ? nil : line.notes
                )
            )
        }
        return out
    }

    /// The lines that ARE numbers, for the live tally. A half-typed line
    /// contributes nothing rather than blocking the figure -- the remainder has
    /// to keep updating while somebody is typing, which is the whole point.
    func tallyingSplits(currency: String) -> [Split] {
        compactMap { line in
            line.amount.minor(currency: currency).map {
                Split(categoryId: line.categoryId, amountMinor: $0, notes: nil)
            }
        }
    }
}

struct SplitEditor: View {
    let currency: String
    /// The parent's signed amount. nil while the parent's own amount is not yet
    /// a number, in which case there is nothing to balance against and the
    /// tally says so instead of showing a figure computed from zero.
    let parentMinor: Int64?
    let categories: [CategoryChoice]
    let frequentIds: [String]
    @Binding var lines: [SplitLine]

    var tally: SplitTally? {
        guard let parentMinor else { return nil }
        return SplitTally.of(
            amountMinor: parentMinor, splits: lines.tallyingSplits(currency: currency),
            currency: currency
        )
    }

    var body: some View {
        Section {
            ForEach($lines) { $line in
                VStack(alignment: .leading, spacing: 8) {
                    CategoryRow(
                        categories: categories, frequentIds: frequentIds,
                        selection: $line.categoryId, label: "Category"
                    )
                    AmountField(title: "Amount", currency: currency, amount: $line.amount)
                    TextField("Note (optional)", text: $line.notes)
                        .font(.footnote)
                }
                .padding(.vertical, 4)
            }
            .onDelete { lines.remove(atOffsets: $0) }

            Button {
                // A NEW LINE OPENS PRE-FILLED WITH WHAT IS LEFT -- FROM THE
                // SECOND LINE ON. This is the tap that makes finishing a split
                // trivial, and it is why an unbalanced split has to be
                // deliberate rather than accidental.
                //
                // The FIRST line arrives empty, which it did not used to. With
                // no lines yet the remainder is the whole transaction, so line
                // one opened holding the full £50.00 of a £50.00 expense -- and
                // since nobody splits £50 into a single £50 line, every two-line
                // split began by clearing a field the app had just filled in.
                // Line two then offered £0.00, because line one had claimed
                // everything. The pre-fill now lands where the arithmetic is
                // actually worth doing: type the part you know, and the next
                // line holds exactly what is left. `SplitTally` decides this;
                // see `suggestedNextLineMinor`, which is tested.
                lines.append(SplitLine(amount: suggestedAmount))
            } label: {
                Label(
                    remainderPrefill == nil
                        ? "Add a split line"
                        : "Add a line for \(Display.money(remainderPrefill!, currency))",
                    systemImage: "plus.circle"
                )
            }

            if !lines.isEmpty {
                Button(role: .destructive) {
                    lines.removeAll()
                } label: {
                    Label("Remove the split", systemImage: "minus.circle")
                }
            }
        } header: {
            Text("Split")
        } footer: {
            footer
        }
    }

    private var remainderPrefill: Int64? {
        guard let tally, let remainder = tally.suggestedNextLineMinor, remainder != 0 else {
            return nil
        }
        return remainder
    }

    private var suggestedAmount: TypedAmount {
        guard let remainder = remainderPrefill else { return TypedAmount() }
        return TypedAmount(signed: remainder, currency: currency)
    }

    @ViewBuilder private var footer: some View {
        if lines.isEmpty {
            Text(
                "A split files one transaction under several categories. The lines have to add "
                    + "up to the transaction exactly."
            )
        } else if parentMinor == nil {
            Text("Enter the transaction's own amount first \u{2014} that is what the lines add up to.")
                .foregroundStyle(.orange)
        } else if lines.splits(currency: currency) == nil {
            // A LINE THAT IS NOT YET A NUMBER, said out loud. The tally treats
            // it as absent so the remainder keeps updating while somebody is
            // typing -- which is right -- but that leaves Save disabled with a
            // message that says "balanced", and a disabled button with no
            // explanation is the most irritating state a form can be in.
            Text("One of the lines does not have an amount yet.")
                .foregroundStyle(.orange)
        } else if let tally, let message = tally.message {
            HStack(spacing: 6) {
                Image(systemName: tally.isSavable ? "checkmark.circle" : "exclamationmark.circle")
                Text(message)
            }
            .foregroundStyle(tally.isSavable ? Color.secondary : Color.orange)
            .accessibilityElement(children: .combine)
        }
    }
}
