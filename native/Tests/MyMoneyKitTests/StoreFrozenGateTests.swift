// THE PHASE 3 GATE: the owner's real book, through SQLite, and back to the same
// bytes.
//
// FrozenGateTests asks whether the RECORDS can reproduce the file. This asks the
// harder version: put those records through a database -- eleven tables, three
// child tables, a schema with type constraints, a JSON column and a canonical
// serialiser -- pull them back out, and see whether the file is still the file.
// Every field that a store can quietly widen, default, reorder or collapse gets
// exactly one chance to do so here, on 5,000-odd real rows rather than on two
// invented ones.
//
// IT RUNS IN MEMORY, deliberately. The store is `:memory:`, so the owner's data
// is never written to a disk anywhere: no temporary file, no WAL, nothing to
// forget to delete. Crash safety cannot be demonstrated on such a store and is
// not attempted here -- StoreAtomicityTests does that, on fabricated books.
//
// WHY IT CONTAINS NO NUMBERS. This repository is PUBLIC and the file is a real
// person's finances. Every expectation is read out of the file itself, so the
// test states no balance, no total and no hash, and a stranger reading it
// learns only that some number of things matched.
//
// WHEN THE FILE IS NOT THERE THE TEST SKIPS, and skipping is not failing. A
// gate that went red on a machine that has never seen the owner's data would be
// switched off within a week, and a switched-off gate proves nothing.
//
//   MYMONEY_FROZEN_BACKUP  path to the frozen file (required to run)
//
// NOTHING HERE WRITES TO THE FILE. It is opened read-only, never copied into
// the repository, never re-serialised to disk.
import Foundation
import Testing

@testable import MyMoneyKit

struct StoreFrozenGateTests {

    @Test(
        "PHASE 3 GATE: the real book goes into SQLite and comes back out as the same file",
        .enabled(if: FrozenGateTests.frozenPath != nil, "no frozen backup to run against")
    )
    func frozenBookRoundTripsThroughTheStore() throws {
        let path = try #require(FrozenGateTests.frozenPath)
        let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])

        let store = try LedgerStore.openInMemory()
        let result = try store.importBackup(
            data: data,
            // Strict: if the store cannot reproduce this file, the import is
            // refused and rolled back rather than accepted with a warning. On
            // the one file that matters most, "close enough" is not a result.
            requiringExactRoundTrip: true
        )

        // ── 1. It proved itself on the way in. The manifest check has already
        //    passed inside BackupImporter, so the rows produce the arithmetic
        //    the file claims.
        #expect(result.imported.verified)
        let claimed = try #require(result.imported.claimedManifest)

        // ── 2. Every row landed. Counted against the file's OWN manifest, not
        //    against a number written here.
        for table in Schema.allTables {
            #expect(result.rowCounts[table] == claimed.rowCounts[table], "\(table)")
            #expect(
                try store.liveCount(StoreSchema.table(forBackupTable: table))
                    == claimed.rowCounts[table],
                "\(table)"
            )
        }

        // ── 3. Every balance, recomputed from the rows THE STORE HANDED BACK,
        //    through Balances -- the app's own code, a different implementation
        //    from the one the manifest check used.
        let book = try store.book()
        var byId: [String: Int64] = [:]
        for balance in try book.accountBalances() { byId[balance.account.id] = balance.balanceMinor }
        var matched = 0
        var problems: [String] = []
        for want in claimed.accounts {
            guard let got = byId[want.id] else {
                problems.append("account \(want.id): in the manifest, absent from the store")
                continue
            }
            if got == want.closingBalanceMinor {
                matched += 1
            } else {
                // The difference in MINOR UNITS, because "out by 1" and "out by
                // 100000" are different bugs and a formatted string hides which.
                problems.append("account \(want.id): out by \(got &- want.closingBalanceMinor)")
            }
        }
        #expect(problems.isEmpty, "\(problems.prefix(5).joined(separator: "; "))")
        #expect(matched == claimed.accounts.count)

        // ── 4. THE BYTES. The file this store re-exports is the file that was
        //    read, to the canonical content hash -- computed by the browser,
        //    carried in the file, and never written down here.
        #expect(result.reproducesSource)
        #expect(try store.exportReproducingSourceHash() == result.sourceContentHash)

        // ── 5. And nothing in it is a float.
        #expect(try store.auditMoneyColumns().isEmpty)
        #expect(try store.integrityCheck() == "ok")

        // ── 6. The provenance the round trip depends on came from the file
        //    rather than from a default: the manifest version selects the
        //    net-worth rule, and getting it from anywhere else would move the
        //    headline figure by a penny.
        #expect(try store.provenance().manifestVersion == claimed.manifestVersion)
        #expect(try store.provenance().schemaVersion == result.imported.file.schemaVersion)
    }

    // MARK: - The register, on the real book

    @Test(
        "PHASE 4 GATE: the real register pages whole, and every running balance lands",
        .enabled(if: FrozenGateTests.frozenPath != nil, "no frozen backup to run against")
    )
    func frozenRegisterPagesAndReconciles() throws {
        let path = try #require(FrozenGateTests.frozenPath)
        let data = try Data(contentsOf: URL(fileURLWithPath: path), options: [.mappedIfSafe])

        // In memory, for the same reason as the gate above: the owner's data
        // never reaches a disk here.
        let store = try LedgerStore.openInMemory()
        let result = try store.importBackup(data: data, requiringExactRoundTrip: true)
        let claimed = try #require(result.imported.claimedManifest)
        let lookups = try store.registerLookups()

        // ── 1. THE WHOLE REGISTER COMES BACK, ONCE. Paged sixty at a time, the
        //    all-accounts register is exactly as many rows as the file says the
        //    transactions table has, with no id appearing twice -- which is the
        //    pair of failures a cursor gets wrong when its sort key is not a
        //    total order.
        var seen = Set<String>()
        var count = 0
        var previous: RegisterCursor?
        var cursor: RegisterCursor?
        repeat {
            let page = try store.registerPage(
                scope: .allAccounts, after: cursor, limit: 60, lookups: lookups
            )
            for row in page.rows {
                #expect(seen.insert(row.id).inserted, "a row was returned twice")
                if let previous {
                    // Strictly descending on the whole key: newest first, and
                    // never equal, or the cursor could not resume from it.
                    let a = (previous.date, previous.createdAt, previous.id)
                    let b = (row.cursor.date, row.cursor.createdAt, row.cursor.id)
                    #expect(a > b, "the register went backwards or stalled")
                }
                previous = row.cursor
                count += 1
            }
            cursor = page.nextCursor
        } while cursor != nil

        #expect(count == claimed.rowCounts["transactions"])
        #expect(count == (try store.registerCount(scope: .allAccounts)))

        // ── 2. EVERY ACCOUNT'S RUNNING BALANCE RECONCILES. Start at the
        //    account's balance, subtract each row on the way down, and the
        //    number left at the bottom must be the opening balance the account
        //    row carries. That is the whole register checked against the
        //    account, per account, with nothing written down here: a row
        //    missed, repeated, or attributed to the wrong account shows up as a
        //    figure that does not land.
        let balances = try store.accountBalances()
        #expect(balances.count == claimed.rowCounts["accounts"])
        var reconciled = 0
        var problems: [String] = []
        for balance in balances {
            let account = balance.account
            var running = RunningBalance(startingAt: balance.balanceMinor)
            var firstRow: Int64?
            var rows = 0
            var cursor: RegisterCursor?
            repeat {
                let page = try store.registerPage(
                    scope: .account(account.id), after: cursor, limit: 200, lookups: lookups
                )
                for row in page.rows {
                    let at = try running.next(row.amountMinor)
                    if firstRow == nil { firstRow = at }
                    rows += 1
                }
                cursor = page.nextCursor
            } while cursor != nil

            if rows != balance.txCount {
                problems.append("account \(account.id): register has \(rows - balance.txCount) rows too many")
            }
            if running.current != account.openingBalanceMinor {
                problems.append(
                    "account \(account.id): landed \(running.current &- account.openingBalanceMinor) from its opening balance"
                )
            }
            if let firstRow, firstRow != balance.balanceMinor {
                problems.append("account \(account.id): the newest row is not the balance")
            }
            if rows == balance.txCount, running.current == account.openingBalanceMinor {
                reconciled += 1
            }
        }
        #expect(problems.isEmpty, "\(problems.prefix(5).joined(separator: "; "))")
        #expect(reconciled == balances.count)

        // ── 3. And the cheap read is the same arithmetic as the full one, on
        //    the real book rather than on a fixture.
        #expect(balances == (try store.book().accountBalances()))
        #expect(try store.accountsSnapshot().netWorth == (try store.book().netWorth()))
    }
}
