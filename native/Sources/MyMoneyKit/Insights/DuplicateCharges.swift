// Payments that look like one payment recorded twice.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SENTENCE THIS FILE IS NOT ALLOWED TO PRODUCE: "you were charged twice".
//
// This app has never seen a bank. It has seen a ledger, which is a file that
// was imported -- possibly twice -- from an app that was itself importing from
// somewhere. When two identical rows sit next to each other, the possibilities
// in rough order of likelihood are:
//
//   1. the file was imported twice, or a row was entered twice by hand;
//   2. it genuinely happened twice (two coffees, two tickets, a top-up);
//   3. the payee really did take the money twice.
//
// Only the third is worth a phone call, and it is the least likely of the
// three. So this file states WHAT MATCHED and hands over every fact it has
// about where the two rows came from, and the screen shows those facts instead
// of a verdict. A false "you were charged twice" costs an hour on hold and a
// conversation in which the customer is wrong; that is a much worse outcome
// than a row that says "two payments, same amount, same day -- here they are".
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO COFFEES ARE NOT A DUPLICATE, AND THE DATA SAYS SO ITSELF.
//
// The rule is not a price threshold -- there is no honest way to say £4.50 is
// too small to be duplicated. It is the owner's own history: if this payee has
// several same-day pairs across the years, then two on one day is what this
// payee looks like, and the row is filed under "this happens here routinely"
// instead of under "unusual". The threshold is a count of PRIOR OCCASIONS, not
// an opinion about coffee.
//
// The evidence that actually distinguishes a double import is carried too:
//
//   * SAME DEDUPE KEY. Two rows the importer would consider indistinguishable.
//     The importer skips an exact duplicate WITHIN one file, so two rows with
//     the same key mean two different imports, or a hand-entered copy.
//   * DIFFERENT IMPORT BATCHES. The two rows arrived from two different files.
//     That is what importing the same statement twice looks like.
//   * SAME IMPORT BATCH. They came from one file -- so the file itself
//     contained both, which is evidence AGAINST a double import.
import Foundation

/// One of the transactions in a suspicion, resolved for display.
public struct DuplicateSide: Sendable, Hashable, Identifiable {
    public let id: String
    public let date: String
    public let amountMinor: Int64
    public let currency: String
    public let accountName: String
    public let payeeName: String
    public let notes: String
    public let status: TxStatus
    public let importBatchId: String?
    public let dedupeHash: String
}

/// Two or more payments that match. NEVER "a duplicate charge": a match.
public struct DuplicateSuspicion: Sendable, Hashable, Identifiable {
    public let id: String
    public let accountId: String
    public let accountName: String
    public let payeeName: String
    public let currency: String
    /// The amount all of them share, as a positive magnitude.
    public let amountMinor: Int64
    /// Ascending by date, then by id.
    public let transactions: [DuplicateSide]
    /// 0 when they are all on one day, 1 when a day apart, and so on.
    public let spanDays: Int
    /// All of them carry the same dedupe key: indistinguishable to the
    /// importer.
    public let sameDedupeKey: Bool
    /// They came from more than one import. What importing a statement twice
    /// looks like.
    public let differentImportBatches: Bool
    /// They all came from ONE import, which is evidence against a double
    /// import.
    public let sameImportBatch: Bool
    /// At least one of them was entered by hand rather than imported.
    public let someEnteredByHand: Bool
    /// How many OTHER occasions this payee has a same-amount cluster on. High
    /// means this is normal here.
    public let otherOccasionsForThisPayee: Int
    /// True when this payee does this routinely, so the screen can file it
    /// under "normal for this payee" instead of "unusual".
    public let routineForThisPayee: Bool

    public var count: Int { transactions.count }
}

public struct DuplicateFindings: Sendable {
    /// Matches at payees where this does NOT normally happen. Amount
    /// descending, then most recent first.
    public let unusual: [DuplicateSuspicion]
    /// Matches at payees where it happens all the time -- two coffees, two
    /// fares. Listed, not hidden, and never described as unusual.
    public let routine: [DuplicateSuspicion]
    /// Payments skipped because they carry no payee, so there was no identity
    /// to match on.
    public let withoutPayeeSkipped: Int
}

public struct DuplicateRules: Sendable, Hashable {
    /// How many days apart two payments may be and still be one suspicion.
    /// "Same or adjacent day" -- a payment posted just after midnight lands on
    /// the next date.
    public var maximumDaysApart = 1
    /// Prior occasions at this payee before it is called routine. Three is
    /// deliberately low: twice could still be chance, and the consequence of
    /// calling something routine is only that it moves down the screen.
    public var routineOccasions = 3
    public static let standard = DuplicateRules()
}

public enum DuplicateCharges {

    public static func find(book: Book, rules: DuplicateRules = .standard) -> DuplicateFindings {
        var accountNames: [String: String] = [:]
        for account in book.accounts { accountNames[account.id] = account.name }
        var payeeNames: [String: String] = [:]
        for payee in book.payees { payeeNames[payee.id] = payee.name }

        struct Row {
            let tx: Transaction
            let date: CalendarDate
            let magnitude: Int64
            let payeeName: String
            let payeeKey: String
        }

        var withoutPayee = 0
        var rows: [Row] = []
        for tx in book.transactions {
            // A transfer leg is not a payment to anyone, and both legs of one
            // transfer are the same money -- exactly the false positive this
            // whole screen must not produce.
            if tx.transferGroupId != nil { continue }
            if tx.amountMinor >= 0 { continue }
            guard tx.amountMinor > Int64.min else { continue }
            guard let payeeId = tx.payeeId, let name = payeeNames[payeeId], !Names.isBlank(name)
            else {
                withoutPayee += 1
                continue
            }
            guard let date = CalendarDate(iso: tx.date) else { continue }
            rows.append(
                Row(
                    tx: tx, date: date, magnitude: -tx.amountMinor, payeeName: name,
                    payeeKey: Dedupe.normalizeForHash(name)
                )
            )
        }

        // SAME ACCOUNT, SAME PAYEE, SAME AMOUNT. Three exact keys rather than
        // anything fuzzy: this screen's whole value is precision, and a
        // near-match on the amount would produce pairs that are simply two
        // different payments.
        var buckets: [String: [Row]] = [:]
        var order: [String] = []
        for row in rows {
            let key = "\(row.tx.accountId)\u{0000}\(row.payeeKey)\u{0000}\(row.magnitude)"
            if buckets[key] == nil { order.append(key) }
            buckets[key, default: []].append(row)
        }

        // Clusters first, so "how often does this payee do this" can be
        // answered before deciding what to call any one of them.
        var clusters: [(key: String, rows: [Row])] = []
        for key in order {
            let sorted = buckets[key]!.sorted {
                $0.date != $1.date ? $0.date < $1.date : $0.tx.id < $1.tx.id
            }
            var current: [Row] = []
            for row in sorted {
                if let previous = current.last,
                    row.date.daysSince(previous.date) > rules.maximumDaysApart
                {
                    if current.count > 1 { clusters.append((key, current)) }
                    current = []
                }
                current.append(row)
            }
            if current.count > 1 { clusters.append((key, current)) }
        }

        var occasionsByPayee: [String: Int] = [:]
        for cluster in clusters {
            occasionsByPayee[cluster.rows[0].payeeKey, default: 0] += 1
        }

        var unusual: [DuplicateSuspicion] = []
        var routine: [DuplicateSuspicion] = []
        for cluster in clusters {
            let rows = cluster.rows
            let first = rows[0]
            let others = (occasionsByPayee[first.payeeKey] ?? 1) - 1
            let isRoutine = others >= rules.routineOccasions
            let batches = Set(rows.compactMap(\.tx.importBatchId))
            let hashes = Set(rows.map(\.tx.dedupeHash))
            let suspicion = DuplicateSuspicion(
                id: rows.map(\.tx.id).sorted().joined(separator: "|"),
                accountId: first.tx.accountId,
                accountName: accountNames[first.tx.accountId] ?? "Unknown account",
                payeeName: rows[rows.count - 1].payeeName,
                currency: first.tx.currency,
                amountMinor: first.magnitude,
                transactions: rows.map { row in
                    DuplicateSide(
                        id: row.tx.id, date: row.tx.date, amountMinor: row.tx.amountMinor,
                        currency: row.tx.currency,
                        accountName: accountNames[row.tx.accountId] ?? "Unknown account",
                        payeeName: row.payeeName, notes: row.tx.notes, status: row.tx.status,
                        importBatchId: row.tx.importBatchId, dedupeHash: row.tx.dedupeHash
                    )
                },
                spanDays: rows[rows.count - 1].date.daysSince(first.date),
                // An empty hash is "this row never carried one", not "they
                // match": a book written before dedupe hashes existed must not
                // read as a book full of duplicates.
                sameDedupeKey: hashes.count == 1 && !(hashes.first ?? "").isEmpty,
                differentImportBatches: batches.count > 1,
                sameImportBatch: batches.count == 1 && rows.allSatisfy { $0.tx.importBatchId != nil },
                someEnteredByHand: rows.contains { $0.tx.importBatchId == nil },
                otherOccasionsForThisPayee: others,
                routineForThisPayee: isRoutine
            )
            if isRoutine {
                routine.append(suspicion)
            } else {
                unusual.append(suspicion)
            }
        }

        // Biggest first: the amount is what decides whether this is worth
        // anybody's afternoon. Then most recent, then by id so the order never
        // changes between two looks at the same book.
        func ranked(_ list: [DuplicateSuspicion]) -> [DuplicateSuspicion] {
            list.sorted { lhs, rhs in
                if lhs.amountMinor != rhs.amountMinor { return lhs.amountMinor > rhs.amountMinor }
                let lastLeft = lhs.transactions[lhs.transactions.count - 1].date
                let lastRight = rhs.transactions[rhs.transactions.count - 1].date
                if lastLeft != lastRight { return lastLeft > lastRight }
                return lhs.id < rhs.id
            }
        }

        return DuplicateFindings(
            unusual: ranked(unusual), routine: ranked(routine), withoutPayeeSkipped: withoutPayee
        )
    }
}
