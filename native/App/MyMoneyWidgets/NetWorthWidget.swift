// What the accounts come to, on the home screen and on the lock screen.
//
// FOUR FAMILIES, ONE FIGURE. Small and medium on the home screen; rectangular
// and inline on the lock screen. Each says the same thing at the size it has,
// and every one of them carries the "as at" line -- see `WidgetPieces.swift`
// rule 1. The inline family is one line of text and still spends a third of it
// on the age, because a lock-screen figure with no date on it is the most
// live-looking number in the whole system.
//
// AND THE CAVEATS TRAVEL. A total that leaves an unrated currency out, or
// leaves accounts out, is marked here exactly as it is marked on the accounts
// screen. A widget that quietly dropped the footnote would be the one screen
// that overstated the total.
import MyMoneyKit
import SwiftUI
import WidgetKit

struct NetWorthWidget: Widget {
    static var families: [WidgetFamily] {
        #if os(iOS)
            [.systemSmall, .systemMedium, .accessoryRectangular, .accessoryInline]
        #else
            [.systemSmall, .systemMedium]
        #endif
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.gs.MyMoneyNative.NetWorth", provider: SnapshotProvider()) {
            entry in
            NetWorthWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("Net worth")
        .description("What your accounts came to when you last opened MyMoney.")
        // THE LOCK-SCREEN FAMILIES ARE iOS ONLY. A Mac has no lock screen to
        // put a widget on, and naming them there is a compile error rather than
        // a no-op -- which is the right way round.
        .supportedFamilies(Self.families)
    }
}

/// The thin wrapper the widget itself renders: it reads the family out of the
/// environment and hands it on.
///
/// THE FAMILY IS AN ARGUMENT, NOT AN ENVIRONMENT READ, one layer down. That is
/// not indirection for its own sake: `\.widgetFamily` is read-only, so a view
/// that reads it directly cannot be drawn anywhere but on a home screen, and a
/// widget nobody can look at outside a home screen is a widget whose layout is
/// checked by hoping. With the family as a parameter, every size is a pure
/// function of (entry, family) and can be rendered and inspected.
struct NetWorthWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SnapshotEntry

    var body: some View {
        NetWorthWidgetViewBody(entry: entry, family: family)
    }
}

struct NetWorthWidgetViewBody: View {
    let entry: SnapshotEntry
    let family: WidgetFamily

    var body: some View {
        guard let snapshot = entry.snapshot, let freshness = entry.freshness else {
            #if os(iOS)
                return AnyView(
                    family == .accessoryInline
                        ? AnyView(Text("Open MyMoney"))
                        : AnyView(NothingYet(compact: family == .accessoryRectangular))
                )
            #else
                return AnyView(NothingYet())
            #endif
        }
        #if os(iOS)
        switch family {
        case .accessoryInline:
            // ONE LINE, and the age is still in it. "£12,345.67 · 3h ago".
            return AnyView(
                Text("\(snapshot.netWorthText) \u{00B7} \(short(freshness))")
                    .accessibilityLabel(
                        "\(snapshot.netWorthSpoken), \(freshness.phrase)"
                    )
            )
        case .accessoryRectangular:
            return AnyView(rectangular(snapshot, freshness))
        case .systemMedium:
            return AnyView(medium(snapshot, freshness))
        default:
            return AnyView(small(snapshot, freshness))
        }
        #else
        return AnyView(
            family == .systemMedium ? AnyView(medium(snapshot, freshness))
                : AnyView(small(snapshot, freshness))
        )
        #endif
    }

    // MARK: - Lock screen

    private func rectangular(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness)
        -> some View
    {
        VStack(alignment: .leading, spacing: 1) {
            Text("Net worth")
                .font(.caption2)
                .foregroundStyle(.secondary)
            Text(snapshot.netWorthText)
                .font(.headline)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            AsAtLine(freshness: freshness)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Net worth \(snapshot.netWorthSpoken), \(freshness.phrase).")
    }

    // MARK: - Home screen

    private func small(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> some View {
        VStack(alignment: .leading, spacing: 4) {
            Text("Net worth")
                .font(.caption)
                .foregroundStyle(.secondary)
            Text(snapshot.netWorthText)
                .font(.title2.weight(.semibold))
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            Spacer(minLength: 2)
            if let note = caveat(snapshot) {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            LocalChangesLine(count: snapshot.localEditCount)
            AsAtLine(freshness: freshness)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenSummary(snapshot, freshness))
    }

    private func medium(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> some View {
        VStack(alignment: .leading, spacing: 6) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 2) {
                    Text("Net worth")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    Text(snapshot.netWorthText)
                        .font(.title.weight(.semibold))
                        .minimumScaleFactor(0.6)
                        .lineLimit(1)
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 2) {
                    Text("Out in \(snapshot.monthName)")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                    MonthOut(snapshot: snapshot, font: .title3.weight(.medium))
                }
            }
            Spacer(minLength: 0)
            if let note = caveat(snapshot) {
                Text(note)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(2)
            }
            LocalChangesLine(count: snapshot.localEditCount)
            AsAtLine(freshness: freshness, long: true)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenSummary(snapshot, freshness))
    }

    // MARK: - The footnotes, carried rather than dropped

    private func caveat(_ snapshot: LedgerSnapshot) -> String? {
        var parts: [String] = []
        if !snapshot.missingRateCurrencies.isEmpty {
            parts.append("excludes \(snapshot.missingRateCurrencies.joined(separator: ", "))")
        }
        if snapshot.excludedAccountCount > 0 {
            parts.append(
                "\(snapshot.excludedAccountCount) account"
                    + (snapshot.excludedAccountCount == 1 ? "" : "s") + " not counted"
            )
        }
        guard !parts.isEmpty else { return nil }
        return parts.joined(separator: " \u{00B7} ")
    }

    private func spokenSummary(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> String
    {
        var sentence = "Net worth \(snapshot.netWorthSpoken), \(freshness.phrase)."
        if let note = caveat(snapshot) { sentence += " " + note + "." }
        if snapshot.localEditCount > 0 {
            sentence +=
                " "
                + LocalEdits(count: snapshot.localEditCount, firstAt: nil, lastAt: nil).countLine
                + "."
        }
        return sentence
    }

    /// "3h", "12m", "2d" -- the inline family has one line and this is the most
    /// of it the age may take.
    private func short(_ freshness: SnapshotFreshness) -> String {
        let age = freshness.age
        switch age {
        case ..<90: return "now"
        case ..<3600: return "\(max(1, Int(age / 60)))m"
        case ..<(48 * 3600): return "\(max(1, Int(age / 3600)))h"
        default: return "\(max(1, Int(age / 86400)))d"
        }
    }
}
