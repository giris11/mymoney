// Which imports this device made, so that undo survives leaving the screen.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS RATHER THAN JUST LISTING THE BOOK'S BATCHES
//
// `LedgerStore.importBatches()` lists every import batch the BOOK carries, and
// most of them were not made here. A book restored from a backup arrives with
// the web app's own batches in it -- imports the owner ran in the browser,
// months ago, whose transactions are now simply part of their ledger. Offering
// an "Undo" beside those would offer to delete a chunk of somebody's history
// under the heading of taking back something they just did.
//
// So the offer is made only for imports THIS APP performed, recorded here when
// they land. The list is then intersected with what the book actually holds, so
// an entry whose batch has gone -- undone already, or replaced wholesale by a
// restore -- disappears rather than pointing at nothing.
//
// It is device-local, throwaway state. Losing it costs the undo shortcut and
// nothing else: the batch, the transactions and the ability to undo them all
// live in the book, which is the only place any of it matters.
import Foundation

/// One import made on this device, and enough to describe it in a list.
struct ImportHistoryEntry: Identifiable, Codable, Sendable, Hashable {
    let batchId: String
    let fileName: String
    let transactionCount: Int
    let accountsCreated: Int
    let importedAt: Date

    var id: String { batchId }
}

enum ImportHistory {
    private static let storageKey = "import.history.v1"
    /// How many are kept. Five is more than the number of statements anybody
    /// imports before deciding they are happy with the result, and it keeps the
    /// section on the import screen a section rather than a screen of its own.
    static let capacity = 5

    static func entries(in defaults: UserDefaults = .standard) -> [ImportHistoryEntry] {
        guard let data = defaults.data(forKey: storageKey),
            let stored = try? JSONDecoder().decode([ImportHistoryEntry].self, from: data)
        else { return [] }
        return stored.sorted { $0.importedAt > $1.importedAt }
    }

    static func record(_ outcome: ImportOutcome, in defaults: UserDefaults = .standard) {
        var stored = entries(in: defaults).filter { $0.batchId != outcome.batchId }
        stored.insert(
            ImportHistoryEntry(
                batchId: outcome.batchId,
                fileName: outcome.fileName,
                transactionCount: outcome.transactionCount,
                accountsCreated: outcome.accountsCreated.count,
                importedAt: outcome.importedAt
            ),
            at: 0
        )
        save(Array(stored.prefix(capacity)), in: defaults)
    }

    /// Drop one, because it has been undone.
    static func forget(batchId: String, in defaults: UserDefaults = .standard) {
        save(entries(in: defaults).filter { $0.batchId != batchId }, in: defaults)
    }

    /// Keep only the entries whose batch is still in the book.
    ///
    /// The caller supplies the ids the book holds. An entry that is not among
    /// them describes an import that no longer exists -- the book was replaced,
    /// or the batch was undone somewhere else -- and an Undo button for it
    /// would be a button that could only fail.
    static func pruned(
        toBatchIds existing: Set<String>, in defaults: UserDefaults = .standard
    ) -> [ImportHistoryEntry] {
        let kept = entries(in: defaults).filter { existing.contains($0.batchId) }
        if kept.count != entries(in: defaults).count { save(kept, in: defaults) }
        return kept
    }

    private static func save(_ entries: [ImportHistoryEntry], in defaults: UserDefaults) {
        guard let data = try? JSONEncoder().encode(entries) else { return }
        defaults.set(data, forKey: storageKey)
    }
}
