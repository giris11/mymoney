// ONE net-worth rule going forward, and a version so that old files keep theirs.
//
// Net worth is computed in three places -- `Balances.netWorth` (the headline),
// `Reports.netWorthSeries` (the chart) and `Manifest.compute` (the file). They
// disagreed about WHEN to round: per account, or per currency. They now all sum
// per currency and convert once.
//
// The manifest is the one that could not simply be changed. An import
// recomputes it and REFUSES on a disagreement, so re-rounding the arithmetic
// would have made every backup already written unrestorable -- a data-loss bug
// introduced while fixing a cosmetic one. So the rule is carried by
// manifestVersion: v1 MEANS per-account and is frozen, v2 means per-currency
// and is what new exports write, and a file is always verified under the rule
// ITS OWN version names.
//
// WHY THIS FILE EXISTS SEPARATELY FROM BackupTests AND BalancesTests. Every
// other fixture in this package -- and every book in tools/oracle/cases -- has
// at most ONE counted account per currency, which is precisely the shape in
// which the two rules cannot disagree. Both suites stayed green through the
// entire defect, in both languages. A rule that only shows itself on one book
// shape needs a test of that shape, or the next port will reintroduce this on
// the same day it reintroduces the tests that missed it.
//
// THE FIXTURE IS THE TYPESCRIPT SUITE'S OWN, read out of the repository rather
// than copied in here (the same argument OracleTests makes for the oracle
// cases: a second copy is a copy that drifts). It was written by the build
// BEFORE the rule changed -- commit 732ff57's exportBackup(), against a seeded
// database, not hand-typed -- so it is real evidence of what a v1 file says and
// not a reconstruction of it. Its book is the smallest one where the two rules
// genuinely differ: two counted EUR accounts of 705 minor units each, one rate,
// EUR->GBP 0.85.
//
//     per account   round(705 x 0.85) x 2 = 599 + 599 = 1198   <- what it says
//     per currency  round(1410 x 0.85 = 1198.5)       = 1199   <- what v2 says
//
// One penny, and it is the whole point: if the version did not select the rule,
// restoring this file would be refused.
//
// Everything here is FABRICATED DATA in a public repository, so the figures are
// written out in full -- which is exactly what the frozen-file tests cannot do,
// and why both kinds of test exist.
import Foundation
import Testing

@testable import MyMoneyKit

struct ManifestVersionTests {

    // MARK: - The fixture

    /// The same file `tests/backup.test.ts` loads. Never written to, and never
    /// copied: if it moves, this test must break rather than quietly go on
    /// checking a stale duplicate.
    static let fixtureURL: URL = URL(fileURLWithPath: #filePath)
        .deletingLastPathComponent()   // .../native/Tests/MyMoneyKitTests
        .deletingLastPathComponent()   // .../native/Tests
        .deletingLastPathComponent()   // .../native
        .deletingLastPathComponent()   // the repository root
        .appendingPathComponent("tests/fixtures/backup-v1-with-manifest.json")

    static func fixtureText() throws -> String {
        try String(contentsOf: fixtureURL, encoding: .utf8)
    }

    static let perAccountTotal: Int64 = 1198
    static let perCurrencyTotal: Int64 = 1199

    /// The fixture, imported, with the manifest source its rows produce.
    struct Loaded {
        let imported: ImportedBackup
        let claimed: BackupManifest
        let source: ManifestSource

        /// The manifest these rows produce under the named rule. Everything
        /// except the rule is held constant, so any difference between two
        /// calls is the rule and nothing else.
        func manifest(_ rule: NetWorthRule) throws -> BackupManifest {
            try Manifest.compute(
                source,
                schemaVersion: claimed.schemaVersion,
                exportedAt: claimed.exportedAt,
                baseCurrency: "GBP",
                netWorthRule: rule
            )
        }
    }

    static func load() throws -> Loaded {
        let imported = try BackupImporter.load(text: try fixtureText())
        let claimed = try #require(imported.claimedManifest)
        return Loaded(
            imported: imported,
            claimed: claimed,
            source: try BackupImporter.manifestSource(file: imported.file, book: imported.book)
        )
    }

    // MARK: - The mapping itself

    @Test("the version of a manifest is what selects its net-worth rule")
    func versionSelectsTheRule() {
        #expect(Manifest.netWorthRule(forVersion: 1) == .perAccount)
        #expect(Manifest.netWorthRule(forVersion: 2) == .perCurrency)
        // A version this build has never heard of has no rule -- and saying so
        // is what lets `isCheckable` refuse to check it instead of guessing.
        #expect(Manifest.netWorthRule(forVersion: Manifest.version + 1) == nil)
        #expect(Manifest.netWorthRule(forVersion: 0) == nil)
        #expect(Manifest.netWorthRule(forVersion: -1) == nil)

        // The pairing is what keeps a file honest about its own arithmetic.
        #expect(Manifest.version(forNetWorthRule: .perAccount) == 1)
        #expect(Manifest.version(forNetWorthRule: .perCurrency) == 2)
        #expect(Manifest.version(forNetWorthRule: Manifest.currentNetWorthRule) == Manifest.version)

        // And every rule this build can name maps to a version that maps back.
        for rule in NetWorthRule.allCases {
            #expect(Manifest.netWorthRule(forVersion: Manifest.version(forNetWorthRule: rule)) == rule)
        }
    }

    @Test("a manifest whose version has no known rule is refused, not guessed at")
    func unknownVersionThrowsRatherThanDefaulting() throws {
        let future = BackupManifest(
            manifestVersion: 99, schemaVersion: 1, exportedAt: "2026-08-28T09:15:00.000Z",
            rowCounts: [:], accounts: [],
            netWorth: ManifestNetWorth(
                baseCurrency: "GBP", totalMinor: 0, rates: [], missingRateCurrencies: []
            )
        )
        #expect(throws: BackupImportError.self) {
            _ = try Manifest.netWorthRule(of: future)
        }
        // The alternative to throwing is verifying under whichever rule the
        // fallback happened to be, and calling the result verified.
        #expect(Manifest.netWorthRule(forVersion: 99) == nil)
    }

    // MARK: - The two rules, on the same rows

    @Test("the same rows give 1198 under the v1 rule and 1199 under the v2 rule")
    func theTwoRulesDisagreeByAPenny() throws {
        let loaded = try Self.load()
        let perAccount = try loaded.manifest(.perAccount)
        let perCurrency = try loaded.manifest(.perCurrency)

        #expect(perAccount.netWorth.totalMinor == Self.perAccountTotal)
        #expect(perCurrency.netWorth.totalMinor == Self.perCurrencyTotal)
        // The version is stamped FROM the rule, so a file cannot claim one
        // version while holding the other's arithmetic.
        #expect(perAccount.manifestVersion == 1)
        #expect(perCurrency.manifestVersion == 2)
    }

    @Test("the rule changes that one integer and nothing else")
    func theRuleChangesOnlyTheTotal() throws {
        let loaded = try Self.load()
        // The rule chooses when to round a TOTAL. Every other figure is a fact
        // about the rows -- including each account's own closing balance, which
        // is a per-account figure and legitimately rounds per account -- and the
        // rates applied and the currencies with none are facts about the book.
        func blanked(_ m: BackupManifest) -> BackupManifest {
            BackupManifest(
                manifestVersion: 0, schemaVersion: m.schemaVersion, exportedAt: m.exportedAt,
                rowCounts: m.rowCounts, accounts: m.accounts,
                netWorth: ManifestNetWorth(
                    baseCurrency: m.netWorth.baseCurrency,
                    totalMinor: 0,
                    rates: m.netWorth.rates,
                    missingRateCurrencies: m.netWorth.missingRateCurrencies
                )
            )
        }
        #expect(blanked(try loaded.manifest(.perAccount)) == blanked(try loaded.manifest(.perCurrency)))
        // Stated positively as well, because `==` over a struct is easy to
        // weaken by accident: both rules see both accounts, at their real
        // closing balances, and both name the one rate they went through.
        let perCurrency = try loaded.manifest(.perCurrency)
        #expect(perCurrency.accounts.map(\.closingBalanceMinor) == [705, 705])
        #expect(perCurrency.accounts.map(\.counted) == [true, true])
        #expect(perCurrency.netWorth.rates.map(\.from) == ["EUR"])
        #expect(perCurrency.netWorth.missingRateCurrencies.isEmpty)
    }

    // MARK: - What the versioning is FOR

    @Test("a v1 file is held to the v1 rule -- the check that keeps it restorable")
    func aV1FileIsCheckedTheV1Way() throws {
        let loaded = try Self.load()
        #expect(loaded.claimed.manifestVersion == 1)
        #expect(loaded.claimed.netWorth.totalMinor == Self.perAccountTotal)

        let byItsOwnVersion = try loaded.manifest(Manifest.netWorthRule(of: loaded.claimed))
        #expect(Manifest.compare(claimed: loaded.claimed, recomputed: byItsOwnVersion).isEmpty)
    }

    @Test("the same file would be REFUSED if the current rule were applied to it")
    func theNaiveChangeWouldHaveRefusedIt() throws {
        // This is the data-loss bug the versioning exists to prevent, spelled
        // out: the naive change turns every backup Girish holds into this
        // message. The wording is the TypeScript's, character for character --
        // one file format, one refusal, whichever build is reading.
        let loaded = try Self.load()
        let naive = try loaded.manifest(Manifest.currentNetWorthRule)
        #expect(
            Manifest.compare(claimed: loaded.claimed, recomputed: naive)
                == ["net worth is \u{00A3}11.99, but the backup says \u{00A3}11.98"]
        )
    }

    @Test("the importer picks the rule off the file it is reading, without being told")
    func theImporterSelectsTheRuleItself() throws {
        // The end-to-end statement: no test scaffolding chooses the rule here,
        // the file does. A build that recomputed this the current way would
        // throw `manifestDisagrees` out of this call.
        let imported = try BackupImporter.load(text: try Self.fixtureText())
        #expect(imported.verified)
        #expect(imported.recomputedManifest == imported.claimedManifest)
        #expect(imported.recomputedManifest?.manifestVersion == 1)
        #expect(imported.recomputedManifest?.netWorth.totalMinor == Self.perAccountTotal)
        // ...while the app's own headline figure for the very same book is the
        // per-currency one. Both numbers are right; the version is what says
        // which question each answers.
        #expect(try imported.book.netWorth().totalBaseMinor == Self.perCurrencyTotal)
    }

    @Test("a version this build has never heard of loads unverified rather than refusing")
    func anUnknownVersionLoadsButIsNotChecked() throws {
        let text = try Self.fixtureText()
            .replacingOccurrences(of: "\"manifestVersion\": 1", with: "\"manifestVersion\": 99")
        #expect(text.contains("\"manifestVersion\": 99"), "the fixture's spelling must still match")
        let imported = try BackupImporter.load(text: text)
        // Refusing would turn a forward-compatible file into an unrestorable
        // one, which is the worse failure. The rows are validated either way.
        #expect(!imported.verified)
        #expect(imported.claimedManifest == nil)
        #expect(imported.book.accounts.count == 2)
    }

    // MARK: - Writing

    @Test("a v1 file re-exports byte for byte under its own rule, and as v2 by default")
    func writingUnderEachRule() throws {
        let loaded = try Self.load()
        let book = loaded.imported.book

        // 1. UNDER THE FILE'S OWN RULE: the same bytes, back out. This is the
        //    mechanism the frozen-data gate depends on, in miniature and with
        //    figures a reader can check by hand.
        let asV1 = try BackupWriter.file(
            book, exportedAt: loaded.imported.file.exportedAt,
            schemaVersion: loaded.imported.file.schemaVersion,
            netWorthRule: Manifest.netWorthRule(of: loaded.claimed)
        )
        #expect(asV1["manifest"]?["manifestVersion"] == .int(1))
        #expect(asV1["manifest"]?["netWorth"]?["totalMinor"] == .int(Int64(Self.perAccountTotal)))
        // Field by field first, so a failure NAMES what diverged instead of
        // saying that something did.
        let onDisk = try Self.fixtureText()
        let differences = JSONDiff.differences(want: try JSONParser.parse(onDisk), got: asV1)
        #expect(differences.isEmpty, "\(JSONDiff.report(differences))")
        // Then to the byte. The file on disk ends with a newline that
        // `serializeBackup` does not write -- it was added when the fixture was
        // saved into the repository, and the TypeScript test never sees it
        // because it parses the text before looking. Everything before it has
        // to match exactly, which is the actual claim: this writer reproduces a
        // file the OTHER implementation wrote, character for character.
        #expect(onDisk.hasSuffix("}\n"), "the fixture's one trailing newline")
        #expect(BackupWriter.serialise(asV1) + "\n" == onDisk)

        // 2. BY DEFAULT: this build writes v2, and the total moves by the penny
        //    the rule change is made of. A figure that moves across a round trip
        //    looks exactly like corruption, which is why the version sits beside
        //    it saying which of the two it is.
        let asWritten = try BackupWriter.file(
            book, exportedAt: loaded.imported.file.exportedAt,
            schemaVersion: loaded.imported.file.schemaVersion
        )
        #expect(asWritten["manifest"]?["manifestVersion"] == .int(Int64(Manifest.version)))
        #expect(asWritten["manifest"]?["netWorth"]?["totalMinor"] == .int(Int64(Self.perCurrencyTotal)))
        // Every other figure in the file is untouched by the upgrade.
        #expect(asWritten["tables"] == asV1["tables"])
        // And the file it wrote is one an importer accepts -- checked against
        // the v2 rule this time, because that is what it now says it is.
        let again = try BackupImporter.load(text: BackupWriter.serialise(asWritten))
        #expect(again.verified)
        #expect(again.claimedManifest?.manifestVersion == 2)
        #expect(again.recomputedManifest?.netWorth.totalMinor == Self.perCurrencyTotal)
    }

    // MARK: - The headline figure, which is where the penny is visible

    @Test("the headline total sums per currency and converts once")
    func headlineRoundsPerCurrency() throws {
        let rates = RateTable([FXRateRow(base: "EUR", quote: "GBP", rate: 0.85)])
        let accounts = [
            Account(id: "eur-a", name: "Euro Pot A", type: .savings, currency: "EUR",
                    openingBalanceMinor: 705, sortOrder: 0),
            Account(id: "eur-b", name: "Euro Pot B", type: .savings, currency: "EUR",
                    openingBalanceMinor: 705, sortOrder: 1),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: rates)

        // 1410 x 0.85 = 1198.5 -> 1199. Converting each account first gives
        // 599 + 599 = 1198, and that is the answer this used to produce.
        #expect(netWorth.totalBaseMinor == Self.perCurrencyTotal)
        // The balances themselves are untouched: a balance is never converted.
        #expect(balances.map(\.balanceMinor) == [705, 705])
    }

    @Test("the NOT-COUNTED total rounds per currency too")
    func excludedTotalRoundsPerCurrency() throws {
        // The excluded figure sits on screen directly beside the headline. Two
        // totals in one place, rounded two different ways, is the same defect
        // wearing different clothes -- so it follows the same rule.
        let rates = RateTable([FXRateRow(base: "EUR", quote: "GBP", rate: 0.85)])
        let accounts = [
            Account(id: "gbp", name: "Current", type: .current, currency: "GBP",
                    openingBalanceMinor: 100_000, sortOrder: 0),
            Account(id: "eur-a", name: "Gift card A", type: .savings, currency: "EUR",
                    openingBalanceMinor: 705, sortOrder: 1, excludeFromNetWorth: true),
            Account(id: "eur-b", name: "Gift card B", type: .savings, currency: "EUR",
                    openingBalanceMinor: 705, sortOrder: 2, excludeFromNetWorth: true),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: rates)

        #expect(netWorth.totalBaseMinor == 100_000)
        #expect(netWorth.excludedCount == 2)
        #expect(netWorth.excludedBaseMinor == Self.perCurrencyTotal)
    }

    @Test("a currency with no rate is named once, and neither total guesses at it")
    func missingRatesAreUnchangedByTheRule() throws {
        // The rule chooses when to round, never what to include. Two counted
        // accounts in a currency with no rate are still one named currency and
        // still nothing added to the total.
        let accounts = [
            Account(id: "gbp", name: "Current", type: .current, currency: "GBP",
                    openingBalanceMinor: 100_000, sortOrder: 0),
            Account(id: "chf-a", name: "Swiss A", type: .savings, currency: "CHF",
                    openingBalanceMinor: 705, sortOrder: 1),
            Account(id: "chf-b", name: "Swiss B", type: .savings, currency: "CHF",
                    openingBalanceMinor: 705, sortOrder: 2),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)

        #expect(netWorth.totalBaseMinor == 100_000)
        #expect(netWorth.missingRateCurrencies == ["CHF"])
        #expect(netWorth.excludedBaseMinor == 0)
    }
}
