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

    /// What a delete left behind, so it can be taken back.
    ///
    /// TWO KINDS, because the store hands back two shapes of receipt: deleting
    /// a transaction may have tombstoned BOTH legs of a transfer, which is one
    /// thing the owner did to two rows, while every other delete is one row.
    /// Neither is a rebuild -- both are a flag being cleared on a row that was
    /// never destroyed.
    enum UndoReceipt: Sendable {
        case transactions(DeletedTransactions)
        case record(DeletedRecord)
    }

    /// A delete that can still be taken back, and the sentence offering it.
    struct PendingUndo: Identifiable, Sendable {
        let id = UUID()
        let receipt: UndoReceipt
        let message: String
    }

    /// THE ONE `LedgerService` IN THE PROCESS, shared with the App Intents.
    ///
    /// Not a style choice. An intent can run while the app is in the foreground
    /// -- Siri asked for a coffee while the register is on screen -- and two
    /// `LedgerService` actors would be two SQLite connections writing one file,
    /// each with its own cached `Book`. One connection, one cache, one writer.
    let service = IntentServices.shared.service

    private(set) var phase: Phase = .loading
    var importPhase: ImportPhase = .idle

    /// Bumped by every committed change. Screens that draw the book watch it.
    private(set) var revision = 0

    /// The most recent delete, while it can still be undone. Cleared when it is
    /// undone, when another change lands, or when the owner dismisses it.
    private(set) var pendingUndo: PendingUndo?

    /// The local reminders. Owned here rather than by a view, because they are
    /// re-planned after every change to the book and a view that happened to be
    /// closed must not be the reason a reminder is stale.
    let reminders = RemindersModel()

    /// What is waiting, for the badge in the sidebar. Kept beside the summary
    /// so the badge and the screen it points at come from the same read.
    private(set) var dueCount = 0
    private(set) var overdueCount = 0

    /// What the last automatic run entered, once, so the schedules screen can
    /// say it out loud. Cleared when the owner has seen it.
    ///
    /// A TRANSACTION THAT APPEARED WITHOUT A TAP HAS TO BE ANNOUNCED. That is
    /// the entire safety argument for auto-post: it is opt-in per schedule, it
    /// cannot reach back before the day it was switched on, and when it does
    /// fire the app says so rather than leaving the owner to notice a row they
    /// do not remember making.
    private(set) var lastAutoPost: AutoPostResult?
    /// The day the automatic run last happened, so returning to the app on a
    /// new day runs it and returning ten minutes later does not.
    private var lastAutoPostDay: String?

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
        // BEFORE THE BOOK IS READ, so the screen that appears already contains
        // anything that entered itself. Nothing happens here unless a schedule
        // has auto-post switched on -- see `LedgerStore.postDue`.
        await runAutomaticPosting()
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
        await refreshDueCounts()
        await replanReminders()
        await WidgetPublishing.publish(using: service)
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
        await refreshDueCounts()
        await replanReminders()
        // THE WIDGET IS PART OF THE APP'S HONESTY, not a decoration. A figure
        // on a home screen that is a week behind the book, with nothing to say
        // so, is the same defect as a banner that stopped counting -- so a
        // committed change republishes before this function returns.
        await WidgetPublishing.publish(using: service)
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
        await deleting {
            let receipt = try await self.service.deleteTransaction(id: id)
            return PendingUndo(
                receipt: .transactions(receipt), message: Self.undoMessage(for: receipt)
            )
        }
    }

    func undoLastDelete() async {
        guard let pending = pendingUndo else { return }
        pendingUndo = nil
        _ = await run {
            switch pending.receipt {
            case .transactions(let receipt): _ = try await self.service.undoDelete(receipt)
            case .record(let receipt): try await self.service.undoDelete(receipt)
            }
        }
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

    // MARK: - Budgets

    func save(_ draft: BudgetDraft) async -> EditOutcome {
        await run { _ = try await self.service.saveBudget(draft) }
    }

    func setBudgetArchived(id: String, archived: Bool) async -> EditOutcome {
        await run { try await self.service.setBudgetArchived(id: id, archived: archived) }
    }

    /// Delete a budget, and offer it back.
    ///
    /// The offer is not politeness. A budget is a set of decisions -- which
    /// categories, what limit, anchored to which day -- and re-entering them is
    /// exactly the kind of small loss that makes somebody stop trusting an app.
    /// Nothing is destroyed by the delete, so the undo is exact.
    func deleteBudget(id: String, named name: String) async -> EditOutcome {
        await deleting {
            let receipt = try await self.service.deleteBudget(id: id)
            return PendingUndo(
                receipt: .record(receipt),
                message: "Deleted the budget \u{201C}\(name)\u{201D}. No transaction was changed."
            )
        }
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
    /// A delete: do it, offer it back, and re-read. One shape for every kind
    /// of delete, so no route can quietly acquire the ability to remove
    /// something with no way back.
    private func deleting(_ body: () async throws -> PendingUndo) async -> EditOutcome {
        do {
            let pending = try await body()
            await refresh()
            // Set AFTER the refresh: `refresh` is the only thing that bumps
            // `revision`, and a bar shown before the screens behind it have
            // caught up would offer to take back something not yet drawn.
            pendingUndo = pending
            return .saved
        } catch let error as EditError {
            return .refused(EditRefusal(error))
        } catch {
            return .refused(EditRefusal(unexpected: error))
        }
    }

    /// One service call, through the same shape every mutation uses: do it,
    /// re-read the book, re-plan the reminders. For the switches on the
    /// schedule detail screen, which are one call each and would otherwise each
    /// need a method here that did nothing else.
    func runService(_ body: @escaping (LedgerService) async throws -> Void) async -> EditOutcome {
        await run { try await body(self.service) }
    }

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

    // MARK: - Schedules

    func save(_ draft: ScheduleDraft) async -> EditOutcome {
        await run { _ = try await self.service.save(draft) }
    }

    func setSchedulePaused(id: String, paused: Bool) async -> EditOutcome {
        await run { try await self.service.setSchedulePaused(id: id, paused: paused) }
    }

    func setScheduleAutoPost(id: String, autoPost: Bool) async -> EditOutcome {
        await run { try await self.service.setScheduleAutoPost(id: id, autoPost: autoPost) }
    }

    func setScheduleRemind(id: String, remind: Bool) async -> EditOutcome {
        await run { try await self.service.setScheduleRemind(id: id, remind: remind) }
    }

    /// Delete a schedule, and offer it back.
    ///
    /// The sentence says what was NOT deleted, because that is the question a
    /// person actually has: the payments it already entered are ordinary
    /// transactions that happened, and they stay.
    func deleteSchedule(id: String, named name: String) async -> EditOutcome {
        await deleting {
            let receipt = try await self.service.deleteSchedule(id: id)
            return PendingUndo(
                receipt: .record(receipt),
                message:
                    "Deleted the schedule \u{201C}\(name)\u{201D}. The payments it already "
                    + "entered are still in your book."
            )
        }
    }

    /// Enter one due occurrence. The deliberate act.
    func post(_ posting: SchedulePosting) async -> EditOutcome {
        await run { _ = try await self.service.postScheduled(posting) }
    }

    func skip(scheduleId: String, occurrenceDate: String) async -> EditOutcome {
        await run {
            try await self.service.skipOccurrence(
                scheduleId: scheduleId, occurrenceDate: occurrenceDate
            )
        }
    }

    func unskip(scheduleId: String, occurrenceDate: String) async -> EditOutcome {
        await run {
            try await self.service.unskipOccurrence(
                scheduleId: scheduleId, occurrenceDate: occurrenceDate
            )
        }
    }

    func acknowledgeAutoPost() { lastAutoPost = nil }

    /// Run the automatic postings, at most once a day.
    ///
    /// ONCE A DAY BY THE DEVICE'S OWN CALENDAR, not on every foregrounding:
    /// re-running it is harmless (a settled occurrence is refused) but it is
    /// also a write attempt per app switch, and the announcement it produces
    /// should appear once rather than every time the owner comes back from
    /// Messages.
    private func runAutomaticPosting() async {
        let today = todayISO()
        guard lastAutoPostDay != today else { return }
        do {
            let result = try await service.postDue(today: today)
            lastAutoPostDay = today
            if !result.isEmpty { lastAutoPost = result }
        } catch {
            // An automatic run that fails is not a reason to fail the launch.
            // It is a reason to say so on the screen that owns it.
            lastAutoPost = AutoPostResult(
                posted: [], heldBack: 0, refusals: [Self.message(for: error)]
            )
        }
    }

    /// Coming back to the app on a new day runs the automatic postings; coming
    /// back ten minutes later does not.
    func foregrounded() async {
        guard hasBook, lastAutoPostDay != todayISO() else { return }
        await runAutomaticPosting()
        // `refresh`, not `load`: the screen is already showing a book, and
        // replacing it with a spinner because the date rolled over would be a
        // flicker on the one screen that must not look unstable.
        await refresh()
    }

    private func refreshDueCounts() async {
        guard let counts = try? await service.dueCounts(today: todayISO()) else {
            dueCount = 0
            overdueCount = 0
            return
        }
        dueCount = counts.due
        overdueCount = counts.overdue
    }

    /// Re-plan the local reminders from what is due now.
    ///
    /// AFTER EVERY CHANGE, because the alternative is a banner tomorrow morning
    /// about a payment entered this morning. The planning itself is
    /// `DueReminders.plan`, in the kit, where it is tested; this hands the
    /// answer to iOS.
    private func replanReminders() async {
        guard reminders.settings.enabled else { return }
        guard let input = try? await service.reminderInput(today: todayISO()) else { return }
        let plan = DueReminders.plan(
            occurrences: input.occurrences,
            remindingScheduleIds: input.reminding,
            settings: reminders.settings,
            today: todayISO(),
            nowMinutes: RemindersModel.nowMinutes()
        )
        await reminders.apply(plan)
    }

    /// Re-plan from outside -- the settings screen, when a switch moves.
    func remindersSettingsChanged() async {
        await replanReminders()
    }

    // MARK: - Files that arrive from elsewhere

    /// A file handed over by another app, waiting on the Import screen for the
    /// owner to say what to do with it.
    ///
    /// It is NOT imported on arrival. See `IncomingDocument`'s header: an
    /// import replaces the copy on this device, and a book replaced because
    /// somebody tapped Share in Mail is exactly the loss this project exists to
    /// prevent.
    var incoming: IncomingDocument?

    /// Take a file the system has handed us. Answers whether it was readable
    /// enough to show, which is always true -- an unreadable one is shown WITH
    /// its reason, because silence after sharing a file is the worst outcome.
    func receive(_ url: URL) {
        guard let document = IncomingDocument.read(url) else { return }
        incoming = document
        importPhase = .idle
        document.discardInboxCopy(at: url)
    }

    func clearIncoming() { incoming = nil }

    /// Import the file that arrived, through the same door as one picked by
    /// hand. There is deliberately no other method here that writes a backup.
    func importIncoming() async {
        guard let document = incoming, document.kind.isBackup else { return }
        incoming = nil
        await importBackup(data: document.data, fileName: document.fileName)
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
