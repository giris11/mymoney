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
    @State private var confirmingReplace = false

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

                    Button {
                        if app.hasBook {
                            confirmingReplace = true
                        } else {
                            picking = true
                        }
                    } label: {
                        Label("Choose a backup file\u{2026}", systemImage: "doc.badge.plus")
                    }
                    .buttonStyle(.borderedProminent)
                    .disabled(isReading)
                }
                .padding(.vertical, 4)
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
        .fileImporter(
            isPresented: $picking,
            allowedContentTypes: [.json, .init(filenameExtension: "json") ?? .json],
            allowsMultipleSelection: false
        ) { result in
            handle(result)
        }
        .confirmationDialog(
            "Replace the copy on this device?",
            isPresented: $confirmingReplace,
            titleVisibility: .visible
        ) {
            Button("Choose a file\u{2026}") { picking = true }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "This device already holds a copy of your book. Importing replaces it. "
                    + "Your web app is untouched either way \u{2014} it is the real ledger."
            )
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
                Task { await app.importBackup(data: data, fileName: name) }
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
