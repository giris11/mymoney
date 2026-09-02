// Getting the book back out, which is what makes everything else safe to do.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS SCREEN IS THE OTHER HALF OF "START EMPTY". Before a book could be
// created here, every book on the device was a copy of one the web app held:
// losing this one cost an import, and the browser still had the real thing. A
// book started HERE has no counterpart at all. Without a way out, such a book
// could be created, added to for a year, and then replaced for ever by one tap
// on the import screen -- and the import screen's own warning ("there is no
// other copy to put it back from") would be advice nobody could act on.
//
// So: one screen, one action, and it produces the SAME FILE FORMAT the importer
// reads. Not an export "feature" with options -- a whole book, whole, in the
// one shape both apps already agree on.
//
// ─────────────────────────────────────────────────────────────────────────────
// IT IS TWO STEPS ON PURPOSE, and the first one is not a delay.
//
//   1. WRITE THE FILE, and then say what is in it: how many accounts, how many
//      transactions, how big it is, and its content fingerprint.
//   2. SAVE OR SEND IT, through the system share sheet, which is the only
//      thing that can put a file where the owner can actually find it.
//
// The figures between the two steps are the point. This app's whole argument
// about honesty is that it shows the evidence rather than the reassurance --
// the import screen lists what it checked instead of saying "verified" -- and
// an export that said "Done!" would be asking somebody to trust that their
// year of entries is in a file they have not been told anything about. The
// fingerprint is the same canonical hash the import screen prints, so the two
// can be compared by eye after a round trip.
//
// NOTHING IS WRITTEN TO THE BOOK. An export is a read: no `lastBackupAt`, no
// local edit counted, no row touched. Looking at your own ledger must not
// change it.
import MyMoneyKit
import SwiftUI

struct ExportView: View {
    @Environment(AppModel.self) private var app

    @State private var exported: ExportedBackup?
    @State private var working = false
    @State private var problem: String?

    var body: some View {
        List {
            Section {
                VStack(alignment: .leading, spacing: 10) {
                    Text("Save a copy of this book")
                        .font(.headline)
                    Text(explanation)
                        .font(.callout)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.vertical, 4)
            }

            if let exported {
                Section {
                    FigureRow(
                        label: "Accounts", value: Display.grouped(exported.accountCount)
                    )
                    FigureRow(
                        label: "Transactions", value: Display.grouped(exported.transactionCount)
                    )
                    FigureRow(label: "File size", value: Self.size(exported.byteCount))
                    FigureRow(
                        label: "File fingerprint",
                        value: String(exported.contentHash.prefix(12)),
                        spoken: "SHA 256, beginning "
                            + exported.contentHash.prefix(12).map(String.init)
                            .joined(separator: " ")
                    )
                } header: {
                    Text("What is in the file")
                } footer: {
                    Text(
                        "The fingerprint is the same one the import screen prints for a file it "
                            + "reads, so the two can be compared after a round trip. The file is "
                            + "named \u{201C}\(exported.url.lastPathComponent)\u{201D}."
                    )
                    .font(.footnote)
                    .fixedSize(horizontal: false, vertical: true)
                }
            }

            if let problem {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "The file could not be written",
                        message: problem
                            + "\n\nYour book is unchanged \u{2014} nothing here writes to it.",
                        tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                }
            }
        }
        .navigationTitle("Back up")
        #if os(iOS)
            .navigationBarTitleDisplayMode(.inline)
        #endif
        .safeAreaInset(edge: .bottom) { bar }
    }

    /// What this file is for, said differently for the two kinds of book --
    /// because for one of them it is a convenience and for the other it is the
    /// only copy that will exist anywhere else.
    private var explanation: String {
        switch app.bookOrigin {
        case .created:
            return
                "This book was started on this device and this app is its only home. A backup "
                + "file is the only way a copy of it exists anywhere else \u{2014} on another "
                + "device, in your web app, or simply somewhere safe."
        case .imported:
            return
                "This writes out everything on this device, including the changes made here that "
                + "your web app does not have. It is the same file format your web app reads, so "
                + "the two can be brought back into step."
        }
    }

    private var bar: some View {
        ActionBar {
            if let exported {
                // THE SHARE SHEET IS THE ONLY WAY A FILE REACHES THE OWNER. An
                // app-private file that nobody can open is not a backup, and
                // iOS gives no other route to Files, iCloud Drive or Mail.
                ShareLink(item: exported.url) {
                    Label("Save or send this file", systemImage: "square.and.arrow.up")
                        .font(.body.weight(.semibold))
                        .frame(maxWidth: .infinity, minHeight: 24)
                }
                .buttonStyle(.borderedProminent)
                .controlSize(.large)
                .reachProbe("Export \u{2014} Save or send")
            } else {
                PrimaryAction(
                    title: working ? "Writing the file\u{2026}" : "Create the file",
                    systemImage: "doc.badge.plus",
                    isEnabled: !working && app.hasBook
                ) {
                    write()
                }
                .reachProbe("Export \u{2014} Create the file")
            }
        }
    }

    private func write() {
        guard !working else { return }
        working = true
        problem = nil
        Task {
            do {
                // CACHES, NOT DOCUMENTS. The file exists to be handed to the
                // share sheet; leaving a second copy of the whole ledger
                // sitting in a user-visible folder beside the real backups is
                // the confusion `LedgerService.defaultStoreURL` already refuses
                // to create. The system may reclaim it, and by then it has been
                // copied wherever the owner put it.
                let directory = FileManager.default.temporaryDirectory
                exported = try await app.service.exportBackup(
                    to: directory, today: todayISO()
                )
            } catch {
                problem = AppModel.message(for: error)
            }
            working = false
        }
    }

    /// "412 KB". Rough on purpose: the exact byte count answers no question
    /// anybody has about a backup.
    static func size(_ bytes: Int) -> String {
        let formatter = ByteCountFormatter()
        formatter.countStyle = .file
        return formatter.string(fromByteCount: Int64(bytes))
    }
}
