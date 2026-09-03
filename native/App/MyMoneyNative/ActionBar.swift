// Where a screen's actions live: the bottom of it.
//
// THE REACH ARGUMENT, AND IT IS A MEASUREMENT RATHER THAN A TASTE. On a 6.9"
// phone the navigation bar sits about 60pt down a 956pt screen -- 0.06 of the
// way from the top -- and that is the one band a thumb cannot get to without
// the hand letting go and re-gripping. SwiftUI's `.confirmationAction` and
// `.cancellationAction` put a button exactly there. That is the right home for
// CANCEL, which is pressed rarely and which a downward swipe already does; it
// is the wrong home for SAVE, ADD, DONE and APPLY, which are the buttons this
// app exists in order to have pressed.
//
// SO EVERY PRIMARY ACTION IS A BAR AT THE BOTTOM, and it is built here once.
// One implementation rather than a dozen hand-rolled `safeAreaInset` blocks
// that drift: the height of the tap target, the gap between Save and Delete,
// and the behaviour under a keyboard are each decided in a single place, and a
// screen added later gets all three by using this rather than by remembering
// them.
//
// IT IS A `safeAreaInset`, AND THAT IS THE WHOLE TRICK. Pinned with an overlay
// the bar would be covered by the keyboard, which is strictly worse than being
// at the top -- a button you cannot see is not a button, and a Save hidden
// under a keypad is a sheet people abandon. As a BOTTOM SAFE-AREA INSET the
// system lifts it with the keyboard and puts it back afterwards, and the
// scrolling content underneath keeps its own room to scroll: nothing ends up
// permanently hidden behind the bar either.
//
// DESTRUCTIVE ACTIONS GO AT THE OTHER END OF THE SAME ROW. Stacked directly
// under Save they would sit in the arc a thumb sweeps through on the way to
// Save, which is the one place a mis-tap is likely; at the far left of a 440pt
// bar they are about 250pt away from it, across the axis the thumb does not
// travel along. The size difference does the rest of the work -- the thing that
// is pressed a hundred times is wide and filled, the thing that is pressed
// twice a year is a small bordered square.
import SwiftUI

#if os(iOS)
    import Combine
    import UIKit
#endif

/// The bar itself: a divider, a material, and whatever the screen puts in it.
///
/// The content is stacked vertically so a screen can put more than one row in
/// (Quick Add puts its keypad above its Save button); a screen wanting two
/// controls side by side puts an `HStack` in.
struct ActionBar<Content: View>: View {
    var spacing: CGFloat = 12
    @ViewBuilder var content: Content

    var body: some View {
        VStack(spacing: spacing) {
            content
        }
        .padding(.horizontal, 16)
        .padding(.vertical, 12)
        .frame(maxWidth: .infinity)
        // `.bar` rather than a solid colour so the content scrolling under it
        // stays faintly visible: a list that appears to end at the bar is a
        // list somebody stops scrolling.
        .background(.bar, ignoresSafeAreaEdges: .bottom)
        .overlay(alignment: .top) { Divider() }
    }
}

/// The button a screen exists to have pressed.
///
/// FULL WIDTH AND FILLED, ALWAYS. Width is reach: a 408pt-wide target cannot be
/// missed by a thumb arriving from any grip, and it removes the horizontal
/// aiming that a 60pt nav-bar button demands. `.controlSize(.large)` takes it
/// to roughly 52pt tall, comfortably past the 44pt minimum.
///
/// ─────────────────────────────────────────────────────────────────────────────
/// THERE IS NO WAY TO DISABLE ONE OF THESE SILENTLY, AND THAT IS THE POINT
///
/// It takes a `disabledReason: DisabledReason?` and NOT an `isEnabled: Bool`. nil
/// live; anything else disables the button AND draws that sentence immediately
/// above it, inside the same bar, where the thumb is already looking.
///
/// This is a defect fixed in the type system rather than by discipline. On a
/// fresh install with a real 348-row export the one button that could do
/// anything with the file was grey, and the sentence explaining why was in a
/// card the owner had already scrolled past. The screen was not lying; it was
/// silent, which is worse, because silence looks like a bug in the app rather
/// than a state with a way out. `isEnabled: someBool` is exactly as easy to
/// write as the correct thing, so the correct thing is now the only thing that
/// compiles.
///
/// TWO RULES FOR WRITING THE REASON, both held by `ImportAdviceTests` for the
/// sentences that live in the kit:
///
///   1. NAME WHAT IS MISSING. "Save" going grey is a question; "Give this
///      account a name" is an answer.
///   2. SAY WHAT TO DO NEXT. An instruction, not a diagnosis -- and one the
///      owner can actually follow on the screen they are looking at.
///
/// A BUSY STATE IS THE ONE EXEMPTION, and it is not really one: a button whose
/// TITLE already reads "Saving…" or "Reading the file…" has stated its reason
/// in the loudest place on the screen, so passing `.working` says exactly that
/// and draws no second line. Use it only where the title changes.
struct PrimaryAction: View {
    let title: String
    var systemImage: String? = nil
    /// nil ⇒ live. See the note above: there is deliberately no `isEnabled`.
    var disabledReason: DisabledReason? = nil
    /// False only where the CALLER is already drawing the sentence somewhere
    /// the thumb can see it -- `SaveBar` spans it across a bar that also holds
    /// a delete. It never means "do not say why"; it means "said once".
    var drawsReason = true
    /// What this control is called in the reach log, if it is measured.
    ///
    /// TAKEN HERE RATHER THAN APPLIED OUTSIDE, so that the probe lands on the
    /// BUTTON and not on the button plus its reason. `.reachProbe` measures the
    /// view it is attached to; attached to the whole of this it would report a
    /// box that grows upward as the sentence gets longer, so a perfectly placed
    /// button would appear to drift up the screen every time the explanation
    /// beside it got a line longer. The thumb hits the button. Measure that.
    var probe: String? = nil
    let run: () -> Void

    /// Why a primary action is not available.
    enum DisabledReason: Equatable {
        /// Something is in flight and the TITLE says so ("Saving…"). No second
        /// sentence, because the button is already the sentence.
        case working
        /// Anything else, in the owner's words: what is missing, and what to do.
        case because(String)

        var sentence: String? {
            if case .because(let text) = self { return text }
            return nil
        }
    }

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if drawsReason, let sentence = disabledReason?.sentence {
                ActionReason(text: sentence)
            }
            Button(action: run) {
                label
                    .font(.body.weight(.semibold))
                    .frame(maxWidth: .infinity, minHeight: 24)
            }
            .buttonStyle(.borderedProminent)
            .controlSize(.large)
            .disabled(disabledReason != nil)
            // SPOKEN AS ONE THING. VoiceOver announces a disabled button and
            // then moves on; the reason is a separate element it may never
            // reach, so it is attached to the button as well as drawn above it.
            .accessibilityHint(disabledReason?.sentence ?? "")
            .reachProbe(probe ?? "")
        }
    }

    @ViewBuilder private var label: some View {
        if let systemImage {
            Label(title, systemImage: systemImage)
        } else {
            Text(title)
        }
    }
}

/// Why the button under this is not available, in the bar, next to it.
///
/// ONE IMPLEMENTATION so that the footnote size, the icon and the wrap
/// behaviour are decided once. `fixedSize(vertical:)` is the load-bearing part:
/// without it a two-line reason is truncated to one, and a truncated
/// explanation is the same dead end as no explanation.
struct ActionReason: View {
    let text: String

    var body: some View {
        Label {
            Text(text)
                .font(.footnote)
                .fixedSize(horizontal: false, vertical: true)
        } icon: {
            Image(systemName: "info.circle")
        }
        .foregroundStyle(.secondary)
        .frame(maxWidth: .infinity, alignment: .leading)
        .accessibilityElement(children: .combine)
    }
}

/// A delete, at the far end of the bar from the save.
///
/// ICON ONLY, AND SMALL, ON PURPOSE. It is the one control on the screen that
/// should be slightly harder to hit than everything else, and a trash glyph in
/// red is not ambiguous. The word is still there for VoiceOver and for a
/// pointer, and the confirmation that follows -- which iOS draws at the bottom
/// of the screen, in reach -- carries the full sentence about what happens.
struct DestructiveAction: View {
    let title: String
    var systemImage = "trash"
    let run: () -> Void

    var body: some View {
        Button(role: .destructive, action: run) {
            Image(systemName: systemImage)
                .frame(minWidth: 28, minHeight: 24)
        }
        .buttonStyle(.bordered)
        .controlSize(.large)
        .tint(.red)
        .accessibilityLabel(title)
        .help(title)
    }
}

/// A bar carrying one save, and optionally one delete kept away from it.
///
/// The shape every editor sheet in this app now ends with, so that the gap
/// between the two buttons is one number in one place rather than a decision
/// each editor makes again.
struct SaveBar: View {
    let title: String
    /// nil ⇒ live. Passed straight to `PrimaryAction`, which draws it above
    /// the button; see the note there for why this is not an `isEnabled`.
    var disabledReason: PrimaryAction.DisabledReason? = nil
    /// What this measurement is called in the reach log. See `Reach`.
    let probe: String
    let save: () -> Void
    /// nil on a screen that creates rather than edits.
    var delete: (title: String, run: () -> Void)? = nil

    var body: some View {
        ActionBar {
            // THE REASON SPANS THE WHOLE BAR, above both buttons, rather than
            // being squeezed into the column the Save occupies next to a
            // delete button. It is a sentence; it needs the width.
            if let sentence = disabledReason?.sentence {
                ActionReason(text: sentence)
            }
            HStack(spacing: 16) {
                if let delete {
                    DestructiveAction(title: delete.title, run: delete.run)
                }
                PrimaryAction(
                    title: title, disabledReason: disabledReason, drawsReason: false,
                    probe: probe, run: save
                )
            }
        }
    }
}

// MARK: - The keyboard

extension View {
    /// Reports the system keyboard coming up and going away.
    ///
    /// Used only by Quick Add, which folds its keypad away when a text field
    /// takes over the bottom of the screen -- two keyboards stacked would leave
    /// the sheet no room at all. Everything else needs nothing: a bottom
    /// safe-area inset is moved by the system on its own.
    func onKeyboardChange(_ handler: @escaping (Bool) -> Void) -> some View {
        #if os(iOS)
            return
                self
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIResponder.keyboardWillShowNotification
                    )
                ) { _ in handler(true) }
                .onReceive(
                    NotificationCenter.default.publisher(
                        for: UIResponder.keyboardWillHideNotification
                    )
                ) { _ in handler(false) }
        #else
            return self
        #endif
    }
}
