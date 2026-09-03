// Two doors, and this screen is both of them.
//
// A BACKUP REPLACES THE BOOK. A STATEMENT ADDS TO IT. Those are different acts
// with different risks, and this screen keeps them apart: a .json backup goes
// down the path described below -- checked against its own summary, then the
// whole book replaced in one transaction. A .csv statement goes to
// `ImportWizard`, which resolves its rows against the book, shows what WOULD
// happen, and writes only after a confirmation. Neither can be reached by
// accident and neither is the other.
//
// UNTIL NOW THE SECOND DOOR WAS A WALL. A statement was recognised correctly --
// the row count, the real column names -- and then refused: bring the rows in
// using your web app, take a fresh backup, and import that here. True at the
// time and useless to somebody holding a phone in a shop. The sentence is gone
// because the thing it described is no longer true.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE STATEMENT HALF is `ImportWizard.swift` and the three step files beside
// it. The rest of this comment is about the BACKUP half, which is what this
// screen was originally built to do and which has not changed.
//
// WHAT IMPORTING A BACKUP ACTUALLY DOES, in the order it does it, because the
// order is the safety:
//
//   1. The file is parsed and validated, and then made to PROVE ITSELF: every
//      row count, every account's closing balance and transaction count, and
//      the net-worth total are recomputed from the file's own rows -- under the
//      file's own manifest version, not this build's -- and compared to what the
//      file claims. A single disagreement refuses the whole import.
//   2. Only then is the database opened for writing, and everything happens in
//      ONE transaction: clear, write eleven tables, record where it came from,
//      audit every money column for anything that is not an integer, commit.
//   3. Afterwards the store is asked to re-export the file it just read, and
//      the two canonical fingerprints are compared. Equal means the copy on
//      this device neither lost a field nor invented one.
//
// A refusal names what disagreed. "This backup is invalid" tells the owner
// nothing they can act on; "accounts: 58 in the manifest, 57 in the rows" does.
//
// AND NOTHING HERE TOUCHES THE WEB APP. The file is opened read-only, the write
// goes to this app's own private copy, and the screen says so before and after.
import MyMoneyKit
import SwiftUI
import UniformTypeIdentifiers

struct ImportView: View {
    @Environment(AppModel.self) private var app
    @State private var picking = false
    /// Asked from the bottom bar, where the import button now lives.
    @State private var confirmingIncoming = false
    /// The statement wizard, while it is open.
    @State private var wizard: ImportWizardModel?
    /// The same model, kept after the sheet closes so that what it DID can be
    /// acted on -- a sheet's `onDismiss` runs after the binding has gone nil.
    @State private var lastWizard: ImportWizardModel?
    /// A statement that could not even be opened as a wizard. Never silent.
    @State private var wizardProblem: String?
    /// An undo that would not go through. Its own state rather than sharing
    /// the one above, because the two are different sentences: one is about a
    /// file that could not be read, the other about rows that are still there.
    @State private var undoProblem: String?
    /// Imports this device made that are still in the book, newest first.
    @State private var undoable: [ImportHistoryEntry] = []
    @State private var undoTarget: ImportHistoryEntry?
    @State private var undoing = false
    @State private var undoReport: String?

    private func importIncoming() {
        Task { await app.importIncoming() }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Bring a file onto this device")
                        .font(.headline)
                    Text(
                        "A BACKUP \u{2014} one your web app exported, or one this app exported on "
                            + "another device \u{2014} is read, checked against its own summary, "
                            + "and REPLACES the copy of your book on this device.\n\n"
                            + "A SPREADSHEET OR BANK STATEMENT is read row by row and ADDS to "
                            + "your book. You see exactly what it would do before anything is "
                            + "written, and the whole import can be undone.\n\n"
                            + "Either way the file itself is opened read-only and is never "
                            + "changed, and nothing here reaches your web app."
                    )
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }

            if let document = app.incoming {
                IncomingSection(
                    document: document,
                    hasBook: app.hasBook,
                    dismiss: { app.clearIncoming() }
                )
            }

            if let wizardProblem {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This statement could not be opened",
                        message: wizardProblem
                            + "\n\nNothing was changed \u{2014} your book is as it was.",
                        tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                }
            }

            if let undoProblem {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "That import could not be undone",
                        message: undoProblem
                            + "\n\nNothing was removed \u{2014} the transactions it added are "
                            + "still in your book.",
                        tone: .problem,
                        action: ("OK", { self.undoProblem = nil })
                    )
                    .frame(maxWidth: .infinity)
                }
            }

            if let undoReport {
                Section {
                    Notice(
                        symbol: "arrow.uturn.backward.circle",
                        title: "Import undone",
                        message: undoReport,
                        tone: .neutral,
                        action: ("OK", { self.undoReport = nil })
                    )
                    .frame(maxWidth: .infinity)
                }
            }

            undoableSection

            if isReading {
                Section {
                    HStack(spacing: 10) {
                        ProgressView()
                        Text("Checking the file against itself\u{2026}")
                            .foregroundStyle(.secondary)
                    }
                    .accessibilityElement(children: .combine)
                }
            }

            switch app.importPhase {
            case .done(let summary):
                VerifiedSection(summary: summary)
            case .refused(let refusal):
                RefusedSection(refusal: refusal)
            case .failed(let message):
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "The import did not finish",
                        message: message
                            + "\n\nNothing was changed \u{2014} the copy already on this device is "
                            + "as it was.",
                        tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                }
            case .idle, .reading:
                EmptyView()
            }

            if let summary = app.summary {
                Section {
                    FigureRow(
                        label: "Accounts", value: Display.grouped(summary.accountCount)
                    )
                    FigureRow(
                        label: "Transactions", value: Display.grouped(summary.transactionCount)
                    )
                    FigureRow(
                        label: "Net worth",
                        value: Display.money(
                            summary.snapshot.netWorth.totalBaseMinor,
                            summary.snapshot.netWorth.baseCurrency
                        ),
                        spoken: Display.moneySpoken(
                            summary.snapshot.netWorth.totalBaseMinor,
                            summary.snapshot.netWorth.baseCurrency
                        ),
                        emphasised: true
                    )
                    // THE SAME DISCLOSURE THE DASHBOARD AND ACCOUNTS SCREENS
                    // CARRY, and it belongs here more than anywhere: a
                    // statement import can CREATE accounts in currencies this
                    // book has no rate for, and the next thing the owner reads
                    // is this figure. Without the note it says "0.00" over a
                    // book that just gained five accounts and seventeen rows,
                    // which is the one kind of quiet wrong number this project
                    // exists to refuse.
                    if !summary.snapshot.netWorth.missingRateCurrencies.isEmpty {
                        Label(
                            "Excludes "
                                + summary.snapshot.netWorth.missingRateCurrencies
                                .joined(separator: ", ")
                                + " \u{2014} no exchange rate set",
                            systemImage: "exclamationmark.triangle"
                        )
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                    if let exportedAt = summary.provenance.exportedAt {
                        FigureRow(
                            label: "Backup taken", value: Display.timestampText(exportedAt)
                        )
                    }
                } header: {
                    Text("On this device now")
                } footer: {
                    Text("Stored privately in this app at \(summary.storePath)")
                        .font(.caption2)
                }
            }
        }
        .navigationTitle("Import")
        // The action this screen has, at the bottom rather than three
        // paragraphs down the list where it used to be. The explanation above
        // is read once; the button is what the screen is for.
        //
        // AND WHICH ACTION THAT IS DEPENDS ON WHETHER A FILE IS ALREADY HERE.
        // When one arrives from the share sheet, "Choose a backup file..." is
        // no longer the thing to do -- the file has been chosen, by another
        // app, and the only question left is whether to import it. That button
        // used to be a `.borderedProminent` inside the file's card, which put
        // the one action the screen existed for at about 0.60 of the screen on
        // a 6.9" phone -- above the bottom third, and further up the longer the
        // file's description ran. It was also the one primary action in the app
        // carrying no `reachProbe`, so no measurement could see it.
        //
        // AND A STATEMENT NOW HAS ITS OWN PRIMARY. It used to have none: the
        // card described the file and then explained that nothing could be done
        // with it, so the bar fell through to "Choose a backup file..." -- the
        // one screen in the app whose big filled button ignored the file
        // sitting on it.
        .safeAreaInset(edge: .bottom) {
            ActionBar {
                if let document = app.incoming, document.kind.isBackup {
                    HStack(spacing: 16) {
                        Button(role: .cancel) { app.clearIncoming() } label: {
                            Text("Not now").frame(minHeight: 24)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)

                        PrimaryAction(
                            title: "Check and import this file",
                            systemImage: "checkmark.seal",
                            isEnabled: !isReading
                        ) {
                            if app.hasBook { confirmingIncoming = true } else { importIncoming() }
                        }
                        .reachProbe("Import \u{2014} Check and import")
                    }
                } else if let document = app.incoming, document.kind == .csv {
                    HStack(spacing: 16) {
                        Button(role: .cancel) { app.clearIncoming() } label: {
                            Text("Not now").frame(minHeight: 24)
                        }
                        .buttonStyle(.bordered)
                        .controlSize(.large)

                        PrimaryAction(
                            title: "Set up this import\u{2026}",
                            systemImage: "tablecells.badge.ellipsis",
                            isEnabled: !isReading && app.hasBook
                        ) {
                            openWizard(for: document)
                        }
                        .reachProbe("Import \u{2014} Set up this import")
                    }
                } else {
                    PrimaryAction(
                        title: "Choose a file\u{2026}",
                        systemImage: "doc.badge.plus",
                        isEnabled: !isReading
                    ) {
                        picking = true
                    }
                    .reachProbe("Import \u{2014} Choose a file")
                }
            }
        }
        // THE STATEMENT WIZARD. A sheet rather than a push: it owns the screen
        // while it is open, its own bottom bars are not competing with this
        // one's, and it cannot be navigated away from by a swipe on the wrong
        // edge. It refuses an interactive dismissal while it holds work.
        .sheet(item: $wizard, onDismiss: wizardClosed) { model in
            ImportWizard(model: model)
        }
        .task(id: app.revision) { await loadUndoable() }
        // A reach measurement, and nothing else, brings its own statement and
        // walks the wizard to the step being measured. `Reach.importMeasurement`
        // is nil unless MYMONEY_REACH=1 is set, and nothing on this path writes.
        .task {
            if let measurement = Reach.importMeasurement { await drive(measurement) }
        }
        .confirmationDialog(
            "Undo this import?", isPresented: undoConfirmation, titleVisibility: .visible
        ) {
            if let target = undoTarget {
                Button("Undo the import", role: .destructive) { undo(target) }
            }
            Button("Keep it", role: .cancel) { undoTarget = nil }
        } message: {
            Text(undoTarget.map(undoMessage) ?? "")
        }
        // THE CONFIRMATION FOLLOWS THE BUTTON. It used to live on the card, for
        // the good reason that the sentence belongs next to the name of the
        // file about to replace the book -- and it still names the file, so
        // nothing about that is lost by asking it from here.
        .confirmationDialog(
            "Replace the copy on this device?",
            isPresented: $confirmingIncoming,
            titleVisibility: .visible
        ) {
            Button(
                "Import \u{201C}\(app.incoming?.fileName ?? "")\u{201D}",
                role: .destructive, action: importIncoming
            )
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(replacementWarning)
        }
        // BOTH KINDS ARE OFFERED IN THE PANEL, and what a file IS is decided
        // from its bytes afterwards -- see `IncomingFile`. A picker restricted
        // to .json would refuse a perfectly good backup that somebody's mail
        // client had saved as .txt, and would still have to check the contents
        // of the ones it did accept.
        .fileImporter(
            isPresented: $picking,
            allowedContentTypes: [.json, .commaSeparatedText, .plainText, .data],
            allowsMultipleSelection: false
        ) { result in
            handle(result)
        }
    }

    private var isReading: Bool {
        if case .reading = app.importPhase { return true }
        return false
    }

    // MARK: - Statements

    /// Open the wizard on a statement that has arrived.
    ///
    /// THE BOOK IS READ FIRST, ONCE, and the wizard is built around that one
    /// snapshot -- see `LedgerService.importContext`. If the read fails there is
    /// no wizard and the reason is on this screen; a half-built wizard resolving
    /// rows against an empty book would show a preview promising to create every
    /// account the owner already has.
    private func openWizard(for document: IncomingDocument) {
        wizardProblem = nil
        guard let text = String(data: document.data, encoding: .utf8) else {
            wizardProblem =
                "\u{201C}\(document.fileName)\u{201D} is not text this app can read."
            return
        }
        Task {
            do {
                let context = try await app.service.importContext()
                guard
                    let model = ImportWizardModel(
                        fileName: document.fileName, text: text, context: context,
                        service: app.service
                    )
                else {
                    wizardProblem =
                        "There is no table of rows in \u{201C}\(document.fileName)\u{201D} "
                        + "\u{2014} it needs a header row and at least one row under it."
                    return
                }
                lastWizard = model
                wizard = model
            } catch {
                wizardProblem = AppModel.message(for: error)
            }
        }
    }

    /// The wizard has closed, however it closed.
    ///
    /// A FILE THAT WAS IMPORTED IS DONE WITH. Leaving its card on this screen
    /// would leave a "Set up this import..." button over rows that are already
    /// in the book -- harmless (a second run matches every one of them as a
    /// duplicate and refuses to write nothing) but a lie about what is waiting.
    /// A file that was previewed and abandoned stays, because that is what
    /// "Cancel" promised.
    private func wizardClosed() {
        if lastWizard?.outcome != nil, lastWizard?.undone == nil { app.clearIncoming() }
        lastWizard = nil
        Task { await loadUndoable() }
    }

    // MARK: - Taking one back

    /// The imports made ON THIS DEVICE that are still in the book.
    ///
    /// Not every batch the book carries: a book restored from a backup arrives
    /// with the web app's own import batches in it, and an Undo beside those
    /// would offer to delete a chunk of somebody's history under the heading of
    /// taking back something they just did. See `ImportHistory`.
    @ViewBuilder private var undoableSection: some View {
        if !undoable.isEmpty {
            Section {
                ForEach(undoable) { entry in
                    HStack(alignment: .firstTextBaseline, spacing: 12) {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(entry.fileName)
                                .font(.subheadline)
                                .lineLimit(1)
                                .truncationMode(.middle)
                            Text(
                                Display.count(entry.transactionCount, "transaction")
                                    + " \u{00B7} " + Display.timestampText(iso(entry.importedAt))
                            )
                            .font(.caption)
                            .foregroundStyle(.secondary)
                        }
                        Spacer(minLength: 8)
                        Button("Undo") { undoTarget = entry }
                            .buttonStyle(.bordered)
                            .disabled(undoing)
                    }
                    .padding(.vertical, 2)
                }
            } header: {
                Text("Imports you can still undo")
            } footer: {
                Text(
                    "Only imports made on this device. Undoing one removes the transactions it "
                        + "added, and any account, category, payee or tag it created that nothing "
                        + "else has used since."
                )
            }
        }
    }

    private var undoConfirmation: Binding<Bool> {
        Binding(get: { undoTarget != nil }, set: { if !$0 { undoTarget = nil } })
    }

    private func undoMessage(_ entry: ImportHistoryEntry) -> String {
        "This removes the \(Display.count(entry.transactionCount, "transaction")) that "
            + "\u{201C}\(entry.fileName)\u{201D} added, INCLUDING any changes you have made to "
            + "them since. Anything the import created that you have used elsewhere is kept, and "
            + "nothing else in your book is touched."
    }

    private func undo(_ entry: ImportHistoryEntry) {
        guard !undoing else { return }
        undoTarget = nil
        undoProblem = nil
        undoReport = nil
        undoing = true
        Task {
            do {
                let undone = try await app.service.undoImport(batchId: entry.batchId)
                ImportHistory.forget(batchId: entry.batchId)
                let result = ImportUndoOutcome(undone)
                var text =
                    "\(Display.count(result.transactionCount, "transaction")) from "
                    + "\u{201C}\(entry.fileName)\u{201D} removed."
                if result.keptCount == 1 {
                    text += " One thing it created was already in use elsewhere and was kept."
                } else if result.keptCount > 1 {
                    text += " \(Display.grouped(result.keptCount)) things it created were already "
                    text += "in use elsewhere and were kept."
                }
                undoReport = text
                await app.rowsImported()
            } catch {
                undoProblem = AppModel.message(for: error)
            }
            undoing = false
            await loadUndoable()
        }
    }

    private func loadUndoable() async {
        guard app.hasBook else {
            undoable = []
            return
        }
        guard let ids = try? await app.service.importBatchIds() else {
            undoable = []
            return
        }
        undoable = ImportHistory.pruned(toBatchIds: ids)
    }

    /// `Display.timestampText` speaks ISO instants, which is what every other
    /// timestamp on this screen is. One formatter, one wording.
    private func iso(_ date: Date) -> String {
        ISO8601DateFormatter().string(from: date)
    }

    // MARK: - Measurement

    /// Put the wizard on the step a reach measurement asked for.
    ///
    /// The real path over an invented file -- the real parser, the real guess,
    /// the real plan against whatever book this device holds. The only thing
    /// that is faked is the RESULT of the final step, because the alternative
    /// is a measurement that writes an import into somebody's ledger to take a
    /// picture of the undo button. See `Reach.ImportMeasurement`.
    private func drive(_ measurement: Reach.ImportMeasurement) async {
        let text = measurement.statement
        let name = measurement == .report ? "report.csv" : "statement.csv"
        app.incoming = IncomingDocument(
            fileName: name, data: Data(text.utf8), kind: .csv, preview: CSVPreview.of(text)
        )
        guard measurement != .csv, app.hasBook else { return }

        // The same beat every other measurement waits: a sheet presented in the
        // turn the screen appears is a sheet presented over a view hierarchy
        // that does not exist yet.
        try? await Task.sleep(for: .milliseconds(600))
        guard let context = try? await app.service.importContext(),
            let model = ImportWizardModel(
                fileName: name, text: text, context: context, service: app.service
            )
        else { return }
        // The invented plain statement carries no Account column, so its
        // mapping needs an account chosen for it -- which is what a person
        // would do here too. The report file names its own accounts and skips
        // the mapping step entirely.
        model.fixedAccountId = context.choosableAccounts.first?.id ?? ""
        lastWizard = model
        wizard = model
        guard measurement != .map else { return }

        try? await Task.sleep(for: .milliseconds(500))
        if model.layout == .generic { await model.continueFromMap() }
        if measurement == .done { model.presentMeasurementOutcome() }
    }

    /// What replacing THIS book actually costs, which is not the same sentence
    /// for the two kinds of book.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    /// THE IMPORTED WORDING MUST NOT LEAK ONTO A BOOK CREATED HERE, and this
    /// is the place it would do the most damage. "Your web app is untouched --
    /// it is the real ledger" is a reassurance, and it is EARNED for an
    /// imported book: whatever this device loses, the browser still has. Said
    /// over a book that was started on this phone it is worse than merely
    /// untrue, because it answers "what am I about to lose?" with "nothing"
    /// when the honest answer is "all of it, unless you have exported a file".
    ///
    /// So a created book gets the warning it is owed, in the same dialog, in
    /// place of a comfort that does not apply. The dialog itself is not
    /// skippable either way: `replacingExistingBook` is always true by the time
    /// this app calls the importer, so this sentence is the last thing standing
    /// between a tap and a book that only ever lived here.
    private var replacementWarning: String {
        let checked =
            "The file is checked against its own summary first, and is refused if anything "
            + "disagrees."
        switch app.bookOrigin {
        case .imported:
            return
                "This device already holds a copy of your book, and importing replaces it. "
                + checked
                + " Your web app is untouched either way \u{2014} it is the real ledger."
        case .created:
            return
                "This book was started on this device, and this app is its only home. Importing "
                + "replaces it, and there is no other copy to put it back from. " + checked
                + " Export a backup of this book first if you want to keep it."
        }
    }

    /// Read the bytes HERE, while the security-scoped URL is still in hand, and
    /// hand `Data` to the model. A URL that outlives its scope is a file the app
    /// can no longer open, and the failure would look like a corrupt backup.
    private func handle(_ result: Result<[URL], Error>) {
        switch result {
        case .failure(let error):
            app.importPhase = .failed(AppModel.message(for: error))
        case .success(let urls):
            guard let url = urls.first else { return }
            let name = url.lastPathComponent
            let scoped = url.startAccessingSecurityScopedResource()
            defer { if scoped { url.stopAccessingSecurityScopedResource() } }
            do {
                // READ THE WHOLE FILE NOW, not `.mappedIfSafe`. A mapped `Data`
                // is pages of a file that is only reachable while the
                // security-scoped access above is held -- and that access ends
                // when this function returns, which is before the Task below
                // runs. The mapping would then fault, and the failure would
                // arrive dressed as a corrupt backup. A few megabytes in memory
                // is the right price for that not happening.
                let data = try Data(contentsOf: url)
                // IDENTIFIED BY ITS BYTES, exactly like a shared file, and
                // shown before it is imported. A picked file used to import
                // itself the moment the panel closed; now the panel chooses
                // the FILE and the owner still chooses the import, which is
                // the same rule the share sheet has to follow.
                let kind = IncomingFile.kind(of: data, fileName: name)
                let preview = kind == .csv
                    ? String(data: data, encoding: .utf8).flatMap(CSVPreview.of)
                    : nil
                app.incoming = IncomingDocument(
                    fileName: name, data: data, kind: kind, preview: preview
                )
                app.importPhase = .idle
            } catch {
                app.importPhase = .failed(
                    "\(name) could not be read: \(error.localizedDescription)"
                )
            }
        }
    }
}

/// What was verified, in the words the owner needs: the counts, the figure, and
/// the two independent checks that were actually run.
private struct VerifiedSection: View {
    let summary: ImportSummary

    private var headline: String {
        "\(Display.count(summary.accountCount, "account")), "
            + "\(Display.count(summary.transactionCount, "transaction")), "
            + "net worth \(Display.money(summary.netWorthMinor, summary.baseCurrency))"
            + (summary.manifestVerified ? " \u{2014} verified" : "")
    }

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text(headline)
                        .font(.headline)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: summary.manifestVerified ? "checkmark.seal.fill" : "info.circle")
                        .foregroundStyle(summary.manifestVerified ? Color.green : Color.secondary)
                }
                .accessibilityElement(children: .ignore)
                .accessibilityLabel(
                    "\(Display.count(summary.accountCount, "account")), "
                        + "\(Display.count(summary.transactionCount, "transaction")), net worth "
                        + Display.moneySpoken(summary.netWorthMinor, summary.baseCurrency)
                        + (summary.manifestVerified ? ", verified" : "")
                )

                Text(summary.fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
            }
            .padding(.vertical, 2)

            if !summary.missingRateCurrencies.isEmpty {
                Label(
                    "The total excludes \(summary.missingRateCurrencies.joined(separator: ", ")) "
                        + "\u{2014} no exchange rate in the file.",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            }

            CheckLine(
                passed: summary.manifestVerified,
                title: summary.manifestVerified
                    ? "The file adds up"
                    : "This file carries no summary to check",
                detail: summary.manifestVerified
                    ? "Every row count, every account's closing balance and transaction count, and "
                        + "the net-worth total were recomputed from the rows in the file and matched "
                        + "what the file claims."
                    : "Nothing disagreed \u{2014} there was simply nothing to compare the rows "
                        + "against. Older backups do not carry a summary."
            )

            CheckLine(
                passed: summary.reproducesSource,
                title: summary.reproducesSource
                    ? "Nothing was lost and nothing was invented"
                    : "The copy could not be written back out identically",
                detail: summary.reproducesSource
                    ? "The copy on this device was written back out to a backup file and produced "
                        + "the same fingerprint as the file that was read \u{2014} "
                        + String(summary.contentHash.prefix(12)) + "\u{2026}"
                    : "Every figure above still matched, but re-exporting produced different bytes. "
                        + "The copy is safe to read; it may be missing a field this app does not model."
            )

            if !summary.warnings.isEmpty {
                DisclosureGroup("\(Display.count(summary.warnings.count, "note"))") {
                    ForEach(summary.warnings, id: \.self) { warning in
                        Text(warning)
                            .font(.footnote)
                            .foregroundStyle(.secondary)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                }
            }

            DisclosureGroup("Everything that was read") {
                ForEach(summary.rowCounts, id: \.table) { row in
                    FigureRow(label: row.table, value: Display.grouped(row.count))
                }
            }
        } header: {
            Text("Imported")
        }
    }
}

private struct CheckLine: View {
    let passed: Bool
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: passed ? "checkmark.circle.fill" : "info.circle")
                .foregroundStyle(passed ? Color.green : Color.secondary)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.medium))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .accessibilityElement(children: .combine)
    }
}

/// A refusal, with the disagreements named one per line.
private struct RefusedSection: View {
    let refusal: ImportRefusal

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 8) {
                Label {
                    Text("Not imported")
                        .font(.headline)
                } icon: {
                    Image(systemName: "xmark.octagon.fill")
                        .foregroundStyle(.red)
                }
                Text(refusal.fileName)
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Text(refusal.headline)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)

            ForEach(refusal.problems, id: \.self) { problem in
                Label {
                    Text(problem)
                        .font(.footnote)
                        .fixedSize(horizontal: false, vertical: true)
                } icon: {
                    Image(systemName: "circle.fill")
                        .font(.system(size: 5))
                        .foregroundStyle(.red)
                }
            }
        } header: {
            Text("What disagreed")
        } footer: {
            Text(
                "Nothing on this device was changed. Take a fresh backup from the web app and "
                    + "try that one."
            )
        }
    }
}

/// A file that has arrived -- picked here, or handed over by another app -- and
/// what it is.
///
/// IT DESCRIBES; THE BAR ACTS. A backup's "Check and import this file" and its
/// "Not now" are in `ImportView`'s bottom bar, and the confirmation that names
/// the file went with them -- the sentence still names the file, so nothing is
/// lost by asking it from the bar. What stays here is the description and, for
/// a file that cannot be imported at all, the single Dismiss.
private struct IncomingSection: View {
    let document: IncomingDocument
    /// Whether this device holds a book at all. A statement adds rows TO one,
    /// so with no book there is nothing for it to be added to.
    let hasBook: Bool
    let dismiss: () -> Void

    var body: some View {
        Section {
            VStack(alignment: .leading, spacing: 6) {
                Label {
                    Text(document.fileName).font(.headline)
                } icon: {
                    Image(systemName: symbol)
                        .foregroundStyle(tint)
                }
                Text(headline)
                    .font(.callout)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            .padding(.vertical, 2)
            .accessibilityElement(children: .combine)

            if case .unreadable(let why) = document.kind {
                Text(why)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let preview = document.preview {
                FigureRow(label: "Rows", value: Display.grouped(preview.rowCount))
                FigureRow(
                    label: "Columns",
                    value: preview.columnNames.isEmpty
                        ? "\u{2014}" : preview.columnNames.joined(separator: ", ")
                )
                if !preview.warnings.isEmpty {
                    DisclosureGroup(Display.count(preview.warnings.count, "note")) {
                        ForEach(preview.warnings, id: \.self) { warning in
                            Text(warning)
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    }
                }
                // WHAT USED TO BE HERE. A sentence saying that bringing a
                // statement's rows into the book was not built here yet, and
                // that the way to do it was the web app. It was true and it was
                // a dead end; the button in the bar below is what replaced it,
                // and this line says the one thing that still needs saying --
                // that pressing it writes nothing on its own.
                //
                // AND THE ONE CASE THE BUTTON CANNOT ANSWER. A statement's rows
                // go INTO a book: they need accounts to land in, categories to
                // resolve against and existing transactions to be checked for
                // duplicates against. With no book on this device there is
                // nothing to add to, so the button is disabled -- and a
                // disabled button with no sentence beside it is the dead end
                // this screen has just stopped having.
                Label(
                    hasBook
                        ? "Nothing has been added. Setting up the import shows you exactly what "
                            + "it would do first, row by row, and writes only when you say so."
                        : "There is no book on this device yet, and a statement adds rows to a "
                            + "book rather than creating one. Import a backup first, or start a "
                            + "book on this device, and then bring this file back.",
                    systemImage: "info.circle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            // THE BUTTONS FOR A FILE THAT CAN BE IMPORTED ARE IN THE BOTTOM
            // BAR, not here -- see the `safeAreaInset` on `ImportView`. Both a
            // backup and a statement have a pair there now. What is left in the
            // card is the one case the bar has no answer for: a file this app
            // can describe and cannot read at all, where "Dismiss" is the only
            // thing to offer and putting it in the bar would dress a dead end
            // up as a primary action.
            if case .unreadable = document.kind {
                Button(role: .cancel, action: dismiss) {
                    Text("Dismiss")
                }
                .buttonStyle(.bordered)
                .padding(.vertical, 4)
            }
        } header: {
            Text("This file")
        }
    }

    private var symbol: String {
        switch document.kind {
        case .backup: return "doc.badge.gearshape"
        case .csv: return "tablecells"
        case .unreadable: return "xmark.octagon.fill"
        }
    }

    private var tint: Color {
        switch document.kind {
        case .backup: return .accentColor
        case .csv: return .secondary
        case .unreadable: return .red
        }
    }

    private var headline: String {
        switch document.kind {
        case .backup:
            return "This looks like a MyMoney backup. Nothing has been read into your book yet "
                + "\u{2014} importing checks it against its own summary first."
        case .csv:
            return "This is a spreadsheet or a bank statement, not a backup. Its rows can be "
                + "ADDED to your book \u{2014} nothing is replaced."
        case .unreadable:
            return "This is not something this app can read."
        }
    }
}
