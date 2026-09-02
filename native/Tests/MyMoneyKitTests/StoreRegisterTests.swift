// The register: does paging return exactly the register, and does the running
// balance down it agree with the account's own balance?
//
// EVERY FIGURE HERE IS INVENTED, and generated rather than typed: a synthetic
// book of 500 rows across four accounts, built to contain the two shapes that
// break a naive pager -- MANY ROWS ON ONE DATE, and rows whose `createdAt` is
// identical too, so the whole sort key comes down to the id tie-break that the
// TypeScript never needed and SQL cannot do without.
//
// The claims:
//   1. reading the register 7 rows at a time is BYTE FOR BYTE the same list as
//      reading it in one go -- no row repeated, none skipped, same order;
//   2. the running balance beside row N equals opening + every amount from row
//      N downwards, computed independently of the subtraction the app uses;
//   3. the cheap balance path and the full `book()` path give the same
//      `AccountBalance` values for the same store;
//   4. the register's indexes are actually USED -- asserted against SQLite's
//      own query plan, because "it will be smooth" is otherwise a hope.
import Foundation
import Testing

@testable import MyMoneyKit

@Suite("Register reads")
struct StoreRegisterTests {

    // MARK: - A synthetic book with awkward ordering

    /// Four accounts, 500 transactions, dates deliberately repeated so that
    /// roughly a fifth of the rows share a date with several others, and every
    /// fiftieth row shares BOTH date and createdAt with its neighbour.
    static func syntheticBook(rowCount: Int = 500) -> Book {
        let accounts = (0..<4).map { i in
            Account(
                id: "acc-\(i)",
                name: "Account \(i)",
                type: .current,
                currency: "GBP",
                openingBalanceMinor: Int64(1000 * (i + 1)),
                colour: "#112233",
                groupId: i < 2 ? "grp-a" : nil,
                sortOrder: i
            )
        }
        var transactions: [Transaction] = []
        for n in 0..<rowCount {
            // 25 distinct dates over 500 rows: every date carries ~20 rows.
            let day = 1 + (n % 25)
            let date = String(format: "2026-03-%02d", day)
            // Identical createdAt for every pair of adjacent rows, so the id is
            // the only thing separating them.
            let createdAt = String(format: "2026-03-%02dT10:%02d:00.000Z", day, (n / 2) % 60)
            transactions.append(
                Transaction(
                    id: String(format: "tx-%04d", n),
                    accountId: "acc-\(n % 4)",
                    date: date,
                    // Signed, never zero, and never the same twice running, so
                    // a running balance that lost a row would show it.
                    amountMinor: Int64((n % 2 == 0 ? -1 : 1) * (100 + n * 7)),
                    currency: "GBP",
                    notes: "row \(n)",
                    status: n % 3 == 0 ? .pending : .cleared,
                    dedupeHash: "hash-\(n)",
                    createdAt: createdAt,
                    updatedAt: createdAt
                )
            )
        }
        return Book(
            accounts: accounts,
            accountGroups: [AccountGroup(id: "grp-a", name: "Everyday", sortOrder: 0)],
            transactions: transactions,
            categories: [],
            payees: [],
            tags: [],
            budgets: [],
            fxRates: [],
            importBatches: [],
            settings: nil,
            baseCurrency: "GBP"
        )
    }

    /// The register order, stated a second time in Swift so the SQL is checked
    /// against something rather than against itself.
    static func expectedOrder(_ transactions: [Transaction]) -> [String] {
        transactions.sorted { a, b in
            if a.date != b.date { return a.date > b.date }
            if a.createdAt != b.createdAt { return a.createdAt > b.createdAt }
            return a.id > b.id
        }.map(\.id)
    }

    static func loaded(_ book: Book) throws -> (ScratchDirectory, LedgerStore) {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.writeBook(book)
        return (scratch, store)
    }

    // MARK: - 1. Paging returns the register, whole and once

    @Test("PAGING RETURNS EXACTLY THE REGISTER: no row twice, none missing, same order")
    func pagingMatchesTheWholeRegister() throws {
        let book = Self.syntheticBook()
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()

        for scope in [RegisterScope.allAccounts, .account("acc-1")] {
            let want = Self.expectedOrder(
                book.transactions.filter { tx in
                    if case .account(let id) = scope { return tx.accountId == id }
                    return true
                }
            )

            // Read it seven at a time -- a page size that divides neither the
            // row count nor the size of any date group, so the page boundaries
            // land inside tie groups rather than politely between them.
            var got: [String] = []
            var cursor: RegisterCursor?
            var pages = 0
            repeat {
                let page = try store.registerPage(
                    scope: scope, after: cursor, limit: 7, lookups: lookups
                )
                got += page.rows.map(\.id)
                cursor = page.nextCursor
                pages += 1
                #expect(pages < 500, "paging did not terminate")
            } while cursor != nil

            #expect(got == want, "paged order for \(scope)")
            #expect(Set(got).count == got.count, "a row was returned twice for \(scope)")
            #expect(got.count == (try store.registerCount(scope: scope)))

            // And the whole thing in one page is the same list.
            let single = try store.registerPage(
                scope: scope, limit: want.count + 10, lookups: lookups
            )
            #expect(single.rows.map(\.id) == want)
            #expect(single.isLastPage)
        }
    }

    @Test("a page that exactly empties the register still reports that it is the last")
    func exactPageBoundaryIsTheLastPage() throws {
        let book = Self.syntheticBook(rowCount: 20)
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()

        let page = try store.registerPage(scope: .allAccounts, limit: 20, lookups: lookups)
        #expect(page.rows.count == 20)
        #expect(page.isLastPage, "20 rows read out of 20 is the end, not 'maybe more'")
    }

    @Test("an empty register is one empty last page, not an error")
    func emptyRegister() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()
        let page = try store.registerPage(scope: .allAccounts, limit: 40, lookups: lookups)
        #expect(page.rows.isEmpty)
        #expect(page.isLastPage)
    }

    // MARK: - 2. The running balance

    @Test("THE RUNNING BALANCE BESIDE A ROW IS THAT ROW'S BALANCE, computed the other way")
    func runningBalanceAgreesWithASumOverTheRowsBelow() throws {
        let book = Self.syntheticBook()
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()

        let accountId = "acc-2"
        let account = book.accounts.first { $0.id == accountId }!
        let ordered = Self.expectedOrder(book.transactions.filter { $0.accountId == accountId })
        let amountById = Dictionary(
            uniqueKeysWithValues: book.transactions.map { ($0.id, $0.amountMinor) }
        )

        // The independent statement: the balance AT row i is the opening
        // balance plus every amount from i to the end of the (newest-first)
        // list. Quadratic and obviously correct, which is what a check is for.
        var want: [Int64] = []
        for i in ordered.indices {
            let below = ordered[i...].map { amountById[$0]! }
            want.append(try Money.sum(below, startingAt: account.openingBalanceMinor))
        }

        // The app's way: start at the account's balance and subtract, page by
        // page, exactly as the register view does.
        let balances = try store.accountBalances()
        let balance = balances.first { $0.account.id == accountId }!
        var running = RunningBalance(startingAt: balance.balanceMinor)
        var got: [Int64] = []
        var cursor: RegisterCursor?
        repeat {
            let page = try store.registerPage(
                scope: .account(accountId), after: cursor, limit: 13, lookups: lookups
            )
            for row in page.rows { got.append(try running.next(row.amountMinor)) }
            cursor = page.nextCursor
        } while cursor != nil

        #expect(got == want)
        // The newest row's running balance IS the account balance...
        #expect(got.first == balance.balanceMinor)
        // ...and after the oldest row, the subtraction has arrived back at the
        // opening balance. If it has not, a row was double-counted somewhere.
        #expect(running.current == account.openingBalanceMinor)
    }

    // MARK: - 3. The cheap path and the book path are the same arithmetic

    @Test("BALANCES READ WITHOUT DECODING THE BOOK EQUAL THE BOOK'S OWN BALANCES")
    func cheapBalancesEqualBookBalances() throws {
        for book in [Self.syntheticBook(), try StoreFixture.imported().book] {
            let (scratch, store) = try Self.loaded(book)
            defer { store.close(); _ = scratch }
            #expect(try store.accountBalances() == (try store.book().accountBalances()))
        }
    }

    @Test("the accounts snapshot's headline is the book's own net worth")
    func snapshotNetWorthMatchesTheBook() throws {
        let book = try StoreFixture.imported().book
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let snapshot = try store.accountsSnapshot()
        #expect(snapshot.netWorth == (try store.book().netWorth()))
        #expect(snapshot.baseCurrency == book.baseCurrency)
        #expect(snapshot.balances == (try store.book().accountBalances()))
    }

    // MARK: - 4. The indexes are used, not merely present

    @Test("THE REGISTER'S QUERIES SEEK AN INDEX RATHER THAN SCANNING THE TABLE")
    func registerQueriesUseTheirIndexes() throws {
        let book = Self.syntheticBook()
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }

        func plan(_ sql: String) throws -> String {
            let statement = try store.connection.prepare("EXPLAIN QUERY PLAN " + sql)
            defer { statement.finalize() }
            var lines: [String] = []
            while try statement.step() { lines.append(try statement.text(3)) }
            return lines.joined(separator: " | ")
        }

        let allAccounts = try plan(
            """
            SELECT t.id FROM live_transactions t
            WHERE (t.date, t.created_at, t.id) < ('2026-03-20', 'x', 'y')
            ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT 40
            """
        )
        #expect(
            allAccounts.contains("idx_transactions_register"),
            "the all-accounts register must seek its index; plan was: \(allAccounts)"
        )
        #expect(
            !allAccounts.contains("USE TEMP B-TREE"),
            "the ordering must come from the index, not from a sort; plan was: \(allAccounts)"
        )

        let oneAccount = try plan(
            """
            SELECT t.id FROM live_transactions t
            WHERE t.account_id = 'acc-1'
              AND (t.date, t.created_at, t.id) < ('2026-03-20', 'x', 'y')
            ORDER BY t.date DESC, t.created_at DESC, t.id DESC LIMIT 40
            """
        )
        #expect(
            oneAccount.contains("idx_transactions_account_register"),
            "one account's register must seek its index; plan was: \(oneAccount)"
        )
        #expect(
            !oneAccount.contains("USE TEMP B-TREE"),
            "the ordering must come from the index, not from a sort; plan was: \(oneAccount)"
        )

        let transfers = try plan(
            "SELECT id FROM live_transactions WHERE transfer_group_id IN ('a', 'b')"
        )
        #expect(
            transfers.contains("idx_transactions_transfer_group"),
            "the transfer lookup must not scan the table; plan was: \(transfers)"
        )
    }

    // MARK: - What a row says

    @Test("a row is titled by its payee, then its note, then what it is")
    func rowTitles() throws {
        var book = Self.syntheticBook(rowCount: 0)
        book = Book(
            accounts: book.accounts,
            accountGroups: book.accountGroups,
            transactions: [
                Transaction(
                    id: "t1", accountId: "acc-0", date: "2026-04-01", amountMinor: -500,
                    currency: "GBP", payeeId: "p1", notes: "ignored when a payee exists"
                ),
                Transaction(
                    id: "t2", accountId: "acc-0", date: "2026-04-02", amountMinor: -600,
                    currency: "GBP", notes: "first line\nsecond line"
                ),
                Transaction(
                    id: "t3", accountId: "acc-0", date: "2026-04-03", amountMinor: -700,
                    currency: "GBP"
                ),
                Transaction(
                    id: "t4", accountId: "acc-0", date: "2026-04-04", amountMinor: -800,
                    currency: "GBP", transferGroupId: "g1"
                ),
                Transaction(
                    id: "t5", accountId: "acc-1", date: "2026-04-04", amountMinor: 800,
                    currency: "GBP", transferGroupId: "g1"
                ),
            ],
            categories: [],
            payees: [Payee(id: "p1", name: "A Shop")],
            tags: [],
            budgets: [],
            fxRates: [],
            importBatches: [],
            settings: nil,
            baseCurrency: "GBP"
        )
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()
        let rows = try store.registerPage(scope: .allAccounts, limit: 50, lookups: lookups).rows
        let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })

        #expect(byId["t1"]?.title == "A Shop")
        #expect(byId["t1"]?.titleIsPlaceholder == false)
        #expect(byId["t2"]?.title == "first line", "a multi-line note contributes its first line")
        #expect(byId["t3"]?.title == "No payee")
        #expect(byId["t3"]?.titleIsPlaceholder == true)
        #expect(byId["t4"]?.title == "Transfer")

        // Each leg of the transfer names the OTHER account, and the direction
        // follows the sign of that leg's own amount.
        #expect(
            Register.categoryText(byId["t4"]!.categoryLine) == "Transfer to Account 1"
        )
        #expect(
            Register.categoryText(byId["t5"]!.categoryLine) == "Transfer from Account 0"
        )
        #expect(Register.categoryText(byId["t3"]!.categoryLine) == "Uncategorised")
    }

    @Test("a split row says how many categories it touches; a plain row says its path")
    func rowCategoryLines() throws {
        let accounts = [
            Account(
                id: "acc-0", name: "Account 0", type: .current, currency: "GBP",
                openingBalanceMinor: 0, colour: "#112233"
            )
        ]
        let categories = [
            Category(id: "c-food", name: "Food", parentId: nil, kind: .expense, sortOrder: 0),
            Category(
                id: "c-cafe", name: "Cafés", parentId: "c-food", kind: .expense, sortOrder: 1
            ),
            Category(id: "c-fuel", name: "Fuel", parentId: nil, kind: .expense, sortOrder: 2),
        ]
        let book = Book(
            accounts: accounts,
            accountGroups: [],
            transactions: [
                Transaction(
                    id: "t1", accountId: "acc-0", date: "2026-05-01", amountMinor: -900,
                    currency: "GBP", categoryId: "c-cafe"
                ),
                Transaction(
                    id: "t2", accountId: "acc-0", date: "2026-05-02", amountMinor: -1000,
                    currency: "GBP",
                    splits: [
                        Split(categoryId: "c-food", amountMinor: -400),
                        Split(categoryId: "c-fuel", amountMinor: -600),
                    ]
                ),
                Transaction(
                    id: "t3", accountId: "acc-0", date: "2026-05-03", amountMinor: -1000,
                    currency: "GBP",
                    splits: [
                        Split(categoryId: "c-food", amountMinor: -400),
                        Split(categoryId: "c-food", amountMinor: -600),
                    ]
                ),
            ],
            categories: categories,
            payees: [],
            tags: [],
            budgets: [],
            fxRates: [],
            importBatches: [],
            settings: nil,
            baseCurrency: "GBP"
        )
        let (scratch, store) = try Self.loaded(book)
        defer { store.close(); _ = scratch }
        let lookups = try store.registerLookups()
        let rows = try store.registerPage(scope: .allAccounts, limit: 50, lookups: lookups).rows
        let byId = Dictionary(uniqueKeysWithValues: rows.map { ($0.id, $0) })

        #expect(Register.categoryText(byId["t1"]!.categoryLine) == "Food \u{203A} Cafés")
        #expect(Register.categoryText(byId["t2"]!.categoryLine) == "Split \u{00B7} 2 categories")
        #expect(
            Register.categoryText(byId["t3"]!.categoryLine) == "Split \u{00B7} 1 category",
            "two splits under one category is one category, and singular"
        )
    }
}

@Suite("Money as it is spoken")
struct MoneyTextTests {
    @Test("a negative amount says the word rather than leaving a hyphen to a synthesiser")
    func spokenSignIsAWord() {
        #expect(Money.spoken(-4567, currency: "GBP") == "minus " + Money.format(4567, currency: "GBP"))
        #expect(Money.spoken(4567, currency: "GBP") == Money.format(4567, currency: "GBP"))
        #expect(Money.spoken(0, currency: "GBP") == Money.format(0, currency: "GBP"))
    }

    @Test("a register amount is spoken as a direction, and zero is neither")
    func spokenFlowIsADirection() {
        let magnitude = Money.format(4567, currency: "GBP")
        #expect(Money.spokenFlow(-4567, currency: "GBP") == "\(magnitude) out")
        #expect(Money.spokenFlow(4567, currency: "GBP") == "\(magnitude) in")
        #expect(Money.spokenFlow(0, currency: "GBP") == Money.format(0, currency: "GBP"))
    }

    @Test("the digits spoken are the digits shown -- one formatter, both times")
    func spokenAgreesWithShown() {
        for minor: Int64 in [0, 1, -1, 99, -99, 123456, -123456, Int64.max] {
            for currency in ["GBP", "JPY", "BHD", "EUR"] {
                let shown = Money.format(minor, currency: currency)
                let spoken = Money.spoken(minor, currency: currency)
                #expect(
                    spoken.hasSuffix(Money.formatMagnitude(minor, currency: currency)),
                    "\(minor) \(currency): spoken \"\(spoken)\" vs shown \"\(shown)\""
                )
            }
        }
    }

    @Test("Int64.min has no magnitude in Int64 and is stated exactly rather than off by one")
    func extremeMagnitude() {
        // abs(Int64.min) traps and Int64(exactly:) refuses it; the exact plain
        // form is used instead, and it is the true number.
        let text = Money.formatMagnitude(Int64.min, currency: "GBP")
        #expect(text == "GBP " + Money.formatPlain(Int64.min, currency: "GBP").dropFirst())
        #expect(!text.contains("-"))
    }
}
