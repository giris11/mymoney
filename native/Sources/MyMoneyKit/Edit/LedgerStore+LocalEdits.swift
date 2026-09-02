// The count of things this copy knows that the web app does not.
//
// ─────────────────────────────────────────────────────────────────────────────
// THIS IS THE HONESTY MACHINERY, AND IT IS THE MOST IMPORTANT FILE IN THE EDIT
// LAYER. Everything else here adds a capability; this is what stops the
// capability becoming a second, silently divergent ledger.
//
// The web app is the system of record. This app imports a backup of it and,
// from this phase on, can edit that imported copy. The moment the first edit
// lands, the two are different books -- and the failure that costs a month of
// entries is not a crash, it is somebody typing into the phone for three weeks
// in the belief that the browser has it too.
//
// A banner saying "this is a copy" is necessary and is NOT sufficient: it says
// the same thing before the first edit and after the hundredth, so it fades
// into furniture. What cannot fade is a COUNT -- "14 changes here since 2
// September that your web app does not have" -- because it grows, it names a
// date, and it is arithmetic rather than a warning.
//
// So every mutation in this package calls `recordLocalEdit()` INSIDE its own
// transaction. Three consequences, all deliberate:
//
//   * a failed edit does not count, because the counter rolls back with it;
//   * an edit cannot happen without counting, because a mutation that forgot
//     the call would be a mutation whose test fails (`LocalEditTests` asserts
//     the count after every kind of change);
//   * an import RESETS it, because the copy has just been replaced wholesale by
//     the file and the two are, at that instant, the same book again.
//
// A BOOK CREATED ON THIS DEVICE HAS NO SUCH COUNT, and its absence is a
// property of the book rather than a decision taken by whichever screen is
// drawing. There is no web app copy of a book the web app has never seen, so
// there is nothing for a count to be a count OF: `recordLocalEdit` records
// nothing, and both sentences below are nil rather than being reworded. The
// reasoning, and what happens when one kind of book is restored over the other,
// is in BookOrigin.swift.
//
// The count is stored in `store_meta`, which is the store's own bookkeeping and
// is not part of the book -- so it never reaches a backup file, never changes a
// content hash, and cannot be mistaken for data.
import Foundation

/// How far this copy has drifted from the file it was imported from.
///
/// ONLY MEANINGFUL FOR AN IMPORTED BOOK, and this type is where that is
/// decided rather than in whatever view is drawing. A book CREATED on this
/// device (BookOrigin.swift) has no counterpart anywhere: there is no web app
/// copy for it to differ from, so there is no number to report and nothing to
/// warn about. For such a book `count` stays at zero -- nothing counts it --
/// and both sentences below are nil, which is how a screen is told to show no
/// banner at all rather than being trusted to remember.
public struct LocalEdits: Sendable, Hashable {
    /// Mutations committed since the last import. Zero means this copy still
    /// says exactly what the backup said -- and stays zero for ever on a book
    /// that was created here, because a created book has nothing to diverge
    /// from.
    public let count: Int
    /// When the first of them landed, ISO-8601. nil when there are none.
    public let firstAt: String?
    /// When the most recent landed. nil when there are none.
    public let lastAt: String?
    /// Where the book came from. What makes the count worth saying, or not.
    public let origin: BookOrigin

    public var hasDiverged: Bool { count > 0 }

    /// Is there anything here to tell the owner about? False for a created
    /// book, always -- the two sentences below are nil in that case, and this
    /// is the same question asked without unwrapping one of them.
    public var isWorthSaying: Bool { origin.hasCounterpartElsewhere }

    /// The default is `.imported` because that is what every `LocalEdits` ever
    /// constructed meant before a book could be created here, and because a
    /// non-zero count can only have come from an imported book: nothing counts
    /// edits on a created one.
    public init(count: Int, firstAt: String?, lastAt: String?, origin: BookOrigin = .imported) {
        self.count = count
        self.firstAt = firstAt
        self.lastAt = lastAt
        self.origin = origin
    }

    /// An imported copy that has not been changed yet.
    ///
    /// NOT "there is no book". A device holding no book has no `LocalEdits` at
    /// all -- `LedgerService.summary()` is nil, and there is nothing for a
    /// banner to say -- whereas this value says "imported, zero changes", which
    /// prints a line. A caller reaching for a placeholder on the no-book path
    /// wants the nil, not this.
    public static let none = LocalEdits(count: 0, firstAt: nil, lastAt: nil)

    /// THE ONE LINE THAT MUST NEVER LEAVE THE SCREEN.
    ///
    /// `summary` below is the whole explanation, and it is two sentences long.
    /// At the largest accessibility text size those two sentences are eight
    /// lines: the banner took about 80% of an iPhone viewport and left the
    /// account list a ~180pt sliver. The two obvious ways out -- shortening the
    /// sentence, or letting the banner scroll away -- both weaken the machinery
    /// this file exists to protect, so the banner is SPLIT instead. This line is
    /// permanent at every text size; `summary` is one tap behind a disclosure.
    ///
    /// THE COUNT IS THE LOAD-BEARING HALF, which is why it is the half that
    /// stays. A fixed sentence saying "this is a copy" reads identically before
    /// the first edit and after the hundredth, and fades into furniture within a
    /// week; a number that grows is arithmetic. The number is also in the SAME
    /// PLACE every time -- first, before any word -- so the eye lands on the
    /// digit rather than reading a sentence to find it. That is why zero is
    /// "0 changes" and not "No changes yet": the shape does not change, only the
    /// figure does, and a reader who glances at this a hundred times a month is
    /// checking one character.
    ///
    /// NIL FOR A BOOK CREATED HERE, and the optionality is the feature. "0
    /// changes not in your web app" is a false sentence about a book the web
    /// app has never seen -- it names a second copy that does not exist and an
    /// authority that was never involved -- and a false line in the one place
    /// this app promises to be honest is worse than no line at all, because it
    /// teaches the reader that this row is furniture. A caller cannot print it
    /// by accident: there is nothing to print.
    public var countLine: String? {
        guard origin.hasCounterpartElsewhere else { return nil }
        return "\(count) change\(count == 1 ? "" : "s") not in your web app"
    }

    /// The sentence the app puts under the net-worth figure. One sentence, in
    /// plain words, that answers "which of my two apps is right about this
    /// number?" without needing the reader to already know the answer.
    ///
    /// Shown behind the disclosure on the banner, and in full wherever there is
    /// room for it. `countLine` is the part that is always on screen.
    ///
    /// Nil for a created book, for the reason `countLine` is: every wording
    /// here names the web app as the authority, and for a book the web app has
    /// never held that is simply untrue.
    public var summary: String? {
        guard origin.hasCounterpartElsewhere else { return nil }
        guard count > 0 else {
            return "This copy matches the backup you imported. Your web app still holds the "
                + "real ledger."
        }
        let changes = "\(count) change\(count == 1 ? "" : "s")"
        return "\(changes) made here that your web app does not have. Your web app is still "
            + "the real ledger \u{2014} these changes live only on this device."
    }
}

extension LedgerStore {

    enum LocalEditKey {
        static let count = "local.editCount"
        static let firstAt = "local.firstEditAt"
        static let lastAt = "local.lastEditAt"
    }

    /// What this copy has that the file did not.
    public func localEdits() throws -> LocalEdits {
        LocalEdits(
            count: Int(try meta(LocalEditKey.count).flatMap(Int.init) ?? 0),
            firstAt: try meta(LocalEditKey.firstAt),
            lastAt: try meta(LocalEditKey.lastAt),
            origin: try bookOrigin()
        )
    }

    /// Count one committed change. Called by every mutation, from INSIDE that
    /// mutation's transaction, so it can neither over- nor under-count.
    ///
    /// `n` is the number of CHANGES, not of rows: deleting a transfer touches
    /// two rows and is one thing the owner did.
    ///
    /// A BOOK CREATED HERE COUNTS NOTHING, and the counter is left absent
    /// rather than left at zero-and-growing. The quantity this measures is
    /// "changes this copy has that the other copy does not"; for a book with no
    /// other copy that quantity is not zero, it is undefined, and a number
    /// stored for it would eventually be shown by somebody. So the honest store
    /// is an empty one -- and it means the widget, the Siri answer and the
    /// banner all stay silent about drift on a created book without any of them
    /// having to know why.
    func recordLocalEdit(_ n: Int = 1, at timestamp: String) throws {
        guard n > 0 else { return }
        guard try bookOrigin().hasCounterpartElsewhere else { return }
        let current = try meta(LocalEditKey.count).flatMap(Int.init) ?? 0
        try setMeta(LocalEditKey.count, String(current + n))
        if try meta(LocalEditKey.firstAt) == nil {
            try setMeta(LocalEditKey.firstAt, timestamp)
        }
        try setMeta(LocalEditKey.lastAt, timestamp)
    }

    /// Forget the drift. Only an IMPORT may do this, and only because an import
    /// replaces the whole book with the file: at that instant the copy and the
    /// backup agree again, and a count carried over from the book that was here
    /// before would be a claim about rows that no longer exist.
    func clearLocalEdits() throws {
        try setMeta(LocalEditKey.count, nil)
        try setMeta(LocalEditKey.firstAt, nil)
        try setMeta(LocalEditKey.lastAt, nil)
    }
}
