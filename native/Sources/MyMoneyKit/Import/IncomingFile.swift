// What a file that arrived from somewhere else actually is.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE EXTENSION IS NOT EVIDENCE
//
// A file arriving from the share sheet, from Files, from AirDrop or from a mail
// attachment brings a name with it, and the name is whatever the last app to
// touch it decided to call it. "backup.csv" is routinely a JSON backup somebody
// renamed; "export.json" is routinely a spreadsheet. Routing on the extension
// means routing on a guess, and the two wrong answers are not symmetrical:
//
//   * a CSV read as a backup is refused loudly by `BackupImporter`, which is
//     fine;
//   * A BACKUP READ AS A CSV IS THE DANGEROUS ONE. It would be parsed as rows
//     of text, and every check that makes an import safe -- the manifest, the
//     recomputed balances, the round trip -- would never run, because the code
//     that runs them was never called.
//
// So the decision is made on the BYTES, here, once, and the name is used for
// nothing but showing the owner which file they picked.
//
// AND THIS DECIDES A ROUTE, NOT A VERDICT. `.backup` means "hand it to
// BackupImporter", which will then do the whole of its own checking and may
// well refuse it. Nothing here relaxes anything: there is no path in this app
// that reaches the database without going through the importer, and this file
// does not create one.
import Foundation

/// Which of the app's two doors a file goes through.
public enum IncomingFileKind: Sendable, Hashable {
    /// Looks like a MyMoney backup document. Goes to `BackupImporter`, which
    /// checks it properly.
    case backup
    /// Looks like delimited text.
    case csv
    /// Neither, with the reason in the owner's words.
    case unreadable(String)

    public var isBackup: Bool { self == .backup }
}

public enum IncomingFile {

    /// The file types this app tells the system it can open. Used to build the
    /// document-type declarations, and repeated nowhere else.
    public static let acceptedExtensions = ["json", "csv", "txt", "tsv"]

    /// Biggest file this app will take from another app.
    ///
    /// The owner's real backup is a few megabytes; fifty is roughly ten times
    /// the largest plausible one. The limit exists because a share sheet is a
    /// door other apps push things through, and reading an arbitrary number of
    /// bytes into memory on a phone because somebody shared a video is a crash
    /// rather than a refusal.
    public static let maximumBytes = 50 * 1024 * 1024

    /// What this file is, decided from its contents.
    public static func kind(of data: Data, fileName: String) -> IncomingFileKind {
        guard !data.isEmpty else {
            return .unreadable("\(display(fileName)) is empty.")
        }
        guard data.count <= maximumBytes else {
            return .unreadable(
                "\(display(fileName)) is too big to be a backup or a statement "
                    + "(\(data.count / 1024 / 1024) MB)."
            )
        }
        guard let text = String(data: data, encoding: .utf8) else {
            return .unreadable(
                "\(display(fileName)) is not text. A backup is a .json file and a statement is "
                    + "a .csv file; this is neither."
            )
        }

        // A BACKUP IS RECOGNISED BY ITS SHAPE, not by its extension and not by
        // a substring search. It has to parse as JSON and be an object -- which
        // is the same first step `BackupImporter` takes, so a file this accepts
        // is a file the importer can at least begin on.
        let trimmed = Money.trimmingJSWhitespace(text)
        if trimmed.hasPrefix("{"), let parsed = try? JSONParser.parse(trimmed),
            parsed.objectValue != nil
        {
            return .backup
        }

        // Delimited text: the parser this app already uses, which guesses the
        // delimiter the same way the web app's does. Two rows and two columns
        // is the least a statement can be and still be one -- a single line
        // with no separator is a note, not a table.
        let table = CSV.parse(text)
        if table.data.count >= 2, table.data.contains(where: { $0.count >= 2 }) {
            return .csv
        }

        if trimmed.hasPrefix("{") || trimmed.hasPrefix("[") {
            return .unreadable(
                "\(display(fileName)) looks like JSON but could not be read. If it is a backup, "
                    + "export a fresh one from your web app."
            )
        }
        return .unreadable(
            "\(display(fileName)) is not something this app can read. It takes a .json backup "
                + "from your web app, or a .csv statement."
        )
    }

    private static func display(_ fileName: String) -> String {
        fileName.isEmpty ? "That file" : "\u{201C}\(fileName)\u{201D}"
    }
}

/// What a delimited file appears to contain, without importing any of it.
///
/// WHY A PREVIEW AND NOT AN IMPORT. This package can PARSE a statement -- the
/// column detection, the date-order guessing and the amount rules are all in
/// `Import/Generic.swift`, held to the oracle's fixtures -- and it has no way
/// to WRITE one into the book. Bringing rows in needs an account to put them
/// in, a column mapping the owner has confirmed, and a dedupe pass against what
/// is already there; none of that exists yet, and half of it existing would be
/// the second write path this app is built not to have.
///
/// So a shared CSV is read, described honestly, and not written. The owner sees
/// what the file holds and is told plainly that nothing was added. That is a
/// smaller feature than importing it, and it is a true one.
public struct CSVPreview: Sendable, Hashable {
    /// Rows below the header.
    public let rowCount: Int
    /// The header row as it stands in the file.
    public let columnNames: [String]
    /// The first few data rows, for showing what the columns hold.
    public let sampleRows: [[String]]
    /// Problems the parser noticed. Empty for a well-formed file.
    public let warnings: [String]

    public static let sampleLimit = 3

    /// Describe a delimited file, or nil when there is not a table in it.
    public static func of(_ text: String) -> CSVPreview? {
        let table = CSV.parse(text)
        guard let header = table.data.first, table.data.count >= 2 else { return nil }
        let body = Array(table.data.dropFirst())
        return CSVPreview(
            rowCount: body.count,
            columnNames: header,
            sampleRows: Array(body.prefix(sampleLimit)),
            warnings: table.errors
        )
    }
}
