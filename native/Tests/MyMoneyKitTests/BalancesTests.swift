// Balances and net worth, beyond what the oracle's books reach.
//
// The oracle pins the answers for three named books. These pin the EDGES: what
// happens when two accounts tie on every sort key, when a total would overflow,
// and when a figure exists but cannot be stated -- the cases a real ledger will
// never reach and a wrong answer would therefore never be noticed in.
import Foundation
import Testing

@testable import MyMoneyKit

struct BalancesTests {

    func account(
        _ id: String, _ currency: String = "GBP", opening: Int64 = 0,
        archived: Bool = false, excluded: Bool = false, sortOrder: Int = 0, name: String = ""
    ) -> Account {
        Account(
            id: id, name: name.isEmpty ? id : name, type: .current, currency: currency,
            openingBalanceMinor: opening, sortOrder: sortOrder,
            archived: archived, excludeFromNetWorth: excluded
        )
    }

    func tx(_ id: String, _ accountId: String, _ amount: Int64, status: TxStatus = .cleared) -> Transaction {
        Transaction(
            id: id, accountId: accountId, date: "2026-08-01", amountMinor: amount,
            currency: "GBP", status: status
        )
    }

    // MARK: - What "not counted" does and does not mean

    @Test("an excluded account keeps its balance, its transactions and its visibility")
    func exclusionOnlyChangesTheTotal() throws {
        let accounts = [
            account("keep", opening: 100_000, sortOrder: 0),
            account("gift", opening: 25_000, excluded: true, sortOrder: 1),
        ]
        let transactions = [tx("t1", "gift", -4_000)]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: transactions)

        // The excluded account is STILL IN THE LIST, with its real balance and
        // its real transaction count. "Not counted" is not "hidden", and the
        // owner must never be unable to find their own money.
        #expect(balances.count == 2)
        #expect(balances[1].account.id == "gift")
        #expect(balances[1].balanceMinor == 21_000)
        #expect(balances[1].txCount == 1)
        #expect(balances[1].excludedFromNetWorth)

        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)
        #expect(netWorth.totalBaseMinor == 100_000)
        #expect(netWorth.excludedCount == 1)
        #expect(netWorth.excludedBaseMinor == 21_000)
    }

    @Test("archived and excluded compose, and an archived account is not double-counted as excluded")
    func archivedAndExcludedCompose() throws {
        let accounts = [
            account("live", opening: 10_000),
            account("archivedOnly", opening: 50_000, archived: true),
            account("excludedOnly", opening: 25_000, excluded: true),
            account("both", opening: 70_000, archived: true, excluded: true),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)

        #expect(netWorth.totalBaseMinor == 10_000)
        // `both` is archived, so it is NOT in excludedCount: it is already out
        // of the total for an older, separate reason and is not on screen next
        // to the headline figure. Counting it again would overstate what the
        // owner can actually see.
        #expect(netWorth.excludedCount == 1)
        #expect(netWorth.excludedBaseMinor == 25_000)
        #expect(accounts.map(Balances.countsTowardNetWorth) == [true, false, false, false])
    }

    // MARK: - Missing rates

    @Test("a missing rate takes one account out of the total and says which currency")
    func missingRateIsSurfaced() throws {
        let accounts = [
            account("gbp", "GBP", opening: 100_000, sortOrder: 0),
            account("chf", "CHF", opening: 20_000, sortOrder: 1),
            account("chf2", "CHF", opening: 5_000, sortOrder: 2),
            account("sek", "SEK", opening: 9_000, sortOrder: 3),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)

        // The honest total is the one that says what is missing from it. Never
        // zero, never the unconverted amount, never a cross rate.
        #expect(netWorth.totalBaseMinor == 100_000)
        // Encounter order, de-duplicated -- CHF appears twice and is named once.
        #expect(netWorth.missingRateCurrencies == ["CHF", "SEK"])
    }

    @Test("the not-counted total latches to nil, rather than quietly omitting an account")
    func excludedTotalLatchesToNil() throws {
        let accounts = [
            account("gbp", "GBP", opening: 100_000, sortOrder: 0),
            account("giftGBP", "GBP", opening: 25_000, excluded: true, sortOrder: 1),
            account("lentCHF", "CHF", opening: 5_000, excluded: true, sortOrder: 2),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)

        #expect(netWorth.totalBaseMinor == 100_000)
        #expect(netWorth.excludedCount == 2)
        // 25000 would be a wrong number wearing a plausible face: it looks like
        // the answer and silently leaves out the Swiss account entirely.
        #expect(netWorth.excludedBaseMinor == nil)
        // And the excluded account's currency is NOT reported as missing from
        // the TOTAL -- it was never going to be in the total.
        #expect(netWorth.missingRateCurrencies.isEmpty)
    }

    @Test("a balance is never converted, only a total is")
    func balancesStayInTheirOwnCurrency() throws {
        let rates = RateTable([FXRateRow(base: "EUR", quote: "GBP", rate: 0.85)])
        let accounts = [account("eur", "EUR", opening: 20_000)]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        #expect(balances[0].balanceMinor == 20_000)          // EUR 200.00, as stored
        let netWorth = try Balances.netWorth(balances, baseCurrency: "GBP", rates: rates)
        #expect(netWorth.totalBaseMinor == 17_000)           // GBP 170.00, at the total
    }

    // MARK: - Ordering

    @Test("accounts tied on sortOrder and name come back in input order, deterministically")
    func sortIsStable() throws {
        // JavaScript's sort has been required to be stable since ES2019;
        // Swift's is not. Without the explicit tiebreak these two would come
        // back in whichever order the sort algorithm happened to leave them,
        // which would make a Swift-written manifest non-reproducible.
        let accounts = [
            account("second", opening: 1, sortOrder: 5, name: "Same"),
            account("first", opening: 2, sortOrder: 5, name: "Same"),
        ]
        for _ in 0..<20 {
            let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
            #expect(balances.map(\.account.id) == ["second", "first"])
        }
    }

    @Test("sortOrder decides before name")
    func sortOrderWinsOverName() throws {
        let accounts = [
            account("z", opening: 0, sortOrder: 0, name: "Zebra"),
            account("a", opening: 0, sortOrder: 1, name: "Aardvark"),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        #expect(balances.map(\.account.name) == ["Zebra", "Aardvark"])
    }

    // MARK: - The edges of Int64

    @Test("a total that would overflow is refused, never wrapped")
    func overflowIsRefused() throws {
        let accounts = [
            account("a", opening: Int64.max),
            account("b", opening: 1),
        ]
        let balances = try Balances.accountBalances(accounts: accounts, transactions: [])
        #expect(throws: MoneyError.self) {
            _ = try Balances.netWorth(balances, baseCurrency: "GBP", rates: .empty)
        }

        // And a single account's own balance, too.
        #expect(throws: MoneyError.self) {
            _ = try Balances.accountBalances(
                accounts: [account("a", opening: Int64.max)],
                transactions: [tx("t1", "a", 1)]
            )
        }
    }

    @Test("a figure that cannot be stated exactly is refused, and not blamed on a missing rate")
    func notRepresentableIsNotAMissingRate() throws {
        // There IS a rate here. Reporting "no exchange rate" would send the
        // owner to the rates screen to fix something that is not broken.
        let rates = RateTable([FXRateRow(base: "AAA", quote: "GBP", rate: 1e300)])
        let balances = try Balances.accountBalances(
            accounts: [account("a", "AAA", opening: 1_000_000)], transactions: []
        )
        #expect(throws: MoneyError.self) {
            _ = try Balances.netWorth(balances, baseCurrency: "GBP", rates: rates)
        }
    }

    @Test("balanceFromAmounts is opening plus the amounts, with no reordering or netting")
    func balanceFromAmounts() throws {
        #expect(try Balances.balanceFromAmounts(100_000, [-4567, -5433]) == 90_000)
        #expect(try Balances.balanceFromAmounts(50_000, []) == 50_000)
        #expect(try Balances.balanceFromAmounts(0, [-1000, -2000]) == -3000)
        #expect(try Balances.balanceFromAmounts(1000, [-1000]) == 0)
        // A negative balance is a real balance (an overdrawn account, a credit
        // card), not an error to clamp at zero.
        #expect(try Balances.balanceFromAmounts(0, [-1]) == -1)
    }
}
