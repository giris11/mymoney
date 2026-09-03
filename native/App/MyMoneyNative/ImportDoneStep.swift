// Step 4 — what actually happened, and the way back out of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE UNDO IS ON THIS SCREEN, NOT BEHIND A MENU
//
// This is the moment somebody finds out whether the import was the one they
// meant: the counts are in front of them, the accounts are named, and the book
// behind this sheet has already been re-read. It is also the moment they are
// most likely to want it all back -- wrong file, wrong account, dates read the
// wrong way round. So "Undo this import" is a button in the bar at the bottom,
// beside Done, in the third of the screen a thumb reaches.
//
// It stays reachable afterwards too: `ImportView` lists the imports this device
// made and offers the same undo for each. Losing the ability to take something
// back because you closed a sheet is not a design, it is a trap.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THE UNDO ACTUALLY DOES, said on the screen rather than assumed
//
// It removes the transactions this batch wrote -- as tombstones, so nothing is
// destroyed -- and removes the accounts, categories, payees and tags it created
// UNLESS something else has since used them. Those are kept and counted, and
// the screen says how many, because "undone" would be a lie if an account with
// a transaction in it had quietly gone with it.
import MyMoneyKit
import SwiftUI

struct ImportDoneStep: View {
    let model: ImportWizardModel
    let close: () -> Void

    @State private var confirmingUndo = false

    var body: some View {
        Group {
            if let outcome = model.outcome {
                List {
                    headlineSection(outcome)
                    if model.undone == nil {
                        addedSection(outcome)
                        whereSection
                        skippedSection(outcome)
                    } else if let undone = model.undone {
                        undoneSection(undone)
                    }
                    if let problem = model.problem {
                        Section { ImportNote(text: problem, tone: .red) }
                    }
                }
            } else {
                ProgressView()
                    .frame(maxWidth: .infinity, maxHeight: .infinity)
            }
        }
        .safeAreaInset(edge: .bottom) { bar }
    }

    // MARK: The headline

    private func headlineSection(_ outcome: ImportOutcome) -> some View {
        Section {
            HStack(alignment: .firstTextBaseline, spacing: 12) {
                Image(systemName: model.undone == nil ? "checkmark.seal.fill" : "arrow.uturn.backward.circle.fill")
                    .font(.title2)
                    .foregroundStyle(model.undone == nil ? Color.green : Color.secondary)
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(headline(outcome))
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                    Text(outcome.fileName)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .lineLimit(1)
                        .truncationMode(.middle)
                }
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)
        }
    }

    private func headline(_ outcome: ImportOutcome) -> String {
        if model.undone != nil { return "This import has been taken back" }
        return "Added \(Display.count(outcome.transactionCount, "transaction")) to your book"
    }

    // MARK: What was added

    private func addedSection(_ outcome: ImportOutcome) -> some View {
        Section {
            FigureRow(
                label: "Transactions added",
                value: Display.grouped(outcome.transactionCount), emphasised: true
            )
            if !outcome.accountsCreated.isEmpty {
                FigureRow(
                    label: Display.count(outcome.accountsCreated.count, "account") + " created",
                    value: outcome.accountsCreated.joined(separator: ", ")
                )
            }
            if outcome.categoriesCreated > 0 {
                FigureRow(
                    label: "Categories created",
                    value: Display.grouped(outcome.categoriesCreated)
                )
            }
            if outcome.payeesCreated > 0 {
                FigureRow(label: "Payees created", value: Display.grouped(outcome.payeesCreated))
            }
            if outcome.tagsCreated > 0 {
                FigureRow(label: "Tags created", value: Display.grouped(outcome.tagsCreated))
            }
            if outcome.currencyMismatchCount == 1 {
                ImportNote(
                    text: "1 transaction declared a different currency from its account. It was "
                        + "stored in the account\u{2019}s currency, at the number the file gave "
                        + "\u{2014} nothing was converted.",
                    symbol: "coloncurrencysign.circle"
                )
            } else if outcome.currencyMismatchCount > 1 {
                ImportNote(
                    text: "\(Display.count(outcome.currencyMismatchCount, "transaction")) "
                        + "declared a different currency from their accounts. They were stored in "
                        + "their accounts\u{2019} currencies, at the numbers the file gave "
                        + "\u{2014} nothing was converted.",
                    symbol: "coloncurrencysign.circle"
                )
            }
            if outcome.unpairedTransferCount == 1 {
                ImportNote(
                    text: "1 transfer leg had no matching opposite row, so it is now an ordinary "
                        + "uncategorised transaction. It counts as income or spending in your "
                        + "reports until you categorise it.",
                    symbol: "arrow.left.arrow.right"
                )
            } else if outcome.unpairedTransferCount > 1 {
                ImportNote(
                    text: "\(Display.count(outcome.unpairedTransferCount, "transfer leg")) had no "
                        + "matching opposite row, so they are now ordinary uncategorised "
                        + "transactions. They count as income or spending in your reports until "
                        + "you categorise them.",
                    symbol: "arrow.left.arrow.right"
                )
            }
        } header: {
            Text("What was added")
        }
    }

    /// The same account lines the preview showed, now describing what happened
    /// rather than what would. Derived from the same plan and the same rule, so
    /// the two screens cannot disagree.
    @ViewBuilder private var whereSection: some View {
        if let plan = model.plan {
            let lines = ImportPreview.accountLines(
                plan: plan, context: model.context, reportAccounts: model.reportAccounts
            )
            .filter { $0.importedCount > 0 }
            if !lines.isEmpty {
                Section {
                    ForEach(lines) { line in
                        FigureRow(
                            label: line.name,
                            value: Display.count(line.importedCount, "transaction")
                                + ", " + Display.money(line.importedNetMinor, line.currency),
                            spoken: Display.count(line.importedCount, "transaction") + ", "
                                + Display.moneySpoken(line.importedNetMinor, line.currency)
                        )
                    }
                } header: {
                    Text("Where they went")
                }
            }
        }
    }

    // MARK: What was not added

    @ViewBuilder private func skippedSection(_ outcome: ImportOutcome) -> some View {
        if outcome.skippedCount > 0 {
            Section {
                if outcome.duplicatesSkipped > 0 {
                    FigureRow(
                        label: "Already in your book",
                        value: Display.grouped(outcome.duplicatesSkipped)
                    )
                }
                if outcome.decisionsSkipped > 0 {
                    FigureRow(
                        label: "You chose to skip",
                        value: Display.grouped(outcome.decisionsSkipped)
                    )
                }
                if outcome.unreadableRows > 0 {
                    FigureRow(
                        label: "Could not be read",
                        value: Display.grouped(outcome.unreadableRows)
                    )
                }
            } header: {
                Text("\(Display.count(outcome.skippedCount, "row")) not added")
            } footer: {
                Text(
                    "Bring the same file back after fixing it and only the missing rows are "
                        + "added \u{2014} everything already here is matched and skipped."
                )
            }
        }
    }

    // MARK: What the undo took back

    private func undoneSection(_ undone: ImportUndoOutcome) -> some View {
        Section {
            FigureRow(
                label: "Transactions removed",
                value: Display.grouped(undone.transactionCount), emphasised: true
            )
            if undone.accountsRemoved > 0 {
                FigureRow(
                    label: "Accounts removed", value: Display.grouped(undone.accountsRemoved)
                )
            }
            if undone.categoriesRemoved > 0 {
                FigureRow(
                    label: "Categories removed", value: Display.grouped(undone.categoriesRemoved)
                )
            }
            if undone.payeesRemoved > 0 {
                FigureRow(label: "Payees removed", value: Display.grouped(undone.payeesRemoved))
            }
            if undone.tagsRemoved > 0 {
                FigureRow(label: "Tags removed", value: Display.grouped(undone.tagsRemoved))
            }
            if undone.keptCount == 1 {
                ImportNote(
                    text: "One thing the import created \u{2014} an account, or a category "
                        + "\u{2014} has been used by something else since, so it was kept rather "
                        + "than removed from under whatever now needs it.",
                    symbol: "info.circle", tone: .secondary
                )
            } else if undone.keptCount > 1 {
                ImportNote(
                    text: "\(Display.grouped(undone.keptCount)) things the import created "
                        + "\u{2014} accounts, or categories \u{2014} have been used by something "
                        + "else since, so they were kept rather than removed from under whatever "
                        + "now needs them.",
                    symbol: "info.circle", tone: .secondary
                )
            }
        } header: {
            Text("What was taken back")
        } footer: {
            Text(
                "Nothing was destroyed \u{2014} removal in this app marks a row as deleted rather "
                    + "than erasing it, which is why the two apps can still be brought back into "
                    + "step."
            )
        }
    }

    // MARK: The bar

    private var bar: some View {
        ActionBar {
            HStack(spacing: 16) {
                if model.undone == nil, model.outcome != nil {
                    Button { confirmingUndo = true } label: {
                        Text("Undo this import").frame(minHeight: 24)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    .disabled(model.busy)
                }
                PrimaryAction(
                    title: model.busy ? "Working\u{2026}" : "Done",
                    systemImage: "checkmark",
                    isEnabled: !model.busy,
                    run: close
                )
                .reachProbe("Import \u{2014} Done")
            }
        }
        .confirmationDialog(
            "Undo this import?", isPresented: $confirmingUndo, titleVisibility: .visible
        ) {
            Button("Undo the import", role: .destructive) { Task { await model.undo() } }
            Button("Keep it", role: .cancel) {}
        } message: {
            Text(undoMessage)
        }
    }

    private var undoMessage: String {
        guard let outcome = model.outcome else { return "" }
        var text =
            "This removes the \(Display.count(outcome.transactionCount, "transaction")) just "
            + "added from \u{201C}\(outcome.fileName)\u{201D}"
        if !outcome.accountsCreated.isEmpty {
            text += ", along with the "
                + Display.count(outcome.accountsCreated.count, "account")
                + " created for them"
        }
        text +=
            ". Anything else in your book is untouched, and anything the import created that you "
            + "have already used somewhere else is kept."
        return text
    }
}
