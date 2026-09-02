// What the app is currently showing, and the little that can change it.
//
// One `@Observable` on the main actor, holding only `Sendable` values that came
// out of `LedgerService`. It never holds a `LedgerStore`, a statement, or
// anything else that belongs to the database's thread.
//
// THE STATE MACHINE IS SMALL BECAUSE THE APP IS READ-ONLY. There is no editing,
// no optimistic update, no pending write and no conflict: the book changes at
// exactly one moment, when the owner imports a file. Everything else is a read.
import Foundation
import MyMoneyKit
import Observation

@MainActor
@Observable
final class AppModel {
    enum Phase {
        /// Opening the local copy and reading it.
        case loading
        /// No book on this device yet.
        case empty
        case ready(LedgerSummary)
        /// The local copy could not be opened or read. Never a blank screen:
        /// the message says what happened.
        case failed(String)
    }

    enum ImportPhase {
        case idle
        case reading(fileName: String)
        case done(ImportSummary)
        case refused(ImportRefusal)
        case failed(String)
    }

    let service = LedgerService()

    private(set) var phase: Phase = .loading
    var importPhase: ImportPhase = .idle

    /// The lookups the register needs, read once per book and shared by every
    /// register screen. Reading them per screen would be correct and wasteful;
    /// caching them here is safe because nothing invalidates them but an import,
    /// which clears them.
    private(set) var lookups: RegisterLookups?

    var summary: LedgerSummary? {
        if case .ready(let summary) = phase { return summary }
        return nil
    }

    var hasBook: Bool { summary != nil }

    func load() async {
        phase = .loading
        do {
            if let summary = try await service.summary() {
                lookups = try await service.registerLookups()
                phase = .ready(summary)
            } else {
                lookups = nil
                phase = .empty
            }
        } catch {
            lookups = nil
            phase = .failed(Self.message(for: error))
        }
    }

    /// Import a file the owner picked. The data is already in hand -- reading
    /// the bytes is the picker's job, because only it holds the security-scoped
    /// URL.
    func importBackup(data: Data, fileName: String) async {
        importPhase = .reading(fileName: fileName)
        do {
            let summary = try await service.importBackup(data: data, fileName: fileName)
            importPhase = .done(summary)
            await load()
        } catch let refusal as ImportRefusal {
            // NOTHING CHANGED. The importer refuses before the database is
            // opened for writing, so the book already on the device is exactly
            // as it was -- reloading proves it rather than assuming it.
            importPhase = .refused(refusal)
            await load()
        } catch {
            importPhase = .failed(Self.message(for: error))
            await load()
        }
    }

    /// Errors from the kit already explain themselves; `error.localizedDescription`
    /// on a plain Swift `Error` does not, and would show the owner a type name.
    static func message(for error: Error) -> String {
        if let store = error as? StoreError { return store.description }
        if let backup = error as? BackupImportError { return backup.description }
        if let money = error as? MoneyError { return money.description }
        if let sqlite = error as? SQLiteError { return sqlite.description }
        return "\(error)"
    }
}
