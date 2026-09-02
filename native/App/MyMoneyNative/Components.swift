// The small shared pieces, and the one sentence this app must never stop saying.
import MyMoneyKit
import SwiftUI

/// The statement that outranks everything else on screen.
///
/// The web app is the system of record. This app reads a backup file and shows
/// it. It cannot edit, add or delete anything, and it is not the place to go
/// when a figure is wrong. Somebody who forgets that could try to "fix"
/// something here, find they cannot, and conclude that their money is missing.
///
/// It is a real sentence, not a chip or an icon: an icon that means "read only"
/// is a thing you have to already know.
struct ReadOnlyBanner: View {
    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "eye")
                .foregroundStyle(.secondary)
                .accessibilityHidden(true)
            Text(
                "Read-only copy. Your web app is the real ledger \u{2014} nothing here can "
                    + "change it, and nothing here can be edited."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.quaternary.opacity(0.4))
        .accessibilityElement(children: .combine)
    }
}

/// A figure with a caption, sized by Dynamic Type, read as one thing.
struct FigureRow: View {
    let label: String
    let value: String
    /// What a screen reader should say instead of `value` -- "minus £45.67"
    /// rather than a hyphen it may or may not pronounce.
    var spoken: String?
    var emphasised = false

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(alignment: .firstTextBaseline) {
                Text(label)
                Spacer(minLength: 12)
                valueText
            }
            VStack(alignment: .leading, spacing: 2) {
                Text(label)
                valueText
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(label)
        .accessibilityValue(spoken ?? value)
    }

    private var valueText: some View {
        Text(value)
            .monospacedDigit()
            .fontWeight(emphasised ? .semibold : .regular)
            .foregroundStyle(emphasised ? AnyShapeStyle(.primary) : AnyShapeStyle(.secondary))
    }
}

/// A coloured dot for an account, from the "#rrggbb" the file carries.
///
/// Decoration, and marked as such: the colour is never the only thing carrying
/// a meaning, so a screen reader is told to skip it rather than to describe it.
struct AccountDot: View {
    let hex: String
    @ScaledMetric(relativeTo: .body) private var size: CGFloat = 10

    var body: some View {
        Circle()
            .fill(Color(hex: hex) ?? .secondary)
            .frame(width: size, height: size)
            .accessibilityHidden(true)
    }
}

extension Color {
    /// "#rrggbb" or "#rgb". nil for anything else -- a colour this app cannot
    /// parse falls back to a visible neutral rather than to black on black.
    init?(hex: String) {
        var s = hex.trimmingCharacters(in: .whitespaces)
        if s.hasPrefix("#") { s.removeFirst() }
        if s.count == 3 { s = s.map { "\($0)\($0)" }.joined() }
        guard s.count == 6, let value = UInt32(s, radix: 16) else { return nil }
        self.init(
            .sRGB,
            red: Double((value >> 16) & 0xFF) / 255,
            green: Double((value >> 8) & 0xFF) / 255,
            blue: Double(value & 0xFF) / 255
        )
    }
}

/// A message that fills the space where content would be: the empty state, a
/// failure, a screen still loading. Never a blank rectangle -- a finance app
/// showing nothing is indistinguishable from a finance app that has lost
/// something.
struct Notice: View {
    let symbol: String
    let title: String
    let message: String
    var tone: Tone = .neutral
    var action: (title: String, run: () -> Void)?

    enum Tone { case neutral, warning, problem }

    var body: some View {
        VStack(spacing: 12) {
            Image(systemName: symbol)
                .font(.largeTitle)
                .foregroundStyle(colour)
                .accessibilityHidden(true)
            // `.frame(maxWidth: .infinity)` on the TEXT, not just on the box
            // around it. Inside a List row the proposed width can arrive
            // unbounded, and a Text given no width takes its IDEAL one -- a
            // single line -- which the row then clips. The result is a
            // sentence that stops mid-word, which in this app would most often
            // be a sentence explaining that nothing was imported.
            Text(title)
                .font(.headline)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
            Text(message)
                .font(.callout)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
                .frame(maxWidth: .infinity)
                .fixedSize(horizontal: false, vertical: true)
            if let action {
                Button(action.title, action: action.run)
                    .buttonStyle(.borderedProminent)
                    .padding(.top, 4)
            }
        }
        .padding(28)
        .frame(maxWidth: 460)
    }

    private var colour: Color {
        switch tone {
        case .neutral: return .secondary
        case .warning: return .orange
        case .problem: return .red
        }
    }
}

/// The colour a signed figure is drawn in.
///
/// Colour is never the only signal: the amount always carries its own sign, and
/// every accessibility label says "in" or "out" in words. This is emphasis, not
/// information.
func amountColour(_ minor: Int64) -> Color {
    minor < 0 ? .red : .primary
}
