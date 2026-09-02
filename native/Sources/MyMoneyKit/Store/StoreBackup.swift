// A backup file into the store, and the store back out to a backup file.
//
// THE PROPERTY THIS FILE EXISTS FOR: a backup imported and then exported
// reproduces the SAME CANONICAL CONTENT HASH. That single statement covers both
// halves of the risk at once -- the store LOST nothing (or a field would be
// missing) and INVENTED nothing (or a field would have appeared). Balances
// agreeing is a weaker claim: two books can agree about every total and
// disagree about a field, and it is the field that gets lost in a migration.
//
// THE TWO FACTS A ROUND TRIP CANNOT DERIVE FROM THE ROWS, and which the store
// therefore has to remember (in `store_meta`, added by migration 2):
//
//   * the file's `schemaVersion`, stamped into the document;
//   * the manifest's version, which SELECTS THE NET-WORTH ARITHMETIC. v1 rounds
//     each account into base currency and sums; v2 sums each currency and
//     converts the subtotal once. On a book with two counted accounts in one
//     currency the two answers differ by a penny -- and a headline figure that
//     moves across a round trip looks exactly like corruption.
//
// WHY THERE ARE TWO EXPORTS AND NOT ONE. They answer different questions and
// conflating them would be how a v1 file gets written in 2026:
//
//   * `exportBackup...`            -- what THIS BUILD would write today: current
//                                     schema, current manifest rule, now.
//     The app's export button.
//   * `exportReproducingSource...` -- the file the store was LOADED FROM, byte
//                                     for byte, under ITS OWN rule. Evidence,
//                                     not a feature: it is how the round-trip
//                                     property is checked, and it is the only
//                                     thing in this package permitted to write
//                                     a manifest version this build no longer
//                                     writes.
import Foundation

/// How the book in this store arrived. Empty on a store that has never had a
/// backup imported into it.
public struct StoreProvenance: Sendable, Hashable {
    /// Whether this book was IMPORTED from a backup or CREATED here.
    ///
    /// THE FIELD THE WORDING HANGS OFF. Everything else on this struct
    /// describes a FILE, and is nil for a book that never came from one; this
    /// says whether there is a file -- and a web app behind it -- in the story
    /// at all. See BookOrigin.swift for the transitions and for why an absent
    /// record reads as `.imported`.
    public let origin: BookOrigin
    /// The `exportedAt` of the file this book came from.
    public let exportedAt: String?
    /// The BACKUP FILE's schema version (`Schema.version`'s scale), not the
    /// store's.
    public let schemaVersion: Int?
    /// The manifest version the file carried, when it carried a checkable one.
    /// This is what selects the net-worth rule on the way back out.
    public let manifestVersion: Int?
    /// The canonical content hash of the file as it arrived.
    public let contentHash: String?
    /// When the import ran, in this app's clock.
    public let importedAt: String?

    /// No file facts at all. Deliberately NOT about `origin`: a created book
    /// has an origin and no source file, and "we know nothing about the file"
    /// is exactly what this asks.
    public var isEmpty: Bool {
        exportedAt == nil && schemaVersion == nil && manifestVersion == nil
            && contentHash == nil && importedAt == nil
    }
}

/// What an import did, and whether the store can reproduce what it read.
public struct StoreImportResult: Sendable {
    /// Everything the file claimed and everything its rows produce. The
    /// manifest check has already passed by the time this exists.
    public let imported: ImportedBackup
    /// Rows that LANDED, counted out of the store, keyed by BACKUP table name.
    public let rowCounts: [String: Int]
    /// The canonical content hash of the file as it arrived.
    public let sourceContentHash: String
    /// What the store re-exports to under the source's own rule. `nil` when the
    /// file carried no manifest, or one whose version this build has no rule
    /// for -- in both cases there is nothing to reproduce it against.
    public let roundTripContentHash: String?
    /// The store neither lost nor invented anything.
    public var reproducesSource: Bool {
        roundTripContentHash != nil && roundTripContentHash == sourceContentHash
    }
    /// Everything worth saying that is not grounds for refusal: the importer's
    /// own warnings, plus anything the round-trip comparison found.
    public let warnings: [String]
}

extension LedgerStore {

    // MARK: - store_meta keys

    enum ProvenanceKey {
        static let exportedAt = "source.exportedAt"
        static let schemaVersion = "source.schemaVersion"
        static let manifestVersion = "source.manifestVersion"
        static let contentHash = "source.contentHash"
        static let importedAt = "source.importedAt"
    }

    public func provenance() throws -> StoreProvenance {
        StoreProvenance(
            origin: try bookOrigin(),
            exportedAt: try meta(ProvenanceKey.exportedAt),
            schemaVersion: try meta(ProvenanceKey.schemaVersion).flatMap(Int.init),
            manifestVersion: try meta(ProvenanceKey.manifestVersion).flatMap(Int.init),
            contentHash: try meta(ProvenanceKey.contentHash),
            importedAt: try meta(ProvenanceKey.importedAt)
        )
    }

    // MARK: - Import

    /// Read a backup file into the store, all or nothing.
    ///
    /// THE ORDER OF OPERATIONS IS THE DESIGN:
    ///
    ///   1. Parse, validate, decode and make the file PROVE ITSELF against its
    ///      own manifest -- all before the database is touched at all. A file
    ///      that does not add up never reaches a write.
    ///   2. Refuse to overwrite a store that already holds a book unless the
    ///      caller says so. "Restore" is not a word that should ever quietly
    ///      mean "destroy what was there".
    ///   3. One transaction: clear, write every table, record provenance, audit
    ///      every money column, and only then commit. A failure anywhere in
    ///      there -- including a failure of the audit -- rolls the whole thing
    ///      back and leaves the store exactly as it was.
    ///
    /// `requiringExactRoundTrip` turns the round-trip comparison from a warning
    /// into a refusal. It defaults to FALSE, and that default is deliberate: a
    /// legitimate file can fail the comparison without being wrong, because
    /// this package's record model does not carry every key a file might have
    /// (BackupWriter says exactly which -- an unmodelled key is dropped, an
    /// absent required field comes back at its default). Refusing a sound
    /// backup is the one failure this whole subsystem exists to prevent, so the
    /// default reports and the strict mode is opt-in.
    @discardableResult
    public func importBackup(
        text: String,
        replacingExistingBook: Bool = false,
        requiringExactRoundTrip: Bool = false
    ) throws -> StoreImportResult {
        try importBackup(
            imported: try BackupImporter.load(text: text),
            replacingExistingBook: replacingExistingBook,
            requiringExactRoundTrip: requiringExactRoundTrip,
            afterEachTable: nil
        )
    }

    @discardableResult
    public func importBackup(
        data: Data,
        replacingExistingBook: Bool = false,
        requiringExactRoundTrip: Bool = false
    ) throws -> StoreImportResult {
        try importBackup(
            imported: try BackupImporter.load(data: data),
            replacingExistingBook: replacingExistingBook,
            requiringExactRoundTrip: requiringExactRoundTrip,
            afterEachTable: nil
        )
    }

    /// The one that does the work. `afterEachTable` is a TEST SEAM (see
    /// `writeBook`) and is why this overload is internal.
    @discardableResult
    func importBackup(
        imported: ImportedBackup,
        replacingExistingBook: Bool,
        requiringExactRoundTrip: Bool,
        afterEachTable: ((String) throws -> Void)?
    ) throws -> StoreImportResult {
        if !replacingExistingBook, !(try isEmpty()) {
            throw StoreError.storeNotEmpty(
                accounts: try liveCount("accounts"),
                transactions: try liveCount("transactions")
            )
        }

        var warnings = imported.warnings
        var roundTripHash: String?

        try connection.transaction {
            try writeBook(imported.book, afterEachTable: afterEachTable)

            try setMeta(ProvenanceKey.exportedAt, imported.file.exportedAt)
            try setMeta(ProvenanceKey.schemaVersion, String(imported.file.schemaVersion))
            try setMeta(
                ProvenanceKey.manifestVersion,
                imported.claimedManifest.map { String($0.manifestVersion) }
            )
            try setMeta(ProvenanceKey.contentHash, imported.contentHash)
            try setMeta(ProvenanceKey.importedAt, Self.timestampNow())
            // AN IMPORT ALWAYS MAKES THIS AN IMPORTED BOOK, whatever was here
            // before -- including a book that was CREATED here and has just
            // been replaced wholesale by the file (which took an explicit
            // `replacingExistingBook`). What this store holds now is a copy of
            // a book that exists somewhere else, and calling it "created here"
            // would be a claim about rows that no longer exist. The reasoning
            // in full, and the reverse direction, is in BookOrigin.swift.
            try setBookOrigin(.imported)
            // The copy has just BECOME the file, so it has drifted from it by
            // nothing. See LedgerStore+LocalEdits.swift for why the count
            // exists at all and why only an import may reset it.
            try clearLocalEdits()

            // INSIDE the transaction, so a store that somehow contains a
            // floating-point amount is never committed. Unreachable through
            // this package's writers, which is the point: this is the check on
            // the assumption, not on the code.
            let problems = try auditMoneyColumns()
            if let first = problems.first { throw first }

            // Also inside, so that `requiringExactRoundTrip` can actually
            // refuse rather than merely complain after the fact.
            //
            // The "cannot check" case is decided UP FRONT, from the manifest,
            // rather than by catching whatever the re-export throws. Swallowing
            // errors here would turn a genuinely corrupt read into the
            // reassuring words "no manifest to compare against".
            let version = imported.claimedManifest?.manifestVersion
            if let version, Manifest.netWorthRule(forVersion: version) != nil {
                let rebuilt = try exportReproducingSourceHash()
                roundTripHash = rebuilt
                if rebuilt != imported.contentHash {
                    let message =
                        "the store re-exports to a different file than the one it read "
                        + "(read \(imported.contentHash.prefix(12))…, re-exported "
                        + "\(rebuilt.prefix(12))…)"
                        + (try firstDivergingTable(from: imported.file).map { ": \($0) differs" } ?? "")
                    if requiringExactRoundTrip {
                        throw StoreError.corrupt(message + ". Nothing was changed.")
                    }
                    warnings.append(message)
                }
            } else if requiringExactRoundTrip {
                throw StoreError.corrupt(
                    "this file carries no manifest this build can reproduce, so an exact round "
                        + "trip cannot be verified and was demanded. Nothing was changed."
                )
            } else {
                warnings.append(
                    "this file carries no manifest this build can reproduce, so the store "
                        + "cannot check that it re-exports to the same bytes"
                )
            }
        }

        // Counted out of the STORE, after the commit -- a statement about what
        // landed, not a restatement of what was offered.
        var rowCounts: [String: Int] = [:]
        for name in Schema.allTables {
            rowCounts[name] = try liveCount(StoreSchema.table(forBackupTable: name))
        }

        return StoreImportResult(
            imported: imported,
            rowCounts: rowCounts,
            sourceContentHash: imported.contentHash,
            roundTripContentHash: roundTripHash,
            warnings: warnings
        )
    }

    // MARK: - Export, as this build writes files

    /// The book, as a backup document written the way THIS BUILD writes one:
    /// current schema version, current manifest rule, and the timestamp given
    /// (or now).
    ///
    /// TOMBSTONED ROWS ARE NOT IN IT, and cannot be: the file format has no way
    /// to say "deleted". That is not a gap in the export, it is the reason the
    /// store keeps tombstones and the file does not -- the file describes what
    /// the book IS, the store additionally remembers what it WAS.
    public func exportBackupFile(exportedAt: String? = nil) throws -> JSONValue {
        try BackupWriter.file(
            try book(),
            exportedAt: exportedAt ?? Self.timestampNow(),
            schemaVersion: Schema.version
        )
    }

    public func exportBackupText(exportedAt: String? = nil) throws -> String {
        BackupWriter.serialise(try exportBackupFile(exportedAt: exportedAt))
    }

    /// The fingerprint of what this build would export. Ignores when the export
    /// was taken, exactly as `BackupReader.canonicalHash` does.
    public func exportContentHash(exportedAt: String? = nil) throws -> String {
        BackupReader.canonicalHash(try exportBackupFile(exportedAt: exportedAt))
    }

    // MARK: - Export, reproducing the source file

    /// The book written back out under the SOURCE FILE'S OWN rules -- its
    /// schema version, its manifest version, its export timestamp.
    ///
    /// EVIDENCE, NOT A FEATURE. This is the only thing in the package allowed
    /// to emit a manifest version this build no longer writes, and the reason
    /// is the same one FrozenGateTests has: the question a port must be able to
    /// answer is "take the file, decode it, throw the document away, rebuild it
    /// from the records -- is it the file that arrived?" Recomputing an old
    /// file under today's rule would answer a different question and would
    /// refuse a backup that is perfectly sound.
    ///
    /// Throws when the store has no provenance (nothing was imported into it)
    /// or when the source's manifest version has no known rule.
    public func exportReproducingSource() throws -> JSONValue {
        let provenance = try provenance()
        guard let exportedAt = provenance.exportedAt else {
            throw StoreError.corrupt(
                "this store has no imported file to reproduce; use exportBackupFile() instead"
            )
        }
        guard let manifestVersion = provenance.manifestVersion else {
            throw StoreError.corrupt(
                "the file this store was loaded from carried no checkable manifest, so there is "
                    + "no rule to reproduce it under"
            )
        }
        guard let rule = Manifest.netWorthRule(forVersion: manifestVersion) else {
            throw StoreError.corrupt(
                "the file this store was loaded from states manifest version \(manifestVersion), "
                    + "whose net-worth rule this build does not know"
            )
        }
        return try BackupWriter.file(
            try book(),
            exportedAt: exportedAt,
            schemaVersion: provenance.schemaVersion ?? Schema.version,
            netWorthRule: rule
        )
    }

    public func exportReproducingSourceText() throws -> String {
        BackupWriter.serialise(try exportReproducingSource())
    }

    public func exportReproducingSourceHash() throws -> String {
        BackupReader.canonicalHash(try exportReproducingSource())
    }

    /// Does this store still reproduce the file it was loaded from?
    ///
    /// The round-trip property, askable at any time -- after an import, after a
    /// migration, after a build that changed a record type. A `false` here does
    /// not mean the money is wrong; it means the FILE would come back different,
    /// which is the earlier and more useful alarm.
    public func reproducesSourceFile() throws -> Bool {
        guard let claimed = try provenance().contentHash else { return false }
        return (try? exportReproducingSourceHash()) == claimed
    }

    /// The first backup table whose re-export differs from the source, for an
    /// error message that names something instead of two hashes.
    func firstDivergingTable(from file: BackupFile) throws -> String? {
        guard let rebuilt = try? exportReproducingSource(),
              let rebuiltTables = rebuilt["tables"]?.objectValue
        else { return nil }
        for name in Schema.allTables {
            let before = JSONValue.array(file.tables[name] ?? [])
            let after = rebuiltTables[name] ?? .array([])
            if before != after { return name }
        }
        if rebuilt["manifest"] != file.root["manifest"] { return "manifest" }
        return nil
    }

    // MARK: - Time

    /// An ISO-8601 instant in the shape the web app writes:
    /// `2026-09-01T12:00:00.000Z`. Milliseconds and a `Z`, because that is what
    /// `new Date().toISOString()` produces and a store whose timestamps looked
    /// different would produce files that looked foreign.
    static func timestampNow(_ date: Date = Date()) -> String {
        let formatter = ISO8601DateFormatter()
        formatter.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        formatter.timeZone = TimeZone(secondsFromGMT: 0)
        return formatter.string(from: date)
    }
}
