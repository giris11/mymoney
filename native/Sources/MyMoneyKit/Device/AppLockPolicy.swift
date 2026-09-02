// When the app should be showing a lock screen, and what to do when unlocking
// fails.
//
// ─────────────────────────────────────────────────────────────────────────────
// READ THIS BEFORE BELIEVING THE LOCK PROTECTS ANYTHING
//
// THIS IS A CURTAIN, NOT A SAFE. It decides whether a view is drawn. It does
// not encrypt the database, it does not hold a key, and it stores no secret --
// there is nothing here for a passcode to unlock, because the SQLite file is
// the same readable file with the lock on as with it off. What it stops is
// somebody picking up an unlocked phone and reading the owner's ledger over his
// shoulder. What it does not stop is anybody with the file.
//
// That distinction is written here, and again on the settings screen the owner
// reads, because a security feature that implies more than it delivers is worse
// than no feature: it changes what somebody is willing to leave lying around.
//
// If real protection is ever wanted, it is a different thing entirely -- an
// encryption key held in the Secure Enclave and the database opened through it
// -- and it belongs in its own phase with its own tests. Do not let this file
// grow into a half version of that.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THE TIMING LIVES IN THE KIT AND NOT IN THE VIEW
//
// Every decision below has a wrong answer that is invisible until it matters:
// a grace period measured from the wrong instant, a clock that went backwards,
// a missing timestamp read as "just now". None of those can be seen in a
// screenshot and all of them are one line. They are stated here as pure
// functions over numbers, and `AppLockTests` asserts each of them, including
// the ones that should never happen.
//
// THE FAIL-SAFE DIRECTION IS ALWAYS THE SAME: when this file does not know, it
// locks. There is no branch below whose "I am not sure" answer is `.unlocked`,
// with one exception, and the exception is stated at `AppLockResponse` where it
// can be argued with.
import Foundation

/// How long the app may be away before it locks itself again.
///
/// Whole seconds as the raw value, because that is exactly what is written into
/// `UserDefaults` -- an enum whose stored form is its own meaning cannot be
/// migrated wrong, and an unknown number read back from a future build falls
/// back to the default rather than to case zero.
public enum AppLockGrace: Int, Sendable, Hashable, CaseIterable, Identifiable {
    case immediately = 0
    case oneMinute = 60
    case fiveMinutes = 300
    case fifteenMinutes = 900
    case oneHour = 3600

    public var id: Int { rawValue }

    public var seconds: Double { Double(rawValue) }

    /// THE DEFAULT, AND THE REASONING FOR IT.
    ///
    /// `immediately` is the safest and is not the default, because the thing it
    /// actually does most often is lock the app while the owner is switching to
    /// the calculator to check a figure he is halfway through typing. An app
    /// that punishes the ordinary use of the phone gets its lock turned off,
    /// and a lock that is off protects nothing at all.
    ///
    /// A minute covers the two-app shuffle and nothing else: a phone put down
    /// on a table and picked up by somebody else is past it long before they
    /// get to it. Any owner who wants `immediately` can have it, in one tap, on
    /// the same screen.
    public static let `default`: AppLockGrace = .oneMinute

    /// The stored value, made safe. An unrecognised number -- an older build,
    /// a corrupted preference, a value from a future version -- becomes the
    /// default rather than `immediately` (which `init(rawValue: 0)` would give
    /// for a missing key) or a crash.
    public static func stored(_ raw: Int?) -> AppLockGrace {
        guard let raw, let grace = AppLockGrace(rawValue: raw) else { return .default }
        return grace
    }

    public var label: String {
        switch self {
        case .immediately: return "Immediately"
        case .oneMinute: return "After 1 minute"
        case .fiveMinutes: return "After 5 minutes"
        case .fifteenMinutes: return "After 15 minutes"
        case .oneHour: return "After 1 hour"
        }
    }

    /// What the settings row says underneath, in the owner's terms rather than
    /// in seconds.
    public var detail: String {
        switch self {
        case .immediately:
            return "Locks the moment you leave the app."
        case .oneMinute:
            return "Stays open if you pop out to another app and come straight back."
        case .fiveMinutes, .fifteenMinutes, .oneHour:
            return "Stays open if you come back within \(label.lowercased().dropFirst(6))."
        }
    }
}

/// Whether the lock screen is up.
public enum AppLockState: Sendable, Hashable {
    case locked
    case unlocked
}

/// Why an unlock attempt did not succeed, in terms this package can reason
/// about without importing LocalAuthentication.
///
/// THE TRANSLATION FROM `LAError.Code` LIVES IN THE APP, in one switch, and the
/// DECISION about each of these lives here where it is tested. That split is
/// deliberate: `LAError.Code` is not a frozen enum, so a `default` branch in
/// that switch is unavoidable, and the branch a new-and-unrecognised error
/// falls into must be the safe one. It is `.unknown`, and `.unknown` stays
/// locked.
public enum AppLockFailure: Sendable, Hashable {
    /// The owner tapped Cancel, or dismissed the sheet.
    case cancelled
    /// Face ID / Touch ID did not recognise them, and there was no fallback
    /// left to offer.
    case notRecognised
    /// This device has no biometry, or it is not enrolled.
    case biometryUnavailable
    /// Too many failed attempts; iOS has locked biometry out until a passcode
    /// is entered.
    case biometryLockout
    /// THE DEVICE ITSELF HAS NO PASSCODE. Not "this app cannot check one" --
    /// there is no passcode on the phone at all.
    case passcodeNotSet
    /// iOS took the prompt away: a call arrived, the app was backgrounded, the
    /// screen locked.
    case systemCancelled
    /// Anything this build has never heard of.
    case unknown
}

/// What the app does about a failed unlock.
public enum AppLockResponse: Sendable, Hashable {
    /// Stay locked. Show `message`, and offer to try again.
    case stayLocked(String)
    /// THE ONE CASE THAT OPENS THE APP WITHOUT AUTHENTICATION, and the argument
    /// for it, which should be read rather than trusted:
    ///
    /// `passcodeNotSet` means the phone has no passcode. Not that this app
    /// cannot read it -- that there is not one. Anybody holding the device is
    /// already past the only gate iOS has, and is already in Mail, Photos and
    /// the banking apps. A lock screen in front of a ledger on such a phone
    /// protects nothing whatsoever; what it does do is shut the owner out of
    /// his own book with no way back in, because the escape from this lock is
    /// the very passcode that does not exist.
    ///
    /// So the app opens, and says why, permanently, until a passcode exists.
    /// The alternative -- an app the owner cannot open and cannot switch the
    /// lock off in, holding a ledger that is not encrypted anyway -- trades a
    /// real loss for an imaginary gain.
    case unenforceable(String)

    public var isLocked: Bool { if case .stayLocked = self { return true } else { return false } }
}

/// The rules, as arithmetic.
///
/// A value rather than a singleton so a test can hold several at once, and so
/// the settings the owner chose are visible at the call site instead of being
/// read out of a global.
public struct AppLockPolicy: Sendable, Hashable {
    /// Has the owner switched the lock on? Off by default -- see
    /// `AppLockSettings.enabledByDefault`.
    public let isEnabled: Bool
    public let grace: AppLockGrace

    public init(isEnabled: Bool, grace: AppLockGrace) {
        self.isEnabled = isEnabled
        self.grace = grace
    }

    /// A cold launch. ALWAYS LOCKED when the lock is on, whatever the grace
    /// period says.
    ///
    /// The grace period is about leaving the app and coming back, and a launch
    /// is not that: the process is new, there is no "when you left" to measure
    /// from that survived it, and the phone may have been off for a week. A
    /// launch that consulted a timestamp written by the previous process would
    /// be trusting a number an attacker with the file can edit, to decide
    /// whether to ask him for a fingerprint.
    public var stateAtLaunch: AppLockState {
        isEnabled ? .locked : .unlocked
    }

    /// Coming back to the foreground.
    ///
    /// `leftForegroundAt` and `now` are readings from the SAME MONOTONIC CLOCK
    /// -- `ProcessInfo.systemUptime` in this app -- and not wall-clock dates.
    /// A wall clock can be changed by the owner, by a time server, or by
    /// crossing a timezone, and every one of those would move a lock the owner
    /// is relying on. Uptime cannot be set.
    ///
    /// Every uncertainty locks:
    ///
    ///   * no reading of when the app left -- it never went to the background,
    ///     or the reading was lost -- so there is nothing to measure the grace
    ///     period against;
    ///   * `now` before `leftForegroundAt`, which uptime cannot do and which
    ///     therefore means something is wrong;
    ///   * either reading not a finite number.
    public func stateOnForeground(leftForegroundAt: Double?, now: Double) -> AppLockState {
        guard isEnabled else { return .unlocked }
        guard let leftForegroundAt,
            leftForegroundAt.isFinite, now.isFinite,
            now >= leftForegroundAt
        else { return .locked }
        // `>=` rather than `>`, so `immediately` (a grace of zero) locks on
        // every return rather than on every return that took a measurable
        // moment.
        return (now - leftForegroundAt) >= grace.seconds ? .locked : .unlocked
    }

    /// What to do about a failed unlock. Everything stays locked except the one
    /// case argued at `AppLockResponse.unenforceable`.
    public static func response(to failure: AppLockFailure) -> AppLockResponse {
        switch failure {
        case .cancelled:
            return .stayLocked("Unlock to see your book.")
        case .notRecognised:
            return .stayLocked("That was not recognised. Try again, or use your passcode.")
        case .biometryUnavailable:
            return .stayLocked(
                "Face ID is not available on this device. Use your passcode instead."
            )
        case .biometryLockout:
            return .stayLocked(
                "Face ID is locked out after too many attempts. Use your passcode instead."
            )
        case .systemCancelled:
            return .stayLocked("Unlock to see your book.")
        case .unknown:
            return .stayLocked("Unlocking did not work. Try again.")
        case .passcodeNotSet:
            return .unenforceable(
                "This iPhone has no passcode, so the lock cannot do anything: anyone holding "
                    + "the phone is already past every other app on it. Set a passcode in "
                    + "Settings and the lock will start working again."
            )
        }
    }
}

/// Where the two settings live, and what they are called.
///
/// The KEYS are here rather than in the app because the widget, the intents and
/// the app all read them, and three spellings of one key is a bug that shows up
/// as a setting that will not stick.
public enum AppLockSettings {
    public static let enabledKey = "lock.enabled"
    public static let graceKey = "lock.graceSeconds"

    /// OFF UNTIL ASKED FOR, and this is a deliberate answer to "shouldn't a
    /// money app lock by default?".
    ///
    /// Switching it on for somebody is switching on a screen they cannot get
    /// past without a fingerprint the app has never checked they have. The
    /// settings screen refuses to turn it on until the device has actually
    /// proved it can authenticate, once, in front of the owner -- which is a
    /// promise that can only be made at the moment they ask for it.
    public static let enabledByDefault = false

    /// The one sentence that must appear wherever this feature is offered.
    public static let honestyLine =
        "This hides the app behind Face ID. It does not encrypt anything \u{2014} your book is "
        + "the same file either way."
}
