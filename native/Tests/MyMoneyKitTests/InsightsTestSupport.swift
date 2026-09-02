// Scaffolding the insights tests share.
//
// EVERY NAME, DATE AND FIGURE IN THESE SUITES IS INVENTED. Not one of them came
// from the owner's book, and none of them may: the repository is public, and a
// realistic-looking payee name that happened to be a real one would be exactly
// the leak the scrub in 31473c7 removed.
//
// WHAT THE BUILDER IS FOR. Every one of these tests is about a SHAPE -- twelve
// payments a month apart, one of them four days late, one month missing -- and
// the shape is the thing that has to be readable in the test. So the builder
// takes a list of dates and an amount and produces the transactions, and the
// test reads as the sentence it is testing.
//
// THE DATES ARE WRITTEN OUT, NOT GENERATED, wherever the test is about a
// calendar corner (a February, a 31st, a leap year). A generated date is a date
// nobody checked.
import Foundation
import Testing

@testable import MyMoneyKit

/// A book, assembled a line at a time.
struct BookBuilder {
    var accounts: [Account] = []
    var payees: [Payee] = []
    var categories: [MyMoneyKit.Category] = []
    var transactions: [Transaction] = []
    var fxRates: [FxRate] = []
    var baseCurrency = "GBP"

    private var serial = 0

    /// An account. Everything defaults to the boring case.
    mutating func account(
        _ id: String, currency: String = "GBP", opening: Int64 = 0, type: AccountType = .current,
        archived: Bool = false, excluded: Bool? = nil, name: String? = nil
    ) {
        accounts.append(
            Account(
                id: id, name: name ?? "Account \(id)", type: type, currency: currency,
                openingBalanceMinor: opening, colour: "#123456", groupId: nil,
                sortOrder: accounts.count, archived: archived, excludeFromNetWorth: excluded
            )
        )
    }

    private mutating func payeeId(for name: String) -> String {
        let key = Names.key(name)
        if let existing = payees.first(where: { Names.key($0.name) == key }) { return existing.id }
        let id = "payee-\(payees.count)"
        payees.append(Payee(id: id, name: name))
        return id
    }

    /// Money OUT: `amount` is a positive magnitude and is stored negative,
    /// which is how the ledger carries it.
    @discardableResult
    mutating func pay(
        _ payee: String, _ amount: Int64, on dates: [String], account: String = "a1",
        currency: String = "GBP", batch: String? = nil, status: TxStatus = .cleared,
        hash: String? = nil
    ) -> [String] {
        dates.map {
            add(
                payee: payee, amount: -amount, date: $0, account: account, currency: currency,
                batch: batch, status: status, hash: hash
            )
        }
    }

    /// One payment at a time, when the amounts differ.
    @discardableResult
    mutating func pay(
        _ payee: String, amounts: [Int64], on dates: [String], account: String = "a1",
        currency: String = "GBP"
    ) -> [String] {
        precondition(amounts.count == dates.count, "one amount per date")
        return zip(amounts, dates).map { amount, date in
            add(payee: payee, amount: -amount, date: date, account: account, currency: currency)
        }
    }

    /// Money IN -- a salary, a refund. Stored positive.
    @discardableResult
    mutating func receive(
        _ payee: String, _ amount: Int64, on dates: [String], account: String = "a1",
        currency: String = "GBP"
    ) -> [String] {
        dates.map {
            add(payee: payee, amount: amount, date: $0, account: account, currency: currency)
        }
    }

    /// A transfer: two legs, one group id, no payee. Not a payment to anyone.
    mutating func transfer(
        _ amount: Int64, from: String, to: String, on dates: [String], currency: String = "GBP"
    ) {
        for date in dates {
            let group = "xfer-\(serial)"
            _ = add(
                payee: nil, amount: -amount, date: date, account: from, currency: currency,
                transferGroupId: group
            )
            _ = add(
                payee: nil, amount: amount, date: date, account: to, currency: currency,
                transferGroupId: group
            )
        }
    }

    @discardableResult
    mutating func add(
        payee: String?, amount: Int64, date: String, account: String = "a1",
        currency: String = "GBP", transferGroupId: String? = nil, batch: String? = nil,
        status: TxStatus = .cleared, hash: String? = nil, notes: String = ""
    ) -> String {
        let id = "tx-\(String(format: "%04d", serial))"
        serial += 1
        var resolvedPayee: String? = nil
        if let payee { resolvedPayee = payeeId(for: payee) }
        transactions.append(
            Transaction(
                id: id,
                accountId: account,
                date: date,
                amountMinor: amount,
                currency: currency,
                payeeId: resolvedPayee,
                categoryId: nil,
                tagIds: [],
                notes: notes,
                status: status,
                splits: [],
                transferGroupId: transferGroupId,
                importBatchId: batch,
                dedupeHash: hash ?? "h-\(id)",
                createdAt: "\(date)T09:00:00.000Z",
                updatedAt: "\(date)T09:00:00.000Z"
            )
        )
        return id
    }

    mutating func rate(_ base: String, _ quote: String, _ value: Double) {
        fxRates.append(FxRate(base: base, quote: quote, rate: value, asOf: "2026-01-01"))
    }

    func book() -> Book {
        Book(
            accounts: accounts.isEmpty
                ? [
                    Account(
                        id: "a1", name: "Account a1", type: .current, currency: "GBP",
                        openingBalanceMinor: 0, colour: "#123456", groupId: nil, sortOrder: 0,
                        archived: false, excludeFromNetWorth: nil
                    )
                ] : accounts,
            accountGroups: [],
            transactions: transactions,
            categories: categories,
            payees: payees,
            tags: [],
            budgets: [],
            fxRates: fxRates,
            importBatches: [],
            settings: nil,
            baseCurrency: baseCurrency
        )
    }
}

enum Dates {
    /// `count` dates one month apart from `start`, on the same day of the
    /// month -- clamped by the calendar exactly as a real direct debit is.
    static func monthly(from start: String, count: Int) -> [String] {
        stepped(from: start, count: count) { $0.addingMonths(1) }
    }

    static func everyDays(_ days: Int, from start: String, count: Int) -> [String] {
        stepped(from: start, count: count) { $0.addingDays(days) }
    }

    static func quarterly(from start: String, count: Int) -> [String] {
        stepped(from: start, count: count) { $0.addingMonths(3) }
    }

    static func yearly(from start: String, count: Int) -> [String] {
        stepped(from: start, count: count) { $0.addingYears(1) }
    }

    private static func stepped(
        from start: String, count: Int, _ next: (CalendarDate) -> CalendarDate
    ) -> [String] {
        guard var date = CalendarDate(iso: start) else { return [] }
        var out: [String] = []
        for _ in 0..<count {
            out.append(date.iso)
            date = next(date)
        }
        return out
    }

    /// Move one date in a list by `days`, so a test can say "and that one was
    /// three days late" without rewriting the list.
    static func shifting(_ dates: [String], index: Int, by days: Int) -> [String] {
        var out = dates
        guard let date = CalendarDate(iso: dates[index]) else { return out }
        out[index] = date.addingDays(days).iso
        return out
    }
}

extension RecurringSeries {
    /// The payments that filled a slot, which is what "12 payments" means.
    var scheduled: [SeriesOccurrence] { occurrences.filter { $0.role == .onSchedule } }
}

extension InsightsReport {
    func series(payee: String) -> RecurringSeries? {
        recurring.first { $0.payeeName == payee }
    }
}
