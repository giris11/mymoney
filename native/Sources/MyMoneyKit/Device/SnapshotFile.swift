// Where the snapshot lives, how it is written, and how old is too old.
//
// THE FILE IS THE ONLY THING THE TWO PROCESSES SHARE. The app writes it; the
// widget and the intents read it. Nothing else crosses the boundary -- in
// particular the SQLite database does NOT, and the group container deliberately
// holds no copy of it. See `LedgerSnapshot`'s header for why.
//
// WRITING IS ATOMIC, and it has to be. A widget can be woken at any instant,
// including the instant halfway through a write, and a half-written JSON file
// is not a stale widget -- it is a widget that has decided the owner's net
// worth is nothing. `Data.write(options: .atomic)` writes a temporary file and
// renames it, and a rename is the one filesystem operation another process
// cannot see the middle of.
//
// A FILE THAT CANNOT BE READ IS NOT AN EMERGENCY AND IS NOT A ZERO. Every read
// path here returns nil -- no snapshot yet, a snapshot from a version this
// build does not know, unreadable bytes -- and every caller draws "open the app
// once" rather than a figure. A widget that invents £0.00 is worse than a
// widget that admits it has nothing.
import Foundation

/// The snapshot on disk.
public enum SnapshotFile {
    /// The file's name inside whatever directory it is handed.
    ///
    /// The DIRECTORY is the app's business -- it is the App Group container,
    /// which only the app target knows the identifier of -- so nothing here
    /// mentions a group. That also makes every function below testable against
    /// a scratch directory, which is what `SnapshotTests` does.
    public static let fileName = "ledger-snapshot.json"

    public static func url(in directory: URL) -> URL {
        directory.appendingPathComponent(fileName)
    }

    /// Sorted keys, so two snapshots of the same figures are the same bytes.
    /// That is what lets the app tell "nothing moved" from "everything moved"
    /// without decoding what it just wrote.
    private static var encoder: JSONEncoder {
        let encoder = JSONEncoder()
        encoder.outputFormatting = [.sortedKeys]
        return encoder
    }

    public static func write(_ snapshot: LedgerSnapshot, to directory: URL) throws {
        try FileManager.default.createDirectory(
            at: directory, withIntermediateDirectories: true
        )
        let data = try encoder.encode(snapshot)
        try data.write(to: url(in: directory), options: .atomic)
    }

    /// The snapshot, or nil for every kind of "there isn't one I can use".
    ///
    /// A VERSION THIS BUILD DOES NOT KNOW IS nil, not a best effort. An older
    /// widget left on a home screen after the app updates would otherwise
    /// decode the fields it recognises and leave the rest at zero -- and a
    /// zero on a widget is a figure, indistinguishable from a real one.
    public static func read(from directory: URL) -> LedgerSnapshot? {
        guard let data = try? Data(contentsOf: url(in: directory)),
            let snapshot = try? JSONDecoder().decode(LedgerSnapshot.self, from: data),
            snapshot.isReadable
        else { return nil }
        return snapshot
    }

    /// Remove it. Called when the app no longer has a book -- after the local
    /// copy is emptied -- because a widget still showing last month's net worth
    /// for a book that is not there any more is the most misleading state this
    /// whole feature can be in.
    public static func remove(from directory: URL) {
        try? FileManager.default.removeItem(at: url(in: directory))
    }
}

/// How old a snapshot is, and what to say about it.
///
/// THE WORDS ARE HERE, NOT IN THE WIDGET, because they are the load-bearing
/// half of the feature: a figure on a home screen looks live, and the only
/// thing standing between the owner and a wrong belief about his own money is
/// this line of text. It is tested rather than eyeballed.
public struct SnapshotFreshness: Sendable, Hashable {
    /// Seconds between the snapshot being taken and now. Never negative -- see
    /// `of(asOf:now:)`.
    public let age: TimeInterval
    /// Past this, the app says out loud that the figure may have moved.
    public static let staleAfter: TimeInterval = 6 * 60 * 60

    public var isStale: Bool { age >= Self.staleAfter }

    /// "just now", "12 minutes ago", "3 hours ago", "2 days ago".
    ///
    /// Deliberately coarse. A widget updated four minutes ago and one updated
    /// five are the same thing to a reader, and a figure that ticks every
    /// minute invites the belief that the NUMBER is being updated too.
    public var phrase: String {
        switch age {
        case ..<90: return "just now"
        case ..<3600: return "\(minutes) minute\(minutes == 1 ? "" : "s") ago"
        case ..<(48 * 3600): return "\(hours) hour\(hours == 1 ? "" : "s") ago"
        default: return "\(days) day\(days == 1 ? "" : "s") ago"
        }
    }

    /// The whole line a widget draws under its figure.
    public var line: String { "as at \(phrase)" }

    /// The line, when there is room for the warning as well.
    public var longLine: String {
        isStale
            ? "as at \(phrase) \u{2014} open MyMoney to bring it up to date"
            : "as at \(phrase)"
    }

    private var minutes: Int { max(1, Int(age / 60)) }
    private var hours: Int { max(1, Int(age / 3600)) }
    private var days: Int { max(1, Int(age / 86400)) }

    /// The age of a snapshot, in seconds.
    ///
    /// A NEGATIVE AGE IS CLAMPED TO ZERO rather than shown. It means the two
    /// clocks disagree -- the snapshot was written on a device whose time was
    /// ahead, or the owner has just moved the clock back -- and "in 3 hours"
    /// under a net-worth figure is nonsense that makes the whole widget look
    /// broken. Zero reads as "just now", which is the closest true thing.
    public static func of(asOf: String, now: Date) -> SnapshotFreshness? {
        guard let taken = instant(asOf) else { return nil }
        return SnapshotFreshness(age: max(0, now.timeIntervalSince(taken)))
    }

    /// The two ISO-8601 shapes this app writes and reads: with fractional
    /// seconds (what `StoreEnvironment` stamps) and without.
    static func instant(_ iso: String) -> Date? {
        let withFraction = ISO8601DateFormatter()
        withFraction.formatOptions = [.withInternetDateTime, .withFractionalSeconds]
        if let date = withFraction.date(from: iso) { return date }
        return ISO8601DateFormatter().date(from: iso)
    }
}
