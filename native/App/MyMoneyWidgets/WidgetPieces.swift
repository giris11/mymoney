// The parts every family of every widget is built from.
//
// TWO RULES, AND THEY ARE THE WHOLE POINT OF THE FILE:
//
//  1. EVERY FIGURE CARRIES ITS AGE. `AsAtLine` is under every net worth and
//     every budget bar, in every size, including the lock-screen ones where
//     there is barely room. A number on a home screen looks live; the only
//     thing standing between the owner and a wrong belief about his own money
//     is that line, so it is not optional and not conditional on space.
//
//  2. NOTHING IS FORMATTED HERE. Every amount goes through `Money.format` in
//     MyMoneyKit -- the same function the app's screens use, held to 284 oracle
//     cases. There is no `NumberFormatter` in this target, exactly as there is
//     none in the app's, and a widget that formatted money itself would be a
//     second answer to "what is this amount" in the place least likely to be
//     checked.
import MyMoneyKit
import SwiftUI
import WidgetKit

/// "as at 3 hours ago". Never omitted.
struct AsAtLine: View {
    let freshness: SnapshotFreshness
    var long = false

    var body: some View {
        Text(long ? freshness.longLine : freshness.line)
            .font(.caption2)
            .foregroundStyle(freshness.isStale ? AnyShapeStyle(.orange) : AnyShapeStyle(.secondary))
            .lineLimit(long ? 2 : 1)
            .minimumScaleFactor(0.8)
    }
}

/// What is drawn when there is no snapshot to draw.
///
/// A SENTENCE, NOT A ZERO. "£0.00" is a figure and would be indistinguishable
/// from a real one; "Open MyMoney" is the truth and is also the instruction.
struct NothingYet: View {
    var compact = false

    var body: some View {
        VStack(alignment: .leading, spacing: 4) {
            Image(systemName: "sterlingsign.circle")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(compact ? "Open MyMoney" : "Open MyMoney once")
                .font(.footnote.weight(.medium))
            if !compact {
                Text("Its figures appear here after you do.")
                    .font(.caption2)
                    .foregroundStyle(.secondary)
            }
        }
        .frame(maxWidth: .infinity, maxHeight: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
        .accessibilityLabel("MyMoney has nothing to show yet. Open the app once.")
    }
}

/// The count of changes this device has that the web app does not.
///
/// ON THE WIDGET TOO, because the honesty machinery does not get to stop at the
/// edge of the app. The whole design of this project is that the phone edits an
/// imported COPY and the browser holds the real ledger; a net worth on a home
/// screen that silently includes edits the browser has never seen is the worst
/// place in the system to leave that unsaid.
struct LocalChangesLine: View {
    let count: Int

    var body: some View {
        // NOTHING AT ALL FOR A BOOK CREATED ON THIS DEVICE. Such a book has no
        // web app copy to differ from, so `countLine` is nil and there is no
        // sentence to draw -- and its count is zero anyway, because nothing
        // counts an edit on it. Two independent reasons for the same silence,
        // which is what makes it hard to lose by accident.
        if count > 0, let line = LocalEdits(count: count, firstAt: nil, lastAt: nil).countLine {
            Text(line)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .lineLimit(1)
                .minimumScaleFactor(0.8)
        }
    }
}

/// A budget's bar, drawn from the same `pct` the app draws.
struct BudgetBar: View {
    let line: BudgetSnapshot
    let currency: String
    var showsName = true

    var body: some View {
        VStack(alignment: .leading, spacing: 3) {
            if showsName {
                HStack(spacing: 4) {
                    Text(line.name)
                        .font(.caption.weight(.medium))
                        .lineLimit(1)
                    Spacer(minLength: 4)
                    Text(remaining)
                        .font(.caption.weight(.semibold))
                        .foregroundStyle(line.over ? AnyShapeStyle(.red) : AnyShapeStyle(.primary))
                        .lineLimit(1)
                }
            }
            // `min(1, pct)` on the WIDTH only: the bar cannot leave the box, and
            // the figure beside it still says how far over it went. A bar drawn
            // past its own track would just be a full bar, which is what being
            // over looks like anyway -- the number is what carries the news.
            GeometryReader { geometry in
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary)
                    Capsule()
                        .fill(line.over ? AnyShapeStyle(.red) : AnyShapeStyle(.tint))
                        .frame(width: geometry.size.width * min(1, max(0, line.pct)))
                }
            }
            .frame(height: 6)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spoken)
    }

    private var remaining: String {
        line.over
            ? Money.format(-line.remainingMinor, currency: currency) + " over"
            : Money.format(line.remainingMinor, currency: currency) + " left"
    }

    private var spoken: String {
        let spent = Money.spoken(line.spentMinor, currency: currency)
        let limit = Money.spoken(line.limitMinor, currency: currency)
        let tail =
            line.over
            ? "over by \(Money.spoken(-line.remainingMinor, currency: currency))"
            : "\(Money.spoken(line.remainingMinor, currency: currency)) left"
        return "\(line.name): \(spent) of \(limit), \(tail)."
    }
}

/// This month's money out, with the word a negative one needs.
///
/// A NEGATIVE "OUT" IS NOT A SMALLER "OUT", IT IS THE OTHER DIRECTION. The demo
/// book and the owner's real one both contain months where refunds beat
/// spending, and the app's own screens learned this the hard way: a figure of
/// "-£5,484.08" under a heading saying "Out", drawn in red, sat directly above
/// a sentence saying the money had come back. `FlowWords` settles both halves
/// for every screen -- the chip and the colour -- and the widget asks it rather
/// than deciding for itself, so the home screen cannot come to disagree with
/// the dashboard it is a summary of.
struct MonthOut: View {
    let snapshot: LedgerSnapshot
    var font: Font = .title3.weight(.semibold)

    private var movement: FlowWords.Movement {
        FlowWords.movement(ofOut: snapshot.monthSpentMinor)
    }

    var body: some View {
        VStack(alignment: .trailing, spacing: 0) {
            Text(snapshot.monthSpentText)
                .font(font)
                .foregroundStyle(colour)
                .minimumScaleFactor(0.6)
                .lineLimit(1)
            if let chip = FlowWords.spendChip(snapshot.monthSpentMinor) {
                Text(chip)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .lineLimit(1)
            }
        }
    }

    /// Colour follows the MONEY, not the heading -- see `FlowWords`. Money that
    /// came back is not red because the column above it is called Out.
    private var colour: AnyShapeStyle {
        switch movement {
        case .inward: return AnyShapeStyle(.green)
        case .outward: return AnyShapeStyle(.primary)
        case .still: return AnyShapeStyle(.secondary)
        }
    }

    /// What a screen reader says, with the same word in it.
    static func spoken(_ snapshot: LedgerSnapshot) -> String {
        let amount = Money.spoken(
            abs(snapshot.monthSpentMinor), currency: snapshot.baseCurrency
        )
        switch FlowWords.movement(ofOut: snapshot.monthSpentMinor) {
        case .outward: return "\(amount) out in \(snapshot.monthName)."
        case .inward: return "\(amount) came back in \(snapshot.monthName), a net refund."
        case .still: return "Nothing out in \(snapshot.monthName)."
        }
    }
}

extension LedgerSnapshot {
    /// "September" from "2026-09", for the month heading.
    ///
    /// Built from the month key rather than from the device's calendar, because
    /// the figure is FOR that month and a widget rendered just after midnight
    /// on the first must not label August's spending "September".
    var monthName: String {
        let parts = monthKey.split(separator: "-")
        guard parts.count == 2, let month = Int(parts[1]), (1...12).contains(month) else {
            return monthKey
        }
        return Self.monthSymbols[month - 1]
    }

    /// Built once. A `DateFormatter` costs about a millisecond to construct,
    /// and a widget body is evaluated more often than it is looked at.
    private static let monthSymbols = DateFormatter().monthSymbols ?? []

    /// The net worth as the widget prints it.
    var netWorthText: String { Money.format(netWorthMinor, currency: baseCurrency) }
    var netWorthSpoken: String { Money.spoken(netWorthMinor, currency: baseCurrency) }
    var monthSpentText: String { Money.format(monthSpentMinor, currency: baseCurrency) }
}
