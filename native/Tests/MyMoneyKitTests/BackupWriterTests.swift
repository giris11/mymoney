// Writing a backup, and the four ways a writer can quietly change a file.
//
// The fixture below is FABRICATED, in the same spirit as tools/oracle/cases and
// BackupTests: three invented accounts, two invented transactions, figures
// small enough to check by hand. No real account, payee or amount appears in
// this repository, ever.
//
// EVERY EXPECTED FIGURE HERE WAS CALCULATED BY HAND:
//
//   w-a  GBP  100000 - 1000 - 1500 (two splits of t1) = 97500   counted
//   w-b  EUR   20000 - 3000                           = 17000   counted
//   w-c  GBP  500000, archived AND excluded           = 500000  not counted
//   net worth = 97500 + round(17000 * 0.85) = 97500 + 14450     = 111950
//
// THE MANIFEST BELOW SAYS VERSION 2, because that is what this build writes: a
// v2 manifest totals each currency and converts the subtotal once. On THIS book
// the older per-account rule (version 1) gives the same 111950 -- there is only
// one counted account in each currency, so there is nothing for the two rules
// to disagree about. That is exactly why this fixture cannot pin the rule, and
// why ManifestVersionTests exists next door with a book where they do differ.
//
// It is deliberately built to contain one of everything a writer can get
// wrong: a row that omits an optional flag and a row that states it as
// `false`; a category with a colour and one without; a split with notes and
// one without; an import batch with the sample-only arrays and one without; a
// rate written as an integer and one written to sixteen decimal places; and a
// savedMappings key that is all digits, which is the case src/backup/canonical.ts
// says a "sort the keys and hand it to JSON.stringify" shortcut gets wrong.
import Foundation
import Testing

@testable import MyMoneyKit

struct BackupWriterTests {

    static let exportedAt = "2026-09-01T12:00:00.000Z"

    static let backup = """
    {
      "app": "MyMoney",
      "schemaVersion": 1,
      "exportedAt": "\(exportedAt)",
      "manifest": {
        "manifestVersion": 2,
        "schemaVersion": 1,
        "exportedAt": "\(exportedAt)",
        "rowCounts": {
          "accounts": 3, "accountGroups": 1, "transactions": 2, "categories": 2,
          "payees": 1, "tags": 1, "budgets": 1, "fxRates": 3, "importBatches": 2,
          "settings": 1
        },
        "accounts": [
          {"id":"w-a","name":"Alpha","currency":"GBP","closingBalanceMinor":97500,"txCount":1,"counted":true},
          {"id":"w-b","name":"Beta","currency":"EUR","closingBalanceMinor":17000,"txCount":1,"counted":true},
          {"id":"w-c","name":"Gamma","currency":"GBP","closingBalanceMinor":500000,"txCount":0,"counted":false}
        ],
        "netWorth": {
          "baseCurrency": "GBP",
          "totalMinor": 111950,
          "rates": [{"from":"EUR","to":"GBP","rate":0.85}],
          "missingRateCurrencies": []
        }
      },
      "tables": {
        "accounts": [
          {"id":"w-a","name":"Alpha","type":"current","currency":"GBP","openingBalanceMinor":100000,"colour":"#111111","groupId":"g1","sortOrder":0,"archived":false},
          {"id":"w-b","name":"Beta","type":"savings","currency":"EUR","openingBalanceMinor":20000,"colour":"#222222","groupId":null,"sortOrder":1,"archived":false,"excludeFromNetWorth":false},
          {"id":"w-c","name":"Gamma","type":"loan","currency":"GBP","openingBalanceMinor":500000,"colour":"#333333","groupId":null,"sortOrder":2,"archived":true,"excludeFromNetWorth":true,"loanPrincipalMinor":400000,"loanRatePct":4.25,"loanTermMonths":240}
        ],
        "accountGroups": [
          {"id":"g1","name":"Everyday","sortOrder":0}
        ],
        "transactions": [
          {"id":"t1","accountId":"w-a","date":"2026-08-03","amountMinor":-2500,"currency":"GBP","payeeId":null,"categoryId":null,"tagIds":["tg1"],"notes":"","status":"cleared","splits":[{"categoryId":"c-food","amountMinor":-1000,"notes":"half"},{"categoryId":null,"amountMinor":-1500}],"transferGroupId":null,"importBatchId":null,"dedupeHash":"h1","createdAt":"2026-08-03T00:00:00.000Z","updatedAt":"2026-08-03T00:00:00.000Z"},
          {"id":"t2","accountId":"w-b","date":"2026-08-22","amountMinor":-3000,"currency":"EUR","payeeId":"p1","categoryId":"c-sub","tagIds":[],"notes":"a note","status":"pending","splits":[],"transferGroupId":"tg-x","importBatchId":"ib1","dedupeHash":"h2","createdAt":"2026-08-22T00:00:00.000Z","updatedAt":"2026-08-22T00:00:00.000Z"}
        ],
        "categories": [
          {"id":"c-food","name":"Food","parentId":null,"kind":"expense","icon":"fork","colour":"#aabbcc","archived":false,"sortOrder":0},
          {"id":"c-sub","name":"Groceries","parentId":"c-food","kind":"expense","archived":false,"sortOrder":1}
        ],
        "payees": [
          {"id":"p1","name":"Corner Shop","nameLower":"corner shop","defaultCategoryId":null}
        ],
        "tags": [
          {"id":"tg1","name":"Holiday","nameLower":"holiday"}
        ],
        "budgets": [
          {"id":"b1","name":"Food","categoryIds":["c-food"],"amountMinor":50000,"period":"monthly","startDate":"2026-01-31","rollover":false,"archived":false}
        ],
        "fxRates": [
          {"id":"EUR:GBP","base":"EUR","quote":"GBP","rate":0.85,"asOf":"2026-01-01T00:00:00.000Z","source":"manual"},
          {"id":"JPY:GBP","base":"JPY","quote":"GBP","rate":0.1234567890123456,"asOf":"2026-01-01T00:00:00.000Z","source":"auto"},
          {"id":"USD:GBP","base":"USD","quote":"GBP","rate":2,"asOf":"2026-01-01T00:00:00.000Z","source":"manual"}
        ],
        "importBatches": [
          {"id":"ib1","source":"csv","fileName":"statement.csv","rowCount":2,"importedAt":"2026-08-01T00:00:00.000Z","createdAccountIds":[],"createdCategoryIds":[],"createdPayeeIds":["p1"],"createdTagIds":[],"createdGroupIds":[]},
          {"id":"ib2","source":"sample","fileName":"","rowCount":0,"importedAt":"2026-01-01T00:00:00.000Z","createdAccountIds":[],"createdCategoryIds":[],"createdPayeeIds":[],"createdTagIds":[],"createdGroupIds":[],"createdBudgetIds":["b1"],"createdFxRateIds":["EUR:GBP"]}
        ],
        "settings": [
          {"id":"app","schemaVersion":1,"baseCurrency":"GBP","theme":"dark","lastBackupAt":null,"onboarded":true,"lastUsedAccountId":"w-a","savedMappings":{"12345":{"date":0,"amount":1,"debit":-1,"credit":-1,"payee":2,"description":3,"category":-1,"account":-1,"currency":-1,"tags":-1,"notes":-1,"dateFormat":"DMY","decimal":"dot","negate":false,"headerRow":true},"abc":{"date":1,"amount":2,"debit":-1,"credit":-1,"payee":0,"description":-1,"category":-1,"account":-1,"currency":-1,"tags":-1,"notes":-1,"dateFormat":"auto","decimal":"auto","negate":true,"headerRow":false}},"createdAt":"2026-01-01T00:00:00.000Z","autoFxEnabled":true,"lastFxSyncAt":"2026-08-30T00:00:00.000Z","lastFxSyncSource":"Example Rates","syncEnabled":false,"syncDeviceId":"dev-1","syncDeviceName":"Laptop","syncClientId":null,"syncLastSyncedAt":null,"syncLastPulledRevision":0,"syncLastPulledSnapshotId":null,"syncLocalRevision":3,"syncSyncedLocalRevision":0}
        ]
      }
    }
    """

    static func imported() throws -> ImportedBackup { try BackupImporter.load(text: backup) }

    static func exported(_ book: Book) throws -> JSONValue {
        try BackupWriter.file(book, exportedAt: exportedAt, schemaVersion: 1)
    }

    /// One row out of an exported document, by table and id.
    static func row(_ document: JSONValue, _ table: String, _ id: String) throws -> [String: JSONValue] {
        let rows = try #require(document["tables"]?[table]?.arrayValue)
        let found = try #require(rows.first { $0["id"]?.stringValue == id })
        return try #require(found.objectValue)
    }

    // MARK: - The whole point

    @Test("a decoded book writes back out as the same bytes it arrived as")
    func roundTripIsByteIdentical() throws {
        let imported = try Self.imported()
        let written = try Self.exported(imported.book)

        // Against the CANONICAL form of the source, not the source text: the
        // fixture above is indented for a human and has its keys in the order
        // a person would write them, and neither of those is data.
        let canonicalSource = CanonicalJSON.text(try JSONParser.parse(Self.backup), indent: 2)
        let differences = JSONDiff.differences(
            want: try JSONParser.parse(Self.backup), got: written
        )
        #expect(differences.isEmpty, "\(JSONDiff.report(differences))")
        #expect(BackupWriter.serialise(written) == canonicalSource)
        #expect(BackupReader.canonicalHash(written) == imported.contentHash)
    }

    @Test("an exported file imports again, and proves itself")
    func exportIsReadableBack() throws {
        let once = try Self.imported()
        let written = BackupWriter.serialise(try Self.exported(once.book))
        let twice = try BackupImporter.load(text: written)
        #expect(twice.verified)
        #expect(twice.warnings.isEmpty)
        #expect(twice.contentHash == once.contentHash)
        #expect(try twice.book.netWorth().totalBaseMinor == 111_950)
    }

    // MARK: - The rule: `T | null` is written, `T?` is omitted

    @Test("a nullable field is written as null, never dropped")
    func nullableFieldsAreWritten() throws {
        let written = try Self.exported(try Self.imported().book)
        #expect(try Self.row(written, "categories", "c-food")["parentId"] == JSONValue.null)
        #expect(try Self.row(written, "payees", "p1")["defaultCategoryId"] == JSONValue.null)
        #expect(try Self.row(written, "accounts", "w-b")["groupId"] == JSONValue.null)
        let t1 = try Self.row(written, "transactions", "t1")
        for key in ["payeeId", "categoryId", "transferGroupId", "importBatchId"] {
            #expect(t1[key] == JSONValue.null, "\(key) must be present as null")
        }
        // A split's categoryId is nullable the same way; its notes are not.
        let splits = try #require(t1["splits"]?.arrayValue)
        #expect(splits[1]["categoryId"] == JSONValue.null)
        #expect(splits[0]["notes"] == .string("half"))
        #expect(splits[1].objectValue?["notes"] == nil, "an absent note stays absent")
    }

    @Test("an optional field with nothing to say is omitted, not written as null")
    func optionalFieldsAreOmitted() throws {
        let written = try Self.exported(try Self.imported().book)
        let plain = try Self.row(written, "categories", "c-sub")
        #expect(plain["colour"] == nil)
        #expect(plain["icon"] == nil)
        let decorated = try Self.row(written, "categories", "c-food")
        #expect(decorated["colour"] == .string("#aabbcc"))
        #expect(decorated["icon"] == .string("fork"))

        let batch = try Self.row(written, "importBatches", "ib1")
        #expect(batch["createdBudgetIds"] == nil)
        #expect(batch["createdFxRateIds"] == nil)
        #expect(try Self.row(written, "importBatches", "ib2")["createdBudgetIds"] == .array([.string("b1")]))

        let loan = try Self.row(written, "accounts", "w-c")
        #expect(loan["loanPrincipalMinor"] == .int(400_000))
        #expect(loan["loanTermMonths"] == .int(240))
        #expect(try Self.row(written, "accounts", "w-a")["loanPrincipalMinor"] == nil)
    }

    /// The regression that forced `Account.excludeFromNetWorth` to become an
    /// optional: absent and `false` are the same answer to every money
    /// question and DIFFERENT BYTES in the file.
    @Test("an absent flag and a flag stated as false are preserved apart")
    func absentAndFalseAreDifferentBytes() throws {
        let book = try Self.imported().book
        let byId = Dictionary(uniqueKeysWithValues: book.accounts.map { ($0.id, $0) })
        #expect(byId["w-a"]?.excludeFromNetWorth == nil, "the row does not carry the key")
        #expect(byId["w-b"]?.excludeFromNetWorth == false, "the row says false out loud")
        #expect(byId["w-c"]?.excludeFromNetWorth == true)
        // ...and none of that changes what counts.
        #expect(Balances.countsTowardNetWorth(byId["w-a"]!))
        #expect(Balances.countsTowardNetWorth(byId["w-b"]!))
        #expect(!Balances.countsTowardNetWorth(byId["w-c"]!))

        let written = try Self.exported(book)
        #expect(try Self.row(written, "accounts", "w-a")["excludeFromNetWorth"] == nil)
        #expect(try Self.row(written, "accounts", "w-b")["excludeFromNetWorth"] == .bool(false))

        // If the two were ever collapsed again, this is what it would cost: a
        // book identical in every balance, with a different fingerprint.
        let collapsed = Book(
            accounts: book.accounts.map {
                Account(
                    id: $0.id, name: $0.name, type: $0.type, currency: $0.currency,
                    openingBalanceMinor: $0.openingBalanceMinor, colour: $0.colour,
                    groupId: $0.groupId, sortOrder: $0.sortOrder, archived: $0.archived,
                    excludeFromNetWorth: $0.excludeFromNetWorth ?? false,
                    loanPrincipalMinor: $0.loanPrincipalMinor, loanRatePct: $0.loanRatePct,
                    loanTermMonths: $0.loanTermMonths
                )
            },
            accountGroups: book.accountGroups, transactions: book.transactions,
            categories: book.categories, payees: book.payees, tags: book.tags,
            budgets: book.budgets, fxRates: book.fxRates, importBatches: book.importBatches,
            settings: book.settings, baseCurrency: book.baseCurrency
        )
        #expect(try collapsed.netWorth().totalBaseMinor == book.netWorth().totalBaseMinor)
        #expect(BackupReader.canonicalHash(try Self.exported(collapsed)) != BackupReader.canonicalHash(written))
    }

    // MARK: - Numbers, keys and order

    @Test("a rate keeps the exact number the file gave it")
    func ratesKeepTheirDigits() throws {
        let written = try Self.exported(try Self.imported().book)
        let text = CanonicalJSON.text(try #require(written["tables"]?["fxRates"]), indent: 0)
        // Sixteen significant digits survive, and an integer-valued rate does
        // NOT become "2.0" -- JSON.stringify writes `2`, and a file that said
        // 2.0 would be a different file.
        #expect(text.contains("\"rate\":0.1234567890123456"))
        #expect(text.contains("\"rate\":2,"))
        #expect(!text.contains("2.0"))
    }

    @Test("an all-digit object key is sorted as a string, not as a number")
    func digitKeysAreNotReordered() throws {
        let written = try Self.exported(try Self.imported().book)
        let settings = try Self.row(written, "settings", "app")
        let mappings = try #require(settings["savedMappings"])
        let text = CanonicalJSON.text(mappings, indent: 0)
        #expect(text.hasPrefix("{\"12345\":"))
        #expect(text.contains("\"abc\":"))
        // The mapping came back whole, all fifteen columns of it.
        #expect(mappings["12345"]?["dateFormat"] == .string("DMY"))
        #expect(mappings["abc"]?["negate"] == .bool(true))
        #expect(mappings["abc"]?.objectValue?.count == 15)
    }

    @Test("the settings keys this build does not model survive untouched")
    func deviceLocalSettingsSurvive() throws {
        let book = try Self.imported().book
        let settings = try #require(book.settings)
        #expect(
            BackupWriter.unmodelledSettingsKeys(settings) == [
                "syncClientId", "syncDeviceId", "syncDeviceName", "syncEnabled",
                "syncLastPulledRevision", "syncLastPulledSnapshotId", "syncLastSyncedAt",
                "syncLocalRevision", "syncSyncedLocalRevision",
            ]
        )
        let written = try Self.row(try Self.exported(book), "settings", "app")
        #expect(written["syncDeviceName"] == .string("Laptop"))
        #expect(written["syncLocalRevision"] == .int(3))
        #expect(written["syncClientId"] == JSONValue.null)
        #expect(written["syncLastPulledSnapshotId"] == JSONValue.null)
        // And the modelled half is rebuilt from the record, not copied.
        #expect(written["theme"] == .string("dark"))
        #expect(written["lastUsedAccountId"] == .string("w-a"))
    }

    @Test("rows go out in primary-key order whatever order they arrived in")
    func rowsAreSortedById() throws {
        let book = try Self.imported().book
        let shuffled = Book(
            accounts: book.accounts.reversed(), accountGroups: book.accountGroups,
            transactions: book.transactions.reversed(), categories: book.categories.reversed(),
            payees: book.payees, tags: book.tags, budgets: book.budgets,
            fxRates: book.fxRates.reversed(), importBatches: book.importBatches.reversed(),
            settings: book.settings, baseCurrency: book.baseCurrency
        )
        let written = try Self.exported(shuffled)
        for (table, ids) in [
            ("accounts", ["w-a", "w-b", "w-c"]),
            ("transactions", ["t1", "t2"]),
            ("categories", ["c-food", "c-sub"]),
            ("fxRates", ["EUR:GBP", "JPY:GBP", "USD:GBP"]),
            ("importBatches", ["ib1", "ib2"]),
        ] {
            let rows = try #require(written["tables"]?[table]?.arrayValue)
            #expect(rows.compactMap { $0["id"]?.stringValue } == ids)
        }
        // Same bytes as the unshuffled book: order of arrival is not data.
        #expect(BackupReader.canonicalHash(written) == BackupReader.canonicalHash(try Self.exported(book)))
    }

    @Test("row order is decided by UTF-16 code unit, with no equality test anywhere")
    func sortIsTheJavaScriptOne() throws {
        // Uppercase sorts before lowercase by code unit, which is what a
        // browser's `a.id < b.id` does.
        #expect(BackupWriter.sortedById(["a", "Z", "A"], id: { $0 }) == ["A", "Z", "a"])

        // The case that catches a sort written the obvious way. Precomposed
        // "ä" (U+00E4) and "a" + combining diaeresis (U+0061 U+0308) are two
        // DIFFERENT keys in a JSON file and the SAME string to Swift's `==`.
        // A comparator that asks "are they equal?" before ordering them leaves
        // this pair in arrival order; one that only ever asks jsStringLess
        // puts the decomposed form first, where its 0x0061 belongs.
        let precomposed = "\u{00E4}"
        let decomposed = "a\u{0308}"
        #expect(precomposed == decomposed, "Swift calls these the same string")
        #expect(Array(precomposed.utf16) != Array(decomposed.utf16), "the file does not")
        let ordered = BackupWriter.sortedById([precomposed, decomposed], id: { $0 })
        #expect(ordered.map { Array($0.utf16) } == [Array(decomposed.utf16), Array(precomposed.utf16)])
    }

    // MARK: - The manifest travels with the rows it describes

    @Test("the manifest is computed from the rows being written, not carried over")
    func manifestFollowsTheRows() throws {
        let book = try Self.imported().book
        // One more transaction on w-a: -500, so its closing balance is 97000
        // and net worth 97000 + 14450 = 111450. Both hand-calculated.
        let extra = Transaction(
            id: "t3", accountId: "w-a", date: "2026-08-30", amountMinor: -500, currency: "GBP",
            dedupeHash: "h3", createdAt: "2026-08-30T00:00:00.000Z",
            updatedAt: "2026-08-30T00:00:00.000Z"
        )
        let changed = Book(
            accounts: book.accounts, accountGroups: book.accountGroups,
            transactions: book.transactions + [extra], categories: book.categories,
            payees: book.payees, tags: book.tags, budgets: book.budgets, fxRates: book.fxRates,
            importBatches: book.importBatches, settings: book.settings,
            baseCurrency: book.baseCurrency
        )
        let written = try Self.exported(changed)
        let manifest = try #require(written["manifest"])
        #expect(manifest["netWorth"]?["totalMinor"] == .int(111_450))
        #expect(manifest["rowCounts"]?["transactions"] == .int(3))
        let alpha = try #require(manifest["accounts"]?.arrayValue?.first)
        #expect(alpha["id"] == .string("w-a"))
        #expect(alpha["closingBalanceMinor"] == .int(97000))
        #expect(alpha["txCount"] == .int(2))
        // ...and the file it produces is one an importer accepts.
        #expect(try BackupImporter.load(text: BackupWriter.serialise(written)).verified)
    }

    // MARK: - Pretty below the limit, compact above it

    @Test("the indent threshold is the browser's, counted the browser's way")
    func prettyPrintThreshold() throws {
        func book(transactions count: Int) -> Book {
            Book(
                accounts: [Account(id: "a", name: "A", type: .current, currency: "GBP", openingBalanceMinor: 0)],
                accountGroups: [], transactions: (0..<count).map {
                    Transaction(
                        id: String(format: "t%05d", $0), accountId: "a", date: "2026-01-01",
                        amountMinor: 0, currency: "GBP"
                    )
                },
                categories: [], payees: [], tags: [], budgets: [], fxRates: [], importBatches: [],
                settings: nil, baseCurrency: "GBP"
            )
        }
        // 1 account + N transactions, so the limit is crossed at 2000 rows.
        let atLimit = try BackupWriter.text(book(transactions: 1999), exportedAt: Self.exportedAt)
        #expect(atLimit.contains("\n"), "2000 rows is still small enough to read")
        let overLimit = try BackupWriter.text(book(transactions: 2000), exportedAt: Self.exportedAt)
        #expect(!overLimit.contains("\n"), "2001 rows is written compact")
        // Whitespace is not data: both fingerprint the same as their own content.
        let pretty = try JSONParser.parse(atLimit)
        #expect(
            BackupReader.canonicalHash(pretty)
                == BackupReader.canonicalHash(try BackupWriter.file(book(transactions: 1999), exportedAt: "different"))
        )
    }

    // MARK: - What a re-export does NOT preserve, pinned on purpose

    @Test("a required field that was absent comes back at the schema's default")
    func absentRequiredFieldsGainDefaults() throws {
        // The oracle's books omit colours and timestamps -- "a Swift port has
        // no obligation to have those columns" -- so a book decoded from one
        // and written out gains them. That is the current schema being written
        // in full, and it is the reason an oracle fixture is not a backup.
        let sparse = try JSONParser.parse("""
        {"id":"a","name":"A","type":"current","currency":"GBP","openingBalanceMinor":0,"groupId":null}
        """)
        let account = try Account(row: RowReader(sparse, context: "accounts[0]"))
        let written = try #require(BackupWriter.row(account).objectValue)
        #expect(written["colour"] == .string(""))
        #expect(written["sortOrder"] == .int(0))
        #expect(written["archived"] == .bool(false))
        // But nothing is INVENTED where the field is optional.
        #expect(written["excludeFromNetWorth"] == nil)
        #expect(written["loanRatePct"] == nil)
    }

    @Test("an optional field written as an explicit null comes back omitted")
    func explicitNullsInOptionalFieldsAreDropped() throws {
        // No build writes `"colour": null` -- the TypeScript's own type forbids
        // it -- but a hand-edited file could, and this is what would happen to
        // it. Pinned rather than discovered later by a hash that would not say
        // which field moved.
        let raw = try JSONParser.parse("""
        {"id":"c","name":"C","parentId":null,"kind":"expense","colour":null,"archived":false,"sortOrder":0}
        """)
        let category = try Category(row: RowReader(raw, context: "categories[0]"))
        let written = try #require(BackupWriter.row(category).objectValue)
        #expect(written["colour"] == nil, "null in, absent out")
        #expect(written["parentId"] == JSONValue.null, "a nullable field keeps its null")
    }
}
