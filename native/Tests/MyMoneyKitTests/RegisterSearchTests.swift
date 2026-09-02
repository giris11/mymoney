// Searching the register: what a typed query means, and what the database does
// about it.
//
// EVERY NAME, NOTE AND FIGURE BELOW IS INVENTED, like every other fixture in
// this suite. The large-book tests use the repository's own synthetic demo
// book.
//
// The tests are in two halves, matching the two halves of the feature. The
// first half is about MEANING and needs no database: what splits into terms,
// what counts as an amount, what counts as a date, and what happens to the
// characters LIKE treats as wildcards. The second half puts a book in a store
// and asks the search to find things in it -- including the two places a
// plausible implementation quietly fails: a category that is only on a SPLIT,
// and a deleted row that is still in the table.
import Foundation
import Testing

@testable import MyMoneyKit

struct RegisterSearchTests {

    // MARK: - What a query means

    @Test("a query splits into terms, folded the same way names are folded")
    func terms() {
        #expect(RegisterSearch("").terms == [])
        #expect(RegisterSearch("   ").terms == [])
        #expect(RegisterSearch("Corner Shop").terms == ["corner", "shop"])
        // The non-breaking space that arrives from a paste out of a bank
        // statement is whitespace here, because `Names.key` uses JavaScript's
        // whitespace set rather than Foundation's -- the same rule that stops
        // " Tesco" pasted with one becoming a second payee.
        #expect(RegisterSearch("Corner\u{00A0}Shop").terms == ["corner", "shop"])
        // Full Unicode folding, not ASCII: the fold that decides two typed
        // names are one name.
        #expect(RegisterSearch("ÅLESUND").terms == ["ålesund"])
        #expect(RegisterSearch("").isEmpty)
        #expect(!RegisterSearch("a").isEmpty)
    }

    @Test("LIKE'S OWN WILDCARDS ARE NEUTRALISED, so a search for \"50%\" is not a search for everything")
    func likeEscaping() {
        #expect(RegisterSearch.likeContains("tesco") == "%tesco%")
        #expect(RegisterSearch.likeContains("50%") == "%50\\%%")
        #expect(RegisterSearch.likeContains("ref_1") == "%ref\\_1%")
        #expect(RegisterSearch.likeContains("a\\b") == "%a\\\\b%")
    }

    @Test("only a date-shaped term searches the date, so \"5\" stays an amount")
    func dateShaped() {
        #expect(RegisterSearch.datePattern("2026") == "%2026%")
        #expect(RegisterSearch.datePattern("2026-09") == "%2026-09%")
        #expect(RegisterSearch.datePattern("09-02") == "%09-02%")
        // Too short, or not made of digits and hyphens. "5" would otherwise
        // match every date with a 5 in it and bury the amount it was meant to
        // be.
        #expect(RegisterSearch.datePattern("5") == nil)
        #expect(RegisterSearch.datePattern("202") == nil)
        #expect(RegisterSearch.datePattern("tesco") == nil)
        #expect(RegisterSearch.datePattern("2026x") == nil)
        #expect(RegisterSearch.datePattern("----") == nil)
    }

    @Test("AN AMOUNT IS PARSED PER CURRENCY, because 420 minor units are not one amount")
    func amountsPerCurrency() {
        // The same typed "4.20" is 420 in GBP and, in a currency with no minor
        // units, is not a valid amount at all. A search box that assumed the
        // base currency would silently miss the euro account's rows.
        let gbp = RegisterSearch.amounts("4.20", currencies: ["GBP"])
        #expect(gbp == [420, -420])

        // Both signs, always: nobody searching for a payment thinks about
        // which direction the sign points.
        #expect(RegisterSearch.amounts("12", currencies: ["GBP"]) == [1200, -1200])

        // JPY has no minor units, so "4.20" is not an amount in it and is
        // refused rather than rounded to 4.
        #expect(RegisterSearch.amounts("4.20", currencies: ["JPY"]).isEmpty)
        #expect(RegisterSearch.amounts("420", currencies: ["JPY"]) == [420, -420])

        // A word is not an amount.
        #expect(RegisterSearch.amounts("tesco", currencies: ["GBP"]).isEmpty)
        // ...and the app's own parser is the one that decides, so its whole
        // vocabulary works here too.
        #expect(RegisterSearch.amounts("£12", currencies: ["GBP"]) == [1200, -1200])
        #expect(RegisterSearch.amounts("1,234.56", currencies: ["GBP"]) == [123_456, -123_456])
    }

    // MARK: - What the database finds

    /// A book with one of everything a search has to reach.
    private func searchStore(_ scratch: ScratchDirectory) throws -> LedgerStore {
        let store = try EditFixture.store(scratch)
        _ = try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-03-04", amountMinor: -1250,
                payeeName: "Bramble Coffee", categoryId: "c-sub",
                tagNames: ["Holiday"], notes: "Beans for the ÅLESUND trip"
            )
        )
        _ = try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-03-05", amountMinor: -420,
                payeeName: "Marlow Hardware", categoryId: nil,
                notes: "50% off REF_2261"
            )
        )
        _ = try store.saveTransaction(
            TransactionDraft(
                accountId: "w-b", date: "2026-04-06", amountMinor: -5000,
                payeeName: "Bramble Coffee", categoryId: nil,
                notes: "euro account"
            )
        )
        // A shop whose CATEGORY IS ONLY ON THE SPLITS. Its own category_id is
        // null, which is exactly the row a search that only looked at the
        // transaction would miss.
        _ = try store.saveTransaction(
            TransactionDraft(
                accountId: "w-a", date: "2026-05-07", amountMinor: -3000,
                payeeName: "Hartley Bakery", categoryId: nil, notes: "weekly shop",
                splits: [
                    Split(categoryId: "c-sub", amountMinor: -2200, notes: "bread and milk"),
                    Split(categoryId: nil, amountMinor: -800, notes: nil),
                ]
            )
        )
        return store
    }

    private func found(
        _ store: LedgerStore, _ query: String, scope: RegisterScope = .allAccounts
    ) throws -> [String] {
        let lookups = try store.registerLookups()
        let page = try store.registerPage(
            scope: scope, search: RegisterSearch(query), limit: 100, lookups: lookups
        )
        return page.rows.map(\.title)
    }

    @Test("a term matches the payee, the account, the note, the tag, the amount and the date")
    func everyField() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)

        // Payee, and CONTAINS rather than prefix: "ramble" finds "Bramble".
        #expect(try found(store, "bramble").sorted() == ["Bramble Coffee", "Bramble Coffee"])
        #expect(try found(store, "ramble").count == 2)

        // Account name. "Beta" is the euro account: its two rows come back and
        // the four rows in the other accounts do not.
        #expect(try found(store, "beta").sorted() == ["Bramble Coffee", "Corner Shop"])

        // Note.
        #expect(try found(store, "weekly") == ["Hartley Bakery"])

        // Tag. The fixture's own untitled row carries it too, which is why the
        // expectation names "No payee" -- a row with no payee and no note is
        // still a row a search must be able to reach.
        #expect(try found(store, "holiday").sorted() == ["Bramble Coffee", "No payee"])

        // Amount, in the currency of the account the row is in.
        #expect(try found(store, "12.50") == ["Bramble Coffee"])
        #expect(try found(store, "4.20") == ["Marlow Hardware"])

        // Date.
        #expect(try found(store, "2026-05") == ["Hartley Bakery"])
    }

    @Test("A CATEGORY ON A SPLIT IS FOUND, and so is the parent it hangs under")
    func categoriesIncludingSplits() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)

        // "Groceries" is on the coffee row's own category_id, on one split of
        // the bakery row (whose own category is null), and on the fixture's
        // euro row.
        #expect(
            try found(store, "groceries").sorted()
                == ["Bramble Coffee", "Corner Shop", "Hartley Bakery"]
        )

        // The PARENT finds the children, because the match is on the resolved
        // path "Food \u{203A} Groceries" rather than on the leaf name. Somebody
        // typing a top-level category wants what is filed underneath it -- so
        // this adds the fixture row whose only Food is on a split.
        #expect(
            try found(store, "food").sorted()
                == ["Bramble Coffee", "Corner Shop", "Hartley Bakery", "No payee"]
        )

        // A split's own note is searched too.
        #expect(try found(store, "bread") == ["Hartley Bakery"])
    }

    @Test("EVERY TERM MUST MATCH: adding a word narrows, it does not widen")
    func termsAreAnded() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        #expect(try found(store, "bramble").count == 2)
        // Both Bramble rows, narrowed to the one in the euro account.
        #expect(try found(store, "bramble beta") == ["Bramble Coffee"])
        // ...and to the one with the tag.
        #expect(try found(store, "bramble holiday") == ["Bramble Coffee"])
        #expect(try found(store, "bramble alpha holiday").count == 1)
        // A word that matches nothing empties the result rather than being
        // quietly ignored.
        #expect(try found(store, "bramble zzzz").isEmpty)
    }

    @Test("a note containing % or _ does not become a wildcard search")
    func wildcardsInTheData() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        // The literal characters find the row that has them...
        #expect(try found(store, "50%") == ["Marlow Hardware"])
        #expect(try found(store, "ref_2261") == ["Marlow Hardware"])
        // ...and do not match everything. Unescaped, "%" alone is LIKE for
        // "any run of characters" and would return all six rows in this book;
        // escaped, it finds the one note that actually contains a per-cent
        // sign. `_` likewise: unescaped it matches any single character, so
        // "ref_zzzz" would match "refXzzzz" and nothing here should match at
        // all.
        #expect(try found(store, "%") == ["Marlow Hardware"])
        #expect(try found(store, "ref_zzzz").isEmpty)
    }

    @Test("NOTES FOLD CASE THE SAME WAY NAMES DO, not merely for ASCII")
    func unicodeFoldingInNotes() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        // The note holds "ÅLESUND". SQLite's own lower() and LIKE fold ASCII
        // only, so without `mm_lower` this finds nothing -- and a payee written
        // into the note instead of the payee field would be findable in one
        // book and not another, with nothing on screen to say why.
        #expect(try found(store, "ålesund") == ["Bramble Coffee"])
        #expect(try found(store, "ÅLESUND") == ["Bramble Coffee"])
        #expect(try found(store, "lesund") == ["Bramble Coffee"])
    }

    @Test("a search inside one account stays inside it")
    func scoped() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        #expect(try found(store, "bramble", scope: .account("w-b")) == ["Bramble Coffee"])
        #expect(try found(store, "bramble", scope: .account("w-a")).count == 1)
        #expect(try found(store, "weekly", scope: .account("w-b")).isEmpty)
    }

    @Test("A DELETED ROW IS NOT A SEARCH RESULT")
    func tombstonesAreNotFound() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        let before = try found(store, "weekly")
        #expect(before == ["Hartley Bakery"])

        let id = try #require(
            try store.registerPage(
                scope: .allAccounts, search: RegisterSearch("weekly"), limit: 5,
                lookups: try store.registerLookups()
            ).rows.first?.id
        )
        _ = try store.deleteTransaction(id: id)

        // The row is still IN the table -- nothing is ever hard-deleted -- and
        // it must still be invisible here. It is, because the search reads
        // `live_transactions` like every other read in this package.
        #expect(try found(store, "weekly").isEmpty)
        #expect(try store.deletedCount("transactions") == 1)
    }

    @Test("the count and the rows agree, and paging a search never repeats or skips a row")
    func countAndPaging() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        let lookups = try store.registerLookups()
        let search = RegisterSearch("bramble")

        let count = try store.registerCount(
            scope: .allAccounts, search: search, lookups: lookups
        )
        #expect(count == 2)

        // ONE ROW AT A TIME, which is where a cursor gets it wrong if it is
        // going to: page 2 must start strictly after page 1's last key.
        var seen: [String] = []
        var cursor: RegisterCursor?
        var pages = 0
        repeat {
            let page = try store.registerPage(
                scope: .allAccounts, search: search, after: cursor, limit: 1, lookups: lookups
            )
            seen.append(contentsOf: page.rows.map(\.id))
            cursor = page.nextCursor
            pages += 1
            #expect(pages < 10, "paging did not terminate")
        } while cursor != nil

        #expect(seen.count == count)
        #expect(Set(seen).count == seen.count, "a row came back twice")

        // And an empty search still counts the whole register.
        #expect(
            try store.registerCount(scope: .allAccounts, search: .none, lookups: lookups)
                == store.registerCount(scope: .allAccounts)
        )
    }

    @Test("a search that matches nothing is an empty page, not an error and not the whole book")
    func noMatches() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        #expect(try found(store, "zzzzz").isEmpty)
        let lookups = try store.registerLookups()
        #expect(
            try store.registerCount(
                scope: .allAccounts, search: RegisterSearch("zzzzz"), lookups: lookups
            ) == 0
        )
    }

    @Test("a searched row is named and described exactly as the register names it")
    func rowsAreTheSameRows() throws {
        let scratch = try ScratchDirectory()
        let store = try searchStore(scratch)
        let lookups = try store.registerLookups()
        // The point of searching through `registerPage` rather than a query of
        // its own: there is one set of rules about what a row is CALLED, and a
        // search result is the same row the register would have drawn.
        let all = try store.registerPage(scope: .allAccounts, limit: 100, lookups: lookups).rows
        let hit = try store.registerPage(
            scope: .allAccounts, search: RegisterSearch("hartley"), limit: 100, lookups: lookups
        ).rows
        let match = try #require(hit.first)
        let same = try #require(all.first { $0.id == match.id })
        #expect(match == same)
    }

    // MARK: - Over a book the size of the owner's

    @Test("SEARCHING A BOOK OF FIVE THOUSAND ROWS IS ONE PAGE OF WORK, and it is fast")
    func speed() throws {
        // The repository's own synthetic demo book: 58 accounts, ~5,200
        // transactions, four currencies, twenty payees, the same shape as the
        // real one and none of its content.
        let book = DemoBookTests.book()
        let store = try LedgerStore.openInMemory()
        defer { store.close() }
        try store.importBackup(
            data: Data(try BackupWriter.text(book, exportedAt: "2026-09-01T08:00:00.000Z").utf8)
        )
        let lookups = try store.registerLookups()
        #expect(try store.registerCount(scope: .allAccounts) >= 5000)

        // The four shapes a query can take, each hitting a different clause:
        // a payee (an id list), a note word (the text scan -- the expensive
        // one), an amount (an integer list) and two words that must both match.
        let queries = ["bramble", "coffee", "12.50", "alderney groceries", "2026-03"]
        var worst = 0.0
        var worstQuery = ""
        for query in queries {
            let started = DispatchTime.now().uptimeNanoseconds
            let page = try store.registerPage(
                scope: .allAccounts, search: RegisterSearch(query), limit: 40, lookups: lookups
            )
            let count = try store.registerCount(
                scope: .allAccounts, search: RegisterSearch(query), lookups: lookups
            )
            let ms = Double(DispatchTime.now().uptimeNanoseconds - started) / 1_000_000
            if ms > worst {
                worst = ms
                worstQuery = query
            }
            // A PAGE IS A PAGE whatever the match count is. This is the claim
            // that memory stays flat: a query matching a thousand rows returns
            // forty, and the other nine hundred and sixty never leave SQLite.
            #expect(page.rows.count <= 40, "\(query)")
            if count > 40 {
                #expect(page.rows.count == 40, "\(query)")
                #expect(page.nextCursor != nil, "\(query) should have more pages")
            }
        }

        // A CEILING, NOT A MEASUREMENT. The numbers on this machine are
        // single-digit milliseconds (they are printed below, so a regression is
        // visible rather than merely under the bar); the assertion is loose
        // enough that a busy CI box does not turn it red, and tight enough that
        // an accidental table scan per row -- the failure this is here to catch
        // -- could not pass it.
        print("register search over \(book.transactions.count) rows: "
            + "worst \(String(format: "%.1f", worst)) ms (\(worstQuery))")
        #expect(worst < 250, "a search took \(worst) ms")
    }

    @Test("paging a search that matches thousands of rows never repeats a row")
    func pagingALargeResult() throws {
        let book = DemoBookTests.book()
        let store = try LedgerStore.openInMemory()
        defer { store.close() }
        try store.importBackup(
            data: Data(try BackupWriter.text(book, exportedAt: "2026-09-01T08:00:00.000Z").utf8)
        )
        let lookups = try store.registerLookups()
        // A single letter: the widest search this book can be asked, so the
        // cursor is exercised over hundreds of rows rather than two.
        let search = RegisterSearch("a")
        let count = try store.registerCount(
            scope: .allAccounts, search: search, lookups: lookups
        )
        #expect(count > 200, "the fixture must actually exercise paging")

        var seen: [String] = []
        var cursor: RegisterCursor?
        repeat {
            let page = try store.registerPage(
                scope: .allAccounts, search: search, after: cursor, limit: 60, lookups: lookups
            )
            seen.append(contentsOf: page.rows.map(\.id))
            cursor = page.nextCursor
        } while cursor != nil

        #expect(seen.count == count)
        #expect(Set(seen).count == seen.count, "a row came back on two pages")
    }
}
