// This month against the budgets, on the home screen and the lock screen.
//
// WHICH BUDGETS, AND WHY THE ORDER DOES NOT MOVE. The snapshot carries the
// three with the largest limits, in that order, decided in
// `LedgerSnapshot.of(_:...)`. Not "closest to breaching": that would reorder
// the widget every time a transaction landed, and a widget whose rows swap
// places under the owner's eye is a widget he stops reading. The same reasoning
// keeps the app's own budgets list in name order.
//
// AND THE SMALL FAMILY SHOWS ONE BUDGET, NOT A SUMMARY OF THREE. Adding three
// budgets together would be arithmetic this widget is not allowed to do -- they
// can share categories, so the sum is not a number that means anything. It
// shows the largest one and says how many others there are.
import MyMoneyKit
import SwiftUI
import WidgetKit

struct BudgetWidget: Widget {
    static var families: [WidgetFamily] {
        #if os(iOS)
            [.systemSmall, .systemMedium, .accessoryRectangular]
        #else
            [.systemSmall, .systemMedium]
        #endif
    }

    var body: some WidgetConfiguration {
        StaticConfiguration(kind: "com.gs.MyMoneyNative.Budget", provider: SnapshotProvider()) {
            entry in
            BudgetWidgetView(entry: entry)
                .containerBackground(.fill.tertiary, for: .widget)
        }
        .configurationDisplayName("This month")
        .description("What you have spent this month, and how your budgets are doing.")
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
struct BudgetWidgetView: View {
    @Environment(\.widgetFamily) private var family
    let entry: SnapshotEntry

    var body: some View {
        BudgetWidgetViewBody(entry: entry, family: family)
    }
}

struct BudgetWidgetViewBody: View {
    let entry: SnapshotEntry
    let family: WidgetFamily

    var body: some View {
        guard let snapshot = entry.snapshot, let freshness = entry.freshness else {
            return AnyView(NothingYet(compact: family != .systemMedium))
        }
        #if os(iOS)
        switch family {
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

    private func rectangular(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness)
        -> some View
    {
        VStack(alignment: .leading, spacing: 1) {
            if let first = snapshot.budgets.first {
                Text(first.name)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                Text(
                    first.over
                        ? Money.format(-first.remainingMinor, currency: snapshot.baseCurrency)
                            + " over"
                        : Money.format(first.remainingMinor, currency: snapshot.baseCurrency)
                            + " left"
                )
                .font(.headline)
                .minimumScaleFactor(0.7)
                .lineLimit(1)
            } else {
                Text("Out in \(snapshot.monthName)")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                MonthOut(snapshot: snapshot, font: .headline)
            }
            AsAtLine(freshness: freshness)
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(snapshot, freshness))
    }

    private func small(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            Text("Out in \(snapshot.monthName)")
                .font(.caption)
                .foregroundStyle(.secondary)
            MonthOut(snapshot: snapshot)
                .frame(maxWidth: .infinity, alignment: .leading)
            if let first = snapshot.budgets.first {
                BudgetBar(line: first, currency: snapshot.baseCurrency)
                if snapshot.budgetCount > 1 {
                    Text("and \(snapshot.budgetCount - 1) more")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
            }
            Spacer(minLength: 0)
            AsAtLine(freshness: freshness)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken(snapshot, freshness))
    }

    private func medium(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack(alignment: .firstTextBaseline) {
                Text("Out in \(snapshot.monthName)")
                    .font(.caption)
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                MonthOut(snapshot: snapshot)
            }

            if snapshot.budgets.isEmpty {
                Text("No budgets yet.")
                    .font(.caption)
                    .foregroundStyle(.secondary)
            } else {
                ForEach(snapshot.budgets) { line in
                    BudgetBar(line: line, currency: snapshot.baseCurrency)
                }
            }

            Spacer(minLength: 0)
            // ONE LINE AT THE BOTTOM, CARRYING BOTH FACTS, and it is one line
            // because of what the pictures showed: with three bars, a header
            // and a separate "3 of 4 budgets" caption, a medium widget's 155
            // points ran out and the line that got clipped was the "as at" --
            // the one line that must never be missing. So the count moved onto
            // it, and the whole row is given layout priority so it is the last
            // thing to be squeezed rather than the first.
            HStack(spacing: 6) {
                AsAtLine(freshness: freshness, long: !hasMoreBudgets(snapshot))
                if hasMoreBudgets(snapshot) {
                    Text(
                        "\u{00B7} \(snapshot.budgets.count) of \(snapshot.budgetCount) budgets, "
                            + "biggest first"
                    )
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
                    .minimumScaleFactor(0.8)
                }
            }
            .layoutPriority(1)
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
    }

    private func hasMoreBudgets(_ snapshot: LedgerSnapshot) -> Bool {
        snapshot.budgetCount > snapshot.budgets.count
    }

    private func spoken(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> String {
        var sentence = MonthOut.spoken(snapshot)
        if let first = snapshot.budgets.first {
            let tail =
                first.over
                ? "over by \(Money.spoken(-first.remainingMinor, currency: snapshot.baseCurrency))"
                : "\(Money.spoken(first.remainingMinor, currency: snapshot.baseCurrency)) left"
            sentence += " \(first.name): \(tail)."
        }
        return sentence + " As at \(freshness.phrase)."
    }
}
