// Account balances and net worth, ported from src/domain/balances.ts.
//
// A BALANCE IS ALWAYS THE ACCOUNT'S OWN REAL BALANCE, in the account's own
// currency, and it is never converted. Whether an account lands in the NET
// WORTH TOTAL is a completely separate question, answered by
// `countsTowardNetWorth`. Archived (retired) or `excludeFromNetWorth`
// ("show it, don't count it") keep an account out of the TOTAL while leaving
// its balance, its transactions and its visibility untouched. Conflating the
// two -- zeroing an excluded account's balance, or hiding it -- would mean the
// owner could not find their own money, which is worse than a wrong headline.
//
// PURE FUNCTIONS OVER ARRAYS, no database. The TypeScript streams the
// transactions table in batches because the sidebar re-runs it on every write
// at 100,000 rows; that is a storage concern and belongs with whatever
// persistence layer the app grows (SQLite, and it will express this as a
// GROUP BY). What belongs HERE is the arithmetic, in a form a test can hand a
// handful of rows to and a form the oracle's books can drive directly.
import Foundation

public struct AccountBalance: Sendable, Hashable {
    public let account: Account
    /// Opening balance plus ALL transactions, pending included (D15).
    public let balanceMinor: Int64
    /// Opening balance plus CLEARED transactions only.
    public let clearedMinor: Int64
    public let txCount: Int
    /// Mirror of `account.excludeFromNetWorth`, resolved here so a consumer can
    /// render "not counted" without a second lookup. The balance above is the
    /// real balance either way.
    public let excludedFromNetWorth: Bool
}

public struct NetWorth: Sendable, Hashable {
    /// The balances that COUNT -- not archived, not excluded -- totalled IN
    /// THEIR OWN CURRENCY and each currency's subtotal then converted to base
    /// exactly once. Per currency, not per account: see `netWorth` below for
    /// why the difference is a real penny and not a stylistic one.
    public let totalBaseMinor: Int64
    public let baseCurrency: String
    /// Currencies left OUT of the total because no rate to base exists.
    /// Surfaced, never guessed: the honest total is the one that says what is
    /// missing from it. In the order the accounts were encountered, matching
    /// the TypeScript's insertion-ordered Set -- note that the BACKUP MANIFEST
    /// sorts the same list instead (see Manifest.swift), and the difference is
    /// deliberate in both places.
    public let missingRateCurrencies: [String]
    /// How many VISIBLE (non-archived) accounts are flagged not-counted, so the
    /// UI can say "N accounts not counted" honestly. An archived account that
    /// is also flagged is not counted here: it is already out of the total for
    /// an older, separate reason and is not on screen next to the figure.
    public let excludedCount: Int
    /// What those excluded accounts are worth in base currency -- totalled per
    /// currency and converted once, exactly like the figure above.
    ///
    /// nil the moment ONE of them cannot be converted. A partial "not counted"
    /// figure would silently omit an account, and a number that quietly means
    /// something other than what it says is the failure this whole package
    /// exists to prevent. Their currencies are deliberately NOT added to
    /// `missingRateCurrencies`: that list means "your total is missing this
    /// currency", and an excluded account was never going to be in the total.
    public let excludedBaseMinor: Int64?
}

public enum Balances {
    /// Has the owner flagged this account out of net-worth totals?
    /// `== true`, never a truthiness test and never `?? false` spelled some
    /// other way: this is the TypeScript's `account.excludeFromNetWorth ===
    /// true`. Absent and an explicit `false` are different bytes in the file
    /// (see `Account.excludeFromNetWorth`) and the same answer here, which is
    /// the whole point -- a net worth that changed because a row was written by
    /// an older build would be indefensible.
    public static func isExcludedFromNetWorth(_ account: Account) -> Bool {
        account.excludeFromNetWorth == true
    }

    /// Does this account contribute to the net-worth total?
    ///
    /// The two reasons not to count COMPOSE: archived OR excluded implies not
    /// counted. One function, so the headline figure and any chart drawn later
    /// can never disagree about which accounts count.
    public static func countsTowardNetWorth(_ account: Account) -> Bool {
        !account.archived && !isExcludedFromNetWorth(account)
    }

    /// The pure core: opening + the sum of the amounts.
    public static func balanceFromAmounts(_ openingMinor: Int64, _ amounts: [Int64]) throws -> Int64 {
        try Money.sum(amounts, startingAt: openingMinor)
    }

    struct Aggregate {
        var sum: Int64 = 0
        var cleared: Int64 = 0
        var count: Int = 0
    }

    /// accountId -> totals, in one pass.
    static func aggregate(_ transactions: [Transaction]) throws -> [String: Aggregate] {
        var totals: [String: Aggregate] = [:]
        for tx in transactions {
            var entry = totals[tx.accountId] ?? Aggregate()
            let (sum, sumOverflowed) = entry.sum.addingReportingOverflow(tx.amountMinor)
            if sumOverflowed {
                throw MoneyError.overflow("summing transactions for account \(tx.accountId)")
            }
            entry.sum = sum
            if tx.status == .cleared {
                let (cleared, clearedOverflowed) = entry.cleared.addingReportingOverflow(tx.amountMinor)
                if clearedOverflowed {
                    throw MoneyError.overflow("summing cleared transactions for account \(tx.accountId)")
                }
                entry.cleared = cleared
            }
            entry.count += 1
            totals[tx.accountId] = entry
        }
        return totals
    }

    /// Balances for ALL accounts -- archived and net-worth-excluded included.
    /// Callers filter; an excluded account must stay visible with its real
    /// balance.
    ///
    /// Sorted by `sortOrder`, then by name. Two notes on the ordering, because
    /// this is a place a port can silently diverge:
    ///  * the sort is made STABLE by falling back to the input position.
    ///    JavaScript's `Array.prototype.sort` has been required to be stable
    ///    since ES2019 and Swift's `sorted(by:)` is not, so two accounts
    ///    identical in sortOrder AND name would otherwise come back in an order
    ///    that depended on the standard library's mood;
    ///  * the name comparison is `localeCompare`'s, i.e. locale-aware, pinned
    ///    to en_GB here. The TypeScript passes no locale and gets the browser's.
    ///    Nothing in the oracle exercises a name tie, so this is a judgement,
    ///    and it is recorded as one.
    public static func accountBalances(
        accounts: [Account],
        transactions: [Transaction]
    ) throws -> [AccountBalance] {
        let totals = try aggregate(transactions)
        let enGB = Locale(identifier: "en_GB")
        let rows: [(offset: Int, balance: AccountBalance)] = try accounts.enumerated().map { index, account in
            let entry = totals[account.id] ?? Aggregate()
            let (balance, balanceOverflowed) = account.openingBalanceMinor.addingReportingOverflow(entry.sum)
            let (cleared, clearedOverflowed) = account.openingBalanceMinor.addingReportingOverflow(entry.cleared)
            if balanceOverflowed || clearedOverflowed {
                throw MoneyError.overflow("balance of account \(account.id)")
            }
            return (
                index,
                AccountBalance(
                    account: account,
                    balanceMinor: balance,
                    clearedMinor: cleared,
                    txCount: entry.count,
                    excludedFromNetWorth: isExcludedFromNetWorth(account)
                )
            )
        }
        return rows.sorted { lhs, rhs in
            let a = lhs.balance.account
            let b = rhs.balance.account
            if a.sortOrder != b.sortOrder { return a.sortOrder < b.sortOrder }
            let byName = a.name.compare(b.name, options: [], range: nil, locale: enGB)
            if byName != .orderedSame { return byName == .orderedAscending }
            return lhs.offset < rhs.offset
        }.map(\.balance)
    }

    /// Net worth in base currency.
    ///
    /// SUM PER CURRENCY FIRST, CONVERT ONCE -- matching `Reports.netWorthSeries`
    /// and `Manifest.compute`'s current rule (`.perCurrency`) exactly.
    ///
    /// This used to convert once per ACCOUNT, and that made the headline figure
    /// disagree with the right-hand end of the net-worth chart whenever two
    /// counted accounts shared a non-base currency: two EUR 7.05 accounts at
    /// 0.85 round to 599 + 599 = 1198 per account, but 1410 x 0.85 = 1198.5 ->
    /// 1199 per currency. Both are defensible in isolation; showing BOTH, in
    /// two places, for the same book, is not.
    ///
    /// Per currency is the one to keep: it rounds once instead of once per
    /// account, so the error cannot grow with the number of accounts, and it is
    /// the ordinary accounting treatment -- total in the source currency, then
    /// convert. It is also what the chart already did, so the chart's history
    /// stays truthful rather than being retroactively re-rounded.
    ///
    /// A balance is still never converted for its own sake: conversion happens
    /// HERE and only here, on a TOTAL, rounded half away from zero exactly
    /// once. Not per transaction (which would round thousands of times and
    /// drift), and never on a sum of mixed currencies (which is not a number).
    ///
    /// THE "NOT COUNTED" TOTAL FOLLOWS THE SAME RULE, for the same reason: it
    /// is a total, it sits on screen beside the headline, and two totals on one
    /// screen rounded two different ways is the defect this change exists to
    /// remove.
    ///
    /// Ported from src/domain/balances.ts `netWorth()`; the two must move
    /// together, and the manifest's `.perCurrency` branch with them.
    public static func netWorth(
        _ balances: [AccountBalance],
        baseCurrency: String,
        rates: RateTable
    ) throws -> NetWorth {
        var missing: [String] = []
        var excludedCount = 0
        // Dictionaries plus the order their keys were first seen: the
        // TypeScript accumulates into Maps, which iterate in insertion order,
        // and `missingRateCurrencies` is documented to be in encounter order.
        // A Swift Dictionary iterates in whatever order it likes, so the order
        // is carried explicitly rather than hoped for.
        var countedOrder: [String] = []
        var counted: [String: Int64] = [:]
        var excludedOrder: [String] = []
        var excluded: [String: Int64] = [:]

        for row in balances {
            if row.account.archived { continue }
            let currency = row.account.currency
            if row.excludedFromNetWorth {
                excludedCount += 1
                if excluded[currency] == nil {
                    excluded[currency] = 0
                    excludedOrder.append(currency)
                }
                let (next, overflowed) = excluded[currency]!.addingReportingOverflow(row.balanceMinor)
                if overflowed { throw MoneyError.overflow("excluded balances in \(currency)") }
                excluded[currency] = next
                continue
            }
            if counted[currency] == nil {
                counted[currency] = 0
                countedOrder.append(currency)
            }
            let (next, overflowed) = counted[currency]!.addingReportingOverflow(row.balanceMinor)
            if overflowed { throw MoneyError.overflow("counted balances in \(currency)") }
            counted[currency] = next
        }

        var total: Int64 = 0
        for currency in countedOrder {
            switch Money.convert(minor: counted[currency]!, from: currency, to: baseCurrency, using: rates) {
            case .converted(let value):
                let (next, overflowed) = total.addingReportingOverflow(value)
                if overflowed { throw MoneyError.overflow("net worth total") }
                total = next
            case .missingRate:
                // Insertion order, and de-duplicated by construction: the
                // TypeScript spreads a Set, which in JavaScript iterates in
                // insertion order.
                missing.append(currency)
            case .notRepresentable:
                // NOT folded into "no rate": there IS a rate, and telling the
                // owner otherwise would send them to the rates screen to fix
                // something that is not broken.
                throw MoneyError.notRepresentable("the \(currency) subtotal")
            }
        }

        // Starts at 0 and LATCHES to nil the moment one excluded currency
        // cannot be converted -- a partial "not counted" total would be a wrong
        // number, and a wrong number is worse than an honest gap (SPEC 6).
        var excludedBase: Int64? = 0
        for currency in excludedOrder {
            switch Money.convert(minor: excluded[currency]!, from: currency, to: baseCurrency, using: rates) {
            case .converted(let value):
                if let running = excludedBase {
                    let (next, overflowed) = running.addingReportingOverflow(value)
                    if overflowed { throw MoneyError.overflow("total of excluded accounts") }
                    excludedBase = next
                }
            case .missingRate:
                excludedBase = nil
            case .notRepresentable:
                throw MoneyError.notRepresentable("the excluded \(currency) subtotal")
            }
        }

        return NetWorth(
            totalBaseMinor: total,
            baseCurrency: baseCurrency,
            missingRateCurrencies: missing,
            excludedCount: excludedCount,
            excludedBaseMinor: excludedBase
        )
    }
}
