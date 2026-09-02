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
//   SIMCTL_CHILD_MYMONEY_REACH=1 SIMCTL_CHILD_MYMONEY_REACH_OPEN=scheduled \
//     xcrun simctl launch --console-pty --terminate-running-process \
//     <device> com.gs.MyMoneyNative
//
// and every line beginning REACH is one control, in window points, with the
// fraction of the screen height its centre sits at. The bottom third is
// fraction >= 0.667.
//
// TWO PIECES OF THAT COMMAND ARE NOT DECORATION, AND BOTH WERE FOUND BY THE
// MEASUREMENT SILENTLY REPORTING NOTHING:
//
//   * `SIMCTL_CHILD_`. Trailing `KEY=VALUE` after the bundle id are ARGV, not
//     environment -- `simctl launch --help` says so at the bottom. Passed that
//     way the variable never reaches `ProcessInfo`, the probe stays off, and
//     the run produces an empty log that looks exactly like a run in which
//     every button was somewhere unexpected.
//   * `--console-pty`, and not `--console`, `--stdout=` or a background
//     redirect. `print` goes to stdout; stdout to a FILE is fully buffered and
//     the app is killed rather than exited, so the buffer dies with it. A pty
//     is line-buffered, which is the only reason any of this appears at all.
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

    /// Which screen to be on when the app finishes launching.
    ///
    /// WHY THIS EXISTS AT ALL. A probe only reports a control that is ON
    /// SCREEN, so measuring a bar inside a sheet three taps in used to mean
    /// somebody driving the simulator by hand -- which makes the number a
    /// thing that happened once rather than a thing that can be checked again.
    /// This puts the app on the screen and lets the layout system report,
    /// which is the same measurement without the hands.
    ///
    /// IT CANNOT AFFECT A REAL RUN. It is read only when `isMeasuring` is
    /// already true, every site that honours it is inside an
    /// `if Reach.isMeasuring`, and the whole thing is nil without the
    /// environment variable that no shipped launch sets.
    ///
    /// EVERY PROBE IN THE APP HAS A NAME HERE, and that is deliberate. A
    /// vocabulary covering four of the nineteen bars meant the other fifteen
    /// were checked by hand or not at all -- and "not at all" is what actually
    /// happened, because hand-driving fifteen screens is a job nobody repeats.
    /// One launch per name, no hands, and a regression on any bar in the app
    /// shows up as a number that moved.
    ///
    /// Known values, each naming one primary action to be measured:
    ///
    ///   accounts           the accounts sidebar       -> Quick add
    ///   quickadd           the Quick Add sheet        -> Save, and its keypad
    ///   transaction        the transaction editor     -> Save
    ///   transfer           the transfer editor        -> Save
    ///   account            the account editor         -> Save
    ///   register           all transactions           -> Quick add
    ///   budgets            the budgets screen         -> New budget
    ///   budgets.new        the budget editor          -> Save
    ///   budgets.detail     the first budget, opened   -> Edit this budget
    ///   scheduled          the upcoming screen        -> New schedule
    ///   scheduled.new      the schedule editor        -> Save
    ///   scheduled.confirm  the first due occurrence   -> Enter it
    ///   scheduled.detail   the first schedule, opened -> Edit this schedule
    ///   reports.range      the custom date range      -> Apply
    ///   import             the import screen          -> Choose a file
    ///   groups             the account groups screen  -> Add
    ///   groups.rename      the rename sheet           -> Save
    ///
    /// And three that carry no primary action at all -- `dashboard`,
    /// `insights`, `settings`. They report nothing, and they are here because
    /// "this screen has no bar" is a claim worth being able to CHECK: a bar
    /// added to one of them later should show up in a sweep rather than in a
    /// screenshot somebody happens to take.
    ///
    /// AN UNKNOWN NAME IS NOT AN ERROR. It leaves the selection alone and the
    /// app opens on the accounts screen, which is what a plain launch does.
    static let opening: String? =
        isMeasuring ? ProcessInfo.processInfo.environment["MYMONEY_REACH_OPEN"] : nil

    /// Is the app being pointed at this screen for a measurement?
    static func isOpening(_ name: String) -> Bool { opening == name }

    /// The route the measurement wants the sidebar to have selected.
    ///
    /// Matched on the FAMILY -- the part before the first dot -- rather than by
    /// prefix, because `hasPrefix` cannot tell `account` (the editor sheet,
    /// which opens over the sidebar) from `accounts` (the sidebar itself), and
    /// picking the wrong one of those measures a bar that is not on screen.
    static var openingRoute: Route? {
        guard let family = opening?.split(separator: ".").first.map(String.init) else { return nil }
        switch family {
        case "scheduled": return .scheduled
        case "budgets": return .budgets
        case "reports": return .reports
        case "import": return .importBackup
        case "groups": return .groups
        case "register": return .allTransactions
        case "dashboard": return .dashboard
        case "insights": return .insights
        case "settings": return .settings
        // The sidebar is the accounts screen, and the four editor sheets open
        // on top of it. Nil leaves the selection alone, which is where they
        // are opened from in a real run.
        default: return nil
        }
    }

    /// The sheet a measurement wants open over the accounts screen.
    ///
    /// Separate from `openingRoute` because these are not routes: they are the
    /// sheets the sidebar's own bar opens, and a measurement of the Save inside
    /// one has to compose with the sidebar behind it exactly as a real tap does.
    static var openingSheet: EditorSheet? {
        switch opening {
        case "quickadd": return .quickAdd
        case "transaction": return .newTransaction
        case "transfer": return .transfer(nil, legId: nil)
        case "account": return .account(nil)
        default: return nil
        }
    }

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
