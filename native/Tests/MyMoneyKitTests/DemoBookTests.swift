// A DEMO BOOK: entirely invented, at the shape and scale of a real one.
//
// WHY IT EXISTS. The native app has to be run, and running it means putting a
// backup file into it. The owner's real backup must never be copied anywhere --
// not into this repository, not onto a simulator's disk, not into a screenshot
// -- so there has to be a file that looks like a ledger and is not one. This
// generates it: 58 accounts across six groups and four currencies, roughly
// 5,200 transactions, transfers, splits, tags, pending rows, two excluded
// accounts and three archived ones.
//
// EVERY NAME AND EVERY FIGURE IS FICTION, generated from a counter. No payee,
// account, amount or date here came from anywhere but this file.
//
// It is a TEST rather than a script because the file has to be RIGHT: a demo
// backup that did not add up would be refused by the importer, and an afternoon
// would go into wondering whether the app was broken. So the same suite that
// writes it also proves it imports, balances, and re-exports to the same hash.
//
//   MYMONEY_WRITE_DEMO=/some/dir   also writes demo-backup.json and
//                                  demo-backup-broken.json into that directory
import Foundation
import Testing

@testable import MyMoneyKit

struct DemoBookTests {

    // MARK: - The invented book

    static let currencies = ["GBP", "GBP", "GBP", "GBP", "EUR", "USD", "JPY"]

    static let groupNames = [
        "Cash", "Bank Accounts", "Savings", "Credit Cards", "Investments & Assets",
        "Foreign Currency",
    ]

    static let payeeNames = [
        "Alderney Grocers", "Bramble Coffee", "Cardinal Energy", "Dovetail Books",
        "Elmwood Pharmacy", "Ferngate Rail", "Gorse Lane Garage", "Hartley Bakery",
        "Ivywood Cinema", "Juniper Fitness", "Kestrel Insurance", "Larkspur Water",
        "Marlow Hardware", "Northfield Dairy", "Oakhurst Council", "Pippin Florist",
        "Quill Stationery", "Redstart Broadband", "Saltmarsh Bistro", "Thistledown Hotel",
    ]

    static let categoryTree: [(name: String, parent: String?, kind: MyMoneyKit.CategoryKind)] = [
        ("Income", nil, .income),
        ("Salary", "Income", .income),
        ("Interest", "Income", .income),
        ("Home", nil, .expense),
        ("Rent", "Home", .expense),
        ("Utilities", "Home", .expense),
        ("Food", nil, .expense),
        ("Groceries", "Food", .expense),
        ("Eating out", "Food", .expense),
        ("Transport", nil, .expense),
        ("Fuel", "Transport", .expense),
        ("Rail", "Transport", .expense),
        ("Health", nil, .expense),
        ("Leisure", nil, .expense),
    ]

    /// Deterministic. A demo file that changed every time it was generated
    /// would be useless for comparing one run of the app with the next.
    struct Rng {
        private var state: UInt64
        init(seed: UInt64) { state = seed }
        mutating func next() -> UInt64 {
            state ^= state << 13
            state ^= state >> 7
            state ^= state << 17
            return state
        }
        mutating func int(_ range: ClosedRange<Int>) -> Int {
            range.lowerBound + Int(next() % UInt64(range.count))
        }
        mutating func pick<T>(_ values: [T]) -> T { values[int(0...(values.count - 1))] }
        mutating func chance(_ oneIn: Int) -> Bool { int(1...oneIn) == 1 }
    }

    static func book(transactionCount: Int = 5200) -> Book {
        var rng = Rng(seed: 0x5EED_1234_ABCD_0001)

        let groups = groupNames.enumerated().map { index, name in
            AccountGroup(id: "grp-\(index)", name: name, sortOrder: index)
        }

        var accounts: [Account] = []
        for i in 0..<58 {
            let currency = currencies[i % currencies.count]
            let group = groups[i % groups.count]
            accounts.append(
                Account(
                    id: "acct-\(String(format: "%02d", i))",
                    name: "\(group.name.split(separator: " ").first!) account \(i + 1)",
                    type: [.current, .savings, .creditCard, .cash, .investment][i % 5],
                    currency: currency,
                    // A round opening balance in the account's own minor units.
                    openingBalanceMinor: Int64((i % 7) * 25_000),
                    colour: ["#1B4A6E", "#2F7A4F", "#8A3B12", "#5D2E7A", "#7A6A12", "#123F7A"][
                        i % 6
                    ],
                    groupId: i % 11 == 0 ? nil : group.id,
                    sortOrder: i,
                    // Three archived, two excluded: both kinds have to be on
                    // screen for the accounts view to be worth looking at.
                    archived: i >= 55,
                    excludeFromNetWorth: (i == 7 || i == 21) ? true : (i % 3 == 0 ? false : nil)
                )
            )
        }

        var categories: [MyMoneyKit.Category] = []
        var idByName: [String: String] = [:]
        for (index, node) in categoryTree.enumerated() {
            let id = "cat-\(index)"
            idByName[node.name] = id
            categories.append(
                Category(
                    id: id,
                    name: node.name,
                    parentId: node.parent.flatMap { idByName[$0] },
                    kind: node.kind,
                    icon: nil,
                    colour: index % 4 == 0 ? "#446688" : nil,
                    archived: false,
                    sortOrder: index
                )
            )
        }
        let leafCategoryIds = categories.filter { $0.parentId != nil }.map { $0.id }

        let payees = payeeNames.enumerated().map { index, name in
            Payee(id: "payee-\(index)", name: name)
        }
        let tags = ["work", "holiday", "reimbursable", "one-off"].enumerated().map { index, name in
            Tag(id: "tag-\(index)", name: name)
        }

        let liveAccounts = accounts.filter { !$0.archived }
        var transactions: [Transaction] = []
        var day = CalendarDate(iso: "2023-01-02")!
        var serial = 0

        while transactions.count < transactionCount {
            // Two to five transactions a day, so plenty of dates carry several
            // rows and the register's tie-break is exercised on every page.
            for _ in 0..<rng.int(2...5) {
                guard transactions.count < transactionCount else { break }
                let account = rng.pick(liveAccounts)
                let id = "tx-\(String(format: "%05d", serial))"
                let stamp = "\(day.iso)T\(String(format: "%02d", rng.int(6...21))):\(String(format: "%02d", rng.int(0...59))):00.000Z"

                // Roughly one in twelve is a transfer, written as two legs
                // sharing a group id -- and only between accounts in the SAME
                // currency, because a transfer that changes currency is a
                // different thing and this file should not pretend otherwise.
                if rng.chance(12),
                    let other = liveAccounts.first(where: {
                        $0.id != account.id && $0.currency == account.currency
                    })
                {
                    let amount = Int64(rng.int(1...400) * Int(Money.minorFactor(for: account.currency)))
                    let group = "xfer-\(serial)"
                    transactions.append(
                        Transaction(
                            id: id, accountId: account.id, date: day.iso, amountMinor: -amount,
                            currency: account.currency, notes: "", status: .cleared,
                            transferGroupId: group, dedupeHash: "demo-\(serial)-a",
                            createdAt: stamp, updatedAt: stamp
                        )
                    )
                    serial += 1
                    transactions.append(
                        Transaction(
                            id: "tx-\(String(format: "%05d", serial))", accountId: other.id,
                            date: day.iso, amountMinor: amount, currency: other.currency,
                            notes: "", status: .cleared, transferGroupId: group,
                            dedupeHash: "demo-\(serial)-b", createdAt: stamp, updatedAt: stamp
                        )
                    )
                    serial += 1
                    continue
                }

                let income = rng.chance(9)
                let factor = Int(Money.minorFactor(for: account.currency))
                let magnitude = Int64(
                    income ? rng.int(80_000 / max(factor, 1) * factor...240_000) : rng.int(1...18_000)
                )
                let amount = income ? magnitude : -magnitude

                // One in twenty carries splits that sum EXACTLY to the parent,
                // because a split that does not is not a transaction.
                var splits: [Split] = []
                if !income, rng.chance(20), magnitude > 3 {
                    let first = amount / 3
                    splits = [
                        Split(categoryId: rng.pick(leafCategoryIds), amountMinor: first),
                        Split(
                            categoryId: rng.pick(leafCategoryIds), amountMinor: amount - first,
                            notes: rng.chance(2) ? "part two" : nil
                        ),
                    ]
                }

                transactions.append(
                    Transaction(
                        id: id,
                        accountId: account.id,
                        date: day.iso,
                        amountMinor: amount,
                        currency: account.currency,
                        payeeId: rng.chance(8) ? nil : rng.pick(payees).id,
                        categoryId: splits.isEmpty ? rng.pick(leafCategoryIds) : nil,
                        tagIds: rng.chance(6) ? [rng.pick(tags).id] : [],
                        notes: rng.chance(10) ? "Note for row \(serial)\nsecond line" : "",
                        status: rng.chance(14) ? .pending : .cleared,
                        splits: splits,
                        dedupeHash: "demo-\(serial)",
                        createdAt: stamp,
                        updatedAt: stamp
                    )
                )
                serial += 1
            }
            day = day.addingDays(1)
        }

        let settings = Settings(
            id: "app",
            schemaVersion: Schema.version,
            baseCurrency: "GBP",
            theme: .system,
            lastBackupAt: nil,
            onboarded: true,
            lastUsedAccountId: nil,
            savedMappings: [:],
            createdAt: "2023-01-01T09:00:00.000Z",
            autoFxEnabled: false,
            lastFxSyncAt: nil,
            lastFxSyncSource: nil,
            raw: .null
        )

        return Book(
            accounts: accounts,
            accountGroups: groups,
            transactions: transactions,
            categories: categories,
            payees: payees,
            tags: tags,
            budgets: [],
            fxRates: [
                // JPY deliberately has NO rate, so the app's "excludes JPY --
                // no exchange rate set" warning is on screen in the demo. A
                // warning nobody has ever seen is a warning nobody has tested.
                FxRate(base: "EUR", quote: "GBP", rate: 0.85, asOf: "2026-01-02", source: .manual),
                FxRate(base: "USD", quote: "GBP", rate: 0.78, asOf: "2026-01-02", source: .manual),
            ],
            importBatches: [],
            settings: settings,
            baseCurrency: "GBP"
        )
    }

    // MARK: - The file is right

    @Test("THE DEMO BACKUP IMPORTS, BALANCES, AND RE-EXPORTS TO THE SAME BYTES")
    func demoBackupIsAValidBackup() throws {
        let book = Self.book()
        let text = try BackupWriter.text(book, exportedAt: "2026-09-01T08:00:00.000Z")

        let store = try LedgerStore.openInMemory()
        defer { store.close() }
        let result = try store.importBackup(data: Data(text.utf8), requiringExactRoundTrip: true)

        #expect(result.imported.verified, "the demo file must carry a checkable manifest")
        #expect(result.reproducesSource)
        #expect(result.rowCounts["accounts"] == book.accounts.count)
        #expect(result.rowCounts["transactions"] == book.transactions.count)
        #expect(try store.auditMoneyColumns().isEmpty)

        // Every split adds up, or the importer would have refused; asserted
        // here anyway so a change to the generator fails HERE rather than at
        // the far end of an import.
        for tx in book.transactions { #expect(try tx.validateSplits()) }

        // The shapes the app's screens exist to show are actually present.
        let snapshot = try store.accountsSnapshot()
        #expect(snapshot.netWorth.excludedCount == 2)
        #expect(snapshot.netWorth.missingRateCurrencies == ["JPY"])
        #expect(snapshot.balances.filter(\.account.archived).count == 3)
        #expect(snapshot.groups.count == Self.groupNames.count)
    }

    @Test("the broken demo backup is REFUSED, and the refusal names the account")
    func brokenDemoBackupIsRefused() throws {
        let broken = try Self.brokenText()
        let store = try LedgerStore.openInMemory()
        defer { store.close() }

        #expect(throws: BackupImportError.self) {
            try store.importBackup(data: Data(broken.utf8))
        }
        do {
            _ = try store.importBackup(data: Data(broken.utf8))
        } catch let error as BackupImportError {
            guard case .manifestDisagrees(let problems) = error else {
                Issue.record("expected a manifest disagreement, got \(error)")
                return
            }
            // The refusal names the account the way a person knows it -- by
            // NAME, not by id -- and says which figure disagreed.
            let name = try #require(
                Self.book(transactionCount: 400).accounts.first { $0.id == "acct-03" }?.name
            )
            #expect(
                problems.contains { $0.contains(name) && $0.contains("closing balance") },
                "\(problems)"
            )
        }
        // And nothing landed.
        #expect(try store.isEmpty())
    }

    /// The good file with ONE account's claimed closing balance moved by a
    /// penny. Everything else is untouched, so the importer has to catch the
    /// single figure that no longer follows from the rows.
    static func brokenText() throws -> String {
        let text = try BackupWriter.text(book(transactionCount: 400), exportedAt: "2026-09-01T08:00:00.000Z")
        let file = try JSONParser.parse(text)
        guard var root = file.objectValue,
            var manifest = root["manifest"]?.objectValue,
            var accounts = manifest["accounts"]?.arrayValue
        else {
            throw BackupImportError.invalid("the demo file did not have the shape it just wrote")
        }
        for (index, entry) in accounts.enumerated() {
            guard var account = entry.objectValue,
                account["id"]?.stringValue == "acct-03",
                let closing = account["closingBalanceMinor"]?.intValue
            else { continue }
            account["closingBalanceMinor"] = .int(closing + 1)
            accounts[index] = .object(account)
        }
        manifest["accounts"] = .array(accounts)
        root["manifest"] = .object(manifest)
        return BackupWriter.serialise(.object(root))
    }

    // MARK: - Writing it out

    @Test(
        "write the demo backups where MYMONEY_WRITE_DEMO says",
        .enabled(if: ProcessInfo.processInfo.environment["MYMONEY_WRITE_DEMO"] != nil)
    )
    func writeDemoBackups() throws {
        let directory = try #require(ProcessInfo.processInfo.environment["MYMONEY_WRITE_DEMO"])
        let base = URL(fileURLWithPath: directory, isDirectory: true)
        try FileManager.default.createDirectory(at: base, withIntermediateDirectories: true)

        let good = try BackupWriter.text(Self.book(), exportedAt: "2026-09-01T08:00:00.000Z")
        try good.write(
            to: base.appendingPathComponent("demo-backup.json"), atomically: true, encoding: .utf8
        )
        try Self.brokenText().write(
            to: base.appendingPathComponent("demo-backup-broken.json"),
            atomically: true, encoding: .utf8
        )

        // ...and a ready-made STORE holding the same demo book, built by the
        // app's own import path. It exists so a desktop build can be looked at
        // without hand-driving an open panel; it is the demo book and nothing
        // else, so a copy of it is a copy of fiction.
        let storeURL = base.appendingPathComponent("demo-ledger.sqlite")
        for suffix in ["", "-wal", "-shm"] {
            try? FileManager.default.removeItem(
                at: base.appendingPathComponent("demo-ledger.sqlite" + suffix)
            )
        }
        let store = try LedgerStore.open(at: storeURL)
        try store.importBackup(data: Data(good.utf8), replacingExistingBook: true)
        // close() checkpoints the WAL, so the single file stands on its own and
        // can be copied somewhere else and opened there.
        store.close()
    }
}
