// The register: every transaction, newest first, one page at a time.
//
// `List` over an array that grows: SwiftUI's List is lazy, so only the rows on
// screen are built, and `RegisterModel` only ever holds the pages that have
// actually been scrolled to. Opening this on 5,127 rows reads 80.
//
// THE COLUMNS, and why they are what they are:
//
//   date | payee (and category beneath) | amount | running balance
//
// The running balance is the reason this screen is worth having on a phone at
// all -- it is what you check a statement against -- and it is only shown for a
// SINGLE ACCOUNT. Down the all-accounts register it would be a running total
// over several currencies, which is not a number; that column shows which
// account each row belongs to instead, and the header says so once.
//
// EVERY ROW IS ONE ACCESSIBILITY ELEMENT with a sentence of its own, because
// four columns read out as four disconnected fragments is not a register.
//
// EDITING: a tap opens the row, a swipe deletes it. The delete is not confirmed
// and does not need to be -- nothing is destroyed by it, and the undo bar the
// shell pins to the bottom offers it straight back. A transfer leg opens the
// TRANSFER editor rather than the transaction one; the row does not decide
// that, `AppModel.editorSheet(forTransaction:)` does, by asking the store which
// kind of draft this row has.
import MyMoneyKit
import SwiftUI

struct RegisterView: View {
    @Environment(AppModel.self) private var app
    @State private var model: RegisterModel
    /// Handed in by the shell, which owns the sheet.
    let openEditor: (String) -> Void
    @State private var refusal: EditRefusal?

    init(model: RegisterModel, openEditor: @escaping (String) -> Void) {
        _model = State(initialValue: model)
        self.openEditor = openEditor
    }

    var body: some View {
        List {
            Section {
                if let message = model.errorMessage, model.entries.isEmpty {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This register could not be read",
                        message: message,
                        tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                } else if model.entries.isEmpty && !model.isLoading {
                    Notice(
                        symbol: "tray",
                        title: "No transactions",
                        message:
                            "Nothing here yet in the copy on this device. Use Add to enter one."
                    )
                    .frame(maxWidth: .infinity)
                }

                if let refusal {
                    RefusalNotice(refusal: refusal)
                }

                ForEach(model.entries) { entry in
                    RegisterRowView(
                        entry: entry,
                        showsRunningBalance: model.showsRunningBalance,
                        runningCurrency: model.currency
                    )
                    .contentShape(Rectangle())
                    .onTapGesture { openEditor(entry.id) }
                    .swipeActions(edge: .trailing) {
                        Button(role: .destructive) {
                            Task { refusal = (await app.deleteTransaction(id: entry.id)).refusal }
                        } label: {
                            Label("Delete", systemImage: "trash")
                        }
                        Button {
                            openEditor(entry.id)
                        } label: {
                            Label("Edit", systemImage: "pencil")
                        }
                        .tint(.blue)
                    }
                    .accessibilityAction(named: "Edit") { openEditor(entry.id) }
                    .accessibilityAction(named: "Delete") {
                        Task { refusal = (await app.deleteTransaction(id: entry.id)).refusal }
                    }
                    .onAppear {
                        guard model.shouldLoadMore(after: entry) else { return }
                        Task { await model.loadNextPage() }
                    }
                }

                if model.isLoading {
                    HStack {
                        Spacer()
                        ProgressView()
                            .accessibilityLabel("Loading more transactions")
                        Spacer()
                    }
                }
                if let message = model.errorMessage, !model.entries.isEmpty {
                    Label(message, systemImage: "exclamationmark.triangle")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                }
            } header: {
                header
            } footer: {
                if model.reachedEnd && !model.entries.isEmpty {
                    Text(
                        "\(Display.count(model.entries.count, "transaction")), oldest last. "
                            + "Tap one to edit it; swipe to delete, with an undo."
                    )
                    .font(.footnote)
                }
            }
        }
        .navigationTitle(model.title)
        .task { await model.start() }
    }

    private var header: some View {
        VStack(alignment: .leading, spacing: 2) {
            Text(
                model.totalCount > 0
                    ? "\(Display.count(model.totalCount, "transaction")), newest first"
                        + (model.showsRunningBalance ? ", with the balance after each one" : "")
                    : "Newest first"
            )
            if !model.showsRunningBalance {
                // Said once, at the top, rather than left as a missing column
                // somebody has to wonder about.
                Text(
                    "No running balance across accounts \u{2014} a total over more than one "
                        + "currency is not a figure. Open a single account for its running balance."
                )
                .foregroundStyle(.secondary)
            }
        }
        .font(.footnote)
        .textCase(nil)
        .fixedSize(horizontal: false, vertical: true)
    }
}

private struct RegisterRowView: View {
    let entry: RegisterEntry
    let showsRunningBalance: Bool
    let runningCurrency: String?

    private var row: RegisterRow { entry.row }

    /// One sentence per row: when, who, what for, how much and which way, what
    /// the balance stood at afterwards, and whether it has cleared.
    private var spokenLabel: String {
        var parts: [String] = [Display.dateSpoken(row.date)]
        parts.append(row.titleIsPlaceholder ? "no payee" : row.title)
        parts.append(Register.categoryText(row.categoryLine))
        parts.append(Display.moneyFlowSpoken(row.amountMinor, row.currency))
        if showsRunningBalance, let running = entry.runningBalanceMinor,
            let currency = runningCurrency
        {
            parts.append("balance \(Display.moneySpoken(running, currency))")
        } else {
            parts.append("in \(row.accountName)")
        }
        if row.status == .pending { parts.append("pending") }
        if !row.tagNames.isEmpty {
            parts.append("tagged \(row.tagNames.joined(separator: ", "))")
        }
        return parts.joined(separator: ", ")
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            wide
            narrow
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenLabel)
    }

    private var wide: some View {
        HStack(alignment: .top, spacing: 12) {
            dateText
                .frame(width: 96, alignment: .leading)
            description
            Spacer(minLength: 8)
            VStack(alignment: .trailing, spacing: 2) {
                amountText
                trailingText
            }
        }
        .padding(.vertical, 2)
    }

    private var narrow: some View {
        VStack(alignment: .leading, spacing: 4) {
            HStack(alignment: .firstTextBaseline) {
                dateText
                Spacer(minLength: 8)
                amountText
            }
            description
            // Right-aligned, under the amount, because that is where a
            // register's balance column lives and where the eye already is.
            // Left-aligned it reads as a third line of description -- one more
            // fact about the payee rather than the figure the row exists to
            // give you.
            HStack {
                Spacer(minLength: 0)
                trailingText
            }
        }
        .padding(.vertical, 2)
    }

    private var dateText: some View {
        Text(Display.dateText(row.date))
            .font(.subheadline)
            .monospacedDigit()
            .foregroundStyle(.secondary)
    }

    private var description: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(spacing: 6) {
                Text(row.title)
                    .font(.body)
                    .foregroundStyle(row.titleIsPlaceholder ? .secondary : .primary)
                    .lineLimit(2)
                if row.status == .pending {
                    Text("Pending")
                        .font(.caption2)
                        .padding(.horizontal, 5)
                        .padding(.vertical, 1)
                        .overlay(
                            Capsule().strokeBorder(.orange, lineWidth: 1)
                        )
                        .foregroundStyle(.orange)
                }
            }
            HStack(spacing: 6) {
                if case .transfer = row.categoryLine {
                    Image(systemName: "arrow.left.arrow.right")
                        .font(.caption2)
                        .foregroundStyle(.tertiary)
                        .accessibilityHidden(true)
                }
                Text(Register.categoryText(row.categoryLine))
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    // Two lines, not one: at an accessibility text size a
                    // truncated "Investments account…" tells the reader who
                    // needs the large type least about the row.
                    .lineLimit(2)
            }
            if !row.tagNames.isEmpty {
                Text(row.tagNames.joined(separator: " \u{00B7} "))
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
        }
    }

    private var amountText: some View {
        Text(Display.money(row.amountMinor, row.currency))
            .font(.body)
            .monospacedDigit()
            .foregroundStyle(amountColour(row.amountMinor))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }

    @ViewBuilder private var trailingText: some View {
        if showsRunningBalance, let running = entry.runningBalanceMinor,
            let currency = runningCurrency
        {
            Text(Display.money(running, currency))
                .font(.caption)
                .monospacedDigit()
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.7)
        } else {
            HStack(spacing: 5) {
                AccountDot(hex: row.accountColour)
                Text(row.accountName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
                    .multilineTextAlignment(.trailing)
            }
        }
    }
}
