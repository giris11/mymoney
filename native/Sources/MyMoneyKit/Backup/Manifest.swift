// The manifest: a backup that states what it contains, so it can be CHECKED
// rather than trusted. Ported from src/backup/manifest.ts.
//
// WHY. Every figure in this app is derived -- a balance is an opening balance
// plus a stream of signed integers, net worth is those balances converted at
// display time. A file that carries only the rows is a PROMISE that those
// derivations will come out the same way when they are read back, and nothing
// in the file can test that promise. So the file also carries the ANSWERS:
// per-table row counts, every account's closing balance in minor units with its
// currency, and the net worth in a named base currency together with the exact
// rates used to reach it. On import every one of them is recomputed from the
// rows that actually arrived, and a disagreement stops the import and NAMES
// what disagreed. A backup that cannot prove itself is not a backup.
//
// TWO RULES THIS FILE IS BUILT AROUND, and both are carried over verbatim:
//
//  * COMPUTED FROM THE ROWS IN HAND. Every number here is derived from the row
//    arrays being written or read, never from a second query. A count taken at
//    a different moment is a statement about a different book.
//  * ONE IMPLEMENTATION FOR BOTH ENDS. Export and verify call the same
//    `compute`, so they cannot drift into disagreeing about what "closing
//    balance" means. The net-worth arithmetic reuses `countsTowardNetWorth` and
//    `Money.convert` from the package itself, so the manifest states the number
//    the app actually shows -- not a second opinion that happens to look
//    similar.
//
// THIS FILE AND src/backup/manifest.ts MUST MOVE TOGETHER. They are not two
// implementations of a similar idea; they are two statements of ONE file
// format, and the whole value of this port is that a file written by either
// one verifies under the other. `NetWorthRule`, `version`,
// `netWorthRule(forVersion:)` and the two-total pass inside `compute` are
// deliberately shaped so the two can be read side by side and diffed by a
// future maintainer. Change one without the other and a backup written on the
// phone stops restoring in the browser -- or, far worse, restores under the
// wrong arithmetic and calls itself verified.
import Foundation

/// HOW A MANIFEST'S NET-WORTH TOTAL WAS ARRIVED AT.
///
/// Two counted accounts in the same non-base currency can be totalled two
/// ways, and the two do not always agree, because conversion rounds:
///
///     705 + 705 EUR at 0.85 -> per account:  round(599.25) + round(599.25) = 1198
///                              per currency: round(1410 x 0.85 = 1198.5)   = 1199
///
///  * `perAccount` -- convert each counted account's closing balance, then add.
///    This is what manifest version 1 MEANS. Every backup file already in
///    existence says it, and that meaning is now FROZEN. A v1 manifest is a
///    record of arithmetic that was already performed, by a build that no
///    longer exists; reinterpreting it would not make the old file wrong, it
///    would make it UNRESTORABLE -- an import recomputes every figure and
///    refuses on a disagreement, so "recompute it the new way" means "refuse
///    every backup Girish is holding". Fixing a rounding cosmetic by making
///    the safety net reject the files it exists to accept is not a fix.
///  * `perCurrency` -- add each currency's counted balances up IN that
///    currency, then convert each subtotal exactly once. Manifest version 2,
///    and what this build writes.
///
/// WHY PER-CURRENCY IS THE RULE GOING FORWARD: it rounds once per currency
/// instead of once per account, so the error cannot grow with the number of
/// accounts; it is the ordinary accounting treatment (total in the source
/// currency, then convert); and it is what `Reports.netWorthSeries` has always
/// done, so adopting it leaves the chart's history truthful instead of
/// retroactively re-rounding it. `Balances.netWorth` -- the headline figure --
/// now does the same. This manifest is the THIRD place that number is
/// computed, and a file whose stated net worth disagrees with the screen is a
/// file that cannot be used to check anything.
///
/// A v1 FILE IS NEVER SILENTLY UPGRADED. Import a v1 backup and export again
/// and the new file carries a v2 manifest whose totalMinor may differ from the
/// v1 one by a penny or two. That is correct and expected -- one book, stated
/// under a better rule -- and it is NOT corruption, however much a figure that
/// moves across a round trip looks like it. The version beside it is what says
/// which of the two it is.
///
/// The raw values are the TypeScript's string union members, so a `NetWorthRule`
/// printed in a diagnostic here reads exactly as it does there.
public enum NetWorthRule: String, Sendable, Hashable, CaseIterable {
    case perAccount = "per-account"
    case perCurrency = "per-currency"
}

/// What one account was worth when the backup was taken.
public struct ManifestAccount: Sendable, Hashable {
    public let id: String
    /// Carried so a mismatch can be reported in the owner's terms, not by id.
    public let name: String
    public let currency: String
    /// openingBalanceMinor + the sum of the account's transactions, in MINOR
    /// UNITS. Stated for EVERY account, archived and excluded included: whether
    /// an account counts toward a total is a separate fact, recorded below.
    public let closingBalanceMinor: Int64
    public let txCount: Int
    public let counted: Bool
}

/// One conversion actually used to reach the net-worth figure: 1 from = rate to.
public struct ManifestRate: Sendable, Hashable {
    public let from: String
    public let to: String
    public let rate: Double
}

public struct ManifestNetWorth: Sendable, Hashable {
    /// Named, never assumed -- the figure means nothing without it.
    public let baseCurrency: String
    public let totalMinor: Int64
    /// Every rate the total depended on, so it can be recomputed by hand.
    public let rates: [ManifestRate]
    /// Currencies left OUT of the total because no rate to base exists.
    /// SORTED here, where `NetWorth.missingRateCurrencies` is in encounter
    /// order -- the manifest has to be byte-stable whatever order the rows
    /// arrived in, and the live figure has no such obligation. The difference
    /// is deliberate on both sides.
    public let missingRateCurrencies: [String]
}

public struct BackupManifest: Sendable, Hashable {
    public let manifestVersion: Int
    public let schemaVersion: Int
    /// The same instant as the file's own `exportedAt`; validation ties them.
    public let exportedAt: String
    /// Table name -> rows written. Every table in Schema.allTables, always.
    public let rowCounts: [String: Int]
    /// Every account, sorted by id.
    public let accounts: [ManifestAccount]
    public let netWorth: ManifestNetWorth
}

/// Per-account transaction totals.
public struct TxTotals: Sendable {
    public private(set) var totals: [String: (sumMinor: Int64, count: Int)] = [:]

    public init() {}

    public mutating func add(accountId: String, amountMinor: Int64) throws {
        var entry = totals[accountId] ?? (sumMinor: 0, count: 0)
        let (sum, overflowed) = entry.sumMinor.addingReportingOverflow(amountMinor)
        if overflowed { throw MoneyError.overflow("manifest total for account \(accountId)") }
        entry.sumMinor = sum
        entry.count += 1
        totals[accountId] = entry
    }

    public subscript(accountId: String) -> (sumMinor: Int64, count: Int)? { totals[accountId] }
}

/// Everything a manifest is computed from, however the caller got hold of it.
public struct ManifestSource: Sendable {
    public let rowCounts: [String: Int]
    public let accounts: [Account]
    public let fxRates: [FxRate]
    public let txByAccount: TxTotals

    public init(rowCounts: [String: Int], accounts: [Account], fxRates: [FxRate], txByAccount: TxTotals) {
        self.rowCounts = rowCounts
        self.accounts = accounts
        self.fxRates = fxRates
        self.txByAccount = txByAccount
    }
}

public enum Manifest {
    /// Manifest format version -- independent of Schema.version, because the
    /// manifest can gain a claim without any row changing shape.
    ///
    /// A file whose manifestVersion this build does not KNOW is not checked
    /// (and says so): an older build must still be able to restore a file a
    /// newer build wrote, and the rows themselves are fully validated either
    /// way. Refusing would turn a forward-compatible file into an unrestorable
    /// one, which is a worse failure than an unverified import that admits it
    /// is unverified.
    ///
    /// EVERY VERSION THIS BUILD KNOWS IS STILL CHECKED -- EACH BY ITS OWN RULE.
    /// The version is not "how new is this file"; it is WHICH ARITHMETIC
    /// PRODUCED THE NET-WORTH FIGURE INSIDE IT (see `NetWorthRule`). v1 files
    /// are recomputed the v1 way, forever.
    public static let version = 2

    /// The rule new exports are written under. Pairs with `version`.
    public static let currentNetWorthRule: NetWorthRule = .perCurrency

    /// The rule a manifest of this version was computed under -- nil when this
    /// build has never heard of the version, the one case where a manifest
    /// cannot be checked at all (see `isCheckable`).
    ///
    /// APPEND-ONLY. Changing what an existing number means would un-restore
    /// every file already carrying it.
    public static func netWorthRule(forVersion version: Int) -> NetWorthRule? {
        if version == 1 { return .perAccount }
        if version == 2 { return .perCurrency }
        return nil
    }

    /// The other direction: a manifest computed under this rule states this
    /// version.
    public static func version(forNetWorthRule rule: NetWorthRule) -> Int {
        rule == .perAccount ? 1 : 2
    }

    /// The rule a manifest that is about to be CHECKED was computed under.
    ///
    /// Separate from `netWorthRule(forVersion:)` so that no caller on the
    /// verifying path has to unwrap an optional rule. A `nil` forced with `!`
    /// would crash, and a `?? .perCurrency` would be worse: it would verify an
    /// old file under the WRONG rule -- silently, with a plausible answer --
    /// which is precisely the failure this whole change exists to remove. So
    /// it throws instead, and an import that throws changes nothing, which is
    /// the right answer to "I do not know how to check this".
    public static func netWorthRule(of manifest: BackupManifest) throws -> NetWorthRule {
        guard let rule = netWorthRule(forVersion: manifest.manifestVersion) else {
            throw BackupImportError.invalid(
                "This backup states manifest version \(manifest.manifestVersion), "
                    + "which this build does not know how to check."
            )
        }
        return rule
    }

    /// The manifest for a set of rows, computed under the rule the caller
    /// names.
    ///
    /// The net-worth arithmetic is deliberately the same as
    /// `Balances.netWorth`: archived or excluded accounts are out of the total
    /// (but keep their real closing balance here, because that is a fact about
    /// the account), conversion goes through `Money.convert` -- integer minor
    /// units in, integer minor units out, rounded half away from zero exactly
    /// once -- and a currency with no rate to base is NAMED rather than
    /// guessed at.
    ///
    /// WHAT `netWorthRule` CHANGES, AND WHAT IT CANNOT. It chooses only WHEN
    /// the rounding happens: once per counted account (`.perAccount`, v1) or
    /// once per currency (`.perCurrency`, v2). Everything else in this manifest
    /// is a fact about the rows and is identical either way -- the per-account
    /// closing balances (a per-account figure legitimately rounds per account:
    /// it IS one account), the row counts, the rates that were applied, and the
    /// currencies that had none. So a v1 file and a v2 file of the same book
    /// differ in exactly one integer, and only when two counted accounts share
    /// a non-base currency.
    ///
    /// The parameter is REQUIRED and never defaulted: exporting passes
    /// `currentNetWorthRule`, and every VERIFYING caller passes the rule THE
    /// MANIFEST IT IS CHECKING declares, via `netWorthRule(of:)`. A default
    /// here would quietly hold an old file to a rule it was never computed
    /// under, and the import would refuse a backup that is perfectly sound.
    ///
    /// The stamped `manifestVersion` comes FROM the rule, never from a
    /// parameter of its own: a manifest that said v1 while holding a
    /// per-currency total would be a file that lies about its own arithmetic,
    /// and every later verification of it would be checked the wrong way round.
    public static func compute(
        _ source: ManifestSource,
        schemaVersion: Int,
        exportedAt: String,
        baseCurrency: String,
        netWorthRule: NetWorthRule
    ) throws -> BackupManifest {
        let table = RateTable(rates: source.fxRates)
        var accounts: [ManifestAccount] = []
        var rates: [String: ManifestRate] = [:]
        var missing: Set<String> = []
        // BOTH totals are accumulated in one pass over the accounts, and the
        // rule picks which one is stated. They are gathered together rather
        // than in two branches so that the rates applied and the currencies
        // with no rate -- facts about the book, not about the rule -- cannot
        // come out differently for a v1 file and a v2 file of the same rows.
        var perAccountTotal: Int64 = 0
        // A dictionary plus the order its keys were first seen, because a
        // Swift Dictionary has no order and the TypeScript accumulates into a
        // Map, which iterates in insertion order. Nothing in the total depends
        // on that order -- integer addition does not care -- but a diagnostic
        // thrown out of the per-currency pass does, and a test that sometimes
        // names one currency and sometimes another is a test nobody trusts.
        var currencyOrder: [String] = []
        var countedByCurrency: [String: Int64] = [:]

        // Sorted by id so the manifest is byte-stable regardless of how the
        // rows arrived. UTF-16 code-unit order, which is what the TypeScript's
        // `a.id < b.id` does -- Swift's own `<` on String is Unicode canonical
        // ordering and is NOT the same comparison.
        let ordered = source.accounts.sorted { jsStringLess($0.id, $1.id) }
        for account in ordered {
            let totals = source.txByAccount[account.id]
            let (closing, overflowed) = account.openingBalanceMinor
                .addingReportingOverflow(totals?.sumMinor ?? 0)
            if overflowed { throw MoneyError.overflow("closing balance of account \(account.id)") }
            let counted = Balances.countsTowardNetWorth(account)
            accounts.append(
                ManifestAccount(
                    id: account.id,
                    name: account.name,
                    currency: account.currency,
                    closingBalanceMinor: closing,
                    txCount: totals?.count ?? 0,
                    counted: counted
                )
            )
            guard counted else { continue }
            if countedByCurrency[account.currency] == nil {
                countedByCurrency[account.currency] = 0
                currencyOrder.append(account.currency)
            }
            let (subtotal, subtotalOverflowed) = countedByCurrency[account.currency]!
                .addingReportingOverflow(closing)
            if subtotalOverflowed { throw MoneyError.overflow("the \(account.currency) subtotal") }
            countedByCurrency[account.currency] = subtotal

            switch Money.convert(minor: closing, from: account.currency, to: baseCurrency, using: table) {
            case .missingRate:
                // A currency with no rate to base cannot be converted at either
                // granularity -- `Money.convert` reports the missing RATE, not
                // a fact about the amount -- so this list is the same under
                // both rules.
                missing.insert(account.currency)
            case .notRepresentable:
                // This pass runs under BOTH rules -- it is where the rates and
                // the missing currencies come from -- so a v2 manifest refuses
                // here too, over a conversion its own total never performs.
                // That is deliberate: the alternative is a manifest that states
                // a figure for a book containing an account whose value cannot
                // be stated, and refusing is the conservative half of a choice
                // no real ledger reaches (it takes roughly 90 trillion pounds).
                // The TypeScript has no equivalent -- a JS number always
                // "fits", which is the same defect wearing a friendlier face.
                throw MoneyError.notRepresentable("the balance of account \(account.id)")
            case .converted(let value):
                let (next, totalOverflowed) = perAccountTotal.addingReportingOverflow(value)
                if totalOverflowed { throw MoneyError.overflow("net worth total") }
                perAccountTotal = next
                if account.currency != baseCurrency, rates[account.currency] == nil {
                    // The rate AS USED, which may be the reciprocal of the
                    // stored row. Writing down what was applied -- not what was
                    // stored -- is what makes the figure recomputable by hand.
                    if let rate = table.rate(from: account.currency, to: baseCurrency) {
                        rates[account.currency] = ManifestRate(
                            from: account.currency, to: baseCurrency, rate: rate
                        )
                    }
                }
            }
        }

        var total = perAccountTotal
        if netWorthRule == .perCurrency {
            // Sum in the source currency, convert the subtotal once. The
            // currencies with no rate are the ones already named in `missing`
            // above; skipping them here keeps the total honest about what it
            // does not include (SPEC 6).
            total = 0
            for currency in currencyOrder {
                switch Money.convert(
                    minor: countedByCurrency[currency]!, from: currency, to: baseCurrency, using: table
                ) {
                case .missingRate:
                    continue
                case .notRepresentable:
                    throw MoneyError.notRepresentable("the \(currency) subtotal")
                case .converted(let value):
                    let (next, overflowed) = total.addingReportingOverflow(value)
                    if overflowed { throw MoneyError.overflow("net worth total") }
                    total = next
                }
            }
        }

        return BackupManifest(
            manifestVersion: version(forNetWorthRule: netWorthRule),
            schemaVersion: schemaVersion,
            exportedAt: exportedAt,
            rowCounts: source.rowCounts,
            accounts: accounts,
            netWorth: ManifestNetWorth(
                baseCurrency: baseCurrency,
                totalMinor: total,
                rates: rates.values.sorted { jsStringLess($0.from, $1.from) },
                missingRateCurrencies: missing.sorted(by: jsStringLess)
            )
        )
    }

    // MARK: - Reading a manifest out of a file

    /// Shape-check a manifest found in a file, WITHOUT trusting any of its
    /// figures. Returns a problem description, or nil when the manifest is
    /// either well-formed or a version this build does not check.
    ///
    /// `file` ties the manifest to the file around it: a manifest claiming a
    /// different schema version or a different export time than its own file is
    /// describing something ELSE, and that is corruption however plausible the
    /// rest of it looks.
    public static func validateShape(
        _ value: JSONValue,
        fileSchemaVersion: Int,
        fileExportedAt: String
    ) -> String? {
        guard let members = value.objectValue else {
            return "Invalid backup: \"manifest\" must be an object"
        }
        guard let manifestVersion = members["manifestVersion"]?.intValue, manifestVersion >= 1 else {
            return "Invalid backup: the manifest has no version number"
        }
        // Not ours to judge -- a version whose net-worth RULE this build does
        // not know (a future one). Every version it DOES know is shape-checked
        // here and arithmetic-checked later against its own rule; v1 and v2
        // have the same shape, and only the meaning of netWorth.totalMinor
        // differs. Narrowing this back to `== version` would leave a v1 file's
        // manifest unvalidated while `isCheckable` still said "check this", so
        // the import would compare against a manifest nothing had validated.
        guard let claimedVersion = Int(exactly: manifestVersion),
              netWorthRule(forVersion: claimedVersion) != nil
        else { return nil }

        guard members["schemaVersion"]?.intValue == Int64(fileSchemaVersion) else {
            let claimed = members["schemaVersion"]?.intValue.map(String.init) ?? "nothing"
            return "Invalid backup: the manifest describes schema \(claimed) "
                + "but the file says \(fileSchemaVersion)"
        }
        guard members["exportedAt"]?.stringValue == fileExportedAt else {
            return "Invalid backup: the manifest was taken at a different time from the file it is in"
        }
        guard let rowCounts = members["rowCounts"]?.objectValue else {
            return "Invalid backup: the manifest has no row counts"
        }
        for name in Schema.allTables {
            guard let count = rowCounts[name]?.intValue, count >= 0 else {
                return "Invalid backup: the manifest's row count for \"\(name)\" is not a whole number"
            }
        }
        guard let accounts = members["accounts"]?.arrayValue else {
            return "Invalid backup: the manifest has no account list"
        }
        for (index, entry) in accounts.enumerated() {
            guard let account = entry.objectValue,
                  let id = account["id"]?.stringValue, !id.isEmpty,
                  account["name"]?.stringValue != nil,
                  account["currency"]?.stringValue != nil,
                  account["closingBalanceMinor"]?.intValue != nil,
                  account["txCount"]?.intValue != nil,
                  account["counted"]?.boolValue != nil
            else {
                return "Invalid backup: the manifest's account entry \(index) is incomplete"
            }
        }
        guard let netWorth = members["netWorth"]?.objectValue,
              let base = netWorth["baseCurrency"]?.stringValue, !base.isEmpty,
              netWorth["totalMinor"]?.intValue != nil,
              let rates = netWorth["rates"]?.arrayValue,
              let missing = netWorth["missingRateCurrencies"]?.arrayValue
        else {
            return "Invalid backup: the manifest has no usable net-worth figure"
        }
        for entry in rates {
            guard let rate = entry.objectValue,
                  rate["from"]?.stringValue != nil,
                  rate["to"]?.stringValue != nil,
                  let value = rate["rate"]?.doubleValue, value > 0
            else {
                return "Invalid backup: the manifest lists an unusable exchange rate"
            }
        }
        if missing.contains(where: { $0.stringValue == nil }) {
            return "Invalid backup: the manifest lists an unusable currency code"
        }
        return nil
    }

    /// Is this a manifest this build knows how to check?
    ///
    /// "Knows how to check" means "knows which net-worth rule produced it",
    /// which is every version in `netWorthRule(forVersion:)` -- NOT only the
    /// current one. Narrowing this to `version` would silently drop the
    /// self-check on every backup written before the rule changed, which is
    /// most of the files that exist: they would still import, but unverified,
    /// and the whole point of the manifest is that an import is held to the
    /// file's own figures.
    public static func isCheckable(_ value: JSONValue?) -> Bool {
        guard let value, let members = value.objectValue,
              let claimed = members["manifestVersion"]?.intValue,
              let claimedVersion = Int(exactly: claimed)
        else { return false }
        return netWorthRule(forVersion: claimedVersion) != nil
    }

    /// Decode a manifest already known to be well-formed and checkable.
    public static func decode(_ value: JSONValue) throws -> BackupManifest {
        let row = try RowReader(value, context: "manifest")
        var rowCounts: [String: Int] = [:]
        if let counts = row.raw("rowCounts")?.objectValue {
            for (name, count) in counts {
                guard let n = count.intValue, let narrowed = Int(exactly: n) else {
                    throw RecordDecodeError(
                        context: "manifest.rowCounts.\(name)", message: "must be a whole number"
                    )
                }
                rowCounts[name] = narrowed
            }
        }
        let accountRows = row.raw("accounts")?.arrayValue ?? []
        let accounts: [ManifestAccount] = try accountRows.enumerated().map { index, entry in
            let account = try RowReader(entry, context: "manifest.accounts[\(index)]")
            return ManifestAccount(
                id: try account.string("id"),
                name: try account.string("name", default: ""),
                currency: try account.string("currency"),
                closingBalanceMinor: try account.int64("closingBalanceMinor"),
                txCount: try account.int("txCount", default: 0),
                counted: try account.bool("counted", default: true)
            )
        }
        let netWorthRow = try RowReader(
            row.raw("netWorth") ?? .object([:]), context: "manifest.netWorth"
        )
        let rateRows = netWorthRow.raw("rates")?.arrayValue ?? []
        let rates: [ManifestRate] = try rateRows.enumerated().map { index, entry in
            let rate = try RowReader(entry, context: "manifest.netWorth.rates[\(index)]")
            return ManifestRate(
                from: try rate.string("from"),
                to: try rate.string("to"),
                rate: try rate.double("rate")
            )
        }
        return BackupManifest(
            manifestVersion: try row.int("manifestVersion", default: 0),
            schemaVersion: try row.int("schemaVersion", default: 0),
            exportedAt: try row.string("exportedAt", default: ""),
            rowCounts: rowCounts,
            accounts: accounts,
            netWorth: ManifestNetWorth(
                baseCurrency: try netWorthRow.string("baseCurrency"),
                totalMinor: try netWorthRow.int64("totalMinor"),
                rates: rates,
                missingRateCurrencies: try netWorthRow.strings("missingRateCurrencies")
            )
        )
    }

    // MARK: - Checking a claim against a recomputation

    /// Every way `recomputed` fails to match what `claimed` says, in plain
    /// English, NAMING the table or the account -- never "verification failed".
    ///
    /// Deliberately NOT compared: manifestVersion, schemaVersion and
    /// exportedAt. Those are claims about the FILE, tied to it by
    /// `validateShape` before a single row is read; here we are only asking
    /// whether the rows produce the arithmetic the file says they produce.
    /// That stays right now that the version selects the rule: a recomputation
    /// performed under the file's own version stamps the file's own version, so
    /// comparing the two would only ever restate the caller's own argument --
    /// and a recomputation performed under the WRONG rule shows up here as the
    /// net-worth disagreement it actually is, which is the finding worth
    /// reporting.
    public static func compare(
        claimed: BackupManifest,
        recomputed: BackupManifest,
        settingsRowMintedLocally: Bool = false
    ) -> [String] {
        var problems: [String] = []

        for name in Schema.allTables {
            if name == "settings" && settingsRowMintedLocally { continue }
            let want = claimed.rowCounts[name] ?? 0
            let got = recomputed.rowCounts[name] ?? 0
            if want != got {
                problems.append(
                    "table \u{201C}\(name)\u{201D}: \(grouped(got)) rows, but the backup says \(grouped(want))"
                )
            }
        }

        var seen: Set<String> = []
        let byId = Dictionary(recomputed.accounts.map { ($0.id, $0) }, uniquingKeysWith: { first, _ in first })
        for want in claimed.accounts {
            seen.insert(want.id)
            let who = want.name.isEmpty ? want.id : want.name
            guard let got = byId[want.id] else {
                problems.append(
                    "account \u{201C}\(who)\u{201D} is in the backup\u{2019}s manifest but not in the restored data"
                )
                continue
            }
            if got.currency != want.currency {
                problems.append(
                    "account \u{201C}\(who)\u{201D}: currency is \(got.currency), but the backup says \(want.currency)"
                )
                // Different currencies make the balance comparison meaningless;
                // the currency mismatch is the finding worth reporting.
                continue
            }
            if got.closingBalanceMinor != want.closingBalanceMinor {
                problems.append(
                    "account \u{201C}\(who)\u{201D}: closing balance is "
                        + Money.format(got.closingBalanceMinor, currency: got.currency)
                        + ", but the backup says "
                        + Money.format(want.closingBalanceMinor, currency: want.currency)
                )
            }
            if got.txCount != want.txCount {
                problems.append(
                    "account \u{201C}\(who)\u{201D}: \(grouped(got.txCount)) transactions, "
                        + "but the backup says \(grouped(want.txCount))"
                )
            }
            if got.name != want.name {
                problems.append(
                    "account \u{201C}\(who)\u{201D} is named \u{201C}\(got.name)\u{201D} in the restored data"
                )
            }
            if got.counted != want.counted {
                problems.append(
                    got.counted
                        ? "account \u{201C}\(who)\u{201D} now counts toward net worth, but the backup says it did not"
                        : "account \u{201C}\(who)\u{201D} no longer counts toward net worth, but the backup says it did"
                )
            }
        }
        for got in recomputed.accounts where !seen.contains(got.id) {
            let who = got.name.isEmpty ? got.id : got.name
            problems.append(
                "account \u{201C}\(who)\u{201D} is in the restored data but not in the backup\u{2019}s manifest"
            )
        }

        let want = claimed.netWorth
        let got = recomputed.netWorth
        if got.baseCurrency != want.baseCurrency {
            problems.append(
                "base currency is \(got.baseCurrency), but the backup says \(want.baseCurrency)"
            )
        } else if got.totalMinor != want.totalMinor {
            // Only when the currencies agree: two totals in different
            // currencies are not a disagreement about arithmetic, and saying so
            // twice hides the cause.
            problems.append(
                "net worth is " + Money.format(got.totalMinor, currency: got.baseCurrency)
                    + ", but the backup says " + Money.format(want.totalMinor, currency: want.baseCurrency)
            )
        }
        let wantRates = want.rates.map { "\($0.from)\u{2192}\($0.to) @ \(JSNumber.string($0.rate))" }
            .joined(separator: ", ")
        let gotRates = got.rates.map { "\($0.from)\u{2192}\($0.to) @ \(JSNumber.string($0.rate))" }
            .joined(separator: ", ")
        if wantRates != gotRates {
            problems.append(
                "exchange rates used: \(gotRates.isEmpty ? "none" : gotRates), "
                    + "but the backup says \(wantRates.isEmpty ? "none" : wantRates)"
            )
        }
        let wantMissing = want.missingRateCurrencies.joined(separator: ", ")
        let gotMissing = got.missingRateCurrencies.joined(separator: ", ")
        if wantMissing != gotMissing {
            problems.append(
                "currencies with no rate: \(gotMissing.isEmpty ? "none" : gotMissing), "
                    + "but the backup says \(wantMissing.isEmpty ? "none" : wantMissing)"
            )
        }
        return problems
    }

    /// The figures in the owner's own terms: "58 accounts, 5,127 transactions,
    /// net worth ...". A sentence, not a table, because the point is that he
    /// RECOGNISES the numbers. A currency the total could not include is SAID,
    /// never left out silently.
    public static func summarise(_ manifest: BackupManifest) -> String {
        let head = plural(manifest.rowCounts["accounts"] ?? 0, "account", "accounts")
            + ", " + plural(manifest.rowCounts["transactions"] ?? 0, "transaction", "transactions")
            + ", net worth " + Money.format(
                manifest.netWorth.totalMinor, currency: manifest.netWorth.baseCurrency
            )
        let missing = manifest.netWorth.missingRateCurrencies
        if missing.isEmpty { return head }
        return head + " (\(missing.joined(separator: ", ")) not counted \u{2014} no exchange rate)"
    }

    private static func grouped(_ n: Int) -> String {
        let formatter = NumberFormatter()
        formatter.numberStyle = .decimal
        formatter.locale = Locale(identifier: "en_GB")
        return formatter.string(from: NSNumber(value: n)) ?? String(n)
    }

    private static func plural(_ n: Int, _ one: String, _ many: String) -> String {
        "\(grouped(n)) \(n == 1 ? one : many)"
    }
}
