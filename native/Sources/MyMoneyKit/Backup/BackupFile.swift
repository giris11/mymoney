// Reading a backup file: validate first, accept second, never the other way.
//
// The contract is src/backup/backup.ts. Everything here happens BEFORE any
// caller is handed a record, because the one thing a finance app must never do
// is half-apply a file it turns out not to like.
import Foundation

public struct BackupFile: Sendable {
    public let app: String
    public let schemaVersion: Int
    public let exportedAt: String
    /// Absent means "this file cannot prove itself", never "this file is
    /// invalid". Every backup written before the manifest existed has none, and
    /// so does every sync snapshot.
    public let manifest: BackupManifest?
    public let tables: [String: [JSONValue]]
    /// The document exactly as parsed. The content hash is taken over THIS, not
    /// over a re-derivation from the typed records: a fingerprint that only
    /// covered the fields this build happens to understand would silently stop
    /// covering a field a newer build added.
    public let root: JSONValue
}

public enum BackupValidationError: Error, Equatable, Sendable, CustomStringConvertible {
    case invalid(String)

    public var description: String {
        switch self { case .invalid(let message): return message }
    }
}

public enum BackupReader {
    /// The field allowed to differ between two exports of an unchanged book.
    /// It appears twice -- at the top of the file and inside the manifest --
    /// and BOTH copies are dropped before hashing, so the fingerprint describes
    /// the DATA and nothing else.
    public static let timestampField = "exportedAt"

    /// Validate a parsed document without accepting anything from it.
    ///
    /// Checks the file shape, the app marker, the schema version, the presence
    /// of an array for every known table, and basic per-row sanity. Unknown
    /// extra table keys are IGNORED, deliberately: a file written by a build
    /// that has one more table must still restore here, minus the table this
    /// build has never heard of, rather than being refused outright.
    public static func validate(_ parsed: JSONValue) throws -> BackupFile {
        guard let members = parsed.objectValue else {
            throw BackupValidationError.invalid(
                "Not a valid backup: expected a JSON object at the top level"
            )
        }
        guard members["app"]?.stringValue == "MyMoney" else {
            throw BackupValidationError.invalid(
                "Not a MyMoney backup file: \"app\" field is missing or not \"MyMoney\""
            )
        }
        guard let rawVersion = members["schemaVersion"], let version64 = rawVersion.intValue,
              let version = Int(exactly: version64), version >= 1
        else {
            throw BackupValidationError.invalid(
                "Invalid backup: \"schemaVersion\" must be a positive integer"
            )
        }
        guard version <= Schema.version else {
            throw BackupValidationError.invalid(
                "This backup was created by a newer version of MyMoney (schema \(version); "
                    + "this app supports up to \(Schema.version)). Update the app, then restore."
            )
        }
        guard let exportedAt = members[timestampField]?.stringValue else {
            throw BackupValidationError.invalid(
                "Invalid backup: \"exportedAt\" must be a timestamp string"
            )
        }
        guard let tableMembers = members["tables"]?.objectValue else {
            throw BackupValidationError.invalid(
                "Invalid backup: \"tables\" must be an object mapping table names to arrays"
            )
        }

        var tables: [String: [JSONValue]] = [:]
        for name in Schema.allTables {
            guard let raw = tableMembers[name] else {
                throw BackupValidationError.invalid("Invalid backup: table \"\(name)\" is missing")
            }
            guard let rows = raw.arrayValue else {
                throw BackupValidationError.invalid("Invalid backup: table \"\(name)\" must be an array")
            }
            // A duplicate primary key inside a table is corruption, and it is
            // caught HERE because there is no store to catch it later. The
            // TypeScript restore relies on Dexie's `bulkAdd` (not `bulkPut`)
            // rejecting it -- "abort, don't mask" -- and a reader with no
            // database would otherwise be the one component that silently
            // accepted two versions of the same account and picked one.
            var seen: Set<String> = []
            for (index, row) in rows.enumerated() {
                guard let fields = row.objectValue else {
                    throw BackupValidationError.invalid("Invalid backup: \(name)[\(index)] is not an object")
                }
                guard let id = fields["id"]?.stringValue, !id.isEmpty else {
                    throw BackupValidationError.invalid("Invalid backup: \(name)[\(index)] has no string \"id\"")
                }
                if name == "settings" && id != "app" {
                    throw BackupValidationError.invalid(
                        "Invalid backup: settings[\(index)] must have id \"app\" (got \"\(id)\")"
                    )
                }
                if !seen.insert(id).inserted {
                    throw BackupValidationError.invalid(
                        "Invalid backup: table \"\(name)\" has two rows with id \"\(id)\""
                    )
                }
            }
            tables[name] = rows
        }

        // The manifest is optional, but a MALFORMED one is corruption and must
        // be caught here, before anything is accepted. The figures themselves
        // are checked against the rows afterwards, by BackupImporter.
        var manifest: BackupManifest?
        if let raw = members["manifest"], !raw.isNull {
            if let problem = Manifest.validateShape(
                raw, fileSchemaVersion: version, fileExportedAt: exportedAt
            ) {
                throw BackupValidationError.invalid(problem)
            }
            if Manifest.isCheckable(raw) {
                manifest = try Manifest.decode(raw)
            }
        }

        return BackupFile(
            app: "MyMoney",
            schemaVersion: version,
            exportedAt: exportedAt,
            manifest: manifest,
            tables: tables,
            root: parsed
        )
    }

    /// The part of a backup the fingerprint covers: everything EXCEPT the
    /// export timestamp, at both the places it appears. Exposed so a test -- or
    /// a curious owner -- can see exactly what is and is not being hashed,
    /// rather than trusting the hash function.
    public static func contentForHash(_ parsed: JSONValue) -> JSONValue {
        guard var members = parsed.objectValue else { return parsed }
        members.removeValue(forKey: timestampField)
        if var manifest = members["manifest"]?.objectValue {
            manifest.removeValue(forKey: timestampField)
            members["manifest"] = .object(manifest)
        }
        return .object(members)
    }

    /// Canonical fingerprint of a backup's contents, ignoring when it was taken.
    ///
    /// Two exports of an unchanged database have the same fingerprint; a book
    /// that has changed by one penny does not. ALWAYS over the COMPACT form, so
    /// a pretty-printed small backup and the same content written compactly
    /// fingerprint identically -- whitespace is not data.
    ///
    /// ONE THING IT COVERS THAT MIGHT SURPRISE YOU: the settings row,
    /// device-local half included. That is deliberate (the fingerprint
    /// describes the FILE, and a faithful import reproduces the file), but it
    /// means the same book on two devices fingerprints differently.
    public static func canonicalHash(_ parsed: JSONValue) -> String {
        ContentHash.sha256Hex(CanonicalJSON.text(contentForHash(parsed), indent: 0))
    }
}
