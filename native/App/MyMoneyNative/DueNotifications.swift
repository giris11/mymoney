// The reminders, handed to iOS.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS HERE AND WHAT IS NOT. Everything decidable -- which days, what the
// text says, how many requests there may be -- is in `DueReminders` in the kit,
// where it is tested without a device. This file does the three things that
// need the system: ask for permission, translate a `DueReminder` into a
// `UNNotificationRequest`, and remember the owner's settings.
//
// PERMISSION IS ASKED WHEN THE SWITCH IS TURNED ON, never on launch. A prompt
// that arrives before somebody has asked for anything is the prompt everybody
// declines, and iOS only asks once -- so a badly timed request permanently
// costs the feature. The switch does not move unless permission was granted:
// like the app lock, a setting that says it is on while doing nothing is worse
// than one that is off.
//
// EVERY REQUEST THIS APP MAKES IS IDENTIFIED `mymoney.due.<day>`, and re-planning
// removes only those. `removeAllPendingNotificationRequests()` would also throw
// away anything a later version of this app schedules for another reason, and
// the failure would be silent.
//
// THE TRIGGER IS A WALL-CLOCK EVENT, which is the one place in this project
// where a local calendar is the right tool. A calendar date plus "08:00" is a
// moment in the owner's own day; `UNCalendarNotificationTrigger` resolves it
// against the device's timezone, so it survives the clocks going back without
// this file reasoning about it. Nothing about MONEY is decided here -- see
// `CalendarDate`'s header for why every figure keeps well away from instants.
import Foundation
import MyMoneyKit
import Observation
import UserNotifications

enum ReminderDefaults {
    static let enabledKey = "reminders.enabled"
    static let hourKey = "reminders.hour"
    static let minuteKey = "reminders.minute"
    static let leadKey = "reminders.leadDays"
    static let detailKey = "reminders.showsDetail"
    /// The prefix every request this app schedules carries.
    static let identifierPrefix = "mymoney.due."
}

@MainActor
@Observable
final class RemindersModel {

    private(set) var settings: ReminderSettings
    /// What the system says about this app, in the owner's words. nil until
    /// there is something worth saying.
    private(set) var message: String?
    /// How many notifications are actually pending, read back from the system
    /// rather than assumed. The settings screen shows it, because "I turned
    /// this on and nothing happened" is otherwise unanswerable.
    private(set) var pendingCount = 0
    private(set) var isWorking = false

    private let defaults: UserDefaults
    private let centre: UNUserNotificationCenter?

    init(defaults: UserDefaults = .standard) {
        self.defaults = defaults
        // `object(forKey:)` first, for the same reason `AppLockModel` does it:
        // "not set" and "set to false" are different states, and the typed
        // accessor cannot tell them apart.
        let enabled =
            defaults.object(forKey: ReminderDefaults.enabledKey) == nil
            ? false
            : defaults.bool(forKey: ReminderDefaults.enabledKey)
        self.settings = ReminderSettings(
            enabled: enabled,
            hour: defaults.object(forKey: ReminderDefaults.hourKey) == nil
                ? 8 : defaults.integer(forKey: ReminderDefaults.hourKey),
            minute: defaults.object(forKey: ReminderDefaults.minuteKey) == nil
                ? 0 : defaults.integer(forKey: ReminderDefaults.minuteKey),
            leadDays: defaults.object(forKey: ReminderDefaults.leadKey) == nil
                ? 1 : defaults.integer(forKey: ReminderDefaults.leadKey),
            showsDetail: defaults.bool(forKey: ReminderDefaults.detailKey)
        )
        // A notification centre needs a bundle. There is one here; the optional
        // is for the harnesses that render these views outside an app, where
        // asking would trap.
        self.centre = Bundle.main.bundleIdentifier == nil ? nil : .current()
    }

    // MARK: - The switch

    /// Turn reminders on, if iOS lets us.
    ///
    /// The switch moves only on success. `.alert` and `.sound` and nothing
    /// else: no badge, because a badge on this app's icon would be a number
    /// about somebody's money sitting on their home screen for anyone to see.
    func enable() async -> Bool {
        guard let centre else { return false }
        isWorking = true
        defer { isWorking = false }
        do {
            let granted = try await centre.requestAuthorization(options: [.alert, .sound])
            guard granted else {
                message =
                    "iOS is not letting MyMoney send notifications. You can allow them in "
                    + "Settings \u{203A} Notifications \u{203A} MyMoney."
                return false
            }
        } catch {
            message = "Notifications could not be switched on: \(error.localizedDescription)"
            return false
        }
        message = nil
        settings.enabled = true
        defaults.set(true, forKey: ReminderDefaults.enabledKey)
        return true
    }

    func disable() {
        settings.enabled = false
        defaults.set(false, forKey: ReminderDefaults.enabledKey)
        clear()
        pendingCount = 0
        message = nil
    }

    func setTime(hour: Int, minute: Int) {
        settings = ReminderSettings(
            enabled: settings.enabled, hour: hour, minute: minute,
            leadDays: settings.leadDays, showsDetail: settings.showsDetail
        )
        defaults.set(settings.hour, forKey: ReminderDefaults.hourKey)
        defaults.set(settings.minute, forKey: ReminderDefaults.minuteKey)
    }

    func setLeadDays(_ days: Int) {
        settings = ReminderSettings(
            enabled: settings.enabled, hour: settings.hour, minute: settings.minute,
            leadDays: days, showsDetail: settings.showsDetail
        )
        defaults.set(settings.leadDays, forKey: ReminderDefaults.leadKey)
    }

    func setShowsDetail(_ shows: Bool) {
        settings = ReminderSettings(
            enabled: settings.enabled, hour: settings.hour, minute: settings.minute,
            leadDays: settings.leadDays, showsDetail: shows
        )
        defaults.set(shows, forKey: ReminderDefaults.detailKey)
    }

    // MARK: - Scheduling

    /// Replace this app's pending reminders with the ones in `plan`.
    ///
    /// REPLACE, not add. Every request is keyed by its day, so re-planning
    /// after a change overwrites the day it changed; the removal pass is what
    /// clears a day that no longer has anything due on it -- a payment entered
    /// this morning must not still produce a banner tomorrow.
    func apply(_ plan: [DueReminder]) async {
        guard let centre else { return }
        guard settings.enabled else {
            clear()
            pendingCount = 0
            return
        }
        // Only ours. See the header.
        let pending = await centre.pendingNotificationRequests()
        let mine = pending.map(\.identifier).filter {
            $0.hasPrefix(ReminderDefaults.identifierPrefix)
        }
        centre.removePendingNotificationRequests(withIdentifiers: mine)

        for reminder in plan {
            guard let date = CalendarDate(iso: reminder.fireDate) else { continue }
            let content = UNMutableNotificationContent()
            content.title = reminder.title
            content.body = reminder.body
            content.sound = .default
            // The owner's own calendar, deliberately: this is an appointment
            // with a morning, not an instant on a timeline.
            var components = DateComponents()
            components.year = date.year
            components.month = date.month
            components.day = date.day
            components.hour = reminder.hour
            components.minute = reminder.minute
            let request = UNNotificationRequest(
                identifier: reminder.id,
                content: content,
                trigger: UNCalendarNotificationTrigger(dateMatching: components, repeats: false)
            )
            do {
                try await centre.add(request)
            } catch {
                // One request that will not schedule must not stop the rest,
                // and it must not be silent either.
                message = "A reminder could not be set: \(error.localizedDescription)"
            }
        }
        pendingCount = await centre.pendingNotificationRequests().filter {
            $0.identifier.hasPrefix(ReminderDefaults.identifierPrefix)
        }.count
    }

    /// Read the pending count back from the system. What is actually there,
    /// not what this app believes it asked for.
    func refreshPendingCount() async {
        guard let centre else { return }
        pendingCount = await centre.pendingNotificationRequests().filter {
            $0.identifier.hasPrefix(ReminderDefaults.identifierPrefix)
        }.count
    }

    private func clear() {
        guard let centre else { return }
        Task {
            let mine = await centre.pendingNotificationRequests().map(\.identifier).filter {
                $0.hasPrefix(ReminderDefaults.identifierPrefix)
            }
            centre.removePendingNotificationRequests(withIdentifiers: mine)
        }
    }

    /// Minutes since local midnight, for `DueReminders.plan`. The one clock
    /// reading this feature needs, taken in one place.
    static func nowMinutes() -> Int {
        let parts = Calendar.current.dateComponents([.hour, .minute], from: Date())
        return (parts.hour ?? 0) * 60 + (parts.minute ?? 0)
    }
}
