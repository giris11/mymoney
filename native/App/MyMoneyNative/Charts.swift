// The chart vocabulary, and the one rule it exists to keep.
//
// ─────────────────────────────────────────────────────────────────────────────
// EVERY MARK IS DIRECT-LABELLED. Name and value on the mark itself, readable
// without a tap and without a colour key.
//
// The web app made that choice deliberately (docs/CONTRACTS.md: "Every mark is
// direct-labelled (name + formatted value visible without hover):
// category/payee/tag spend renders as a labelled horizontal-bar list, never an
// unlabelled pie. This is the accessibility relief for entity-coloured marks --
// non-negotiable.") and it is kept here for the same reason and one more.
//
// The reason: a legend is a lookup table. It asks the reader to hold six
// colours in their head, match each to a wedge, and then read a number off an
// axis -- and for the ~8% of men with a red-green colour deficiency, the
// matching step does not work at all. A labelled bar list asks nothing: the
// name and the amount are on the row.
//
// The extra reason on a phone: a hover tooltip is not a thing that exists.
// Anything only reachable by touching a 6-point wedge is, in practice, not
// reachable.
//
// SO: colour in this file is EMPHASIS, never information. Every bar's colour
// is decoration, marked `accessibilityHidden`, and every row's accessibility
// label states the name, the amount and -- where a direction is meant -- the
// words "in" and "out", never a hue. A screen reader gets the whole chart.
//
// AND EVERY FIGURE COMES FROM `MyMoneyKit.Money`, through `Display`. There is
// no `NumberFormatter` in this file and there must never be one: a chart label
// that formatted a penny differently from the total above it would be the most
// convincing wrong number in the app.
import MyMoneyKit
import SwiftUI

// MARK: - The labelled bar list

/// One row of a labelled bar list: everything drawn, nothing computed.
struct BarItem: Identifiable, Hashable {
    let id: String
    let name: String
    /// The amount as it will be shown, already formatted by the kit.
    let value: String
    /// What a screen reader should say for `value`.
    let spokenValue: String
    /// Bar length as a fraction of the largest row, 0...1.
    let fraction: Double
    /// "12%" of the level total, or nil when a share is not meaningful.
    let share: String?
    /// "#rrggbb" from the entity, or nil for the neutral fallback.
    let colourHex: String?
    /// A short word beside the name ("Over", "directly").
    let chip: String?
    /// Set when the row descends a level.
    let drill: (() -> Void)?

    static func == (lhs: BarItem, rhs: BarItem) -> Bool { lhs.id == rhs.id }
    func hash(into hasher: inout Hasher) { hasher.combine(id) }
}

/// The contract-mandated rendering for category, payee and tag spend.
///
/// Bars are proportional to the LARGEST ROW, not to the total: at a glance the
/// question is "how does this compare with the biggest one", and scaling to the
/// total makes every bar in a long-tailed book a sliver.
struct BarList: View {
    let items: [BarItem]
    /// Named for a screen reader, so the list announces what it is a list of.
    let label: String

    var body: some View {
        VStack(spacing: 0) {
            ForEach(items) { item in
                if let drill = item.drill {
                    Button(action: drill) { row(item, drillable: true) }
                        .buttonStyle(.plain)
                        .accessibilityHint("Shows what is inside \(item.name)")
                } else {
                    row(item, drillable: false)
                }
            }
        }
        .accessibilityLabel(label)
    }

    private func row(_ item: BarItem, drillable: Bool) -> some View {
        VStack(alignment: .leading, spacing: 5) {
            // THE LABEL LINE. Name and value on the mark; this is the whole
            // point of the component.
            ViewThatFits(in: .horizontal) {
                HStack(spacing: 8) {
                    dot(item)
                    nameText(item)
                    Spacer(minLength: 8)
                    shareText(item)
                    valueText(item)
                    if drillable { chevron }
                }
                VStack(alignment: .leading, spacing: 2) {
                    HStack(spacing: 8) {
                        dot(item)
                        nameText(item)
                        Spacer(minLength: 4)
                        if drillable { chevron }
                    }
                    HStack(spacing: 8) {
                        shareText(item)
                        valueText(item)
                    }
                }
            }
            ProportionBar(fraction: item.fraction, colourHex: item.colourHex)
        }
        .padding(.vertical, 7)
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(item.chip.map { "\(item.name), \($0)" } ?? item.name)
        .accessibilityValue(
            item.share.map { "\(item.spokenValue), \($0) of the total" } ?? item.spokenValue
        )
    }

    private func dot(_ item: BarItem) -> some View {
        // Decoration. The row already says the name; the dot only helps the eye
        // pair a row with its bar.
        Circle()
            .fill(barColour(item.colourHex))
            .frame(width: 9, height: 9)
            .accessibilityHidden(true)
    }

    private func nameText(_ item: BarItem) -> some View {
        HStack(spacing: 6) {
            Text(item.name)
                .font(.callout)
                .lineLimit(1)
            if let chip = item.chip {
                Text(chip)
                    .font(.caption2)
                    .foregroundStyle(.secondary)
                    .padding(.horizontal, 5)
                    .padding(.vertical, 1)
                    .background(.quaternary, in: Capsule())
            }
        }
    }

    private func shareText(_ item: BarItem) -> some View {
        Group {
            if let share = item.share {
                Text(share)
                    .font(.caption)
                    .monospacedDigit()
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private func valueText(_ item: BarItem) -> some View {
        Text(item.value)
            .font(.callout.weight(.medium))
            .monospacedDigit()
            .lineLimit(1)
    }

    private var chevron: some View {
        Image(systemName: "chevron.right")
            .font(.caption.weight(.semibold))
            .foregroundStyle(.tertiary)
            .accessibilityHidden(true)
    }
}

/// The bar itself. `accessibilityHidden` throughout: it repeats, in pixels,
/// what the line above it says in words.
struct ProportionBar: View {
    let fraction: Double
    var colourHex: String? = nil
    var height: CGFloat = 6

    var body: some View {
        GeometryReader { geometry in
            let width = max(0, min(1, fraction)) * geometry.size.width
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(barColour(colourHex))
                    // A non-zero amount always draws SOMETHING. A bar of zero
                    // width beside a real figure reads as "nothing", which is
                    // the one thing it is not.
                    .frame(width: fraction > 0 ? max(3, width) : 0)
            }
        }
        .frame(height: height)
        .accessibilityHidden(true)
    }
}

/// The entity's own colour, or a neutral that is visible in both appearances.
func barColour(_ hex: String?) -> Color {
    hex.flatMap { Color(hex: $0) } ?? Color.accentColor
}

// MARK: - Money in and money out, by month

/// One month as a pair of labelled bars.
///
/// A ROW PER MONTH RATHER THAN A GROUPED COLUMN CHART. Grouped columns are
/// prettier and cannot be direct-labelled on a phone: twelve months of two
/// series is twenty-four marks across 390 points, and the labels either overlap
/// or disappear into a tooltip nobody can reach. Rows scroll, and every bar
/// keeps its own figure beside it.
struct MonthFlowRow: View {
    let month: String
    let incomeMinor: Int64
    let expenseMinor: Int64
    let currency: String
    /// The largest single figure across every month on screen, so the bars are
    /// comparable down the list rather than each scaled to itself.
    let scaleMinor: Int64

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text(monthLabel(month))
                .font(.footnote.weight(.medium))
                .foregroundStyle(.secondary)
            bar(label: "In", minor: incomeMinor, colour: .green)
            bar(label: "Out", minor: expenseMinor, colour: .red)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .combine)
        .accessibilityLabel(monthLabel(month))
        .accessibilityValue(
            "In \(Display.moneySpoken(incomeMinor, currency)), "
                + "out \(Display.moneySpoken(expenseMinor, currency))"
        )
    }

    private func bar(label: String, minor: Int64, colour: Color) -> some View {
        HStack(spacing: 8) {
            // THE WORD, not the colour, is what says which series this is.
            Text(label)
                .font(.caption2)
                .foregroundStyle(.secondary)
                .frame(width: 26, alignment: .leading)
            GeometryReader { geometry in
                let fraction = scaleMinor > 0 ? Double(minor) / Double(scaleMinor) : 0
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 14)
                    Capsule()
                        .fill(colour.opacity(0.85))
                        .frame(width: minor > 0 ? max(3, fraction * geometry.size.width) : 0, height: 14)
                }
            }
            .frame(height: 14)
            Text(Display.money(minor, currency))
                .font(.caption.weight(.medium))
                .monospacedDigit()
                .lineLimit(1)
        }
        .accessibilityHidden(true)
    }
}

/// One month of cash flow: a bar leaving a centre line, left for a month that
/// spent more than it took, right for one that did not.
struct CashFlowRow: View {
    let month: String
    let netMinor: Int64
    let cumulativeMinor: Int64
    let currency: String
    /// The largest ABSOLUTE net in the range, so both directions share a scale.
    let scaleMinor: Int64

    var body: some View {
        VStack(alignment: .leading, spacing: 5) {
            HStack {
                Text(monthLabel(month))
                    .font(.footnote.weight(.medium))
                    .foregroundStyle(.secondary)
                Spacer(minLength: 8)
                // Direct-labelled, with the sign spelled out rather than left
                // to the side of the centre line the bar happens to be on.
                Text(signed(netMinor))
                    .font(.callout.weight(.medium))
                    .monospacedDigit()
                Text("running \(Display.money(cumulativeMinor, currency))")
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
                    .lineLimit(1)
            }
            GeometryReader { geometry in
                let half = geometry.size.width / 2
                let fraction = scaleMinor > 0 ? Double(abs(netMinor)) / Double(scaleMinor) : 0
                let length = netMinor == 0 ? 0 : max(3, fraction * half)
                ZStack(alignment: .leading) {
                    Capsule().fill(.quaternary).frame(height: 10)
                    Rectangle()
                        .fill(.tertiary)
                        .frame(width: 1)
                        .offset(x: half)
                    Capsule()
                        .fill((netMinor < 0 ? Color.red : Color.green).opacity(0.85))
                        .frame(width: length, height: 10)
                        .offset(x: netMinor < 0 ? half - length : half)
                }
            }
            .frame(height: 10)
            .accessibilityHidden(true)
        }
        .padding(.vertical, 6)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(monthLabel(month))
        .accessibilityValue(
            "\(Display.moneyFlowSpoken(netMinor, currency)), "
                + "running total \(Display.moneySpoken(cumulativeMinor, currency))"
        )
    }

    private func signed(_ minor: Int64) -> String {
        (minor > 0 ? "+" : "") + Display.money(minor, currency)
    }
}

// MARK: - Net worth over time

/// A line with its ends labelled.
///
/// NO AXES, AND THAT IS THE POINT. An axis is a lookup table with the same
/// problem as a legend: it asks the reader to trace a mark across to a tick and
/// read a number off it. The two figures that answer "how am I doing" are the
/// first and the last, so those two are printed ON the chart, at the ends of
/// the line they belong to, and the high and low are stated underneath in
/// words. Nothing on this chart requires a tap to read.
///
/// A COMPACT "£1.2k" FORMATTER WAS DELIBERATELY NOT WRITTEN. The web app has
/// one for its axis ticks; this chart has no ticks, and inventing a second way
/// to render money -- one with no oracle behind it -- to save four characters
/// would be the wrong trade in this app.
struct NetWorthChart: View {
    let points: [NetWorthPoint]
    let currency: String
    var height: CGFloat = 132

    private var values: [Int64] { points.map(\.totalBaseMinor) }
    private var lowest: Int64 { values.min() ?? 0 }
    private var highest: Int64 { values.max() ?? 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if points.count >= 2 {
                chart
                extremes
            } else {
                Text("Not enough history yet to draw a line \u{2014} this needs at least two months.")
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// Where each point sits, worked out ONCE per layout.
    ///
    /// A method rather than a closure inside the `GeometryReader`: a result
    /// builder cannot hold a function declaration, and recomputing the
    /// arithmetic per mark would run it three times over for the line, the
    /// fill and the dots.
    private func positions(in size: CGSize) -> [CGPoint] {
        let span = max(1, highest - lowest)
        // Inset so the two end labels have somewhere to sit without being
        // clipped by the edge of the card.
        let top: CGFloat = 18
        let bottom: CGFloat = 16
        let plot = max(1, size.height - top - bottom)
        return values.indices.map { index in
            let x = values.count == 1
                ? size.width / 2
                : size.width * CGFloat(index) / CGFloat(values.count - 1)
            let ratio = Double(values[index] - lowest) / Double(span)
            return CGPoint(x: x, y: top + plot * (1 - ratio))
        }
    }

    /// The two ends of the line -- one index when there is only one point.
    private func endIndices(of marks: [CGPoint]) -> [Int] {
        guard !marks.isEmpty else { return [] }
        return marks.count == 1 ? [0] : [0, marks.count - 1]
    }

    private var chart: some View {
        GeometryReader { geometry in
            let size = geometry.size
            let marks = positions(in: size)
            ZStack(alignment: .topLeading) {
                // The filled area is decoration; the line is the mark.
                Path { path in
                    path.move(to: CGPoint(x: 0, y: size.height))
                    for point in marks { path.addLine(to: point) }
                    path.addLine(to: CGPoint(x: size.width, y: size.height))
                    path.closeSubpath()
                }
                .fill(
                    LinearGradient(
                        colors: [Color.accentColor.opacity(0.28), Color.accentColor.opacity(0.02)],
                        startPoint: .top, endPoint: .bottom
                    )
                )
                Path { path in
                    for (index, point) in marks.enumerated() {
                        if index == 0 { path.move(to: point) } else { path.addLine(to: point) }
                    }
                }
                .stroke(Color.accentColor, style: StrokeStyle(lineWidth: 2, lineJoin: .round))

                // Indices rather than points: `CGPoint` only became `Hashable`
                // in iOS 18, and this app runs on 17.
                ForEach(endIndices(of: marks), id: \.self) { index in
                    Circle()
                        .fill(Color.accentColor)
                        .frame(width: 6, height: 6)
                        .position(marks[index])
                }

                // THE DIRECT LABELS. First on the left, last on the right,
                // each above its own end of the line.
                if let first = points.first, let last = points.last {
                    endLabel(first, alignment: .leading)
                        .frame(width: size.width, alignment: .leading)
                    endLabel(last, alignment: .trailing)
                        .frame(width: size.width, alignment: .trailing)
                }
            }
        }
        .frame(height: height)
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Net worth over time")
        .accessibilityValue(accessibilitySentence)
    }

    private func endLabel(_ point: NetWorthPoint, alignment: HorizontalAlignment) -> some View {
        VStack(alignment: alignment, spacing: 0) {
            Text(Display.money(point.totalBaseMinor, currency))
                .font(.caption.weight(.semibold))
                .monospacedDigit()
            Text(Display.dateText(point.date))
                .font(.caption2)
                .foregroundStyle(.secondary)
        }
        .lineLimit(1)
        .accessibilityHidden(true)
    }

    /// The high and the low, in words, under the line. This is what an axis
    /// would have been for.
    private var extremes: some View {
        Group {
            if let high = points.max(by: { $0.totalBaseMinor < $1.totalBaseMinor }),
                let low = points.min(by: { $0.totalBaseMinor < $1.totalBaseMinor }),
                high.totalBaseMinor != low.totalBaseMinor
            {
                Text(
                    "High \(Display.money(high.totalBaseMinor, currency)) on "
                        + "\(Display.dateText(high.date)) \u{00B7} Low "
                        + "\(Display.money(low.totalBaseMinor, currency)) on "
                        + "\(Display.dateText(low.date))"
                )
                .font(.caption2)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        }
    }

    /// A chart a screen reader can actually read: the shape, in a sentence.
    private var accessibilitySentence: String {
        guard let first = points.first, let last = points.last else { return "No data" }
        let direction: String
        if last.totalBaseMinor > first.totalBaseMinor {
            direction = "up"
        } else if last.totalBaseMinor < first.totalBaseMinor {
            direction = "down"
        } else {
            direction = "unchanged"
        }
        return
            "\(points.count) points. From \(Display.moneySpoken(first.totalBaseMinor, currency)) on "
            + "\(Display.dateSpoken(first.date)) to "
            + "\(Display.moneySpoken(last.totalBaseMinor, currency)) on "
            + "\(Display.dateSpoken(last.date)). Overall \(direction)."
    }
}

// MARK: - Budgets

/// A budget's progress bar: the fill, and the two figures beside it.
///
/// The bar is capped at full width because a bar cannot be 140% long, and the
/// UNCAPPED figure is stated in the line above it -- so "over by £20" is read,
/// not inferred from a bar that has stopped growing.
struct BudgetBar: View {
    let progress: BudgetProgress
    let currency: String

    var body: some View {
        GeometryReader { geometry in
            let fraction = min(1, max(0, progress.pct))
            ZStack(alignment: .leading) {
                Capsule().fill(.quaternary)
                Capsule()
                    .fill(fill)
                    .frame(width: progress.spentMinor > 0 ? max(3, fraction * geometry.size.width) : 0)
            }
        }
        .frame(height: 8)
        .accessibilityHidden(true)
    }

    private var fill: Color {
        if progress.over { return .red }
        // 85% is the web app's threshold for "getting close" (NEAR_LIMIT in
        // budgetFormat.tsx), kept so both apps warn at the same moment.
        return progress.pct >= 0.85 ? .orange : .accentColor
    }
}

/// "Spent £120.00 of £200.00 · £80.00 left" -- or "£20.00 over".
///
/// One sentence, in words, so the state of a budget never depends on reading
/// the colour of a bar.
struct BudgetStatusLine: View {
    let progress: BudgetProgress
    let currency: String

    var body: some View {
        Text(sentence)
            .font(.footnote)
            .foregroundStyle(.secondary)
            .monospacedDigit()
            .fixedSize(horizontal: false, vertical: true)
            .accessibilityLabel(spoken)
    }

    /// A NEGATIVE SPEND IS NOT "Spent -£20.00".
    ///
    /// `spentMinor` is net of refunds and is deliberately not floored at zero
    /// (see `Budgets.progress`), so a period whose refunds beat its spending
    /// has a negative figure -- and "Spent -£7,369.76 of £450.00 · £7,819.76
    /// left" is arithmetic nobody should have to parse. It gets its own
    /// sentence instead.
    private var sentence: String {
        if progress.spentMinor < 0 {
            return "\(Display.money(-progress.spentMinor, currency)) came back \u{2014} more "
                + "refunded than spent \u{00B7} limit "
                + "\(Display.money(progress.limitMinor, currency))"
        }
        let head =
            "Spent \(Display.money(progress.spentMinor, currency)) of "
            + "\(Display.money(progress.limitMinor, currency))"
        if progress.over {
            return head + " \u{00B7} \(Display.money(-progress.remainingMinor, currency)) over"
        }
        return head + " \u{00B7} \(Display.money(progress.remainingMinor, currency)) left"
    }

    private var spoken: String {
        if progress.spentMinor < 0 {
            return "\(Display.moneySpoken(-progress.spentMinor, currency)) came back, more "
                + "refunded than spent. Limit "
                + "\(Display.moneySpoken(progress.limitMinor, currency))"
        }
        let head =
            "Spent \(Display.moneySpoken(progress.spentMinor, currency)) of "
            + "\(Display.moneySpoken(progress.limitMinor, currency))"
        if progress.over {
            return head + ", \(Display.moneySpoken(-progress.remainingMinor, currency)) over budget"
        }
        return head + ", \(Display.moneySpoken(progress.remainingMinor, currency)) left"
    }
}

// MARK: - The note that must never be omitted

/// SPEC §6: a missing rate is SURFACED, never guessed.
///
/// Two shapes, because two things can be missing: transactions left out of a
/// flow report, and whole currencies left out of a net-worth total. Both say
/// what to do about it, because "some figures are missing" with no next step is
/// a message people learn to ignore.
struct MissingRateNote: View {
    var count: Int = 0
    var currencies: [String] = []

    var body: some View {
        Group {
            if !currencies.isEmpty || count > 0 {
                HStack(alignment: .firstTextBaseline, spacing: 6) {
                    Image(systemName: "exclamationmark.triangle.fill")
                        .font(.caption)
                        .foregroundStyle(.orange)
                        .accessibilityHidden(true)
                    Text(message)
                        .font(.caption)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                .padding(.top, 2)
                .accessibilityElement(children: .combine)
            }
        }
    }

    private var message: String {
        if !currencies.isEmpty {
            return
                "Excludes \(currencies.joined(separator: ", ")) balances \u{2014} no exchange rate "
                + "to your base currency. Add one in your web app."
        }
        return
            "\(Display.count(count, "transaction")) excluded \u{2014} no exchange rate to your "
            + "base currency. Add one in your web app."
    }
}

// MARK: - Small shared pieces

/// 'YYYY-MM' → "Sep 2026", the display form both apps use for a month.
func monthLabel(_ month: String) -> String {
    Display.dateText("\(month)-01").split(separator: " ").dropFirst().joined(separator: " ")
}

/// The word a NEGATIVE spend row needs.
///
/// `spendingByCategory` and its siblings drop zero rows and keep negative ones,
/// because a category whose refunds beat its spending this period is a real
/// thing that happened and hiding it would make the rows stop adding up to the
/// total. But a negative row draws no bar -- there is no length to draw -- and
/// a row with a figure and an empty bar reads as missing data.
///
/// So it gets a word instead. Seen on a real screen: a month where "Food"
/// showed -£7,362.43 against a blank bar and nothing said why.
func spendChip(_ spentMinor: Int64) -> String? {
    spentMinor < 0 ? "net refund" : nil
}

/// A share of a total, rendered as the web app renders it: whole percents from
/// 10 up, one decimal below.
func percentText(_ fraction: Double) -> String? {
    guard fraction.isFinite else { return nil }
    let pct = fraction * 100
    if abs(pct) >= 10 { return "\(Int(pct.rounded()))%" }
    return String(format: "%.1f%%", (pct * 10).rounded() / 10)
}

/// A titled block on a screen made of blocks.
struct CardSection<Content: View>: View {
    let title: String
    var caption: String? = nil
    var trailing: AnyView? = nil
    @ViewBuilder let content: () -> Content

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(alignment: .firstTextBaseline) {
                VStack(alignment: .leading, spacing: 1) {
                    Text(title)
                        .font(.subheadline.weight(.semibold))
                    if let caption {
                        Text(caption)
                            .font(.caption)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                if let trailing { trailing }
            }
            content()
        }
        .padding(16)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.background.secondary, in: RoundedRectangle(cornerRadius: 14))
    }
}
