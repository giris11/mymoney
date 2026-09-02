// Finding the payments that repeat, and refusing to find the ones that do not.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS FILE IS ALLOWED TO CLAIM.
//
// It says "these payments form a pattern" and nothing else. It never says
// "subscription": whether a repeating payment is a subscription, a rent, a
// standing order to a relative or a season ticket is a fact about a CONTRACT,
// and this app has only ever seen a ledger. Rent repeats monthly and is not a
// subscription; the honest word for both is "recurring payment", so that is the
// only word used. Nothing here has to guess, and so nothing here does.
//
// MONEY IN IS NOT CONSIDERED AT ALL. A salary is the most regular thing in most
// people's records and it is not something you pay, so the whole income side is
// excluded before any pattern is looked for. That is the first and cheapest
// defence against the most obvious false positive there is, and it is a rule
// rather than a threshold: no salary can ever appear here, however regular.
//
// TRANSFERS ARE NOT CONSIDERED. A standing monthly move from current to savings
// is not a payment to anyone (D13 already says a transfer leg is not flow).
//
// ─────────────────────────────────────────────────────────────────────────────
// HOW A PATTERN IS DECIDED, and why it is anchored at the END.
//
// The dates are matched against a grid of expected days built BACKWARDS from
// the most recent payment. Not forwards from the first, and not from the gaps
// between consecutive payments, and both of those alternatives were rejected
// for the same reason: SLIP DOES NOT ACCUMULATE. A bill due on the 1st that is
// taken on Monday the 3rd this month is due on the 1st again next month. Gap
// arithmetic would carry the two days forward and, after a year of weekends,
// would decide the series had drifted out of its own pattern. Every slot in the
// grid is measured from the anchor, so a slipped payment costs that slot two
// days of tolerance and costs the next slot nothing.
//
// Anchoring at the LAST payment rather than the first means the pattern
// describes what is happening NOW. A subscription whose billing date moved in
// 2019 is reported as the run it has been in since, with the older payments
// listed as "earlier payments to this payee that are not part of this pattern"
// -- visible, counted, and not silently folded into a confidence figure.
//
// THREE THINGS ARE COUNTED, and the confidence is made of them:
//
//   * MATCHED  -- a slot with a payment in it.
//   * MISSED   -- a slot inside the run with nothing in it. One missed month is
//                 a failed card; two in a row ends the run, because at that
//                 point what is being described is a different arrangement.
//   * EXTRA    -- a payment inside the run that no slot wanted. This is the one
//                 that stops a supermarket looking like a subscription: shopping
//                 twice in a week puts a payment where the grid has no slot, and
//                 enough of those makes the pattern fail.
//
// ─────────────────────────────────────────────────────────────────────────────
// TWO IS NOT THREE. Two payments a month apart is one gap, and one gap is a
// coincidence -- your dentist, twice. Those come back separately, as `pairs`,
// with the interval stated and no next-payment date, and the screen says which
// they are. Three payments at a consistent interval is a pattern, and that is
// the smallest thing this file will call one.
import Foundation

// MARK: - What comes out

/// How sure the app is, in four words the UI must render differently.
///
/// `pair` is deliberately part of the same scale rather than a separate flag:
/// it is the LOWEST confidence there is, and a screen that sorts by confidence
/// must put it at the bottom without being told to.
public enum SeriesConfidence: String, Sendable, Hashable, Comparable, CaseIterable {
    case pair
    case low
    case medium
    case high

    private var rank: Int {
        switch self {
        case .pair: return 0
        case .low: return 1
        case .medium: return 2
        case .high: return 3
        }
    }

    public static func < (lhs: SeriesConfidence, rhs: SeriesConfidence) -> Bool {
        lhs.rank < rhs.rank
    }

    /// The word the screen shows. "Possible" and "unclear" are chosen over
    /// "low confidence" because they say what to DO with the row.
    public var label: String {
        switch self {
        case .pair: return "Only twice"
        case .low: return "Possible"
        case .medium: return "Likely"
        case .high: return "Clear"
        }
    }
}

/// How much the amount moves about. A classification for choosing words, never
/// an input to money arithmetic.
public enum AmountStability: String, Sendable, Hashable {
    /// Every payment at the current price is the same to the penny.
    case exact
    /// Within a few percent -- a subscription with a rounding or an FX fee.
    case steady
    /// A bill that genuinely varies: a utility, a phone with usage on it.
    case varies
    /// THE LAST PAYMENT WAS THE FIRST AT THIS AMOUNT, so there is no price yet
    /// -- only a new figure that may or may not be one.
    ///
    /// This case exists because of a bug, and the bug is worth recording. The
    /// price levels are worked out first, and stability was then read off the
    /// MOST RECENT level -- which, when the last payment differs from the ones
    /// before it, is a level of exactly one payment with a spread of zero. Zero
    /// spread reads as "the same to the penny", so a payee with five unrelated
    /// amounts could be described as having an exact price. Running four
    /// hundred invented payees of random amounts through the detector produced
    /// eight confident-looking series, and every single one of them had a
    /// one-payment level at the end.
    ///
    /// One payment is not a price. A series in this state is held to the same
    /// strict standard as one whose amount varies, and it is never called
    /// clear -- but it is worth saying out loud rather than hiding, because
    /// "£10.99, and that is the first payment at that amount" is exactly what
    /// somebody wants to know the month after a rise.
    case unsettled

    /// Is there a settled price to state, or only a figure?
    public var isSettled: Bool { self == .exact || self == .steady }
}

/// Where one payment sits in the pattern.
public enum OccurrenceRole: String, Sendable, Hashable {
    /// It filled a slot in the grid.
    case onSchedule
    /// It is inside the run but no slot wanted it.
    case extra
    /// It is older than the run this pattern describes.
    case earlier
}

/// One payment, with everything the detail screen needs to show its working.
public struct SeriesOccurrence: Sendable, Hashable, Identifiable {
    /// The transaction id, so a tap can open the transaction itself.
    public let id: String
    public let date: String
    /// The day the grid expected, for an on-schedule payment.
    public let expectedDate: String?
    /// date − expectedDate. Positive is late. 0 for anything not on schedule.
    public let slipDays: Int
    public let role: OccurrenceRole
    /// Signed, as the transaction carries it (negative is money out).
    public let amountMinor: Int64
    /// The same amount as a positive magnitude, which is what a price is.
    public let magnitudeMinor: Int64
    public let currency: String
    public let accountId: String
    public let accountName: String
    /// The payee name as recorded on THIS transaction. Kept per-payment because
    /// a series can span a rename, and the rename is evidence.
    public let payeeName: String
}

/// The counts behind the confidence, so the screen can print them instead of
/// asking to be believed.
public struct SeriesEvidence: Sendable, Hashable {
    public let matched: Int
    public let missed: Int
    public let extras: Int
    /// The expected days nothing landed on, so the screen can name the month
    /// that was skipped rather than saying "one missed".
    public let missedDates: [String]
    public let toleranceDays: Int
    /// The typical distance from the expected day, in days. 0 means it lands on
    /// the day every time.
    public let typicalSlipDays: Int
    public let worstSlipDays: Int
    /// Payments to this payee older than the run.
    public let earlierPayments: Int
    /// Payments to this payee inside the run's dates that this pattern is NOT
    /// about -- non-zero only for a series picked out of a payee's other
    /// spending by amount. The detail screen must say so.
    public let otherPaymentsInRun: Int

    /// matched / (matched + missed): how complete the run is.
    public var coverage: Double {
        let total = matched + missed
        return total == 0 ? 0 : Double(matched) / Double(total)
    }

    /// matched / (matched + extras): how much of what is there the pattern
    /// actually explains.
    public var cleanliness: Double {
        let total = matched + extras
        return total == 0 ? 0 : Double(matched) / Double(total)
    }

    /// The two multiplied. One number for ranking; both halves are printed.
    public var fit: Double { coverage * cleanliness }
}

/// Whether the payments are still coming.
public enum SeriesStatus: Sendable, Hashable {
    /// The next one is not due yet, or is due within the usual slip.
    case active
    /// Past its day, but not by a whole period. A card that expired last week
    /// looks exactly like this, and so does a bill taken four days late.
    case due(daysLate: Int)
    /// More than a whole period past due. LOOKS cancelled; is never called
    /// cancelled, because this app cannot see a cancellation.
    case lapsed(daysSinceLast: Int, missedPayments: Int)

    public var isLive: Bool {
        if case .lapsed = self { return false }
        return true
    }
}

/// One repeating payment.
public struct RecurringSeries: Sendable, Hashable, Identifiable {
    public let id: String
    /// The payee name as most recently recorded.
    public let payeeName: String
    /// Earlier spellings folded into this series, newest first. Empty unless a
    /// rename was detected, and shown on the detail screen when it is not.
    public let alsoKnownAs: [String]
    public let currency: String
    /// Every account these payments came from, in first-seen order. More than
    /// one is worth showing: it usually means a card was replaced.
    public let accountIds: [String]
    public let accountNames: [String]
    public let cadence: Cadence
    public let confidence: SeriesConfidence
    public let status: SeriesStatus
    /// Ascending by date. Includes the extras and the earlier payments, each
    /// labelled by `role` -- this is the evidence, so nothing is left out of it.
    public let occurrences: [SeriesOccurrence]
    public let firstDate: String
    public let lastDate: String
    /// One period after the last payment. For a pair this is nil: two payments
    /// do not predict a third.
    public let nextExpectedDate: String?
    /// The typical payment at the CURRENT price, as a positive magnitude.
    public let typicalAmountMinor: Int64
    public let lastAmountMinor: Int64
    public let stability: AmountStability
    /// The prices this payment has been at, oldest first.
    public let levels: [PriceLevel]
    /// The steps between those prices.
    public let changes: [PriceChange]
    public let evidence: SeriesEvidence
    /// typicalAmount × the cadence's payments-a-year, in the series' own
    /// currency. An ESTIMATE whenever `stability == .varies`.
    public let annualCostMinor: Int64
    /// True when this pattern was picked out of a payee's other spending by
    /// amount rather than found in everything they were paid. The screen says
    /// so, because it is a weaker claim.
    public let foundAmongOtherSpending: Bool

    /// The most recent price level.
    public var currentLevel: PriceLevel? { levels.last }

    /// The most recent step, when there is one.
    public var latestChange: PriceChange? { changes.last }

    /// Is the annual figure an estimate rather than a multiplication of one
    /// known price?
    public var annualCostIsEstimate: Bool { stability == .varies }
}

/// What was looked at and what was not. Printed on the screen: an insights
/// screen that does not say what it ignored is inviting the reader to assume it
/// ignored nothing.
public struct RecurrenceCoverage: Sendable, Hashable {
    public let paymentsConsidered: Int
    public let transfersSkipped: Int
    public let moneyInSkipped: Int
    public let withoutPayeeSkipped: Int
    /// Payments that could not be read at all -- a date this app cannot parse,
    /// or an amount with no positive magnitude.
    ///
    /// SEPARATE FROM `withoutPayeeSkipped` on purpose, even though it should
    /// always be zero: a book that reached this code came through an importer
    /// that validates every date. Counting these as "no payee" would put a
    /// sentence on the screen that was not true, and the whole feature is
    /// built on not doing that.
    public let unreadableSkipped: Int
    public let payeesSeen: Int
    public let payeesWithOnePayment: Int
    /// Payee groups with enough payments to have a pattern, that did not have
    /// one. The most important number here: it is the count of things this
    /// screen deliberately did not claim.
    public let payeesWithNoPattern: Int
    public let earliestDate: String?
    public let latestDate: String?
}

public struct RecurrenceResult: Sendable {
    /// Patterns: three payments or more.
    public let series: [RecurringSeries]
    /// Exactly two payments, one gap. Never mixed in with the patterns.
    public let pairs: [RecurringSeries]
    public let coverage: RecurrenceCoverage
}

// MARK: - The thresholds

/// Every number the detector uses, named, in one place.
///
/// They are `var`s on a value type so a test can move ONE of them and see what
/// it was holding back; the app never does. `.standard` is what ships.
public struct RecurrenceRules: Sendable, Hashable {
    /// Two empty slots in a row ends the run. One missed payment is a failed
    /// card; two is a different arrangement.
    public var maxConsecutiveMisses = 2
    /// Three payments is the smallest pattern. Two is a coincidence.
    public var minimumOccurrences = 3
    /// Below this fit nothing is claimed at all.
    public var minimumFit = 0.6
    public var mediumOccurrences = 4
    public var mediumFit = 0.8
    public var highOccurrences = 6
    public var highFit = 0.9
    /// Three payments can still be a pattern -- but only a perfect one.
    public var perfectFit = 0.99

    /// Spread of the current price level, as a fraction of it.
    public var exactSpread = 0.005
    public var steadySpread = 0.15
    /// Beyond this the amounts are not a price at all.
    ///
    /// TWO IS DELIBERATELY GENEROUS: a real gas bill can be £30 in July and
    /// £120 in January, which is a spread well over one, and it IS a monthly
    /// bill. So the amounts are not what rejects a supermarket -- the DATES
    /// are, and a series whose amounts vary this much has to fit its dates
    /// almost perfectly before anything is said about it (see `confidence`).
    public var erraticSpread = 2.0
    /// What a series with a varying amount must reach on the dates before it is
    /// reported at all. Higher than `mediumFit`: with no stable price, the
    /// calendar is the only evidence there is.
    public var variesFit = 0.9

    /// A pair is only reported when its two amounts agree this closely.
    public var pairSpread = 0.02

    /// The share of the payments under consideration that the run must
    /// actually explain.
    ///
    /// Anchoring at the last payment means a run can always be found at the
    /// tail of a stream of irregular payments -- take enough shopping trips and
    /// the last seven will be seven days apart. Requiring the run to account
    /// for a real share of the payee's payments is what separates "this is what
    /// this payee is" from "this is where the phase happened to line up". Set
    /// low enough that a genuine subscription which changed its billing day
    /// half way through is still reported.
    public var minimumRunShare = 0.4

    // Picking a pattern out of a payee's other spending, by amount.
    public var clusterMinimumOccurrences = 4
    public var clusterMinimumFit = 0.9
    /// Amounts within this fraction of each other are the same price.
    public var clusterSpread = 0.1

    // Merging a renamed payee into the series that continued it.
    /// The two names' typical amounts must agree this closely.
    public var renameAmountSpread = 0.25

    public static let standard = RecurrenceRules()
}

// MARK: - The detector

public enum Recurrence {

    /// Every repeating payment in the book, as of `today`.
    ///
    /// `today` is a parameter for the same reason it is one on the dashboard: a
    /// screen that reads the clock itself cannot be tested, and every "next
    /// expected" and "looks cancelled" on one screen must be about the same day.
    public static func detect(
        book: Book, today: String, rules: RecurrenceRules = .standard
    ) throws -> RecurrenceResult {
        guard let todayDate = CalendarDate(iso: today) else {
            throw DomainError.invalidDate(today)
        }

        var accountNames: [String: String] = [:]
        for account in book.accounts { accountNames[account.id] = account.name }
        var payeeNames: [String: String] = [:]
        for payee in book.payees { payeeNames[payee.id] = payee.name }

        var transfers = 0
        var moneyIn = 0
        var withoutPayee = 0
        var unreadable = 0
        var items: [Item] = []
        var earliest: String? = nil
        var latest: String? = nil

        for tx in book.transactions {
            if tx.transferGroupId != nil {
                transfers += 1
                continue
            }
            // Money in is never a recurring PAYMENT. This is where the salary
            // leaves, and it leaves by a rule rather than by a threshold.
            if tx.amountMinor >= 0 {
                moneyIn += 1
                continue
            }
            guard let payeeId = tx.payeeId, let name = payeeNames[payeeId],
                !Names.isBlank(name)
            else {
                withoutPayee += 1
                continue
            }
            guard let date = CalendarDate(iso: tx.date) else {
                // A date this app cannot read is not silently given a day. It
                // is left out of the pattern search and counted as unreadable.
                unreadable += 1
                continue
            }
            // Int64.min has no positive magnitude. Unreachable for real money
            // and refused rather than negated into itself.
            guard tx.amountMinor > Int64.min else {
                unreadable += 1
                continue
            }
            items.append(
                Item(
                    txId: tx.id,
                    date: date,
                    magnitude: -tx.amountMinor,
                    signed: tx.amountMinor,
                    currency: tx.currency,
                    accountId: tx.accountId,
                    accountName: accountNames[tx.accountId] ?? "Unknown account",
                    payeeName: name,
                    payeeKey: Dedupe.normalizeForHash(name)
                )
            )
            if earliest == nil || tx.date < earliest! { earliest = tx.date }
            if latest == nil || tx.date > latest! { latest = tx.date }
        }

        var groups = Self.groups(from: items)
        let payeesSeen = Set(groups.map(\.payeeKey)).count
        let singles = groups.filter { $0.items.count == 1 }.count
        groups = mergeRenamedPayees(groups, rules: rules)

        var series: [RecurringSeries] = []
        var pairs: [RecurringSeries] = []
        var noPattern = 0

        for group in groups {
            if group.items.count < 2 { continue }
            if group.items.count == 2 {
                if let pair = try pair(from: group, rules: rules) {
                    pairs.append(pair)
                } else {
                    // Two unrelated payments to a shop. Not a pattern, not a
                    // pair, not counted as a refusal either -- there was never
                    // enough here to have an opinion about.
                }
                continue
            }
            let found = try patterns(in: group, today: todayDate, rules: rules)
            if found.isEmpty {
                noPattern += 1
            } else {
                series.append(contentsOf: found)
            }
        }

        // A deterministic order, so two runs of the same book cannot present
        // the same rows differently. The screen re-sorts by what it is for.
        series.sort(by: Self.stableOrder)
        pairs.sort(by: Self.stableOrder)

        return RecurrenceResult(
            series: series,
            pairs: pairs,
            coverage: RecurrenceCoverage(
                paymentsConsidered: items.count,
                transfersSkipped: transfers,
                moneyInSkipped: moneyIn,
                withoutPayeeSkipped: withoutPayee,
                unreadableSkipped: unreadable,
                payeesSeen: payeesSeen,
                payeesWithOnePayment: singles,
                payeesWithNoPattern: noPattern,
                earliestDate: earliest,
                latestDate: latest
            )
        )
    }

    private static func stableOrder(_ lhs: RecurringSeries, _ rhs: RecurringSeries) -> Bool {
        if lhs.payeeName != rhs.payeeName {
            return DisplayOrder.nameLess(lhs.payeeName, rhs.payeeName)
        }
        return lhs.id < rhs.id
    }

    // MARK: - One payment, as this file needs it

    struct Item: Sendable, Hashable {
        let txId: String
        let date: CalendarDate
        /// Money out, positive.
        let magnitude: Int64
        let signed: Int64
        let currency: String
        let accountId: String
        let accountName: String
        let payeeName: String
        let payeeKey: String
    }

    /// One payee's payments in one currency.
    ///
    /// THE TWO SUMMARY FIGURES ARE STORED, NOT COMPUTED ON READ. They are asked
    /// for inside a loop that compares every payee with every other one, and
    /// as computed properties -- each sorting a fresh array -- they were most
    /// of a fourteen-second screen on a book with four hundred payees. Measured,
    /// not guessed.
    struct Group: Sendable {
        var payeeKey: String
        /// The name as most recently recorded.
        var payeeName: String
        var currency: String
        /// Earlier names folded in by a rename merge, newest first.
        var alsoKnownAs: [String]
        /// Ascending by date, then by id.
        private(set) var items: [Item]
        /// The typical payment.
        private(set) var medianMagnitude: Int64
        /// The typical number of days between this payee's payments. The
        /// median rather than the mean, so one three-year gap in the middle of
        /// a monthly history does not double it.
        private(set) var typicalGapDays: Int

        init(
            payeeKey: String, payeeName: String, currency: String, alsoKnownAs: [String],
            items: [Item]
        ) {
            self.payeeKey = payeeKey
            self.payeeName = payeeName
            self.currency = currency
            self.alsoKnownAs = alsoKnownAs
            self.items = items
            self.medianMagnitude = PriceSteps.median(items.map(\.magnitude))
            self.typicalGapDays = Self.typicalGap(items)
        }

        mutating func replaceItems(with new: [Item]) {
            items = new
            medianMagnitude = PriceSteps.median(new.map(\.magnitude))
            typicalGapDays = Self.typicalGap(new)
        }

        private static func typicalGap(_ items: [Item]) -> Int {
            guard items.count >= 2 else { return 0 }
            let gaps = (1..<items.count).map {
                Int64(items[$0].date.daysSince(items[$0 - 1].date))
            }
            return PriceSteps.median(gaps).asInt
        }

        var first: Item { items[0] }
        var last: Item { items[items.count - 1] }
    }

    /// Group by normalised payee AND CURRENCY. The currency is part of the key
    /// rather than a detail: a series lives in one currency, and a "£12 a month"
    /// that was sometimes 12 euros is not one payment described twice, it is two
    /// arrangements that must not be added together.
    static func groups(from items: [Item]) -> [Group] {
        var byKey: [String: [Item]] = [:]
        var order: [String] = []
        for item in items {
            let key = "\(item.payeeKey)\u{0000}\(item.currency)"
            if byKey[key] == nil { order.append(key) }
            byKey[key, default: []].append(item)
        }
        return order.map { key in
            let sorted = byKey[key]!.sorted {
                $0.date != $1.date ? $0.date < $1.date : $0.txId < $1.txId
            }
            return Group(
                payeeKey: sorted[sorted.count - 1].payeeKey,
                payeeName: sorted[sorted.count - 1].payeeName,
                currency: sorted[0].currency,
                alsoKnownAs: [],
                items: sorted
            )
        }
    }

    // MARK: - A payee that was renamed

    /// Fold "SPOTIFY" into "Spotify AB" when the evidence says they are one
    /// arrangement recorded under two spellings.
    ///
    /// SIX GATES, and all six have to pass. They are in cost order, cheapest
    /// first, because this is an every-payee-against-every-other comparison and
    /// a decade of a real ledger has hundreds of payees in it.
    ///
    ///   1. Same currency.
    ///   2. BOTH SIDES HAVE AT LEAST TWO PAYMENTS. One payment has no rhythm to
    ///      continue, so folding it into a series adds a data point and no
    ///      evidence -- and one-payment payees are the most numerous thing in a
    ///      real book, which makes this the gate that does the most work.
    ///   3. Their dates DO NOT OVERLAP. Two payees you are paying in the same
    ///      years are two payees, however alike their names -- "Tesco" and
    ///      "Tesco Fuel" are similar strings and are not a rename.
    ///   4. THE SECOND ONE CARRIES ON WHERE THE FIRST STOPPED. The gap between
    ///      them must be no more than twice the later name's own typical
    ///      interval. A rename does not leave a hole: the payments continue,
    ///      under a new spelling. Without this, every pair of similarly-named
    ///      one-off payees years apart is a merge candidate, which is both
    ///      wrong and, on a book with four hundred payees, slow enough to hang
    ///      the screen -- a scale test found exactly that.
    ///   5. Their typical amounts agree to within a quarter.
    ///   6. THE MERGE ACTUALLY EXPLAINS MORE. The combined dates must fit a
    ///      cadence at least as well as the later name did alone, and must
    ///      cover more payments. A merge that made the pattern worse is a merge
    ///      that was wrong, and this catches it without anybody having to
    ///      predict which names would be a problem.
    static func mergeRenamedPayees(_ input: [Group], rules: RecurrenceRules) -> [Group] {
        var groups = input
        var merged = true
        while merged {
            merged = false
            outer: for i in groups.indices {
                for j in groups.indices where j != i {
                    guard groups[i].currency == groups[j].currency else { continue }
                    guard groups[i].items.count >= 2, groups[j].items.count >= 2 else { continue }
                    // `earlier` and `later` by date, whatever order they are in.
                    let (earlier, later) =
                        groups[i].last.date < groups[j].first.date
                        ? (i, j) : (groups[j].last.date < groups[i].first.date ? (j, i) : (-1, -1))
                    guard earlier >= 0 else { continue }  // ranges overlap: two payees
                    let gap = groups[later].first.date.daysSince(groups[earlier].last.date)
                    guard gap <= groups[later].typicalGapDays * 2 else { continue }
                    guard
                        withinSpread(
                            groups[earlier].medianMagnitude, groups[later].medianMagnitude,
                            rules.renameAmountSpread)
                    else { continue }
                    guard looksLikeARename(groups[i].payeeKey, groups[j].payeeKey) else {
                        continue
                    }

                    let combined =
                        (groups[earlier].items + groups[later].items)
                        .sorted { $0.date != $1.date ? $0.date < $1.date : $0.txId < $1.txId }
                    let before = bestFit(groups[later].items, rules: rules)
                    let after = bestFit(combined, rules: rules)
                    guard let after else { continue }
                    let beforeFit = before?.evidenceFit ?? 0
                    let beforeMatched = before?.matchedIndices.count ?? 0
                    guard after.evidenceFit + 1e-9 >= beforeFit, after.matchedIndices.count > beforeMatched
                    else { continue }

                    var kept = groups[later]
                    kept.replaceItems(with: combined)
                    kept.alsoKnownAs = ([groups[earlier].payeeName] + groups[earlier].alsoKnownAs
                        + groups[later].alsoKnownAs).reduced()
                    groups[later] = kept
                    groups.remove(at: earlier)
                    merged = true
                    break outer
                }
            }
        }
        return groups
    }

    /// Are these two normalised names the same name, spelled differently?
    ///
    /// It is `Dedupe.similarPayee`'s rule -- the one the importer already uses
    /// to spot a near-duplicate -- with ONE EXCEPTION ADDED, and the exception
    /// was found by putting four hundred invented payees through the detector
    /// and watching a dozen of them merge into each other:
    ///
    ///     TWO NAMES THAT DIFFER ONLY IN THEIR DIGITS ARE NOT A RENAME.
    ///
    /// "Payee number 3" and "Payee number 30" are similar strings by every
    /// string measure there is -- one is a prefix of the other -- and they are
    /// obviously two different payees. Real ledgers are full of the same shape:
    /// "UBER TRIP 4821" and "UBER TRIP 4822", "INVOICE 1001" and "INVOICE
    /// 1002", a card number in a description. Merging any of those would put
    /// two unrelated payments in one series and then say something confident
    /// about the pair.
    ///
    /// The exception is narrow on purpose: it only fires when removing the
    /// DIGITS makes the two names identical. "Spotify" and "Spotify AB" are
    /// untouched by it, because the difference between them is letters.
    static func looksLikeARename(_ a: String, _ b: String) -> Bool {
        if a == b { return true }
        if withoutDigits(a) == withoutDigits(b) { return false }
        return Dedupe.similarNormalized(a, b)
    }

    private static func withoutDigits(_ s: String) -> String {
        String(s.unicodeScalars.filter { !($0.value >= 48 && $0.value <= 57) }.map(Character.init))
    }

    /// |a − b| ≤ spread × max(a, b). Symmetric, so the answer does not depend
    /// on which name happened to be first.
    static func withinSpread(_ a: Int64, _ b: Int64, _ spread: Double) -> Bool {
        let larger = max(abs(a), abs(b))
        if larger == 0 { return true }
        return Double(abs(a - b)) / Double(larger) <= spread
    }

    // MARK: - Fitting a grid to the dates

    /// One cadence tried against one set of dates.
    struct Fit: Sendable {
        let cadence: Cadence
        /// Indices into the group's items, ascending by date.
        let matchedIndices: [Int]
        let expectedByIndex: [Int: CalendarDate]
        let missedDates: [CalendarDate]
        let extraIndices: [Int]
        /// The first item of the run this fit describes.
        let runStartIndex: Int

        var matched: Int { matchedIndices.count }
        var coverage: Double {
            let total = matched + missedDates.count
            return total == 0 ? 0 : Double(matched) / Double(total)
        }
        var cleanliness: Double {
            let total = matched + extraIndices.count
            return total == 0 ? 0 : Double(matched) / Double(total)
        }
        var evidenceFit: Double { coverage * cleanliness }

        /// HOW MUCH THIS CADENCE ACTUALLY EXPLAINS: the number of payments it
        /// accounts for, weighted by how well.
        ///
        /// The quality alone is not enough, and getting that wrong was a real
        /// bug caught by a real test. Eleven monthly payments with one month
        /// missing score 0.92; the last two of them ALSO sit four weeks apart,
        /// so a four-weekly grid matches those two and nothing else and scores
        /// a perfect 1.00. Ranking on quality made a year-long subscription
        /// into a two-payment four-weekly one, which was then thrown away for
        /// having fewer than three payments -- so the series vanished entirely.
        /// Multiplying by the count is what makes "explains eleven payments
        /// well" beat "explains two payments perfectly".
        var explains: Double { Double(matched) * evidenceFit }
    }

    /// Try one cadence. See the file header for the grid and the three counts.
    static func fit(_ items: [Item], cadence: Cadence, rules: RecurrenceRules) -> Fit? {
        guard items.count >= 2 else { return nil }
        let anchorIndex = items.count - 1
        let anchor = items[anchorIndex].date
        let earliest = items[0].date

        var used: Set<Int> = [anchorIndex]
        var expectedByIndex: [Int: CalendarDate] = [anchorIndex: anchor]
        var matchedIndices: [Int] = [anchorIndex]
        var missed: [CalendarDate] = []
        var pendingMisses: [CalendarDate] = []
        var nearMisses = Set<Int>()
        var consecutiveMisses = 0
        var runStartIndex = anchorIndex

        var step = 1
        while true {
            let expected = cadence.date(from: anchor, steps: -step)
            // Past the oldest payment there is nothing left to match.
            if earliest.daysSince(expected) > cadence.toleranceDays { break }

            var best: Int? = nil
            var bestDistance = Int.max
            for index in items.indices where !used.contains(index) {
                let distance = abs(items[index].date.daysSince(expected))
                if distance > cadence.toleranceDays { continue }
                // Nearest wins; a tie goes to the EARLIER payment, so the
                // choice is the same on every run.
                if distance < bestDistance {
                    best = index
                    bestDistance = distance
                }
            }

            if let best {
                used.insert(best)
                expectedByIndex[best] = expected
                matchedIndices.append(best)
                runStartIndex = min(runStartIndex, best)
                // Misses only count once something older confirms the run
                // continued past them.
                missed.append(contentsOf: pendingMisses)
                pendingMisses.removeAll()
                consecutiveMisses = 0
            } else {
                // A NEAR MISS IS EVIDENCE AGAINST THE GRID, not an absence.
                //
                // An empty slot with nothing anywhere near it is a missed
                // payment. An empty slot with a payment sitting just outside
                // the tolerance is something else entirely: the payee WAS paid
                // around then, on a day this rhythm did not predict. That is
                // what a shop looks like -- payments every five to nine days,
                // which drift through any weekly grid and leave a clean-looking
                // run at whichever end the phase happens to line up.
                //
                // Found by a test that put nine months of invented supermarket
                // shopping through the detector and got back "weekly, £63.05" --
                // from the last seven shops, which happened to be seven days
                // apart. The thirty-six before them were not evidence of
                // anything at the time, and they should have been.
                for index in items.indices where !used.contains(index) {
                    let distance = abs(items[index].date.daysSince(expected))
                    if distance > cadence.toleranceDays, distance <= cadence.toleranceDays * 2 {
                        nearMisses.insert(index)
                    }
                }
                pendingMisses.append(expected)
                consecutiveMisses += 1
                if consecutiveMisses >= rules.maxConsecutiveMisses { break }
            }
            step += 1
        }

        // Everything inside the run that no slot wanted, plus every near miss
        // wherever it fell -- including the ones just before the run started,
        // which are the reason it started there.
        var extraSet = Set((runStartIndex...anchorIndex).filter { !used.contains($0) })
        extraSet.formUnion(nearMisses.filter { !used.contains($0) })
        let extras = extraSet.sorted()
        return Fit(
            cadence: cadence,
            matchedIndices: matchedIndices.sorted(),
            expectedByIndex: expectedByIndex,
            missedDates: missed.sorted(),
            extraIndices: extras,
            runStartIndex: runStartIndex
        )
    }

    /// The cadence that explains the dates best.
    ///
    /// A cadence that is too SHORT collects empty slots (a monthly bill leaves
    /// three of every four weekly slots empty); one that is too LONG collects
    /// extras (a quarterly grid over monthly payments leaves two of every three
    /// payments homeless). Both are punished by `evidenceFit`, and `explains`
    /// then makes sure a cadence cannot win by describing a tiny corner of the
    /// data perfectly.
    ///
    /// Used for the rename gate. The SERIES chooses its cadence a step later,
    /// by which candidate produces the strongest claim -- see `series(from:)`.
    static func bestFit(_ items: [Item], rules: RecurrenceRules) -> Fit? {
        var best: Fit? = nil
        for cadence in Cadence.allCases {
            guard let candidate = fit(items, cadence: cadence, rules: rules) else { continue }
            guard let current = best else {
                best = candidate
                continue
            }
            if isBetter(candidate, than: current) { best = candidate }
        }
        return best
    }

    private static func isBetter(_ candidate: Fit, than current: Fit) -> Bool {
        if abs(candidate.explains - current.explains) > 1e-9 {
            return candidate.explains > current.explains
        }
        if candidate.matched != current.matched { return candidate.matched > current.matched }
        // Everything equal, the more frequent explanation. Reached only by
        // fixtures; stated so the answer is never arbitrary.
        return candidate.cadence.nominalDays < current.cadence.nominalDays
    }

    // MARK: - Turning a fit into a series

    /// Every pattern in one payee's payments.
    ///
    /// The whole group is tried first. If that produces something the rules
    /// accept with real confidence, it is the answer. If it does not, the
    /// payments are split by AMOUNT and each price is tried on its own -- which
    /// is how a £2.99 monthly charge is found among two hundred irregular
    /// purchases at the same shop. That path is held to a higher bar and is
    /// marked on the series, because it is a weaker claim: it looked at a
    /// subset chosen for looking regular.
    static func patterns(
        in group: Group, today: CalendarDate, rules: RecurrenceRules
    ) throws -> [RecurringSeries] {
        if let whole = try series(from: group, items: group.items, today: today, rules: rules,
                                  fromCluster: false),
            whole.confidence >= .medium
        {
            return [whole]
        }

        var fromClusters: [RecurringSeries] = []
        for cluster in amountClusters(group.items, rules: rules)
        where cluster.count >= rules.clusterMinimumOccurrences {
            if let found = try series(
                from: group, items: cluster, today: today, rules: rules, fromCluster: true
            ) {
                fromClusters.append(found)
            }
        }
        if !fromClusters.isEmpty { return fromClusters }

        // Nothing clean; fall back to whatever the whole group could support,
        // which is at most a `low`.
        if let whole = try series(from: group, items: group.items, today: today, rules: rules,
                                  fromCluster: false) {
            return [whole]
        }
        return []
    }

    /// Split payments into groups of similar amount, in date order within each.
    /// Sorted by amount, cut wherever the next amount is more than
    /// `clusterSpread` above the last.
    static func amountClusters(_ items: [Item], rules: RecurrenceRules) -> [[Item]] {
        let sorted = items.sorted {
            $0.magnitude != $1.magnitude ? $0.magnitude < $1.magnitude : $0.txId < $1.txId
        }
        var clusters: [[Item]] = []
        var current: [Item] = []
        for item in sorted {
            if let previous = current.last,
                !withinSpread(previous.magnitude, item.magnitude, rules.clusterSpread)
            {
                clusters.append(current)
                current = []
            }
            current.append(item)
        }
        if !current.isEmpty { clusters.append(current) }
        return clusters.map { cluster in
            cluster.sorted { $0.date != $1.date ? $0.date < $1.date : $0.txId < $1.txId }
        }
    }

    /// The strongest thing that can honestly be said about these payments.
    ///
    /// EVERY CADENCE IS BUILT ALL THE WAY OUT and the best RESULT wins, rather
    /// than picking a cadence first and then seeing whether it survives the
    /// rules. Those are not the same thing: a cadence can look best by fit and
    /// then be rejected for having too few payments, and if it had already won
    /// the fit contest it would take the series down with it -- silently, and
    /// only for series that have something slightly wrong with them, which are
    /// exactly the ones worth finding.
    static func series(
        from group: Group, items: [Item], today: CalendarDate, rules: RecurrenceRules,
        fromCluster: Bool
    ) throws -> RecurringSeries? {
        guard items.count >= rules.minimumOccurrences else { return nil }
        var best: RecurringSeries? = nil
        for cadence in Cadence.allCases {
            guard let fit = fit(items, cadence: cadence, rules: rules) else { continue }
            guard
                let candidate = try build(
                    from: group, items: items, fit: fit, today: today, rules: rules,
                    fromCluster: fromCluster
                )
            else { continue }
            if let current = best, !isStronger(candidate, than: current) { continue }
            best = candidate
        }
        return best
    }

    static func isStronger(_ candidate: RecurringSeries, than current: RecurringSeries) -> Bool {
        if candidate.confidence != current.confidence {
            return candidate.confidence > current.confidence
        }
        if candidate.evidence.matched != current.evidence.matched {
            return candidate.evidence.matched > current.evidence.matched
        }
        if abs(candidate.evidence.fit - current.evidence.fit) > 1e-9 {
            return candidate.evidence.fit > current.evidence.fit
        }
        return candidate.cadence.nominalDays < current.cadence.nominalDays
    }

    static func build(
        from group: Group, items: [Item], fit: Fit, today: CalendarDate, rules: RecurrenceRules,
        fromCluster: Bool
    ) throws -> RecurringSeries? {
        guard fit.matched >= rules.minimumOccurrences else { return nil }
        // The run has to be most of what this payee is, not a tail of it.
        guard Double(fit.matched) / Double(items.count) >= rules.minimumRunShare else { return nil }

        let scheduled = fit.matchedIndices.map { items[$0] }
        let levels = PriceSteps.levels(
            scheduled.map { PriceSteps.Point(date: $0.date.iso, magnitudeMinor: $0.magnitude) },
            currency: group.currency
        )
        guard let current = levels.last else { return nil }

        // The spread across EVERY payment in the run, which is what has to be
        // looked at when the most recent level is a single payment: see
        // `AmountStability.unsettled`.
        let runAmounts = scheduled.map(\.magnitude)
        let runMedian = PriceSteps.median(runAmounts)
        let runSpread =
            runMedian > 0
            ? Double((runAmounts.max() ?? 0) - (runAmounts.min() ?? 0)) / Double(runMedian) : 0

        let stability: AmountStability
        if current.isProvisional && levels.count > 1 {
            guard runSpread <= rules.erraticSpread else { return nil }
            stability = .unsettled
        } else if current.spread <= rules.exactSpread {
            stability = .exact
        } else if current.spread <= rules.steadySpread {
            stability = .steady
        } else if current.spread <= rules.erraticSpread {
            stability = .varies
        } else {
            // Not a price. A weekly shop at one supermarket ends here, and the
            // screen says nothing about it at all.
            return nil
        }

        guard
            let confidence = self.confidence(
                fit: fit, stability: stability, fromCluster: fromCluster, rules: rules
            )
        else { return nil }

        let slips = fit.matchedIndices.compactMap { index -> Int? in
            guard let expected = fit.expectedByIndex[index] else { return nil }
            return items[index].date.daysSince(expected)
        }
        let lastItem = items[items.count - 1]
        let nextExpected = fit.cadence.date(from: lastItem.date, steps: 1)

        var accountIds: [String] = []
        var accountNames: [String] = []
        for item in scheduled where !accountIds.contains(item.accountId) {
            accountIds.append(item.accountId)
            accountNames.append(item.accountName)
        }

        let occurrences = items.enumerated().map { index, item -> SeriesOccurrence in
            let expected = fit.expectedByIndex[index]
            let role: OccurrenceRole =
                expected != nil ? .onSchedule : (index < fit.runStartIndex ? .earlier : .extra)
            return SeriesOccurrence(
                id: item.txId,
                date: item.date.iso,
                expectedDate: expected?.iso,
                slipDays: expected.map { item.date.daysSince($0) } ?? 0,
                role: role,
                amountMinor: item.signed,
                magnitudeMinor: item.magnitude,
                currency: item.currency,
                accountId: item.accountId,
                accountName: item.accountName,
                payeeName: item.payeeName
            )
        }

        // Other payments to this payee, inside these dates, that this pattern
        // is not about. Non-zero only on the by-amount path.
        let runStart = items[fit.runStartIndex].date
        let runEnd = lastItem.date
        let inWindow = group.items.filter { $0.date >= runStart && $0.date <= runEnd }.count
        let others = fromCluster ? max(0, inWindow - fit.matched - fit.extraIndices.count) : 0

        let (annual, overflowed) = current.amountMinor.multipliedReportingOverflow(
            by: Int64(fit.cadence.occurrencesPerYear)
        )
        if overflowed { throw MoneyError.overflow("a year of \(group.payeeName)") }

        let idAmount = Money.formatPlain(current.amountMinor, currency: group.currency)
        return RecurringSeries(
            id: "\(group.payeeKey)|\(group.currency)|\(fit.cadence.rawValue)|\(idAmount)",
            payeeName: group.payeeName,
            alsoKnownAs: group.alsoKnownAs,
            currency: group.currency,
            accountIds: accountIds,
            accountNames: accountNames,
            cadence: fit.cadence,
            confidence: confidence,
            status: status(lastDate: lastItem.date, cadence: fit.cadence, today: today),
            occurrences: occurrences,
            firstDate: items[fit.runStartIndex].date.iso,
            lastDate: lastItem.date.iso,
            nextExpectedDate: nextExpected.iso,
            typicalAmountMinor: current.amountMinor,
            lastAmountMinor: lastItem.magnitude,
            stability: stability,
            levels: levels,
            changes: PriceSteps.changes(
                between: levels, currency: group.currency,
                idPrefix: "\(group.payeeKey)|\(group.currency)"
            ),
            evidence: SeriesEvidence(
                matched: fit.matched,
                missed: fit.missedDates.count,
                extras: fit.extraIndices.count,
                missedDates: fit.missedDates.map(\.iso),
                toleranceDays: fit.cadence.toleranceDays,
                typicalSlipDays: slips.isEmpty ? 0 : PriceSteps.median(slips.map { Int64(abs($0)) }).asInt,
                worstSlipDays: slips.map { abs($0) }.max() ?? 0,
                earlierPayments: fit.runStartIndex,
                otherPaymentsInRun: others
            ),
            annualCostMinor: annual,
            foundAmongOtherSpending: fromCluster
        )
    }

    /// The confidence ladder, written as the four sentences it is.
    ///
    /// nil means "not a pattern" -- the row is not shown at all rather than
    /// shown quietly, because a screen full of maybes is a screen nobody reads.
    static func confidence(
        fit: Fit, stability: AmountStability, fromCluster: Bool, rules: RecurrenceRules
    ) -> SeriesConfidence? {
        let value = fit.evidenceFit
        if fromCluster {
            // Picked out by amount: a higher bar, and never the top word. The
            // pattern is real but the SET it was found in was chosen for
            // looking regular, and that is a weaker claim than "everything this
            // payee was paid looks like this".
            guard fit.matched >= rules.clusterMinimumOccurrences, value >= rules.clusterMinimumFit,
                stability != .varies
            else { return nil }
            return .medium
        }
        if !stability.isSettled {
            // No settled price to lean on -- either it moves about, or the most
            // recent amount has been paid once -- so the calendar has to carry
            // the whole claim: four payments and an almost perfect fit, or
            // nothing. And never the top word: "clear" beside an amount that
            // swings by a factor of three, or one that changed last month,
            // would be describing something else.
            guard fit.matched >= rules.mediumOccurrences, value >= rules.variesFit else {
                return nil
            }
            return .medium
        }
        if fit.matched >= rules.highOccurrences, value >= rules.highFit { return .high }
        if fit.matched >= rules.mediumOccurrences, value >= rules.mediumFit { return .medium }
        // Three payments, but only when the pattern is perfect and the amount
        // never moved. Three at a wobbly interval is a `low`.
        if fit.matched >= rules.minimumOccurrences, value >= rules.perfectFit,
            stability == .exact
        {
            return .medium
        }
        if fit.matched >= rules.minimumOccurrences, value >= rules.minimumFit { return .low }
        return nil
    }

    static func status(lastDate: CalendarDate, cadence: Cadence, today: CalendarDate)
        -> SeriesStatus
    {
        let expected = cadence.date(from: lastDate, steps: 1)
        let daysLate = today.daysSince(expected)
        if daysLate <= cadence.toleranceDays { return .active }
        if daysLate <= cadence.nominalDays { return .due(daysLate: daysLate) }
        var missed = 0
        var step = 1
        while cadence.date(from: lastDate, steps: step) <= today, missed < 1000 {
            missed += 1
            step += 1
        }
        return .lapsed(daysSinceLast: today.daysSince(lastDate), missedPayments: missed)
    }

    // MARK: - Two payments

    /// A pair: two payments to one payee, one gap between them.
    ///
    /// Reported only when the two amounts agree and the gap is one of the
    /// cadences -- otherwise it is just two payments to a shop, and there are
    /// thousands of those. It carries NO next-expected date: predicting a third
    /// payment from one gap is exactly the guess this file will not make.
    static func pair(from group: Group, rules: RecurrenceRules) throws -> RecurringSeries? {
        guard group.items.count == 2 else { return nil }
        let first = group.items[0]
        let second = group.items[1]
        guard withinSpread(first.magnitude, second.magnitude, rules.pairSpread) else { return nil }
        guard let cadence = Cadence.matching(from: first.date, to: second.date) else { return nil }

        let magnitudes = [first.magnitude, second.magnitude]
        let typical = PriceSteps.median(magnitudes)
        let (annual, overflowed) = typical.multipliedReportingOverflow(
            by: Int64(cadence.occurrencesPerYear)
        )
        if overflowed { throw MoneyError.overflow("a year of \(group.payeeName)") }

        let occurrences = group.items.map { item in
            SeriesOccurrence(
                id: item.txId, date: item.date.iso, expectedDate: nil, slipDays: 0,
                role: .onSchedule, amountMinor: item.signed, magnitudeMinor: item.magnitude,
                currency: item.currency, accountId: item.accountId,
                accountName: item.accountName, payeeName: item.payeeName
            )
        }
        let idAmount = Money.formatPlain(typical, currency: group.currency)
        return RecurringSeries(
            id: "pair|\(group.payeeKey)|\(group.currency)|\(idAmount)",
            payeeName: group.payeeName,
            alsoKnownAs: group.alsoKnownAs,
            currency: group.currency,
            accountIds: Array(Set(group.items.map(\.accountId))).sorted(),
            accountNames: Array(Set(group.items.map(\.accountName))).sorted(),
            cadence: cadence,
            confidence: .pair,
            status: .active,
            occurrences: occurrences,
            firstDate: first.date.iso,
            lastDate: second.date.iso,
            // No prediction from one gap. This nil is the feature.
            nextExpectedDate: nil,
            typicalAmountMinor: typical,
            lastAmountMinor: second.magnitude,
            stability: first.magnitude == second.magnitude ? .exact : .steady,
            levels: [],
            changes: [],
            evidence: SeriesEvidence(
                matched: 2, missed: 0, extras: 0, missedDates: [],
                toleranceDays: cadence.toleranceDays, typicalSlipDays: 0, worstSlipDays: 0,
                earlierPayments: 0, otherPaymentsInRun: 0
            ),
            annualCostMinor: annual,
            foundAmongOtherSpending: false
        )
    }
}

// MARK: - Small helpers

extension Int64 {
    /// The Int form of a day count that came back through the median helper.
    /// Day counts are small; a clamp here would hide a bug rather than cause
    /// one, so it is spelled as a conversion that cannot fail for real data.
    var asInt: Int { Int(clamping: self) }
}

extension Array where Element == String {
    /// De-duplicated, first occurrence wins, order kept.
    func reduced() -> [String] {
        var seen = Set<String>()
        var out: [String] = []
        for value in self where !seen.contains(value) {
            seen.insert(value)
            out.append(value)
        }
        return out
    }
}
