// The two things a mutation needs from outside itself: what time it is, and a
// new id.
//
// WHY THEY ARE INJECTED RATHER THAN CALLED. Both are the reasons an edit test
// is otherwise untestable: `createdAt` and `updatedAt` are compared for
// equality by every round-trip assertion in this suite, and an id that changes
// per run cannot appear in an expectation at all. Making them a value the store
// HOLDS means the tests state exactly what they are and the production path
// takes the real ones -- rather than every test being written around the two
// fields it cannot predict, which is how a suite ends up not checking them.
//
// THE IDS ARE LOWERCASE v4 UUIDs, matching src/lib/util.ts's `uid()` character
// for character. Foundation's `UUID().uuidString` is UPPERCASE, and the
// difference is not cosmetic: ids are sorted into the backup file by UTF-16
// code unit (`jsStringLess`), where 'A' (0x41) sorts before 'a' (0x61) and both
// sort after '0'. A book carrying both spellings would still be correct, but
// its rows would interleave in an order neither app intended -- and this
// package's whole claim is that a book written here is a book the browser
// would have written.
import Foundation

/// A source of ids and timestamps. Not `Sendable` on purpose: it lives inside
/// `LedgerStore`, which is single-owner by design, and marking it otherwise
/// would be a promise about the closures somebody hands it.
public struct StoreEnvironment {
    /// An ISO-8601 instant with milliseconds and a `Z`, exactly as
    /// `nowISO()` produces in the browser.
    public var now: () -> String
    /// A fresh record id.
    public var newId: () -> String

    public init(now: @escaping () -> String, newId: @escaping () -> String) {
        self.now = now
        self.newId = newId
    }

    /// The real clock and real randomness. What every store gets unless a test
    /// says otherwise.
    public static var live: StoreEnvironment {
        StoreEnvironment(now: { LedgerStore.timestampNow() }, newId: { Identity.newId() })
    }

    /// A clock that does not move and ids that count up from a prefix.
    ///
    /// FOR TESTS, and it says so in the name of every id it produces, so an id
    /// like "fixed-3" showing up in a real book would be visibly not from here.
    public static func fixed(now: String, idPrefix: String = "fixed") -> StoreEnvironment {
        var counter = 0
        return StoreEnvironment(
            now: { now },
            newId: {
                counter += 1
                return "\(idPrefix)-\(counter)"
            }
        )
    }
}

public enum Identity {
    /// A lowercase RFC 4122 v4 UUID, the same shape the web app writes.
    public static func newId() -> String {
        UUID().uuidString.lowercased()
    }
}
