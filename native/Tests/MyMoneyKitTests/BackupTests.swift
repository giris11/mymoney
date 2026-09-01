// Reading a backup, and refusing one.
//
// The fixture below is FABRICATED, in the same spirit as tools/oracle/cases and
// tests/fixtures: four invented accounts, three invented transactions, figures
// small enough to check by hand. No real account, payee or amount appears in
// this repository, ever.
//
// EVERY EXPECTED FIGURE HERE WAS CALCULATED BY HAND, and the arithmetic is
// written out where it is used, so a failure can be argued with rather than
// merely re-recorded:
//
//   a-cur  GBP  100000 - 4567 - 5433              = 90000   (cleared: 95433)
//   a-eur  EUR   20000 - 2000                     = 18000
//   a-old  GBP  500000, archived                  = 500000  (not counted)
//   a-gift GBP   25000, excludeFromNetWorth       =  25000  (not counted)
//   net worth = 90000 + round(18000 * 0.85)       = 90000 + 15300 = 105300
import Foundation
import Testing

@testable import MyMoneyKit

struct BackupTests {

    static let exportedAt = "2026-09-01T12:00:00.000Z"

    /// A complete, self-consistent backup with a manifest that is true.
    static let validBackup = """
    {
      "app": "MyMoney",
      "schemaVersion": 1,
      "exportedAt": "\(exportedAt)",
      "manifest": {
        "manifestVersion": 1,
        "schemaVersion": 1,
        "exportedAt": "\(exportedAt)",
        "rowCounts": {
          "accounts": 4, "accountGroups": 0, "transactions": 3, "categories": 0,
          "payees": 0, "tags": 0, "budgets": 0, "fxRates": 1, "importBatches": 0,
          "settings": 1
        },
        "accounts": [
          {"id":"a-cur","name":"Current","currency":"GBP","closingBalanceMinor":90000,"txCount":2,"counted":true},
          {"id":"a-eur","name":"Euro Pot","currency":"EUR","closingBalanceMinor":18000,"txCount":1,"counted":true},
          {"id":"a-gift","name":"Gift Cards","currency":"GBP","closingBalanceMinor":25000,"txCount":0,"counted":false},
          {"id":"a-old","name":"Old ISA","currency":"GBP","closingBalanceMinor":500000,"txCount":0,"counted":false}
        ],
        "netWorth": {
          "baseCurrency": "GBP",
          "totalMinor": 105300,
          "rates": [{"from":"EUR","to":"GBP","rate":0.85}],
          "missingRateCurrencies": []
        }
      },
      "tables": {
        "accounts": [
          {"id":"a-cur","name":"Current","type":"current","currency":"GBP","openingBalanceMinor":100000,"colour":"#111111","groupId":null,"sortOrder":0,"archived":false},
          {"id":"a-eur","name":"Euro Pot","type":"savings","currency":"EUR","openingBalanceMinor":20000,"colour":"#222222","groupId":null,"sortOrder":1,"archived":false},
          {"id":"a-gift","name":"Gift Cards","type":"cash","currency":"GBP","openingBalanceMinor":25000,"colour":"#333333","groupId":null,"sortOrder":3,"archived":false,"excludeFromNetWorth":true},
          {"id":"a-old","name":"Old ISA","type":"savings","currency":"GBP","openingBalanceMinor":500000,"colour":"#444444","groupId":null,"sortOrder":2,"archived":true}
        ],
        "accountGroups": [],
        "transactions": [
          {"id":"t1","accountId":"a-cur","date":"2026-08-03","amountMinor":-4567,"currency":"GBP","payeeId":null,"categoryId":null,"tagIds":[],"notes":"","status":"cleared","splits":[],"transferGroupId":null,"importBatchId":null,"dedupeHash":"h1","createdAt":"2026-08-03T00:00:00.000Z","updatedAt":"2026-08-03T00:00:00.000Z"},
          {"id":"t2","accountId":"a-cur","date":"2026-08-10","amountMinor":-5433,"currency":"GBP","payeeId":null,"categoryId":null,"tagIds":[],"notes":"","status":"pending","splits":[],"transferGroupId":null,"importBatchId":null,"dedupeHash":"h2","createdAt":"2026-08-10T00:00:00.000Z","updatedAt":"2026-08-10T00:00:00.000Z"},
          {"id":"t3","accountId":"a-eur","date":"2026-08-22","amountMinor":-2000,"currency":"EUR","payeeId":null,"categoryId":null,"tagIds":[],"notes":"","status":"cleared","splits":[],"transferGroupId":null,"importBatchId":null,"dedupeHash":"h3","createdAt":"2026-08-22T00:00:00.000Z","updatedAt":"2026-08-22T00:00:00.000Z"}
        ],
        "categories": [],
        "payees": [],
        "tags": [],
        "budgets": [],
        "fxRates": [
          {"id":"EUR:GBP","base":"EUR","quote":"GBP","rate":0.85,"asOf":"2026-01-01T00:00:00.000Z","source":"manual"}
        ],
        "importBatches": [],
        "settings": [
          {"id":"app","schemaVersion":1,"baseCurrency":"GBP","theme":"system","lastBackupAt":null,"onboarded":true,"lastUsedAccountId":null,"savedMappings":{},"createdAt":"2026-01-01T00:00:00.000Z","autoFxEnabled":false,"lastFxSyncAt":null,"lastFxSyncSource":null,"syncEnabled":false,"syncDeviceId":"","syncDeviceName":"","syncClientId":null,"syncLastSyncedAt":null,"syncLastPulledRevision":0,"syncLastPulledSnapshotId":null,"syncAncestry":[],"syncLocalRevision":0,"syncSyncedLocalRevision":0}
        ]
      }
    }
    """

    // MARK: - The happy path

    @Test("a self-consistent backup loads, proves itself, and reproduces the figures")
    func validBackupLoads() throws {
        let imported = try BackupImporter.load(text: Self.validBackup)
        #expect(imported.verified)
        #expect(imported.warnings.isEmpty)
        #expect(imported.book.accounts.count == 4)
        #expect(imported.book.transactions.count == 3)
        #expect(imported.book.baseCurrency == "GBP")

        let balances = try imported.book.accountBalances()
        // Ordered by sortOrder, so a-old (2) comes before a-gift (3).
        #expect(balances.map(\.account.id) == ["a-cur", "a-eur", "a-old", "a-gift"])
        #expect(balances[0].balanceMinor == 90000)
        #expect(balances[0].clearedMinor == 95433)   // the pending 5433 is out
        #expect(balances[0].txCount == 2)
        #expect(balances[1].balanceMinor == 18000)   // EUR, and NOT converted
        #expect(balances[2].balanceMinor == 500000)  // archived, real balance kept
        #expect(balances[3].balanceMinor == 25000)   // excluded, real balance kept

        let netWorth = try imported.book.netWorth()
        #expect(netWorth.totalBaseMinor == 105_300)
        #expect(netWorth.baseCurrency == "GBP")
        #expect(netWorth.missingRateCurrencies.isEmpty)
        #expect(netWorth.excludedCount == 1)         // a-old is archived, not "excluded"
        #expect(netWorth.excludedBaseMinor == 25000)

        // And the recomputation agrees with the claim, field for field.
        #expect(imported.recomputedManifest == imported.claimedManifest)
        #expect(imported.recomputedManifest?.netWorth.totalMinor == 105_300)
        #expect(imported.recomputedManifest?.accounts.map(\.id) == ["a-cur", "a-eur", "a-gift", "a-old"])
    }

    @Test("a file with no manifest still loads, and says it cannot prove itself")
    func manifestIsOptional() throws {
        // Every backup written before the manifest existed has none, and so
        // does every sync snapshot. Absent means unverified, never invalid.
        let text = try tamper(Self.validBackup) { $0.removeValue(forKey: "manifest") }
        let imported = try BackupImporter.load(text: text)
        #expect(!imported.verified)
        #expect(imported.claimedManifest == nil)
        #expect(try imported.book.netWorth().totalBaseMinor == 105_300)
    }

    @Test("a manifest from a future format is not judged, and does not block the restore")
    func unknownManifestVersionIsNotChecked() throws {
        let text = Self.validBackup.replacingOccurrences(
            of: "\"manifestVersion\": 1", with: "\"manifestVersion\": 99"
        )
        let imported = try BackupImporter.load(text: text)
        // Refusing here would turn a forward-compatible file into an
        // unrestorable one, which is a worse failure than an unverified restore
        // that admits it is unverified.
        #expect(!imported.verified)
    }

    // MARK: - Refusals: the file disagrees with itself

    @Test("an altered amount is caught, and the account is named")
    func alteredAmountIsRefused() throws {
        // One penny, in one transaction, out of three.
        let text = Self.validBackup.replacingOccurrences(
            of: "\"amountMinor\":-4567", with: "\"amountMinor\":-4568"
        )
        let problems = try problemsFromLoading(text)
        // TWO findings, and both are worth having: the account whose balance
        // moved, named by the owner's own name for it, and the headline figure
        // that moved with it. Reporting only the total would leave him hunting
        // 5,127 rows for the penny.
        #expect(problems.count == 2)
        #expect(problems.contains { $0.contains("Current") && $0.contains("899.99") && $0.contains("900.00") })
        #expect(problems.contains { $0.contains("net worth is") })
    }

    @Test("a deleted row is caught by both the row count and the balance")
    func deletedRowIsRefused() throws {
        let text = try tamper(Self.validBackup) { file in
            guard var tables = file["tables"]?.objectValue,
                  var transactions = tables["transactions"]?.arrayValue else { return }
            transactions.removeLast()
            tables["transactions"] = .array(transactions)
            file["tables"] = .object(tables)
        }
        let problems = try problemsFromLoading(text)
        #expect(problems.contains { $0.contains("transactions") && $0.contains("2 rows") })
        #expect(problems.contains { $0.contains("Euro Pot") })
    }

    @Test("an account renamed since the backup is caught")
    func renamedAccountIsRefused() throws {
        let text = try tamperAccount(Self.validBackup, id: "a-cur") { row in
            row["name"] = .string("Everyday")
        }
        let problems = try problemsFromLoading(text)
        #expect(problems.contains { $0.contains("Everyday") })
    }

    @Test("an account that has stopped counting toward net worth is caught")
    func changedExclusionIsRefused() throws {
        let text = try tamperAccount(Self.validBackup, id: "a-eur") { row in
            row["archived"] = .bool(true)
        }
        let problems = try problemsFromLoading(text)
        #expect(problems.contains { $0.contains("no longer counts toward net worth") })
        // ...and the net worth itself has moved, which is the consequence that
        // matters.
        #expect(problems.contains { $0.contains("net worth is") })
    }

    @Test("a changed FX rate is caught, because the manifest records the rate it used")
    func changedRateIsRefused() throws {
        let text = Self.validBackup.replacingOccurrences(
            of: "\"rate\":0.85,\"asOf\"", with: "\"rate\":0.9,\"asOf\""
        )
        let problems = try problemsFromLoading(text)
        #expect(problems.contains { $0.contains("exchange rates used") })
        #expect(problems.contains { $0.contains("net worth is") })
    }

    // MARK: - Refusals: the file is not a backup

    @Test("a file from a newer build is refused, and says so in the owner's terms")
    func newerSchemaIsRefused() throws {
        let text = try tamper(Self.validBackup) { file in
            file["schemaVersion"] = .int(2)
            file.removeValue(forKey: "manifest")   // it would be a mismatch too
        }
        // Reading it with this build's assumptions is how a restore produces
        // plausible wrong numbers instead of an error.
        let message = try messageFromLoading(text)
        #expect(message.contains("newer version"))
        #expect(message.contains("Update the app"))
    }

    @Test("anything that is not a MyMoney backup is refused before it is read")
    func notABackup() throws {
        for (text, expected) in [
            ("[]", "expected a JSON object"),
            ("{}", "\"app\" field"),
            (#"{"app":"SomethingElse"}"#, "\"app\" field"),
            (#"{"app":"MyMoney","schemaVersion":"one"}"#, "positive integer"),
            (#"{"app":"MyMoney","schemaVersion":1}"#, "\"exportedAt\""),
            (#"{"app":"MyMoney","schemaVersion":1,"exportedAt":"x"}"#, "\"tables\""),
            (#"{"app":"MyMoney","schemaVersion":1,"exportedAt":"x","tables":{}}"#, "accounts\" is missing"),
        ] {
            #expect(try messageFromLoading(text).contains(expected), "\(text)")
        }
    }

    @Test("a row without an id, and a settings row with the wrong id, are refused")
    func rowSanity() throws {
        let noId = Self.validBackup.replacingOccurrences(
            of: "{\"id\":\"t1\",", with: "{\"identifier\":\"t1\","
        )
        #expect(try messageFromLoading(noId).contains("transactions[0] has no string \"id\""))

        let wrongSettingsId = Self.validBackup.replacingOccurrences(
            of: "{\"id\":\"app\",\"schemaVersion\"", with: "{\"id\":\"settings\",\"schemaVersion\""
        )
        #expect(try messageFromLoading(wrongSettingsId).contains("must have id \"app\""))
    }

    @Test("a manifest describing a different file is corruption, however plausible it looks")
    func manifestMustDescribeItsOwnFile() throws {
        let wrongTime = try tamperManifest(Self.validBackup) { manifest in
            manifest["exportedAt"] = .string("2026-08-30T00:00:00.000Z")
        }
        #expect(try messageFromLoading(wrongTime).contains("taken at a different time"))

        let wrongSchema = try tamperManifest(Self.validBackup) { manifest in
            manifest["schemaVersion"] = .int(7)
        }
        #expect(try messageFromLoading(wrongSchema).contains("manifest describes schema 7"))
    }

    @Test("a malformed manifest is caught before any row is accepted")
    func malformedManifest() throws {
        let noCounts = try tamperManifest(Self.validBackup) { manifest in
            manifest.removeValue(forKey: "rowCounts")
        }
        #expect(try messageFromLoading(noCounts).contains("no row counts"))

        let badRate = try tamperManifest(Self.validBackup) { manifest in
            manifest["netWorth"] = .object([
                "baseCurrency": .string("GBP"),
                "totalMinor": .int(105_300),
                "rates": .array([.object([
                    "from": .string("EUR"), "to": .string("GBP"), "rate": .double(0),
                ])]),
                "missingRateCurrencies": .array([]),
            ])
        }
        #expect(try messageFromLoading(badRate).contains("unusable exchange rate"))

        let noAccounts = try tamperManifest(Self.validBackup) { manifest in
            manifest.removeValue(forKey: "accounts")
        }
        #expect(try messageFromLoading(noAccounts).contains("no account list"))
    }

    @Test("a settings row with no base currency falls back rather than being refused")
    func blankBaseCurrencyFallsBack() throws {
        // src/backup/manifest.ts treats a missing OR EMPTY baseCurrency as "not
        // stated" (JavaScript's `||`, where "" is falsy). Refusing such a file
        // here would make something the web app can still restore unreadable on
        // the phone, and an unreadable backup is a lost backup.
        let text = try tamper(Self.validBackup) { file in
            guard var tables = file["tables"]?.objectValue,
                  var settings = tables["settings"]?.arrayValue,
                  var row = settings[0].objectValue else { return }
            row["baseCurrency"] = .string("")
            settings[0] = .object(row)
            tables["settings"] = .array(settings)
            file["tables"] = .object(tables)
        }
        let imported = try BackupImporter.load(text: text)
        // The manifest still names GBP, and the check is done in the currency
        // the file named rather than refused over a blank the file left.
        #expect(imported.verified)
        #expect(imported.book.baseCurrency == "GBP")
    }

    // MARK: - The content fingerprint

    @Test("the fingerprint ignores when the backup was taken, at both places it appears")
    func hashIgnoresTheTimestamp() throws {
        let later = Self.validBackup.replacingOccurrences(
            of: Self.exportedAt, with: "2027-01-01T00:00:00.000Z"
        )
        let a = try BackupImporter.load(text: Self.validBackup)
        let b = try BackupImporter.load(text: later)
        #expect(a.contentHash == b.contentHash)
        #expect(a.contentHash.count == 64)
    }

    @Test("the fingerprint notices one penny")
    func hashNoticesAPenny() throws {
        // The claim the whole manifest exists to support: two exports of an
        // unchanged book fingerprint identically, and a book that has changed
        // by a penny does not.
        let tampered = Self.validBackup
            .replacingOccurrences(of: "\"amountMinor\":-4567", with: "\"amountMinor\":-4568")
            .replacingOccurrences(of: "\"closingBalanceMinor\":90000", with: "\"closingBalanceMinor\":89999")
            .replacingOccurrences(of: "\"totalMinor\": 105300", with: "\"totalMinor\": 105299")
        let a = try BackupImporter.load(text: Self.validBackup)
        let b = try BackupImporter.load(text: tampered)   // internally consistent again
        #expect(a.contentHash != b.contentHash)
    }

    @Test("the fingerprint is over the content, not the bytes: key order and whitespace do not count")
    func hashIsOverContentNotBytes() throws {
        // The same document, re-emitted pretty-printed with every key in a
        // different order, must fingerprint identically -- otherwise a Swift
        // export could never match a browser export of the same book.
        let parsed = try JSONParser.parse(Self.validBackup)
        let reserialised = CanonicalJSON.text(parsed, indent: 2)
        #expect(reserialised != Self.validBackup)
        #expect(
            BackupReader.canonicalHash(parsed)
                == BackupReader.canonicalHash(try JSONParser.parse(reserialised))
        )
    }

    @Test("what the fingerprint covers can be inspected rather than trusted")
    func contentForHashIsInspectable() throws {
        let content = BackupReader.contentForHash(try JSONParser.parse(Self.validBackup))
        #expect(content["exportedAt"] == nil)
        #expect(content["manifest"]?["exportedAt"] == nil)
        // Everything else is still there -- including the settings row, whose
        // device-local half is deliberately part of the fingerprint.
        #expect(content["manifest"]?["netWorth"]?["totalMinor"] == .int(105_300))
        #expect(content["tables"]?["settings"]?[0]?["baseCurrency"] == .string("GBP"))
    }

    // MARK: - Amounts a browser could not hold

    @Test("an amount past 2^53 loads, and is named in a warning rather than hidden")
    func amountsBeyondTheBrowsersRangeAreFlagged() throws {
        // Not grounds for refusal -- refusing would itself be a way to lose
        // data -- but the owner's web build would corrupt this number on
        // restore, and that has to be said out loud.
        let text = try tamper(Self.validBackup) { file in
            file.removeValue(forKey: "manifest")
            guard var tables = file["tables"]?.objectValue,
                  var accounts = tables["accounts"]?.arrayValue,
                  var first = accounts[0].objectValue else { return }
            first["openingBalanceMinor"] = .int(9_007_199_254_740_993)
            accounts[0] = .object(first)
            tables["accounts"] = .array(accounts)
            file["tables"] = .object(tables)
        }
        let imported = try BackupImporter.load(text: text)
        #expect(imported.warnings.count == 1)
        #expect(imported.warnings[0].contains("accounts[0].openingBalanceMinor"))
        #expect(imported.warnings[0].contains("9007199254740993"))
        // And the value itself survived intact, which is the point.
        #expect(imported.book.accounts.first { $0.id == "a-cur" }?.openingBalanceMinor
            == 9_007_199_254_740_993)
    }

    @Test("two rows with the same id are corruption, and are refused")
    func duplicateIdsAreRefused() throws {
        // The TypeScript restore leans on Dexie's bulkAdd (not bulkPut) to
        // reject this -- "abort, don't mask". A reader with no database would
        // otherwise be the one component that silently accepted two versions of
        // the same account and quietly picked one of them.
        let text = try tamper(Self.validBackup) { file in
            file.removeValue(forKey: "manifest")
            guard var tables = file["tables"]?.objectValue,
                  var accounts = tables["accounts"]?.arrayValue else { return }
            accounts.append(accounts[0])
            tables["accounts"] = .array(accounts)
            file["tables"] = .object(tables)
        }
        #expect(try messageFromLoading(text).contains("two rows with id \"a-cur\""))
    }

    @Test("splits that do not sum to their parent are reported, and do not block the restore")
    func splitsThatDoNotSumAreReported() throws {
        // SPEC 6 says splits must sum EXACTLY to the parent, and the WRITE path
        // is where that is enforced. Refusing to read such a file would mean an
        // owner whose data already contains one bad row could no longer restore
        // any of it -- a one-transaction problem turned into a total loss.
        let text = try tamper(Self.validBackup) { file in
            file.removeValue(forKey: "manifest")
            guard var tables = file["tables"]?.objectValue,
                  var transactions = tables["transactions"]?.arrayValue,
                  var first = transactions[0].objectValue else { return }
            // -4567 split into -4000 and -566: one penny short.
            first["splits"] = .array([
                .object(["categoryId": .string("c1"), "amountMinor": .int(-4000)]),
                .object(["categoryId": .string("c2"), "amountMinor": .int(-566)]),
            ])
            transactions[0] = .object(first)
            tables["transactions"] = .array(transactions)
            file["tables"] = .object(tables)
        }
        let imported = try BackupImporter.load(text: text)
        #expect(imported.warnings.count == 1)
        #expect(imported.warnings[0].contains("transaction t1"))
        #expect(imported.warnings[0].contains("-45.66"))   // what the splits say
        #expect(imported.warnings[0].contains("-45.67"))   // what the transaction says
        // The book still loaded, and the transaction's own amount is untouched.
        #expect(imported.book.transactions[0].amountMinor == -4567)
        #expect(try imported.book.transactions[0].validateSplits() == false)
    }

    @Test("splits that DO sum raise nothing")
    func correctSplitsAreSilent() throws {
        let text = try tamper(Self.validBackup) { file in
            file.removeValue(forKey: "manifest")
            guard var tables = file["tables"]?.objectValue,
                  var transactions = tables["transactions"]?.arrayValue,
                  var first = transactions[0].objectValue else { return }
            first["splits"] = .array([
                .object(["categoryId": .string("c1"), "amountMinor": .int(-4000)]),
                .object(["categoryId": .string("c2"), "amountMinor": .int(-567)]),
            ])
            transactions[0] = .object(first)
            tables["transactions"] = .array(transactions)
            file["tables"] = .object(tables)
        }
        let imported = try BackupImporter.load(text: text)
        #expect(imported.warnings.isEmpty)
        #expect(try imported.book.transactions[0].validateSplits())
    }

    // MARK: - Helpers

    /// Edit the parsed document, then re-serialise it. Used where a string
    /// replacement would be too blunt to be readable.
    func tamper(_ text: String, _ edit: (inout [String: JSONValue]) -> Void) throws -> String {
        guard var members = try JSONParser.parse(text).objectValue else { return text }
        edit(&members)
        return CanonicalJSON.text(.object(members), indent: 2)
    }

    func tamperManifest(_ text: String, _ edit: (inout [String: JSONValue]) -> Void) throws -> String {
        try tamper(text) { file in
            guard var manifest = file["manifest"]?.objectValue else { return }
            edit(&manifest)
            file["manifest"] = .object(manifest)
        }
    }

    func tamperAccount(
        _ text: String, id: String, _ edit: (inout [String: JSONValue]) -> Void
    ) throws -> String {
        try tamper(text) { file in
            guard var tables = file["tables"]?.objectValue,
                  var accounts = tables["accounts"]?.arrayValue else { return }
            for (index, account) in accounts.enumerated() {
                guard var row = account.objectValue, row["id"] == .string(id) else { continue }
                edit(&row)
                accounts[index] = .object(row)
            }
            tables["accounts"] = .array(accounts)
            file["tables"] = .object(tables)
        }
    }

    func problemsFromLoading(_ text: String) throws -> [String] {
        do {
            _ = try BackupImporter.load(text: text)
            Issue.record("should have been refused")
            return []
        } catch BackupImportError.manifestDisagrees(let problems) {
            return problems
        }
    }

    func messageFromLoading(_ text: String) throws -> String {
        do {
            _ = try BackupImporter.load(text: text)
            Issue.record("should have been refused")
            return ""
        } catch let error as BackupImportError {
            return error.description
        }
    }
}
