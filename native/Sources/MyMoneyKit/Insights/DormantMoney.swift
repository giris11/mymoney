// Money sitting in an account nobody has touched.
//
// The simplest thing on this screen and the one most likely to be USEFUL: an
// old current account with £400 in it, a savings account opened for a purpose
// that passed, a card with a small balance still owing. None of them will ever
// announce themselves.
//
// FOUR DECISIONS, all of them stated here rather than in a view:
//
//   1. A YEAR. Six months of quiet on a savings account is not dormancy, it is
//      a savings account. A year means "you have been through a whole cycle of
//      the year without touching this", which is the point at which somebody
//      has genuinely forgotten.
//   2. A BALANCE IN EITHER DIRECTION. A dormant credit card with £80 still
//      owing is exactly as worth surfacing as a current account with £80 in it
//      -- more so, because it may be quietly accruing interest. Both are
//      reported, and the sign is carried so the screen can use the right word.
//   3. NOT ARCHIVED. Archiving is the owner SAYING "I am done with this". An
//      archived account with a balance is still shown -- separately, and
//      counted -- because "I retired this and left money in it" is a thing
//      worth knowing, but it is not a surprise and it does not belong at the
//      top of a list of surprises.
//   4. THE BALANCE IS THE ACCOUNT'S OWN, in the account's own currency, never
//      converted (Balances' rule). The conversion happens once, at the total,
//      and a currency with no rate is named rather than dropped.
import Foundation

public struct DormantAccount: Sendable, Hashable, Identifiable {
    public var id: String { account.id }
    public let account: Account
    /// Opening balance plus every transaction, in the ACCOUNT'S currency.
    public let balanceMinor: Int64
    /// The most recent transaction on the account. nil when it has none at all
    /// -- an account holding an opening balance and nothing else.
    public let lastActivityDate: String?
    /// Days from that to today. nil when there has never been any activity,
    /// because "how long since something that never happened" has no answer and
    /// this app does not invent one.
    public let daysSinceActivity: Int?
    public let transactionCount: Int
    /// The same balance in base currency, or nil when no rate joins them.
    public let baseMinor: Int64?
    /// Flags carried through so the screen can say them rather than re-derive
    /// them: an excluded account is real money that the net-worth total does
    /// not count, and that is worth repeating here.
    public let excludedFromNetWorth: Bool
    public let isArchived: Bool

    /// Money owed rather than money held.
    public var isOwed: Bool { balanceMinor < 0 }
}

public struct DormantFindings: Sendable {
    /// Live accounts, longest-quiet first.
    public let accounts: [DormantAccount]
    /// Archived accounts that still hold something. Reported separately: the
    /// owner already said they were done with these.
    public let archived: [DormantAccount]
    /// Total of the live ones in base currency.
    ///
    /// THE SAME RULE AS `Balances.netWorth`, deliberately: an account whose
    /// currency has no rate is left OUT of the total and its currency is NAMED,
    /// rather than the whole figure refusing to exist. That is the convention
    /// the rest of this app already follows, and the row itself is on the
    /// screen either way, in its own currency, so nothing is hidden by it.
    /// nil only when the addition itself could not be stated.
    public let totalBaseMinor: Int64?
    /// How many accounts that total covers, so the screen can say "£420 across
    /// 3 accounts" rather than implying it covers all of them.
    public let accountsCounted: Int
    /// Accounts left out of the total for want of a rate.
    public let accountsWithoutRate: Int
    public let baseCurrency: String
    /// Currencies left out of that total for want of a rate, sorted.
    public let missingRateCurrencies: [String]
}

public struct DormantRules: Sendable, Hashable {
    /// Quiet for this long before an account is called dormant.
    public var quietDays = 365
    /// The smallest balance worth a row, in MAJOR units. Below one pound an
    /// account is not forgotten money, it is a rounding.
    public var minimumMajorUnits: Int64 = 1
    public static let standard = DormantRules()

    public func minimumMinor(currency: String) -> Int64 {
        Money.minorFactor(for: currency) * minimumMajorUnits
    }
}

public enum DormantMoney {

    public static func find(
        book: Book, today: String, rules: DormantRules = .standard
    ) throws -> DormantFindings {
        guard let todayDate = CalendarDate(iso: today) else {
            throw DomainError.invalidDate(today)
        }
        let rates = book.rateTable
        let base = book.baseCurrency

        var lastByAccount: [String: String] = [:]
        var countByAccount: [String: Int] = [:]
        for tx in book.transactions {
            countByAccount[tx.accountId, default: 0] += 1
            if let existing = lastByAccount[tx.accountId], existing >= tx.date { continue }
            lastByAccount[tx.accountId] = tx.date
        }

        var live: [DormantAccount] = []
        var archived: [DormantAccount] = []
        for balance in try book.accountBalances() {
            let account = balance.account
            if abs(balance.balanceMinor) < rules.minimumMinor(currency: account.currency) {
                continue
            }
            let lastDate = lastByAccount[account.id]
            var quietFor: Int? = nil
            if let lastDate {
                guard let last = CalendarDate(iso: lastDate) else { continue }
                let days = todayDate.daysSince(last)
                // A future-dated transaction means the account is anything but
                // forgotten. Negative days are not dormancy.
                if days < rules.quietDays { continue }
                quietFor = days
            }
            let converted = Money.convert(
                minor: balance.balanceMinor, from: account.currency, to: base, using: rates
            ).minor
            let row = DormantAccount(
                account: account,
                balanceMinor: balance.balanceMinor,
                lastActivityDate: lastDate,
                daysSinceActivity: quietFor,
                transactionCount: countByAccount[account.id] ?? 0,
                baseMinor: converted,
                excludedFromNetWorth: balance.excludedFromNetWorth,
                isArchived: account.archived
            )
            if account.archived {
                archived.append(row)
            } else {
                live.append(row)
            }
        }

        // Longest quiet first; an account with no transactions at all has no
        // "how long", so it sorts to the top -- it is the most forgotten thing
        // there is. Then by size, then by name, so the order is total.
        func ranked(_ list: [DormantAccount]) -> [DormantAccount] {
            list.sorted { lhs, rhs in
                let left = lhs.daysSinceActivity ?? Int.max
                let right = rhs.daysSinceActivity ?? Int.max
                if left != right { return left > right }
                if abs(lhs.balanceMinor) != abs(rhs.balanceMinor) {
                    return abs(lhs.balanceMinor) > abs(rhs.balanceMinor)
                }
                return DisplayOrder.nameLess(lhs.account.name, rhs.account.name)
            }
        }

        var total: Int64? = 0
        var counted = 0
        var withoutRate = 0
        var missing = Set<String>()
        for row in live {
            guard let value = row.baseMinor else {
                missing.insert(row.account.currency)
                withoutRate += 1
                continue
            }
            counted += 1
            guard let running = total else { continue }
            let (next, overflowed) = running.addingReportingOverflow(value)
            total = overflowed ? nil : next
        }

        return DormantFindings(
            accounts: ranked(live),
            archived: ranked(archived),
            totalBaseMinor: total,
            accountsCounted: counted,
            accountsWithoutRate: withoutRate,
            baseCurrency: base,
            missingRateCurrencies: missing.sorted(by: jsStringLess)
        )
    }
}
