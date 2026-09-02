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

    /// What is being searched for. Empty is the ordinary register.
    private(set) var search: RegisterSearch = .none
    /// How many rows the WHOLE register has, regardless of the search, so the
    /// screen can say "12 of 5,127" rather than a bare count that looks like
    /// the book shrank.
    private(set) var unfilteredCount: Int = 0

    private let service: LedgerService
    private let lookups: RegisterLookups
    private var cursor: RegisterCursor?
    private var running: RunningBalance?
    /// The balance the running column starts from, kept so a cleared search can
    /// start it again from exactly the same integer.
    private let openingRunningBalanceMinor: Int64?
    /// Row id -> its position in `entries`, so the "am I near the bottom?"
    /// question the list asks per row is answered without a search.
    private var indexById: [String: Int] = [:]
    /// Bumped by every `apply(search:)`. A page that finishes after the query
    /// has moved on is dropped rather than appended -- see `apply`.
    private var generation = 0
    private var hasLoaded = false
    /// The whole register's row count is a fact about the book, not about the
    /// query, so it is read once.
    private var hasCountedWholeRegister = false

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
        self.openingRunningBalanceMinor = openingRunningBalanceMinor
        // The newest row's running balance IS the account's balance. Starting
        // anywhere else -- at zero, at the opening balance -- would mean the
        // register and the accounts screen showed two different figures for the
        // same account, which is the exact defect this project keeps writing
        // down.
        self.running = openingRunningBalanceMinor.map(RunningBalance.init(startingAt:))
    }

    /// THERE IS NO RUNNING BALANCE DOWN A SEARCH, and that is not a limitation
    /// to be worked around.
    ///
    /// The running balance is "the account's balance, minus each newer row as
    /// you go down" -- it is exact precisely because every row between the top
    /// and here has been subtracted. A filtered list has holes in it by
    /// definition, so the same subtraction over the rows that happen to match
    /// would produce a column of numbers that look like balances, are not, and
    /// disagree with the account's own figure. Showing nothing is the only
    /// honest option; the screen says why once, at the top.
    var showsRunningBalance: Bool { search.isEmpty && (running != nil || account != nil) }

    var isSearching: Bool { !search.isEmpty }

    var currency: String? { account?.currency }

    /// Load the register, or reload it for a new search. THE ONLY ENTRY POINT.
    ///
    /// ONE ENTRY POINT RATHER THAN TWO, and that is a fix rather than tidiness.
    /// With a separate `start()` on `.task` and this on `.task(id: query)`,
    /// both fire on the first appearance, and which of them read the count and
    /// which loaded page one depended on the order two `async` calls happened
    /// to finish in.
    ///
    /// EVERYTHING RESETS ON A NEW SEARCH, including the running balance. A
    /// search is a different list, not a filter over the one already on screen:
    /// the cursor, the page state and the balance chain all belong to the
    /// previous query, and carrying any of them across is how a register ends
    /// up showing page three of one list under page one of another.
    ///
    /// THE GENERATION COUNTER IS WHAT MAKES FAST TYPING SAFE. `.task(id:)`
    /// cancels the previous run, but cancellation is cooperative and an actor
    /// call already in flight finishes anyway -- so two runs can interleave,
    /// and the failure mode is the worst kind: the rows for one query appearing
    /// under a different one, with nothing on screen to say so. Every await
    /// below is followed by "is this still the current query?", and a stale run
    /// stops without touching anything.
    ///
    /// The DEBOUNCE is the caller's; see `RegisterView`.
    func apply(search text: String) async {
        let next = RegisterSearch(text)
        if hasLoaded && next == search { return }
        hasLoaded = true

        generation += 1
        let mine = generation

        search = next
        entries = []
        indexById = [:]
        cursor = nil
        reachedEnd = false
        errorMessage = nil
        running = openingRunningBalanceMinor.map(RunningBalance.init(startingAt:))

        do {
            if !hasCountedWholeRegister {
                let total = try await service.registerCount(scope: scope)
                guard mine == generation else { return }
                unfilteredCount = total
                hasCountedWholeRegister = true
            }
            if next.isEmpty {
                totalCount = unfilteredCount
            } else {
                let matches = try await service.registerCount(
                    scope: scope, search: next, lookups: lookups
                )
                guard mine == generation else { return }
                totalCount = matches
            }
        } catch {
            guard mine == generation else { return }
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
        let mine = generation
        do {
            let page = try await service.registerPage(
                scope: scope, search: search, after: cursor, limit: Self.pageSize,
                lookups: lookups
            )
            // The query moved on while this page was being read. Dropping it is
            // the whole point of the counter: appending would put one query's
            // rows under another's heading.
            guard mine == generation else { return }
            var appended: [RegisterEntry] = []
            appended.reserveCapacity(page.rows.count)
            for row in page.rows {
                if running != nil && showsRunningBalance {
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
            guard mine == generation else { return }
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
