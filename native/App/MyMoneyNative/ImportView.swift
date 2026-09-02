// Importing a backup, and showing what was checked.
//
// WHAT AN IMPORT ACTUALLY DOES, in the order it does it, because the order is
// the safety:
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

    private func importIncoming() {
        Task { await app.importIncoming() }
    }

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Bring a backup onto this device")
                        .font(.headline)
                    Text(
                        "Export a backup from the web app, then choose the file here. This app "
                            + "reads it and keeps its own private copy to show you. The file is "
                            + "opened read-only and is never changed, and neither is your web app."
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
                    dismiss: { app.clearIncoming() }
                )
            }

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
                } else {
                    PrimaryAction(
                        title: "Choose a backup file\u{2026}",
                        systemImage: "doc.badge.plus",
                        isEnabled: !isReading
                    ) {
                        picking = true
                    }
                    .reachProbe("Import \u{2014} Choose a file")
                }
            }
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
            Text(
                "This device already holds a copy of your book, and importing replaces it. The "
                    + "file is checked against its own summary first, and is refused if anything "
                    + "disagrees. Your web app is untouched either way \u{2014} it is the real "
                    + "ledger."
            )
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
                // SAID PLAINLY, not softened. This app can read a statement and
                // cannot yet write one into the book; half a write path for
                // real money is worse than none.
                Label(
                    "Nothing was added. Bringing a statement's rows into your book is not built "
                        + "here yet \u{2014} import them in your web app, then take a fresh backup "
                        + "and bring that here.",
                    systemImage: "info.circle"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            // A BACKUP'S TWO BUTTONS ARE IN THE BOTTOM BAR, not here -- see the
            // `safeAreaInset` on `ImportView`. What is left in the card is the
            // one case the bar has no answer for: a file this app can describe
            // and cannot import, where "Dismiss" is the only thing to offer and
            // putting it in the bar would dress a dead end up as a primary
            // action.
            if !document.kind.isBackup {
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
            return "This is a spreadsheet or a bank statement, not a backup."
        case .unreadable:
            return "This is not something this app can read."
        }
    }
}
