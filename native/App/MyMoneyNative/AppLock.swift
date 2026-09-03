// Face ID in front of the app, and the screen that stands there until it opens.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS IS, SAID ONCE MORE WHERE THE CODE IS
//
// It draws a view over the app. It does not encrypt the database, hold a key,
// or store a secret. `AppLockPolicy`'s header argues the point at length and
// `AppLockSettings.honestyLine` is the sentence the owner reads on the settings
// screen. Nothing in this file should ever grow a keychain item: the moment it
// does, this stops being a curtain that is honest about being a curtain and
// becomes a safe that is not one.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE THREE THINGS THAT ARE EASY TO GET WRONG, AND WHAT IS DONE ABOUT EACH
//
//  1. A REUSED `LAContext` DOES NOT ASK AGAIN. A context caches its successful
//     evaluation for `touchIDAuthenticationAllowableReuseDuration` and, more to
//     the point, `evaluatePolicy` on a context that has already succeeded can
//     return immediately. A lock built on one long-lived context therefore
//     stops asking. Every attempt below makes a NEW context.
//
//  2. THE APP SWITCHER TAKES A PICTURE. iOS snapshots the window when the app
//     leaves the foreground, and that snapshot is what somebody scrolling
//     through open apps sees. Locking on `.background` is too late -- the
//     picture is taken at `.inactive`. So the cover goes up at `.inactive`,
//     before the shutter, and comes down only after an unlock.
//
//  3. THE GRACE PERIOD MUST BE MEASURED ON A CLOCK NOBODY CAN SET.
//     `ProcessInfo.systemUptime`, not `Date()`: a wall clock moves when the
//     owner changes it, when a time server corrects it, and when the phone
//     crosses a timezone, and a lock that can be postponed by changing the
//     clock is not a lock. The arithmetic itself is in the kit, where it is
//     tested against every impossible reading.
import LocalAuthentication
import MyMoneyKit
import Observation
import SwiftUI

@MainActor
@Observable
final class AppLockModel {

    /// Has the owner asked for the lock? Persisted.
    private(set) var isEnabled: Bool
    private(set) var grace: AppLockGrace

    /// Locked, or not. Never set directly from outside this class.
    private(set) var state: AppLockState = .unlocked
    /// What went wrong last time, in the owner's words. nil before the first
    /// attempt and after a success.
    private(set) var message: String?
    /// True while iOS is showing its own prompt, so the button cannot be
    /// pressed twice and two prompts cannot be stacked.
    private(set) var isAuthenticating = false
    /// Set when the device turns out to have no passcode at all. The app opens
    /// -- see `AppLockResponse.unenforceable` -- and says this until it does.
    private(set) var unenforceableReason: String?

    /// The reading of the monotonic clock at the moment the app stopped being
    /// frontmost. nil means it has not left since it launched.
    private var leftForegroundAt: Double?
    /// True from `.inactive` until an unlock. The cover, which is a stronger
    /// condition than `state == .locked` -- see (2) above.
    private(set) var isObscured = false

    private let defaults: UserDefaults

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `object(forKey:)` TO ASK WHETHER IT IS SET, then the typed accessor
        // to read it. A stored boolean and a boolean supplied another way -- a
        // managed preference, a launch argument -- are not the same Objective-C
        // type, and `as? Bool` quietly answers nil for the second, which for
        // this setting means "the lock is off" and looks exactly like the owner
        // never turned it on. `bool(forKey:)` interprets all of them; the
        // presence check is what keeps "not set" distinguishable from "false".
        self.isEnabled =
            defaults.object(forKey: AppLockSettings.enabledKey) == nil
            ? AppLockSettings.enabledByDefault
            : defaults.bool(forKey: AppLockSettings.enabledKey)
        self.grace = AppLockGrace.stored(
            defaults.object(forKey: AppLockSettings.graceKey) == nil
                ? nil
                : defaults.integer(forKey: AppLockSettings.graceKey)
        )
        // A LAUNCH IS LOCKED. Set here rather than in a `.task`, so there is no
        // frame in which the book is on screen before the lock arrives.
        self.state = policy.stateAtLaunch
        self.isObscured = state == .locked
    }

    var policy: AppLockPolicy {
        AppLockPolicy(isEnabled: isEnabled, grace: grace)
    }

    var isLocked: Bool { state == .locked }

    // MARK: - Settings

    /// Turn the lock on, but only after proving, once, in front of the owner,
    /// that this device can actually authenticate.
    ///
    /// WITHOUT THAT PROOF THE SWITCH IS A TRAP: it would put a screen in front
    /// of the book that the owner has no way past, and the way past is the very
    /// thing that has just been shown not to work. So enabling is an `async`
    /// operation that can fail, not a boolean somebody sets.
    func enable() async -> Bool {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            message = AppLockPolicy.response(to: Self.failure(from: error)).messageText
            return false
        }
        guard await evaluate(context, reason: Self.enableReason) else {
            // The message was set by `evaluate`. Nothing is switched on.
            return false
        }
        isEnabled = true
        defaults.set(true, forKey: AppLockSettings.enabledKey)
        message = nil
        unenforceableReason = nil
        state = .unlocked
        isObscured = false
        return true
    }

    /// Turn it off. No authentication is asked for, and that is not an
    /// oversight: the app is already open, which means the owner has already
    /// been through the lock (or it was never on). Asking again would be
    /// theatre, and this file does not do theatre about what it protects.
    func disable() {
        isEnabled = false
        defaults.set(false, forKey: AppLockSettings.enabledKey)
        state = .unlocked
        isObscured = false
        message = nil
        unenforceableReason = nil
    }

    func setGrace(_ grace: AppLockGrace) {
        self.grace = grace
        defaults.set(grace.rawValue, forKey: AppLockSettings.graceKey)
    }

    /// Can this device authenticate at all? Asked so the settings screen can
    /// explain rather than offer a switch that will not work.
    var biometryDescription: String {
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            return AppLockPolicy.response(to: Self.failure(from: error)).messageText
        }
        switch context.biometryType {
        case .faceID: return "Face ID, with your passcode as a fallback."
        case .touchID: return "Touch ID, with your passcode as a fallback."
        case .opticID: return "Optic ID, with your passcode as a fallback."
        default: return "Your device passcode."
        }
    }

    // MARK: - Scene phase

    /// Called for every scene-phase change.
    ///
    /// `.inactive` covers the screen (the app-switcher snapshot is taken here)
    /// and records when the app left. `.active` asks the policy whether enough
    /// time has passed, on a clock nobody can set.
    func scenePhaseChanged(to phase: ScenePhase) {
        guard isEnabled else {
            isObscured = false
            return
        }
        switch phase {
        case .inactive, .background:
            if leftForegroundAt == nil { leftForegroundAt = Self.monotonicNow }
            isObscured = true
        case .active:
            // NOTHING TO MEASURE MEANS THE APP NEVER LEFT, and that must not be
            // treated as "I do not know". `.active` can arrive more than once
            // for a single foregrounding -- after a system alert, after a
            // permission sheet -- and re-running the grace-period test with no
            // departure to measure from would answer "locked" and slam the
            // curtain shut on somebody who unlocked two seconds ago. The launch
            // case is already covered: `init` decides a launch is locked, before
            // the first frame.
            guard let left = leftForegroundAt else {
                isObscured = state == .locked
                return
            }
            leftForegroundAt = nil
            state = policy.stateOnForeground(leftForegroundAt: left, now: Self.monotonicNow)
            isObscured = state == .locked
            if state == .unlocked { message = nil }
        @unknown default:
            // A phase this build has never heard of is not a reason to open.
            state = .locked
            isObscured = true
        }
    }

    // MARK: - Unlocking

    func unlock() async {
        guard isEnabled, state == .locked, !isAuthenticating else { return }
        isAuthenticating = true
        defer { isAuthenticating = false }

        // A FRESH CONTEXT EVERY TIME. See (1) in the header.
        let context = LAContext()
        var error: NSError?
        guard context.canEvaluatePolicy(.deviceOwnerAuthentication, error: &error) else {
            apply(AppLockPolicy.response(to: Self.failure(from: error)))
            return
        }
        if await evaluate(context, reason: Self.unlockReason) {
            state = .unlocked
            isObscured = false
            message = nil
            unenforceableReason = nil
        }
    }

    /// Run iOS's own prompt. `.deviceOwnerAuthentication` is biometry WITH the
    /// device passcode behind it -- not `.deviceOwnerAuthenticationWithBiometrics`,
    /// which has no fallback and would strand anybody whose face is not
    /// recognised on a cold morning.
    private func evaluate(_ context: LAContext, reason: String) async -> Bool {
        do {
            return try await context.evaluatePolicy(.deviceOwnerAuthentication, localizedReason: reason)
        } catch {
            apply(AppLockPolicy.response(to: Self.failure(from: error as NSError)))
            return false
        }
    }

    private func apply(_ response: AppLockResponse) {
        switch response {
        case .stayLocked(let text):
            state = .locked
            isObscured = true
            message = text
        case .unenforceable(let text):
            // The one case the app opens on. Argued in `AppLockResponse`.
            state = .unlocked
            isObscured = false
            message = nil
            unenforceableReason = text
        }
    }

    // MARK: - Translating LocalAuthentication

    /// `LAError.Code` -> the kit's vocabulary, in one place.
    ///
    /// `LAError.Code` IS NOT A FROZEN ENUM, so a `default` here is unavoidable
    /// -- which is exactly why the DECISION about each case lives in the kit and
    /// is tested there. Anything this build has never seen becomes `.unknown`,
    /// and `.unknown` stays locked.
    private static func failure(from error: NSError?) -> AppLockFailure {
        guard let error, error.domain == LAError.errorDomain else { return .unknown }
        switch LAError.Code(rawValue: error.code) {
        case .userCancel, .appCancel: return .cancelled
        case .authenticationFailed: return .notRecognised
        case .userFallback: return .cancelled
        case .biometryNotAvailable, .biometryNotEnrolled: return .biometryUnavailable
        case .biometryLockout: return .biometryLockout
        case .passcodeNotSet: return .passcodeNotSet
        case .systemCancel, .invalidContext, .notInteractive: return .systemCancelled
        default: return .unknown
        }
    }

    /// The sentence iOS puts on its own prompt. It has to say WHY, because that
    /// dialog is the only thing on screen at that moment.
    private static let unlockReason = "Unlock MyMoney to see your accounts."
    private static let enableReason = "Confirm it\u{2019}s you, so MyMoney can lock itself."

    /// A clock nobody can set. See (3) in the header.
    private static var monotonicNow: Double { ProcessInfo.processInfo.systemUptime }
}

extension AppLockResponse {
    var messageText: String {
        switch self {
        case .stayLocked(let text): return text
        case .unenforceable(let text): return text
        }
    }
}

// MARK: - The screen that stands in the way

/// What is drawn over the app while it is locked -- and while it is merely
/// leaving the foreground, which is when the app switcher takes its picture.
///
/// OPAQUE, NOT BLURRED. A blur over a net-worth figure is still the shape and
/// the length of a net-worth figure, and a screenshot of it is worse than
/// useless: it looks as though something was protected.
struct LockCover: View {
    let lock: AppLockModel

    var body: some View {
        ZStack {
            Color.appBackground
                .ignoresSafeArea()

            if lock.isLocked {
                VStack(spacing: 22) {
                    Spacer()

                    Image(systemName: "lock.fill")
                        .font(.system(size: 44))
                        .foregroundStyle(.secondary)
                        .accessibilityHidden(true)

                    VStack(spacing: 8) {
                        Text("MyMoney is locked")
                            .font(.title2.weight(.semibold))
                        Text(lock.message ?? "Unlock to see your accounts.")
                            .font(.callout)
                            .foregroundStyle(.secondary)
                            .multilineTextAlignment(.center)
                            .fixedSize(horizontal: false, vertical: true)
                    }
                    .padding(.horizontal, 32)
                    .accessibilityElement(children: .combine)

                    Spacer()

                    // THE UNLOCK BUTTON IS AT THE BOTTOM, like every other
                    // primary action in this app, and for the same reason:
                    // it is the only thing on this screen worth pressing and
                    // the thumb should not have to travel.
                    ActionBar {
                        PrimaryAction(
                            title: lock.isAuthenticating ? "Unlocking\u{2026}" : "Unlock",
                            systemImage: "faceid",
                            // The TITLE is the reason -- see
                            // `PrimaryAction.DisabledReason.working`.
                            disabledReason: lock.isAuthenticating ? .working : nil,
                            probe: "Lock \u{2014} Unlock"
                        ) {
                            Task { await lock.unlock() }
                        }
                    }
                }
                // ASKS AS SOON AS IT APPEARS. The button is for a second
                // attempt after a cancel, not for the first one: making
                // somebody tap "Unlock" before Face ID even looks at them is a
                // tap for nothing.
                .task { await lock.unlock() }
            }
        }
    }
}

extension Color {
    /// The system's own window background on both platforms. Written here
    /// because the two SDKs spell it differently and a view should not have to.
    static var appBackground: Color {
        #if os(macOS)
            return Color(nsColor: .windowBackgroundColor)
        #else
            return Color(uiColor: .systemBackground)
        #endif
    }
}
