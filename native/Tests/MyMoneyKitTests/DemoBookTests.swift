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

        var payees = payeeNames.enumerated().map { index, name in
            Payee(id: "payee-\(index)", name: name)
        }
        let tags = ["work", "holiday", "reimbursable", "one-off"].enumerated().map { index, name in
            Tag(id: "tag-\(index)", name: name)
        }

        // THREE ACCOUNTS ARE HELD BACK FROM THE RANDOM SPENDING so that the
        // demo has money sitting still in it: one in each of three currencies,
        // including the JPY one that has no exchange rate. An insights screen
        // whose "dormant money" section has never been seen with anything in it
        // is a section nobody has tested.
        let dormantIds: Set<String> = ["acct-41", "acct-44", "acct-46"]
        let liveAccounts = accounts.filter { !$0.archived && !dormantIds.contains($0.id) }
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

        // The shapes the insights screen exists to find. Everything below is
        // invented, and it is here for the same reason the JPY account with no
        // rate is here: a screen that has never been seen with real shapes in
        // it has not been looked at.
        appendPatterns(
            into: &transactions, payees: &payees, serial: &serial,
            categoryId: idByName["Utilities"]
        )

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
            // Two imports, so the duplicate-charge section has the one piece
            // of evidence that actually distinguishes a double import from a
            // thing that happened twice: which file each row came from.
            importBatches: [
                ImportBatch(
                    id: "batch-1", source: .csv, fileName: "statement-may.csv", rowCount: 1,
                    importedAt: "2026-05-20T09:12:00.000Z"
                ),
                ImportBatch(
                    id: "batch-2", source: .csv, fileName: "statement-may-again.csv", rowCount: 1,
                    importedAt: "2026-06-02T18:40:00.000Z"
                ),
            ],
            settings: settings,
            baseCurrency: "GBP"
        )
    }

    // MARK: - The shapes the insights screen looks for

    /// Recurring payments, a price rise, a rename, a card change, a pair of
    /// matching charges and a payee that does the same thing routinely.
    ///
    /// EVERY NAME, AMOUNT AND DATE HERE IS INVENTED, like everything else in
    /// this file. What is NOT invented is the shapes: each one is a thing a
    /// real ledger contains and a thing the detector has a rule about, so that
    /// running the app shows the screen doing its job rather than showing an
    /// empty screen that might mean anything.
    static func appendPatterns(
        into transactions: inout [Transaction], payees: inout [Payee], serial: inout Int,
        categoryId: String?
    ) {
        func payee(_ name: String) -> String {
            if let existing = payees.first(where: { $0.name == name }) { return existing.id }
            let id = "payee-\(payees.count)"
            payees.append(Payee(id: id, name: name))
            return id
        }

        func add(
            _ name: String, _ amount: Int64, on dates: [String], account: String = "acct-01",
            currency: String = "GBP", batch: String? = nil, hash: String? = nil
        ) {
            for date in dates {
                let id = "tx-\(String(format: "%05d", serial))"
                transactions.append(
                    Transaction(
                        id: id, accountId: account, date: date, amountMinor: -amount,
                        currency: currency, payeeId: payee(name), categoryId: categoryId,
                        tagIds: [], notes: "", status: .cleared, splits: [],
                        transferGroupId: nil, importBatchId: batch,
                        dedupeHash: hash ?? "demo-\(serial)",
                        createdAt: "\(date)T09:00:00.000Z", updatedAt: "\(date)T09:00:00.000Z"
                    )
                )
                serial += 1
            }
        }

        func varying(_ name: String, _ amounts: [Int64], on dates: [String], account: String) {
            for (amount, date) in zip(amounts, dates) {
                add(name, amount, on: [date], account: account)
            }
        }

        // A subscription that rose from £8.99 to £10.99 two years in.
        let streaming = Dates.monthly(from: "2023-02-05", count: 43)
        add("Northgate Streaming", 899, on: Array(streaming.prefix(25)))
        add("Northgate Streaming", 1_099, on: Array(streaming.suffix(18)))

        // One that stopped in February 2025, so the "looks stopped" section has
        // something in it.
        add("Halloway Gym", 3_400, on: Dates.monthly(from: "2023-03-12", count: 24))

        // A utility: monthly to the day, seasonal amounts, no price rise in it.
        let season: [Int64] = [
            3_800, 4_200, 6_100, 8_900, 9_400, 8_700, 6_200, 4_400, 3_600, 3_500, 3_900, 4_800,
        ]
        varying(
            "Meridian Gas", season + season,
            on: Dates.monthly(from: "2024-09-18", count: 24), account: "acct-02"
        )

        // Four-weekly and fortnightly, which are 13 and 26 a year and are the
        // two the annual figures get wrong.
        add("Pallant Rail Pass", 12_000, on: Dates.everyDays(28, from: "2025-09-22", count: 13))
        add("Copperfield Charity", 1_500, on: Dates.everyDays(14, from: "2025-09-05", count: 26))

        // Quarterly and yearly.
        add("Fernway Water", 5_840, on: Dates.quarterly(from: "2024-11-06", count: 8))
        add("Wren Insurance", 31_000, on: Dates.yearly(from: "2023-06-14", count: 4))

        // A payee whose recorded name changed, with no gap in the payments.
        add("TOLLGATE MOBILE", 2_200, on: Dates.monthly(from: "2024-01-09", count: 12))
        add("Tollgate Mobile Ltd", 2_200, on: Dates.monthly(from: "2025-01-09", count: 20))

        // A card that was replaced half way through.
        let cloud = Dates.monthly(from: "2025-03-21", count: 18)
        add("Lantern Cloud", 499, on: Array(cloud.prefix(8)), account: "acct-01")
        add("Lantern Cloud", 499, on: Array(cloud.suffix(10)), account: "acct-02")

        // A euro subscription, so the yearly total has to convert something.
        add(
            "Adriatic Hosting", 1_200, on: Dates.monthly(from: "2025-05-11", count: 16),
            account: "acct-04", currency: "EUR"
        )

        // A monthly membership buried in a shop's other spending, which is the
        // only thing the by-amount path exists for.
        add("Harbourside Market", 650, on: Dates.monthly(from: "2025-01-07", count: 20))
        varying(
            "Harbourside Market",
            [
                2_340, 1_580, 9_900, 4_210, 12_750, 3_305, 6_640, 1_990, 8_120, 2_875,
                5_460, 14_300, 3_720, 990, 7_050, 2_150, 4_890, 11_240, 1_360, 6_075,
            ],
            on: [
                "2025-01-19", "2025-02-02", "2025-02-24", "2025-03-11", "2025-04-06",
                "2025-04-28", "2025-05-17", "2025-06-03", "2025-06-29", "2025-07-15",
                "2025-08-08", "2025-09-21", "2025-10-13", "2025-11-04", "2025-12-19",
                "2026-01-26", "2026-02-14", "2026-03-30", "2026-05-08", "2026-06-22",
            ],
            account: "acct-01"
        )

        // Two matching charges on one day, from two different imports, with the
        // same dedupe key: the shape a statement imported twice leaves behind.
        add(
            "Meadow Furniture", 44_999, on: ["2026-05-14"], account: "acct-02", batch: "batch-1",
            hash: "acct-02|2026-05-14|-4499900|meadow furniture"
        )
        add(
            "Meadow Furniture", 44_999, on: ["2026-05-14"], account: "acct-02", batch: "batch-2",
            hash: "acct-02|2026-05-14|-4499900|meadow furniture"
        )

        // A payee where two on one day is simply what happens.
        for day in [
            "2026-01-15", "2026-02-27", "2026-04-09", "2026-05-21", "2026-07-02", "2026-08-13",
        ] {
            add("Quayside Espresso", 280, on: [day, day], account: "acct-01")
        }

        // The three held-back accounts: one with old activity, one with older
        // activity, one that has never been used at all.
        add("Marlow Hardware", 4_500, on: ["2023-04-18", "2023-05-02"], account: "acct-44")
        add(
            "Kestrel Insurance", 9_000, on: ["2023-02-09"], account: "acct-41", currency: "JPY"
        )
        // acct-46 gets nothing: an account opened, funded, and forgotten.
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

    @Test("THE DEMO BOOK CONTAINS THE SHAPES THE INSIGHTS SCREEN LOOKS FOR")
    func demoBookExercisesTheInsights() throws {
        // The detector, run over five and a half thousand transactions of which
        // all but a few hundred are random noise. This is the closest thing in
        // the repository to a real book, and it is the only test that asks the
        // whole feature the question that actually matters: how much does it
        // claim, and is all of it true?
        let report = try Insights.report(book: Self.book(), today: "2026-09-02")

        // EVERY SERIES IT FOUND IS ONE THAT WAS PLANTED. The book has twenty
        // random payees with thousands of unrelated payments between them, and
        // none of them produced a claim.
        let planted: Set<String> = [
            "Northgate Streaming", "Halloway Gym", "Meridian Gas", "Pallant Rail Pass",
            "Copperfield Charity", "Fernway Water", "Wren Insurance", "Tollgate Mobile Ltd",
            "Lantern Cloud", "Adriatic Hosting", "Harbourside Market",
        ]
        #expect(Set(report.recurring.map(\.payeeName)) == planted)

        func series(_ name: String) throws -> RecurringSeries {
            try #require(report.recurring.first { $0.payeeName == name }, "\(name)")
        }

        // The two cadences whose annual figures people get wrong.
        #expect(try series("Pallant Rail Pass").cadence == .fourWeekly)
        #expect(try series("Pallant Rail Pass").annualCostMinor == 156_000)  // £120 × 13
        #expect(try series("Copperfield Charity").cadence == .fortnightly)
        #expect(try series("Copperfield Charity").annualCostMinor == 39_000)  // £15 × 26

        // A payee whose recorded name changed, folded into one series.
        #expect(try series("Tollgate Mobile Ltd").alsoKnownAs == ["TOLLGATE MOBILE"])
        #expect(try series("Tollgate Mobile Ltd").evidence.matched == 32)

        // A card replaced half way through.
        #expect(try series("Lantern Cloud").accountIds == ["acct-01", "acct-02"])

        // A variable bill: found, and never described as a price.
        #expect(try series("Meridian Gas").stability == .varies)
        #expect(try series("Meridian Gas").confidence == .medium)

        // A membership found among a shop's other spending, marked as the
        // weaker claim it is.
        #expect(try series("Harbourside Market").foundAmongOtherSpending)

        // One that stopped, kept out of the yearly figure and said out loud.
        #expect(try series("Halloway Gym").status.isLive == false)
        #expect(report.annual.seriesLapsed == 1)

        // One price rise, annualised on the right multiplier: £2 × 12 = £24.
        #expect(report.priceChanges.count == 1)
        let rise = try #require(report.priceChanges.first)
        #expect(rise.payeeName == "Northgate Streaming")
        #expect(rise.change.fromMinor == 899)
        #expect(rise.change.toMinor == 1_099)
        #expect(rise.annualisedChangeMinor == 2_400)
        #expect(rise.change.confirmed)

        // The duplicate pair, with the provenance that makes it worth showing.
        #expect(report.duplicates.unusual.count == 1)
        let duplicate = try #require(report.duplicates.unusual.first)
        #expect(duplicate.payeeName == "Meadow Furniture")
        #expect(duplicate.differentImportBatches)
        #expect(duplicate.sameDedupeKey)
        // ...and six occasions at a payee where two in a day is just what
        // happens, filed separately rather than presented as six problems.
        #expect(report.duplicates.routine.count == 6)
        #expect(report.duplicates.unusual.allSatisfy { !$0.routineForThisPayee })

        // Three accounts sitting still, in three currencies, one of which has
        // no rate -- so the total says what it covers and what it does not.
        #expect(report.dormant.accounts.count == 3)
        #expect(report.dormant.accountsCounted == 2)
        #expect(report.dormant.accountsWithoutRate == 1)
        #expect(report.dormant.missingRateCurrencies == ["JPY"])
        #expect(report.dormant.accounts.contains { $0.daysSinceActivity == nil })

        // And the yearly total is only what is still running, converted once
        // each: ten series, with the euro one among them.
        #expect(report.annual.seriesCounted == 10)
        #expect(report.annual.containsEstimates)
        #expect(report.annual.totalMinor == 367_776)
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
