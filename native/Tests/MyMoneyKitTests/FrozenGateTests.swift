// THE PHASE 2 GATE.
//
// One test, three questions, and it either passes or it does not:
//
//   1. Read the frozen export of the owner's real book and recompute EVERY
//      account's closing balance from the transaction rows -- not from the
//      manifest -- and check all of them against what the file says they are.
//   2. Recompute the net worth the same way, from the balances and the rates
//      the file carries, and check it against the file's own figure -- under
//      the arithmetic THE FILE'S OWN MANIFEST VERSION names (v1 rounds per
//      account, v2 per currency), never under whichever rule this build
//      happens to prefer today. A build that recomputed an old file the new
//      way would refuse a backup that is perfectly sound, and refusing a sound
//      backup is the one failure this whole subsystem exists to prevent.
//   3. Throw the parsed document away, write the file BACK OUT of the decoded
//      Swift records, and check that the canonical content hash is the one the
//      browser computed. Balance-equivalence is not enough here: two files can
//      agree about every total and disagree about a field, and it is the field
//      that gets lost in a migration.
//
// WHY IT CONTAINS NO NUMBERS. This repository is PUBLIC and the file is a real
// person's finances. Every expectation is READ OUT OF THE FILE ITSELF -- the
// manifest's per-account figures, its net-worth total, its own content hash --
// so the test states no balance, no total and no hash, and could be read by a
// stranger without learning anything except that 58 of something matched.
// That is not a weaker test: the manifest is a claim the ROWS have to satisfy,
// and satisfying a claim carried by the file is exactly what an import has to
// do. A runner who wants belt and braces can pin the figures from outside:
//
//   MYMONEY_FROZEN_BACKUP        path to the frozen file (required to run)
//   MYMONEY_FROZEN_HASH          expected canonical content hash (optional)
//   MYMONEY_FROZEN_ACCOUNTS      expected account row count (optional)
//   MYMONEY_FROZEN_TRANSACTIONS  expected transaction row count (optional)
//   MYMONEY_FROZEN_NET_WORTH     expected net worth, in minor units (optional)
//
// WHEN THE FILE IS NOT THERE THE TEST SKIPS, and skipping is not failing. CI
// and every other machine must be able to run `swift test` green; a gate that
// went red on a laptop that has never seen the owner's data would be turned
// off within a week, and a turned-off gate proves nothing.
//
// NOTHING HERE WRITES. The file is opened read-only, never copied into the
// repository, never re-serialised to disk. The export exists as a String in
// memory, is compared, and is dropped.
import Foundation
import Testing

@testable import MyMoneyKit

struct FrozenGateTests {

    static func env(_ name: String) -> String? {
        guard let value = ProcessInfo.processInfo.environment[name], !value.isEmpty else { return nil }
        return value
    }

    /// The path, but only if something is actually there. A stale environment
    /// variable pointing at a file that has moved must SKIP, not fail: "the
    /// evidence is missing" and "the evidence disagrees" are different
    /// findings and only one of them is about the code.
    static var frozenPath: String? {
        guard let path = env("MYMONEY_FROZEN_BACKUP") else { return nil }
        return FileManager.default.fileExists(atPath: path) ? path : nil
    }

    @Test(
        "PHASE 2 GATE: the real book imports, its 58 balances recompute, and it exports back to the same hash",
        .enabled(if: FrozenGateTests.frozenPath != nil, "no frozen backup to run against")
    )
    func phase2Gate() throws {
        let path = try #require(Self.frozenPath)
        let url = URL(fileURLWithPath: path)
        let data = try Data(contentsOf: url, options: [.mappedIfSafe])

        // ------------------------------------------------------------------
        // 1. IMPORT
        // ------------------------------------------------------------------
        let imported = try BackupImporter.load(data: data)
        let book = imported.book
        let claimed = try #require(
            imported.claimedManifest,
            "the frozen file must carry a manifest -- there is nothing to check it against otherwise"
        )

        if let accounts = Self.env("MYMONEY_FROZEN_ACCOUNTS").flatMap(Int.init) {
            #expect(book.accounts.count == accounts)
        }
        if let transactions = Self.env("MYMONEY_FROZEN_TRANSACTIONS").flatMap(Int.init) {
            #expect(book.transactions.count == transactions)
        }
        // The manifest's own row counts, satisfied by the rows that arrived.
        #expect(book.accounts.count == claimed.rowCounts["accounts"])
        #expect(book.transactions.count == claimed.rowCounts["transactions"])

        // ------------------------------------------------------------------
        // 2a. EVERY ACCOUNT'S CLOSING BALANCE, FROM THE ROWS
        //
        // Through `Balances.accountBalances`, which is the app's own balance
        // code and a DIFFERENT implementation from the one the import used to
        // recompute the manifest (Manifest.compute walks TxTotals). Driving
        // the check through the path a screen would use is what makes it a
        // statement about the app rather than about one function.
        // ------------------------------------------------------------------
        let computed = try book.accountBalances()
        var byId: [String: AccountBalance] = [:]
        for balance in computed { byId[balance.account.id] = balance }

        var matched = 0
        var problems: [String] = []
        for want in claimed.accounts {
            guard let got = byId[want.id] else {
                problems.append("account \(want.id): in the manifest, but no such account row arrived")
                continue
            }
            var ok = true
            if got.balanceMinor != want.closingBalanceMinor {
                // The difference in MINOR UNITS, signed, because "out by 1" and
                // "out by 100000" are different bugs and a formatted string
                // hides which one this is.
                let delta = got.balanceMinor &- want.closingBalanceMinor
                problems.append(
                    "account \(want.id) (\(want.currency)): computed closing balance differs from the "
                        + "manifest by \(delta) minor units"
                )
                ok = false
            }
            if got.txCount != want.txCount {
                problems.append(
                    "account \(want.id): \(got.txCount) transactions in the rows, "
                        + "manifest says \(want.txCount)"
                )
                ok = false
            }
            if got.account.currency != want.currency {
                problems.append("account \(want.id): currency disagrees with the manifest")
                ok = false
            }
            if Balances.countsTowardNetWorth(got.account) != want.counted {
                problems.append("account \(want.id): counts-toward-net-worth disagrees with the manifest")
                ok = false
            }
            if ok { matched += 1 }
        }
        for got in computed where !claimed.accounts.contains(where: { $0.id == got.account.id }) {
            problems.append("account \(got.account.id): in the rows, but not in the manifest")
        }

        let accountReport = problems.joined(separator: "\n")
        #expect(problems.isEmpty, "\(problems.count) account(s) disagree:\n\(accountReport)")
        #expect(
            matched == claimed.accounts.count,
            "\(matched) of \(claimed.accounts.count) accounts match exactly"
        )

        // ------------------------------------------------------------------
        // 2b. NET WORTH, FROM THOSE BALANCES AND THE FILE'S OWN RATES
        //
        // TWO TOTALS, AND THE FILE'S OWN VERSION SAYS WHICH ONE IT STATED.
        // Converting each counted account and adding up is not the same
        // arithmetic as adding each currency up and converting the subtotal --
        // rounding happens once per account in the first and once per currency
        // in the second, and on a book with two counted accounts in one foreign
        // currency they differ. This file carries a v1 manifest, which MEANS
        // per-account, and it is held to that; the app's headline figure is
        // per-currency (v2) and is held to THAT. Both are computed here, from
        // the balances above, so neither is taken on trust from the other.
        //
        // If this ever fails with the two totals a penny apart, the bug is that
        // something has stopped selecting the rule by version -- not that the
        // arithmetic drifted.
        // ------------------------------------------------------------------
        let counting = computed.filter { Balances.countsTowardNetWorth($0.account) }
        var perAccountTotal: Int64 = 0
        var byCurrency: [String: Int64] = [:]
        for row in counting {
            byCurrency[row.account.currency, default: 0] += row.balanceMinor
            guard case .converted(let value) = Money.convert(
                minor: row.balanceMinor, from: row.account.currency, to: book.baseCurrency,
                using: book.rateTable
            ) else { continue }  // a currency with no rate is in neither total
            perAccountTotal += value
        }
        var perCurrencyTotal: Int64 = 0
        for (currency, minor) in byCurrency {
            guard case .converted(let value) = Money.convert(
                minor: minor, from: currency, to: book.baseCurrency, using: book.rateTable
            ) else { continue }
            perCurrencyTotal += value
        }

        let fileRule = try Manifest.netWorthRule(of: claimed)
        #expect(
            claimed.netWorth.totalMinor == (fileRule == .perAccount ? perAccountTotal : perCurrencyTotal),
            """
            the file states manifest version \(claimed.manifestVersion), so its total must be the \
            one the \(fileRule.rawValue) rule produces from these rows
            """
        )

        let netWorth = try book.netWorth()
        #expect(netWorth.baseCurrency == claimed.netWorth.baseCurrency)
        #expect(
            netWorth.totalBaseMinor == perCurrencyTotal,
            "the headline figure is the per-currency conversion, exactly"
        )
        // A total that quietly left a currency out is not the same answer as a
        // total that included everything, however equal the two numbers look.
        // This list is a fact about the RATES and is the same under both rules.
        #expect(netWorth.missingRateCurrencies.sorted(by: jsStringLess)
            == claimed.netWorth.missingRateCurrencies)
        if let expected = Self.env("MYMONEY_FROZEN_NET_WORTH").flatMap(Int64.init) {
            // The variable pins the HEADLINE, which is now the per-currency
            // figure. A value copied off a v1 file's manifest is the
            // per-account one and can be a penny or two adrift; say which of
            // the two it is, rather than let it read as an arithmetic failure.
            if netWorth.totalBaseMinor != expected && perAccountTotal == expected {
                Issue.record(
                    """
                    MYMONEY_FROZEN_NET_WORTH holds the per-account (v1) total for this book. \
                    The headline figure is per-currency (v2) since the manifest was versioned; \
                    update the variable.
                    """
                )
            }
            #expect(netWorth.totalBaseMinor == expected)
        }

        // ------------------------------------------------------------------
        // 3. EXPORT, AND THE HASH
        //
        // Built from `book` -- the decoded records -- with the parsed document
        // used for nothing except the three facts a re-export cannot invent:
        // the instant it was taken, which schema version wrote it, and which
        // net-worth rule its manifest was computed under.
        //
        // THAT THIRD ONE IS NOT A LOOPHOLE. The question this step asks is
        // "can the Swift writer reproduce THIS file", and this file was written
        // by a build whose manifests were per-account (v1). Writing v2 here
        // would change one integer and one version number and prove nothing
        // about the other 5,127 rows, which is what the hash is really
        // guarding. The rule is read off the file's own manifest, not asserted
        // to be v1, so the day Girish takes a fresh backup the same line reads
        // v2 out of it and the gate goes on meaning exactly what it means now.
        // An ordinary export passes no rule at all and gets v2 -- see
        // ManifestVersionTests.
        // ------------------------------------------------------------------
        let exported = try BackupWriter.file(
            book, exportedAt: imported.file.exportedAt, schemaVersion: imported.file.schemaVersion,
            netWorthRule: fileRule
        )
        #expect(
            exported["manifest"]?["manifestVersion"]?.intValue
                == Int64(Manifest.version(forNetWorthRule: fileRule)),
            "the re-export must stamp the version whose rule it was written under"
        )
        let exportedHash = BackupReader.canonicalHash(exported)

        if exportedHash != imported.contentHash {
            // The hash is the gate; this is the diagnosis. Name the fields, in
            // order, so a failure says what diverged instead of that something
            // did.
            let differences = JSONDiff.differences(
                want: BackupReader.contentForHash(imported.file.root),
                got: BackupReader.contentForHash(exported)
            )
            Issue.record(
                """
                The Swift export does not reproduce the file's content hash.
                \(differences.count) difference(s) found; the first are:
                \(JSONDiff.report(differences))
                """
            )
        }
        #expect(exportedHash == imported.contentHash, "the export must reproduce the file's own hash")
        if let expected = Self.env("MYMONEY_FROZEN_HASH") {
            #expect(exportedHash == expected, "the export must reproduce the hash written down outside the file")
            #expect(imported.contentHash == expected, "the file as read must have the hash written down outside it")
        }

        // Stronger than the hash, and free: the hash deliberately ignores
        // `exportedAt`, so two files can share a hash and differ in the one
        // field it drops. The frozen file was written by `serializeBackup`, so
        // a faithful writer reproduces it BYTE FOR BYTE, timestamp included.
        let originalText = try #require(String(data: data, encoding: .utf8))
        let exportedText = BackupWriter.serialise(exported)
        #expect(
            exportedText.utf8.count == originalText.utf8.count,
            "exported \(exportedText.utf8.count) bytes against the file's \(originalText.utf8.count)"
        )
        #expect(exportedText == originalText, "the export must be the same bytes as the file it came from")

        // And the file on disk is exactly as it was found. This test only ever
        // reads; the assertion is here so that stays true by construction if
        // anyone ever adds to it.
        let after = try Data(contentsOf: url)
        #expect(after.count == data.count)
        #expect(after == data)
    }
}
