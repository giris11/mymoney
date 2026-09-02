// The measurement the reach work is answerable to.
//
// A CLAIM ABOUT WHERE A BUTTON IS SHOULD BE A NUMBER. "It looks like it's near
// the bottom" is how a layout regresses quietly: a section grows, a bar is
// wrapped in something that eats the safe area, a keyboard covers a Save, and
// the screenshot everybody remembers is six months old. So every primary action
// in this app is tagged with `.reachProbe("...")`, and the layout system itself
// reports where it actually landed -- not a guess from a picture of it.
//
// IT IS OFF UNLESS ASKED FOR. `MYMONEY_REACH=1` in the launch environment turns
// it on; without that the modifier hands the view straight back and there is no
// GeometryReader, no preference and no print. Run it like this:
//
//   xcrun simctl launch --console-pty --terminate-running-process \
//     <device> com.gs.MyMoneyNative MYMONEY_REACH=1
//
// and every line beginning REACH is one control, in window points, with the
// fraction of the screen height its centre sits at. The bottom third is
// fraction >= 0.667.
//
// THE FRACTION IS OF THE WHOLE SCREEN, home indicator and status bar included,
// because that is the thing the hand is holding. Measuring against the safe
// area would flatter every number by about seven per cent.
import SwiftUI

#if os(iOS)
    import UIKit
#endif

/// One measured control: where its box landed, in window points.
struct ReachSample: Equatable, Sendable {
    let name: String
    let frame: CGRect
}

private struct ReachKey: PreferenceKey {
    static var defaultValue: [ReachSample] { [] }

    static func reduce(value: inout [ReachSample], nextValue: () -> [ReachSample]) {
        value.append(contentsOf: nextValue())
    }
}

enum Reach {
    /// Read once, from the launch environment. A `let` rather than a settable
    /// flag so nothing in the app can turn logging on for a real user.
    static let isMeasuring: Bool = ProcessInfo.processInfo.environment["MYMONEY_REACH"] == "1"

    @MainActor static func report(_ samples: [ReachSample]) {
        guard isMeasuring else { return }
        let height = screenHeight
        guard height > 0 else { return }
        for sample in samples where sample.frame.height > 0 {
            print(
                String(
                    format:
                        "REACH\t%@\ttop=%.1f\tmid=%.1f\tbottom=%.1f\theight=%.1f\twidth=%.1f"
                        + "\tscreen=%.1f\tfraction=%.3f",
                    sample.name, sample.frame.minY, sample.frame.midY, sample.frame.maxY,
                    sample.frame.height, sample.frame.width, height, sample.frame.midY / height
                )
            )
        }
    }

    /// The whole screen, not the window and not the safe area: a sheet's window
    /// is inset, and measuring against it would report a Save button as being
    /// lower down than the hand holding the phone finds it.
    @MainActor private static var screenHeight: CGFloat {
        #if os(iOS)
            let scenes = UIApplication.shared.connectedScenes.compactMap { $0 as? UIWindowScene }
            return scenes.first?.screen.bounds.height ?? 0
        #else
            return 0
        #endif
    }
}

extension View {
    /// Tag a control so `MYMONEY_REACH=1` reports where it ends up.
    func reachProbe(_ name: String) -> some View {
        modifier(ReachProbe(name: name))
    }
}

private struct ReachProbe: ViewModifier {
    let name: String

    @ViewBuilder func body(content: Content) -> some View {
        if Reach.isMeasuring {
            content
                .background {
                    GeometryReader { proxy in
                        Color.clear.preference(
                            key: ReachKey.self,
                            value: [ReachSample(name: name, frame: proxy.frame(in: .global))]
                        )
                    }
                }
                .onPreferenceChange(ReachKey.self) { samples in
                    Task { @MainActor in Reach.report(samples) }
                }
        } else {
            content
        }
    }
}
