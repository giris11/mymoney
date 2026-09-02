// Where a widget gets its figures, and how the "as at" line keeps ticking when
// the app never runs.
//
// ─────────────────────────────────────────────────────────────────────────────
// A WIDGET DOES NO WORK
//
// It reads one small JSON file out of the shared container and formats it. It
// does not open the database, decode 5,127 transactions or compute a month's
// spend: it is given a couple of seconds and a few tens of megabytes at moments
// nobody chose, and a widget that misses that budget is a blank rectangle on
// somebody's home screen. `LedgerSnapshot`'s header sets this out at length.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE TIMELINE EXISTS TO MAKE THE AGE HONEST
//
// The figures cannot change without the app running. The AGE of the figures
// changes every minute, and the age is the whole reason the widget is allowed
// to show an old number at all. So the timeline is several entries carrying the
// SAME snapshot at DIFFERENT times -- one now, then hourly -- and each renders
// its own "as at" line from its own date. WidgetKit swaps them without waking
// anything, so a widget the owner has not opened the app for since Tuesday says
// "2 days ago" rather than "just now" for ever.
import MyMoneyKit
import SwiftUI
import WidgetKit

/// One moment, with whatever the app last published.
struct SnapshotEntry: TimelineEntry {
    let date: Date
    /// nil when there is no snapshot: no shared container, nothing published
    /// yet, or a file this build cannot read. Every view draws an explanation
    /// rather than a figure -- "£0.00" IS a figure, and would be a lie.
    let snapshot: LedgerSnapshot?

    var freshness: SnapshotFreshness? {
        guard let snapshot else { return nil }
        return SnapshotFreshness.of(asOf: snapshot.asOf, now: date)
    }
}

struct SnapshotProvider: TimelineProvider {

    /// How far ahead entries are produced, and how often. Six hours of hourly
    /// entries: enough that the age stays right through a working day without
    /// the app being opened, short enough that WidgetKit comes back and picks
    /// up a newer file.
    static let horizon = 6
    static let step: TimeInterval = 3600

    func placeholder(in context: Context) -> SnapshotEntry {
        // The gallery placeholder. Deliberately EMPTY rather than a plausible
        // pretend net worth: a made-up figure in the widget gallery is a figure
        // somebody might read as theirs.
        SnapshotEntry(date: Date(), snapshot: nil)
    }

    func getSnapshot(in context: Context, completion: @escaping (SnapshotEntry) -> Void) {
        completion(SnapshotEntry(date: Date(), snapshot: Self.read()))
    }

    func getTimeline(in context: Context, completion: @escaping (Timeline<SnapshotEntry>) -> Void) {
        let now = Date()
        let snapshot = Self.read()
        let entries = (0...Self.horizon).map { hour in
            SnapshotEntry(
                date: now.addingTimeInterval(Double(hour) * Self.step), snapshot: snapshot
            )
        }
        // `.atEnd`: ask again when the last entry is reached, rather than at a
        // fixed clock time. The app republishes on every change and reloads the
        // timelines itself, so this is only the floor.
        completion(Timeline(entries: entries, policy: .atEnd))
    }

    /// The published file, or nil for every kind of "there isn't one".
    static func read() -> LedgerSnapshot? {
        guard let directory = SharedGroup.containerURL() else { return nil }
        return SnapshotFile.read(from: directory)
    }
}
