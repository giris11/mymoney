// The small shared pieces, and the one sentence this app must never stop saying.
import MyMoneyKit
import SwiftUI

/// THE STATEMENT THAT OUTRANKS EVERYTHING ELSE ON SCREEN.
///
/// The web app is the system of record. This app holds an imported COPY of it,
/// and from this version on it can edit that copy -- which means the two can
/// disagree, and the person holding the phone has to be able to tell which is
/// which without thinking about it.
///
/// SO THE BANNER IS NOT A WARNING, IT IS A COUNT. A fixed sentence ("this is a
/// copy") says the same thing before the first edit and after the hundredth,
/// and a sentence that never changes stops being read within a week. A number
/// that grows -- "14 changes made here that your web app does not have" -- is
/// arithmetic rather than advice: it is different every time you look at it,
/// which is exactly why it keeps being looked at.
///
/// It is permanent, it is not dismissible, and it sits ABOVE the scrolling
/// list so it cannot be scrolled away. The wording comes from
/// `LocalEdits` in the kit, so the sentence and the number it quotes are
/// produced by the same thing.
///
/// IT IS COMPACT BY DEFAULT, AND THAT IS A FIX RATHER THAN A PREFERENCE.
/// It used to print `LocalEdits.summary` -- two sentences -- permanently. At
/// the largest accessibility text size those two sentences are eight lines: the
/// banner took roughly 80% of an iPhone viewport and the account list underneath
/// it became a ~180pt sliver. A ledger you cannot see is its own kind of
/// dishonesty.
///
/// The two obvious escapes were both refused, and rightly: shortening the
/// sentence weakens what it explains, and letting the banner scroll away removes
/// the one guarantee it exists to give. So the banner SPLITS instead. What stays
/// on screen at every text size is the COUNT -- one line, the number first --
/// and the explanation is one tap behind a disclosure. That division follows
/// what each half is for: the sentence is read once, when somebody first wonders
/// what this app is; the number is read every day, and it is the number that
/// changes.
struct LocalCopyBanner: View {
    /// nil when there is nothing to say, and the caller does not decide which
    /// case that is -- `LedgerSummary` is nil with no book, and `LocalEdits`
    /// answers nil for a book CREATED on this device.
    ///
    /// AN OPTIONAL RATHER THAN A REWORDING, and that is the whole point. Every
    /// sentence this banner can print names the web app as the authority, and
    /// for a book the web app has never held that is not a warning that is
    /// slightly too strong, it is a false statement in the one place this app
    /// promises to be exact. A reader who catches it being wrong once has
    /// learned the row is furniture, and the day the count is right is the day
    /// it is ignored. So there is nothing to print, and nothing is printed.
    let edits: LocalEdits?
    /// Closed on every launch. This is deliberately NOT remembered: the
    /// explanation is a thing you go and read, not a setting, and a banner whose
    /// height depended on a tap made six weeks ago would be a banner nobody
    /// could predict the size of.
    @State private var showingExplanation = false

    var body: some View {
        if let edits, let countLine = edits.countLine {
            banner(edits, countLine)
        }
    }

    private func banner(_ edits: LocalEdits, _ countLine: String) -> some View {
        VStack(alignment: .leading, spacing: 0) {
            Button {
                withAnimation(.snappy(duration: 0.2)) { showingExplanation.toggle() }
            } label: {
                countRow(edits, countLine)
            }
            .buttonStyle(.plain)
            .accessibilityElement(children: .combine)
            .accessibilityAddTraits(.isButton)
            .accessibilityHint(
                showingExplanation ? "Hides what this means" : "Explains what this means"
            )

            if showingExplanation, let summary = edits.summary {
                Text(summary)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                    .frame(maxWidth: .infinity, alignment: .leading)
                    .padding(.top, 8)
                    .transition(.opacity)
            }
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(
            edits.hasDiverged
                ? AnyShapeStyle(.orange.opacity(0.12)) : AnyShapeStyle(.quaternary.opacity(0.4))
        )
    }

    private func countRow(_ edits: LocalEdits, _ countLine: String) -> some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(
                systemName: edits.hasDiverged
                    ? "arrow.triangle.branch" : "iphone.and.arrow.forward"
            )
            .foregroundStyle(edits.hasDiverged ? .orange : .secondary)
            .accessibilityHidden(true)
            // THE COUNT, AND NOTHING ELSE. `.medium` because this is now the
            // whole message rather than the first half of a paragraph, and it
            // still wraps rather than truncating: a count that ran off the edge
            // of the screen at a large text size would be the same bug in a
            // smaller costume.
            Text(countLine)
                .font(.footnote.weight(.medium))
                .foregroundStyle(edits.hasDiverged ? .primary : .secondary)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Image(systemName: "chevron.down")
                .font(.caption2.weight(.semibold))
                .foregroundStyle(.secondary)
                .rotationEffect(.degrees(showingExplanation ? 180 : 0))
                .accessibilityHidden(true)
        }
        .contentShape(Rectangle())
    }
}

/// A refusal, shown where the Save button is.
///
/// BOTH SENTENCES, ALWAYS, and in different weights: what was wrong is the
/// headline, and "nothing was saved" is the line underneath it. The second one
/// is the one that stops somebody closing the sheet and re-entering everything
/// they just typed -- possibly onto a row that already took it.
struct RefusalNotice: View {
    let refusal: EditRefusal

    var body: some View {
        HStack(alignment: .firstTextBaseline, spacing: 10) {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(refusal.problem)
                    .font(.callout)
                    .fixedSize(horizontal: false, vertical: true)
                Text(refusal.unchanged)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        }
        .frame(maxWidth: .infinity, alignment: .leading)
        .padding(.vertical, 4)
        .accessibilityElement(children: .combine)
    }
}

/// The bar that offers a delete back.
///
/// A DELETE IS AN ACTION WITH A WAY BACK, not a question with a confirmation
/// dialog. Confirming every delete taxes the common case -- a delete the owner
/// meant -- to protect the rare one, and people learn to tap through
/// confirmations without reading them within a day. An undo taxes nothing and
/// is EXACT here, because the row was never destroyed: undoing clears a
/// tombstone rather than rebuilding anything from a copy that might be stale.
struct UndoBar: View {
    let message: String
    let undo: () -> Void
    let dismiss: () -> Void

    var body: some View {
        HStack(spacing: 12) {
            Text(message)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
            Spacer(minLength: 8)
            Button("Undo", action: undo)
                .font(.footnote.weight(.semibold))
            Button {
                dismiss()
            } label: {
                Image(systemName: "xmark")
                    .font(.footnote)
            }
            .buttonStyle(.plain)
            .foregroundStyle(.secondary)
            .accessibilityLabel("Dismiss")
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 10)
        .frame(maxWidth: .infinity, alignment: .leading)
        .background(.thinMaterial)
        .overlay(alignment: .top) { Divider() }
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

/// The colour a figure printed under a DIRECTIONAL heading is drawn in.
///
/// The heading does not decide it; `FlowWords.Movement` does, and that follows
/// the money. "Out −£5,438.08" used to be red because the column is called Out
/// -- directly above a sentence saying the money came back. Colour that argues
/// with the words beside it is worse than no colour, because the reader has to
/// decide which of the two the app means.
///
/// Zero is neither, and is drawn as neither: a month with nothing out of it has
/// not sent money anywhere, and the colour of a departure would be emphasis on
/// an event that did not happen.
func flowColour(_ movement: FlowWords.Movement) -> Color {
    switch movement {
    case .inward: return .green
    case .outward: return .red
    case .still: return .secondary
    }
}
