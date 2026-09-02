// A file handed to this app by another one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE RULE: A SHARED FILE TAKES THE SAME DOOR AS A CHOSEN ONE
//
// A backup that arrives from the share sheet, from Files, from AirDrop or from
// a mail attachment goes to `AppModel.importBackup`, which goes to
// `LedgerService.importBackup`, which goes to `BackupImporter` -- the same
// path, with the same manifest check, the same recomputed balances and the same
// round-trip verification as a file picked in the open panel. There is no
// second importer here and there must never be one: the whole value of the
// check is that there is no way to reach the database around it.
//
// AND ARRIVING IS NOT IMPORTING. An import REPLACES the copy on this device. A
// file that imported itself because somebody tapped Share in Mail would be a
// book replaced by accident, so a shared file lands on the Import screen,
// described, with the same confirmation an owner gets when they pick one
// themselves. The share sheet chooses the FILE; the owner still chooses the
// import.
//
// WHAT IS AND IS NOT SUPPORTED, plainly: a .json backup imports. A .csv is
// read, described -- how many rows, which columns -- and NOT written, because
// this app has no validated path from a statement's rows into the book yet.
// Half of one would be the second write path this project is built without.
import Foundation
import MyMoneyKit

/// A file this app has been handed, already read and already identified.
///
/// The BYTES are carried, not the URL. A URL from another app is only reachable
/// while its security scope is held, and that scope ends when the handler
/// returns -- long before the `Task` that would use it runs. The same mistake,
/// and the same fix, as `ImportView.handle(_:)`.
struct IncomingDocument: Identifiable, Sendable {
    let id = UUID()
    let fileName: String
    let data: Data
    let kind: IncomingFileKind
    /// Filled in for a CSV: what the file appears to hold, so the screen can
    /// describe it without importing it.
    let preview: CSVPreview?

    /// Read a URL handed over by the system.
    ///
    /// Returns nil only when the file could not be READ at all; a file that is
    /// readable but is not something this app takes comes back with
    /// `kind == .unreadable` and its own sentence, because "nothing happened"
    /// after sharing a file is the worst answer available.
    static func read(_ url: URL) -> IncomingDocument? {
        let scoped = url.startAccessingSecurityScopedResource()
        defer { if scoped { url.stopAccessingSecurityScopedResource() } }

        let name = url.lastPathComponent
        // The whole file now, not `.mappedIfSafe`: a mapping would fault the
        // moment the scope above is released.
        guard let data = try? Data(contentsOf: url) else {
            return IncomingDocument(
                fileName: name,
                data: Data(),
                kind: .unreadable(
                    "\u{201C}\(name)\u{201D} could not be opened. If it came from another app, "
                        + "try saving it to Files first and choosing it here."
                ),
                preview: nil
            )
        }

        let kind = IncomingFile.kind(of: data, fileName: name)
        let preview =
            kind == .csv
            ? String(data: data, encoding: .utf8).flatMap(CSVPreview.of)
            : nil
        return IncomingDocument(fileName: name, data: data, kind: kind, preview: preview)
    }

    /// A file dropped in the app's Inbox is a COPY the system made for this
    /// app, and it is this app's job to tidy it up. Called after the owner has
    /// decided what to do with it, never before -- deleting it while the screen
    /// still holds it would leave a description of a file that is gone.
    func discardInboxCopy(at url: URL) {
        guard url.path.contains("/Inbox/") else { return }
        try? FileManager.default.removeItem(at: url)
    }
}
