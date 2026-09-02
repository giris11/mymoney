// The lock's arithmetic, including every case that should never happen.
//
// A lock is one of the few features whose failures are all invisible. A grace
// period measured from the wrong instant looks identical to one measured from
// the right one until the day the phone is picked up by somebody else; a clock
// that goes backwards produces an app that is simply open. So the decisions are
// pure functions over numbers, and every branch of them is asserted here --
// especially the branches whose answer is "I do not know", because those are
// the ones that must lock.
import Testing

@testable import MyMoneyKit

struct AppLockTests {

    private let on = AppLockPolicy(isEnabled: true, grace: .oneMinute)
    private let off = AppLockPolicy(isEnabled: false, grace: .oneMinute)

    @Test("A LAUNCH IS ALWAYS LOCKED, whatever the grace period says")
    func launchIsLocked() {
        for grace in AppLockGrace.allCases {
            #expect(AppLockPolicy(isEnabled: true, grace: grace).stateAtLaunch == .locked)
        }
        #expect(off.stateAtLaunch == .unlocked)
    }

    @Test("inside the grace period the app stays open; outside it, it locks")
    func graceWindow() {
        // Left at 1000 on the monotonic clock.
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: 1000) == .unlocked)
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: 1059.9) == .unlocked)
        // Exactly the grace period is OUT, not in: the boundary belongs to the
        // safe side.
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: 1060) == .locked)
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: 5000) == .locked)
    }

    @Test("`Immediately` means immediately, including a return that took no measurable time")
    func immediately() {
        let policy = AppLockPolicy(isEnabled: true, grace: .immediately)
        #expect(policy.stateOnForeground(leftForegroundAt: 1000, now: 1000) == .locked)
        #expect(policy.stateOnForeground(leftForegroundAt: 1000, now: 1000.0001) == .locked)
    }

    @Test("EVERY UNCERTAINTY LOCKS: no reading, a clock that went backwards, a non-number")
    func failsSafe() {
        // Never went to the background, or the reading was lost with the
        // process. There is nothing to measure against, so it locks.
        #expect(on.stateOnForeground(leftForegroundAt: nil, now: 1000) == .locked)
        // Monotonic clocks do not go backwards. One that appears to has been
        // tampered with or misread, and either way this is not the moment to
        // give somebody the benefit of the doubt.
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: 999) == .locked)
        #expect(on.stateOnForeground(leftForegroundAt: .nan, now: 1000) == .locked)
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: .nan) == .locked)
        #expect(on.stateOnForeground(leftForegroundAt: 1000, now: .infinity) == .locked)
        #expect(on.stateOnForeground(leftForegroundAt: -.infinity, now: 1000) == .locked)
    }

    @Test("with the lock switched off nothing locks, including the impossible readings")
    func disabled() {
        #expect(off.stateOnForeground(leftForegroundAt: nil, now: 1000) == .unlocked)
        #expect(off.stateOnForeground(leftForegroundAt: 1000, now: 99999) == .unlocked)
    }

    @Test("EVERY FAILURE STAYS LOCKED except the one that is argued for in writing")
    func failuresStayLocked() {
        // This is the test that stops the fail-safe being weakened by a future
        // edit that "helpfully" opens the app on some new error. Anything added
        // to `AppLockFailure` shows up here as a compile error, which is the
        // point of switching over it rather than listing cases.
        for failure in [
            AppLockFailure.cancelled, .notRecognised, .biometryUnavailable,
            .biometryLockout, .systemCancelled, .unknown,
        ] {
            #expect(
                AppLockPolicy.response(to: failure).isLocked,
                "\(failure) must not open the app"
            )
        }

        // The exception, and only this one.
        let response = AppLockPolicy.response(to: .passcodeNotSet)
        #expect(!response.isLocked)
        guard case .unenforceable(let message) = response else {
            Issue.record("passcodeNotSet must be reported as unenforceable")
            return
        }
        // And it must SAY why rather than opening quietly.
        #expect(message.contains("no passcode"))
        #expect(message.contains("Settings"))
    }

    @Test("every failure message tells the owner what to do next")
    func messagesAreActionable() {
        for failure in [
            AppLockFailure.cancelled, .notRecognised, .biometryUnavailable,
            .biometryLockout, .systemCancelled, .unknown, .passcodeNotSet,
        ] {
            let message: String
            switch AppLockPolicy.response(to: failure) {
            case .stayLocked(let m): message = m
            case .unenforceable(let m): message = m
            }
            #expect(!message.isEmpty, "\(failure)")
            // No error codes, no type names, no "an error occurred".
            #expect(!message.lowercased().contains("error"), "\(failure): \(message)")
        }
    }

    @Test("a stored grace period that this build does not recognise falls back to the default")
    func storedGrace() {
        #expect(AppLockGrace.stored(nil) == .default)
        #expect(AppLockGrace.stored(60) == .oneMinute)
        #expect(AppLockGrace.stored(300) == .fiveMinutes)
        // A missing key read as an Int is 0 in UserDefaults, which is
        // `immediately` -- the wrong answer, silently, and the reason `stored`
        // exists at all rather than `AppLockGrace(rawValue:)`.
        #expect(AppLockGrace.stored(7) == .default)
        #expect(AppLockGrace.stored(-1) == .default)
        // Zero IS a real choice, so it must survive the round trip.
        #expect(AppLockGrace.stored(0) == .immediately)
    }

    @Test("THE LOCK NEVER CLAIMS TO BE ENCRYPTION")
    func honesty() {
        // The one sentence that has to travel with the feature. If somebody
        // rewords it into a promise, this fails.
        #expect(AppLockSettings.honestyLine.contains("does not encrypt"))
        #expect(!AppLockSettings.enabledByDefault)
    }
}
