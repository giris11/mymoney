// The register, a page at a time.
//
// WHAT THIS IS CAREFUL ABOUT, in order of how badly it would show:
//
//  1. IT NEVER MATERIALISES THE LEDGER. Rows arrive in pages of 80 and the list
//     is lazy, so opening the all-accounts register on 5,127 rows reads 80 of
//     them. The register would behave the same at 100,000.
//  2. THE RUNNING BALANCE CANNOT DRIFT ACROSS A PAGE BOUNDARY. It is carried in
//     one `RunningBalance` that is stepped exactly once per row appended, in
//     order, and it starts from the account's own balance -- so the top of the
//     register is the figure on the accounts screen, by construction rather
//     than by a second calculation that happens to agree.
//  3. IT CANNOT LOAD THE SAME PAGE TWICE. `isLoading` guards re-entry, which
//     matters because a SwiftUI list will happily fire the same onAppear again
//     while the first load is in flight -- and a duplicated page would step the
//     running balance twice and put a wrong number beside every row below it.
//
// NO RUNNING BALANCE IN THE ALL-ACCOUNTS VIEW, and that is a decision rather
// than an omission: the accounts in this book are not all in one currency, and
// a running total down a list of mixed currencies is not a number. The view
// shows the account each row belongs to in that column instead, and says so.
import Foundation
import MyMoneyKit
import Observation

/// One row as the list draws it: what the store said, plus the running balance
/// at that row when there is one.
struct RegisterEntry: Identifiable, Sendable {
    let row: RegisterRow
    /// nil in the all-accounts register. See the note above.
    let runningBalanceMinor: Int64?

    var id: String { row.id }
}

@MainActor
@Observable
final class RegisterModel {
    /// Big enough that a phone screen is filled by the first page and a scroll
    /// rarely waits; small enough that the first page is the cost of opening
    /// the screen, not the cost of reading the book.
    static let pageSize = 80

    let scope: RegisterScope
    let title: String
    /// The account, when this register is one account's. Its currency is the
    /// running balance's currency, and there is no running balance without it.
    let account: Account?

    private(set) var entries: [RegisterEntry] = []
    private(set) var totalCount: Int = 0
    private(set) var isLoading = false
    private(set) var reachedEnd = false
    private(set) var errorMessage: String?

    private let service: LedgerService
    private let lookups: RegisterLookups
    private var cursor: RegisterCursor?
    private var running: RunningBalance?
    /// Row id -> its position in `entries`, so the "am I near the bottom?"
    /// question the list asks per row is answered without a search.
    private var indexById: [String: Int] = [:]

    init(
        scope: RegisterScope,
        title: String,
        account: Account?,
        openingRunningBalanceMinor: Int64?,
        service: LedgerService,
        lookups: RegisterLookups
    ) {
        self.scope = scope
        self.title = title
        self.account = account
        self.service = service
        self.lookups = lookups
        // The newest row's running balance IS the account's balance. Starting
        // anywhere else -- at zero, at the opening balance -- would mean the
        // register and the accounts screen showed two different figures for the
        // same account, which is the exact defect this project keeps writing
        // down.
        self.running = openingRunningBalanceMinor.map(RunningBalance.init(startingAt:))
    }

    var showsRunningBalance: Bool { running != nil || account != nil }

    var currency: String? { account?.currency }

    /// Load the first page, once. Safe to call from `.task` on every appearance.
    func start() async {
        guard entries.isEmpty, !isLoading, !reachedEnd else { return }
        do {
            totalCount = try await service.registerCount(scope: scope)
        } catch {
            errorMessage = AppModel.message(for: error)
            return
        }
        await loadNextPage()
    }

    /// Called when the list gets near the bottom. Re-entrant calls are dropped
    /// rather than queued: see (3) in the header.
    func loadNextPage() async {
        guard !isLoading, !reachedEnd, errorMessage == nil else { return }
        isLoading = true
        defer { isLoading = false }
        do {
            let page = try await service.registerPage(
                scope: scope, after: cursor, limit: Self.pageSize, lookups: lookups
            )
            var appended: [RegisterEntry] = []
            appended.reserveCapacity(page.rows.count)
            for row in page.rows {
                if running != nil {
                    // `next` mutates, so it is stepped exactly once per row and
                    // only here.
                    let at = try running!.next(row.amountMinor)
                    appended.append(RegisterEntry(row: row, runningBalanceMinor: at))
                } else {
                    appended.append(RegisterEntry(row: row, runningBalanceMinor: nil))
                }
            }
            for (offset, entry) in appended.enumerated() {
                indexById[entry.id] = entries.count + offset
            }
            entries.append(contentsOf: appended)
            cursor = page.nextCursor
            reachedEnd = page.isLastPage
        } catch {
            // A failed page stops the register rather than leaving a gap in it:
            // rows below a missing page would carry running balances computed
            // from an incomplete list, and a wrong number is worse than a
            // visible stop.
            errorMessage = AppModel.message(for: error)
            reachedEnd = true
        }
    }

    /// True when this entry is close enough to the end to start the next page.
    ///
    /// O(1), and it has to be: this is called from `onAppear` on every row the
    /// list draws, so a linear search here would make scrolling quadratic in
    /// the number of rows already loaded -- the exact failure the paging exists
    /// to avoid, reintroduced by the code that asks for the next page.
    func shouldLoadMore(after entry: RegisterEntry) -> Bool {
        guard !reachedEnd, !isLoading else { return false }
        guard let index = indexById[entry.id] else { return false }
        return index >= entries.count - 20
    }
}
