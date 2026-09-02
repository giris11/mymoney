// Turning a schedule into dates. The whole of it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE DECISION THIS FILE EXISTS FOR: EVERY OCCURRENCE IS MEASURED FROM THE
// ANCHOR, NEVER FROM THE ONE BEFORE IT.
//
// Occurrence n is `cadence.date(from: start, steps: n)`. It is never
// `cadence.date(from: previousOccurrence, steps: 1)`, and the difference is
// the difference between a schedule that works and one that rots:
//
//     31 January, monthly, from the anchor:   31 Jan, 28 Feb, 31 Mar, 30 Apr…
//     31 January, monthly, step by step:      31 Jan, 28 Feb, 28 Mar, 28 Apr…
//
// `CalendarDate.addingMonths` clamps the day to the length of the month it
// lands in (dayjs's rule, and the rule the budget windows are already built
// on), and clamping DOES NOT COMPOSE. Step from the clamped date and February
// permanently swallows the schedule: a bill on the 31st becomes a bill on the
// 28th, in February, silently, for ever. Measure from the anchor and February
// costs one occurrence three days and costs the next one nothing -- which is
// what the bank does, and what the recurrence detector in Insights already
// assumes when it builds its grid backwards from the most recent payment.
//
// SO: MONTHLY ON THE 31ST IS THE LAST DAY OF EVERY MONTH. 31 Jan, 28 Feb (29 in
// a leap year), 31 Mar, 30 Apr. That is not an approximation of the owner's
// intent, it IS the intent -- a payment due on the 31st in a month with no 31st
// is taken on the last day, which is exactly what clamping produces. The
// alternative reading, "roll forward to 1 March", was rejected: it moves the
// payment into the next month, which moves it into the next MONTHLY BUDGET
// WINDOW, and a bill that lands in February's budget in some years and March's
// in others is a bill nobody can plan around. The editor says which rule it
// picked, in words, under the date field.
//
// ─────────────────────────────────────────────────────────────────────────────
// NO SECOND CADENCE ARITHMETIC. Every date below comes out of
// `Cadence.date(from:steps:)` -- the same function the recurrence detector uses
// to decide whether a run of real payments fits a pattern. This file adds
// exactly two things to it: where the series stops, and how to find the index
// of a date without walking from the beginning.
import Foundation

/// The dates a schedule falls on.
///
/// A VALUE, and pure. It knows nothing about the book, the store, what has been
/// posted or what today is; those are `Upcoming`'s business. Which is what
/// makes the awkward cases -- February, leap years, an end date that lands
/// between two occurrences -- testable as arithmetic rather than through a
/// database.
public struct ScheduleCalendar: Sendable, Hashable {
    public let cadence: Cadence
    /// Occurrence 0. Also the anchor every other occurrence is measured from.
    public let start: CalendarDate
    public let end: ScheduleEnd

    /// A ceiling on how far a search will walk.
    ///
    /// Not a limit on schedules -- a million weekly occurrences is nineteen
    /// thousand years -- but a promise about TERMINATION. `firstIndex(onOrAfter:)`
    /// is asked for dates that come from a device clock and from stored rows,
    /// and a corrupt "year 9999" must return a bounded wrong answer rather than
    /// spin a phone's CPU flat.
    static let indexCap = 1_000_000

    public init(cadence: Cadence, start: CalendarDate, end: ScheduleEnd = .never) {
        self.cadence = cadence
        self.start = start
        self.end = end
    }

    // MARK: - Where the series stops

    /// The index of the last occurrence, or nil when it never ends.
    ///
    /// Can be NEGATIVE, and that is a real state rather than an error: an end
    /// date before the start date describes a schedule with no occurrences at
    /// all. `saveSchedule` refuses to write one, so this is the reader's half
    /// of that -- a row that got in some other way produces an empty calendar
    /// instead of a crash or a first payment that ignores its own end date.
    public var lastIndex: Int? {
        switch end {
        case .never:
            return nil
        case .afterOccurrences(let count):
            return count - 1
        case .onDate(let iso):
            // AN UNREADABLE END DATE STOPS THE SCHEDULE. It cannot happen
            // through `saveSchedule`, which refuses one, so this is about a row
            // that arrived some other way -- and of the two ways to be wrong,
            // "this schedule has ended" shows an empty list the owner can see
            // and fix, while "this schedule never ends" quietly offers payments
            // that should have stopped. Fail towards the visible one.
            guard let last = CalendarDate(iso: iso) else { return -1 }
            guard last >= start else { return -1 }
            // The first index PAST the end, minus one. `firstIndexRaw` is
            // exact, so this is exact -- including the case where the end date
            // falls exactly on an occurrence, which is included (the end date
            // is inclusive, because "until 1 January" reads as including it).
            let after = firstIndexRaw(onOrAfter: last.addingDays(1))
            return after - 1
        }
    }

    /// Does this schedule ever produce an occurrence?
    public var isEmpty: Bool { (lastIndex ?? 0) < 0 }

    /// The final date, when there is one.
    public var finalDate: CalendarDate? {
        guard let lastIndex, lastIndex >= 0 else { return nil }
        return rawDate(lastIndex)
    }

    // MARK: - Index to date

    /// The date of occurrence `index`, or nil when the index is outside the
    /// series. Occurrence 0 is the start date.
    public func date(at index: Int) -> CalendarDate? {
        guard index >= 0 else { return nil }
        if let lastIndex, index > lastIndex { return nil }
        return rawDate(index)
    }

    /// The grid, ignoring where the series stops. Private on purpose: every
    /// public answer respects the end.
    func rawDate(_ index: Int) -> CalendarDate {
        cadence.date(from: start, steps: index)
    }

    // MARK: - Date to index

    /// The index of the first occurrence on or after `target`, or nil when the
    /// series has already ended by then.
    public func firstIndex(onOrAfter target: CalendarDate) -> Int? {
        let index = firstIndexRaw(onOrAfter: target)
        if let lastIndex, index > lastIndex { return nil }
        return index
    }

    /// The index of the occurrence that lands exactly on `date`, or nil.
    ///
    /// Used to decide whether a stored decision -- "the 3 September one was
    /// skipped" -- still refers to a date this schedule falls on. It can stop
    /// doing so: changing the start date or the cadence moves the whole grid,
    /// and the decisions taken under the old one become ORPHANS. They are shown
    /// as orphans rather than deleted (see `LedgerStore.scheduleHistory`),
    /// because the transaction they posted is still in the book and still the
    /// owner's.
    public func index(on date: CalendarDate) -> Int? {
        guard let index = firstIndex(onOrAfter: date) else { return nil }
        return rawDate(index) == date ? index : nil
    }

    /// Of these dates, the ones this calendar does NOT fall on.
    ///
    /// ASKED BEFORE A GRID IS MOVED, not after. Changing the cadence or the
    /// anchor moves every occurrence, and the decisions already taken -- this
    /// one entered, that one skipped -- were about dates on the OLD grid. The
    /// ones the new grid misses become orphans: still the owner's, still listed
    /// in the history, and no longer attached to anything the schedule will do
    /// again. The editor asks this question with the dates the schedule has
    /// decisions for, so the sentence it shows before saving is a COUNT of real
    /// rows rather than a general warning nobody reads.
    ///
    /// A date that is not a date is off the grid, because nothing this
    /// calendar produces could ever equal it.
    public func datesOffTheGrid(_ dates: [String]) -> [String] {
        dates.filter { iso in
            guard let date = CalendarDate(iso: iso) else { return true }
            return index(on: date) == nil
        }
    }

    /// The occurrences between two dates, inclusive at both ends.
    ///
    /// Returns index and date together because every caller needs both: the
    /// date to show and the index to know whether the count-limited end has
    /// been reached.
    public func occurrences(
        from: CalendarDate, through: CalendarDate
    ) -> [(index: Int, date: CalendarDate)] {
        guard from <= through, !isEmpty else { return [] }
        guard var index = firstIndex(onOrAfter: from) else { return [] }
        var out: [(index: Int, date: CalendarDate)] = []
        while true {
            guard let date = date(at: index), date <= through else { break }
            out.append((index, date))
            index += 1
            // A window of one year at the shortest cadence is 53 rows. This
            // ceiling is not that limit -- it is the same termination promise
            // `indexCap` makes, for a caller that asks for a century.
            if out.count >= Self.indexCap { break }
        }
        return out
    }

    // MARK: - The search

    /// The first index whose date is on or after `target`, ignoring the end.
    ///
    /// EXPONENTIAL THEN BINARY, which is exact because the grid is strictly
    /// increasing: `date(n+1) > date(n)` for every cadence here, including the
    /// clamped month-based ones (the smallest day of month m+1 is later than
    /// the largest day of month m). A cheaper "estimate from nominalDays and
    /// walk" would be right for a schedule that started this year and drift by
    /// dozens of steps for one that started in 1994, and the cost of being
    /// wrong is a payment shown on the wrong day.
    func firstIndexRaw(onOrAfter target: CalendarDate) -> Int {
        if rawDate(0) >= target { return 0 }
        var high = 1
        while rawDate(high) < target {
            high *= 2
            if high >= Self.indexCap { return Self.indexCap }
        }
        // rawDate(low) < target <= rawDate(high) is the invariant from here.
        var low = high / 2
        while low + 1 < high {
            let mid = low + (high - low) / 2
            if rawDate(mid) < target { low = mid } else { high = mid }
        }
        return high
    }
}
