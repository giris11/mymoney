// What the app is currently showing, and everything that can change it.
//
// One `@Observable` on the main actor, holding only `Sendable` values that came
// out of `LedgerService`. It never holds a `LedgerStore`, a statement, or
// anything else that belongs to the database's thread.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE STATE MACHINE GREW BECAUSE THE APP CAN NOW WRITE, and the two additions
// are both about honesty rather than about editing:
//
//   1. `revision`. Every successful mutation bumps it, and every screen that
//      draws the book is rebuilt from it. That is deliberately blunter than
//      patching the affected row in place: a register whose running balance was
//      patched would be a second implementation of the arithmetic, and the
//      first symptom of it drifting would be a balance on this screen that
//      disagreed with the account's own. Reading the page again costs
//      milliseconds and cannot disagree.
//
//   2. `pendingUndo`. A delete is not a question ("are you sure?") but an
//      action with a way back, because that is the only design in which the
//      common case -- a delete the owner meant -- is one tap, and the rare case
//      is still recoverable. It is recoverable EXACTLY: the row was never
//      destroyed, so undo clears a tombstone rather than rebuilding anything.
//
// A REFUSAL IS NEVER SWALLOWED AND NEVER SHOWN AS "Error". `EditRefusal`
// carries the store's own two sentences -- what was wrong, and what was NOT
// changed -- and every editor shows both.
import Foundation
import MyMoneyKit
import Observation

/// Why an edit did not happen, in the words the owner should read.
struct EditRefusal: Sendable, Hashable {
    let problem: String
    /// "Nothing was saved -- the transaction is still as it was." The half that
    /// stops somebody re-entering work the app already has.
    let unchanged: String

    init(_ error: EditError) {
        problem = error.problem
        unchanged = error.unchanged
    }

    /// Anything that is not an `EditError` -- a database that will not open, a
    /// disk that is full. The kit's errors already explain themselves.
    init(unexpected error: Error) {
        problem = AppModel.message(for: error)
        unchanged = "Nothing was changed."
    }
}

/// What a save did. `Void` would not do: the editor stays open on a refusal and
/// closes on success, and it needs to be told which.
enum EditOutcome: Sendable {
    case saved
    case refused(EditRefusal)

    var refusal: EditRefusal? {
        if case .refused(let refusal) = self { return refusal }
        return nil
    }

    var didSave: Bool { if case .saved = self { return true } else { return false } }
}

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

    /// A delete that can still be taken back, and the sentence offering it.
    struct PendingUndo: Identifiable, Sendable {
        let id = UUID()
        let receipt: DeletedTransactions
        let message: String
    }

    let service = LedgerService()

    private(set) var phase: Phase = .loading
    var importPhase: ImportPhase = .idle

    /// Bumped by every committed change. Screens that draw the book watch it.
    private(set) var revision = 0

    /// The most recent delete, while it can still be undone. Cleared when it is
    /// undone, when another change lands, or when the owner dismisses it.
    private(set) var pendingUndo: PendingUndo?

    /// The lookups the register needs, read once per book and shared by every
    /// register screen. Re-read after a change, because an edit can create a
    /// payee, a tag or an account that a row now needs a name for.
    private(set) var lookups: RegisterLookups?

    var summary: LedgerSummary? {
        if case .ready(let summary) = phase { return summary }
        return nil
    }

    var hasBook: Bool { summary != nil }

    /// How far this copy has drifted from the backup it was made from.
    var localEdits: LocalEdits { summary?.localEdits ?? .none }

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

    /// Re-read after a change WITHOUT flashing the loading state. The screen is
    /// already showing a book; replacing it with a spinner for 3ms is a flicker
    /// that reads as instability on the one screen that must not.
    private func refresh() async {
        do {
            if let summary = try await service.summary() {
                lookups = try await service.registerLookups()
                phase = .ready(summary)
            } else {
                lookups = nil
                phase = .empty
            }
        } catch {
            phase = .failed(Self.message(for: error))
        }
        revision += 1
    }

    // MARK: - Transactions

    func save(_ draft: TransactionDraft) async -> EditOutcome {
        await run { _ = try await self.service.save(draft) }
    }

    func save(_ draft: TransferDraft) async -> EditOutcome {
        await run { _ = try await self.service.save(draft) }
    }

    /// Delete, and keep the receipt so it can be taken back.
    func deleteTransaction(id: String) async -> EditOutcome {
        do {
            let receipt = try await service.deleteTransaction(id: id)
            pendingUndo = PendingUndo(receipt: receipt, message: Self.undoMessage(for: receipt))
            await refresh()
            return .saved
        } catch let error as EditError {
            return .refused(EditRefusal(error))
        } catch {
            return .refused(EditRefusal(unexpected: error))
        }
    }

    func undoLastDelete() async {
        guard let pending = pendingUndo else { return }
        pendingUndo = nil
        _ = await run { _ = try await self.service.undoDelete(pending.receipt) }
    }

    func dismissUndo() { pendingUndo = nil }

    /// "Deleted Kiosk, £3.50." -- the row named the way the register named it,
    /// so the sentence describes the line that has just gone.
    private static func undoMessage(for receipt: DeletedTransactions) -> String {
        let amount = Display.money(receipt.amountMinor, receipt.currency)
        if receipt.isTransfer {
            return "Deleted the transfer, \(amount) \u{2014} both halves."
        }
        return "Deleted \u{201C}\(receipt.title)\u{201D}, \(amount)."
    }

    // MARK: - Accounts

    func save(_ draft: AccountDraft) async -> EditOutcome {
        await run { _ = try await self.service.save(draft) }
    }

    func save(_ draft: AccountGroupDraft) async -> EditOutcome {
        await run { _ = try await self.service.save(draft) }
    }

    func setAccountArchived(id: String, archived: Bool) async -> EditOutcome {
        await run { try await self.service.setAccountArchived(id: id, archived: archived) }
    }

    func setAccountExcluded(id: String, excluded: Bool) async -> EditOutcome {
        await run { try await self.service.setAccountExcluded(id: id, excluded: excluded) }
    }

    func moveAccount(id: String, toGroup groupId: String?) async -> EditOutcome {
        await run { try await self.service.moveAccount(id: id, toGroup: groupId) }
    }

    func reorderAccount(id: String, _ direction: MoveDirection) async -> EditOutcome {
        await run { try await self.service.reorderAccount(id: id, direction) }
    }

    func deleteAccount(id: String) async -> EditOutcome {
        await run { _ = try await self.service.deleteAccount(id: id) }
    }

    func deleteAccountGroup(id: String) async -> EditOutcome {
        await run { _ = try await self.service.deleteAccountGroup(id: id) }
    }

    func reorderAccountGroup(id: String, _ direction: MoveDirection) async -> EditOutcome {
        await run { try await self.service.reorderAccountGroup(id: id, direction) }
    }

    /// Which editor a register row opens.
    ///
    /// TWO DOORS, AND THE ROW DECIDES WHICH. A transfer leg has no ordinary
    /// draft -- the store will not give one out -- because a transfer edited as
    /// a single transaction would be written back as half a transfer. So this
    /// asks for the ordinary draft first and falls through to the transfer
    /// editor, which is the only place a pair can be changed safely.
    func editorSheet(forTransaction id: String) async -> EditorSheet? {
        do {
            if let draft = try await service.transactionDraft(id: id) {
                return .editTransaction(draft)
            }
            if let transfer = try await service.transferDraft(legId: id) {
                return .transfer(transfer, legId: id)
            }
            return nil
        } catch {
            return nil
        }
    }

    /// One shape for every mutation: do it, and on success re-read the book and
    /// clear any undo offer, because an undo bar left on screen after a
    /// DIFFERENT change would offer to take back something the owner is no
    /// longer looking at.
    private func run(_ body: () async throws -> Void) async -> EditOutcome {
        do {
            try await body()
            pendingUndo = nil
            await refresh()
            return .saved
        } catch let error as EditError {
            return .refused(EditRefusal(error))
        } catch {
            return .refused(EditRefusal(unexpected: error))
        }
    }

    // MARK: - Import

    /// Import a file the owner picked. The data is already in hand -- reading
    /// the bytes is the picker's job, because only it holds the security-scoped
    /// URL.
    func importBackup(data: Data, fileName: String) async {
        importPhase = .reading(fileName: fileName)
        do {
            let summary = try await service.importBackup(data: data, fileName: fileName)
            importPhase = .done(summary)
            pendingUndo = nil
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
    ///
    /// `nonisolated` because `EditRefusal` is a plain value that can be built
    /// anywhere, and a message-formatting function that needed the main actor
    /// would make every error path an `await`.
    nonisolated static func message(for error: Error) -> String {
        if let edit = error as? EditError { return edit.description }
        if let store = error as? StoreError { return store.description }
        if let backup = error as? BackupImportError { return backup.description }
        if let money = error as? MoneyError { return money.description }
        if let sqlite = error as? SQLiteError { return sqlite.description }
        return "\(error)"
    }
}
