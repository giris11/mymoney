// Where the book in this store came from, and therefore what this app is
// entitled to say about it.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS IS NOT A DETAIL. Everything the local-copy machinery says --
// "14 changes not in your web app", "your web app is still the real ledger" --
// is true of a book that was IMPORTED from a backup, because that book has a
// counterpart the web app still owns. None of it is true of a book CREATED
// here: this app is its only home, there is no second copy to differ from, and
// there never was a web app in the story at all. Telling somebody their web app
// holds the real version of a book the web app has never seen is not a
// harmless bit of over-warning -- it teaches the reader that the banner is
// noise, and the day the banner is right is the day it is ignored.
//
// So the book knows where it came from, it remembers across relaunches, and the
// wording is derived FROM the origin rather than decided by whichever screen is
// drawing (see `LocalEdits`). A view cannot get this wrong, because a view is
// not asked.
//
// WHERE IT IS KEPT, AND WHY THERE. `store_meta`, beside the local-edit count.
// That table is the store's own bookkeeping and is not part of the book, so the
// origin never reaches a backup file and cannot change a content hash -- a book
// created here and a book imported here export to exactly the same bytes, which
// is what makes the round-trip property still mean something. It also needs no
// migration: migration 2 created `store_meta`, and a key is just a row.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TRANSITIONS, DECIDED RATHER THAN DISCOVERED
//
//   * CREATE on an empty store              → `.created`.
//   * IMPORT, always, whatever was here     → `.imported`, and the local-edit
//     count is cleared. An import replaces the whole book with the file in one
//     transaction; afterwards this store holds a copy of a book that exists
//     somewhere else, which is the definition of `.imported`. That includes
//     RESTORING OVER A BOOK CREATED HERE: the created book is gone -- it was
//     replaced, deliberately, by a caller that had to pass
//     `replacingExistingBook: true` to get that far -- and continuing to call
//     the result "created here" would be a claim about rows that no longer
//     exist.
//   * CREATE over ANY existing book         → REFUSED
//     (`StoreError.bookAlreadyExists`). There is no flag that turns this into a
//     destructive create, and that asymmetry with import is deliberate: a
//     restore is asked for by someone holding the file they want, while
//     "start fresh" is a button that could be tapped by somebody who has not
//     understood that their imported ledger is behind it. Data loss is
//     unacceptable, so the create path cannot destroy anything at all.
//   * A BOOK WITH NO ORIGIN RECORDED        → read as `.imported`.
//     Every store that exists before this file did was filled by an import --
//     it was the only way a book could get in -- so that is what the absence
//     means, and it is also the safe direction: a book wrongly called imported
//     shows a warning that is at worst redundant, while a book wrongly called
//     created shows none at all. A created book always writes the key inside
//     the same transaction that writes its settings row, so the fallback can
//     never mislabel one.
//
// THE ONE CASE THE FILE FORMAT CANNOT DISTINGUISH. A backup EXPORTED from a
// book created here and then imported back into this app comes back as
// `.imported`, because a backup file carries no record of which app wrote it
// and inventing one would change the file format and every content hash. That
// is the honest reading anyway: a file the book was restored from is a second
// copy of it, and the count that starts from zero at that moment measures drift
// from that file. What it is NOT is a reason to weaken the imported wording,
// which is right for the only book this app actually holds today.
import Foundation

/// How the book in this store came to be here.
public enum BookOrigin: String, Sendable, Hashable, CaseIterable {
    /// Read from a backup file. There is a counterpart elsewhere -- the web app
    /// that exported it -- so divergence is a fact worth counting and saying.
    case imported

    /// Started here, empty, and typed into on this device. This app is its only
    /// home; there is nothing for it to have drifted from.
    case created

    /// Is there another copy of this book to be honest about?
    public var hasCounterpartElsewhere: Bool { self == .imported }
}

extension LedgerStore {

    enum BookKey {
        /// Namespaced like `source.*` and `local.*`, so a later phase can add
        /// its own keys without collision.
        static let origin = "book.origin"
    }

    /// Where this store's book came from. `.imported` when nothing was
    /// recorded -- see the note at the top of this file for why that is both
    /// the historical truth and the safe direction.
    ///
    /// Answering for a store with NO book is meaningless rather than wrong; the
    /// callers that care (`LedgerService.summary`, the snapshot writers) all ask
    /// `isEmpty()` first and never reach here.
    public func bookOrigin() throws -> BookOrigin {
        guard let raw = try meta(BookKey.origin) else { return .imported }
        // An unreadable value is treated exactly like an absent one. A future
        // build that adds a third origin must not make this build refuse to
        // open the store -- it would be locked out of its own ledger by a word.
        return BookOrigin(rawValue: raw) ?? .imported
    }

    /// Record where the book came from. Called from INSIDE the transaction that
    /// puts the book there, so a book and its origin are committed together or
    /// not at all.
    func setBookOrigin(_ origin: BookOrigin) throws {
        try setMeta(BookKey.origin, origin.rawValue)
    }
}
