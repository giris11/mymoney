// Deciding what to remind the owner about, and when.
//
// ─────────────────────────────────────────────────────────────────────────────
// LOCAL NOTIFICATIONS ONLY. There is no server in this project and there is not
// going to be one: a push notification about somebody's rent requires their
// ledger to be on somebody else's computer, and that trade is not worth a
// reminder. So every reminder here is a `UNCalendarNotificationTrigger` set by
// the app while it is running, on the device, out of the book the device
// already holds.
//
// WHAT THAT COSTS, AND WHY IT IS STILL WORTH IT. A local notification is
// scheduled from a snapshot of what was due when the app was last open. If a
// payment is entered somewhere else -- in the browser -- the reminder still
// fires, because nothing told this device. The wording is chosen for that: it
// says what is DUE, not what is unpaid, and it never says "you have not paid
// this". The app re-plans on every launch and after every change, so the window
// in which it can be stale is the window in which nobody has opened it.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE NOTIFICATION PER DAY, NOT PER PAYMENT.
//
// iOS keeps at most 64 pending notification requests per app and DISCARDS the
// rest -- silently, and it keeps the ones nearest in time, so the ones lost are
// the ones furthest away. A weekly schedule and a 90-day horizon would spend
// thirteen of those on one arrangement. Aggregating by day means a book with
// forty schedules still uses one request per day that has anything in it, and
// `maximumReminders` keeps the whole feature inside half the budget so that
// anything else this app ever notifies about cannot quietly push these out.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE BODY CARRIES NO FIGURES UNLESS ASKED.
//
// A notification is drawn on the LOCK SCREEN, which is the one surface of a
// phone that other people see. This app already refuses to blur its own
// app-switcher snapshot on the grounds that a blurred net worth is still the
// shape of a net worth; a banner reading "Rent £1,450 due tomorrow" is the same
// disclosure with the numbers left in. So the default says how many, and the
// owner can turn the detail on -- an informed choice, made once, rather than a
// default nobody chose.
import Foundation

/// When and whether to remind. Off until the owner says otherwise, like every
/// other switch in this app that reaches outside it.
public struct ReminderSettings: Sendable, Hashable {
    public var enabled: Bool
    /// Local wall-clock time. 8am by default: before the working day, after the
    /// owner is awake, and early enough that a payment due today can still be
    /// dealt with.
    public var hour: Int
    public var minute: Int
    /// How many days ahead. ONE by default, not zero: a reminder on the morning
    /// a direct debit is taken is a reminder that arrives too late to move
    /// money, and the whole value of knowing is having time to act.
    public var leadDays: Int
    /// Put the schedules and their amounts in the notification.
    ///
    /// OFF BY DEFAULT. See the file header: this text is drawn on a lock
    /// screen.
    public var showsDetail: Bool

    public init(
        enabled: Bool = false, hour: Int = 8, minute: Int = 0, leadDays: Int = 1,
        showsDetail: Bool = false
    ) {
        self.enabled = enabled
        // Clamped rather than trusted: these come back from a settings store
        // that a future version could write anything into, and an hour of 25
        // would be a notification that never fires and never explains itself.
        self.hour = min(23, max(0, hour))
        self.minute = min(59, max(0, minute))
        self.leadDays = min(14, max(0, leadDays))
        self.showsDetail = showsDetail
    }

    public static let off = ReminderSettings()
}

/// One notification, ready to be handed to the system.
///
/// A VALUE, WITH NO `UNNotificationRequest` IN IT. Everything decidable is
/// decided here, where it is testable without a notification centre, an
/// authorisation prompt or a device; the app layer's whole job is to translate
/// these into requests and hand them over.
public struct DueReminder: Sendable, Hashable, Identifiable {
    /// Stable and derived from the day, so re-planning REPLACES yesterday's
    /// request for the same day rather than adding a second one. iOS keys
    /// pending requests by identifier, which is what makes that work.
    public var id: String { "mymoney.due.\(fireDate)" }
    /// The day it fires, "YYYY-MM-DD", in the device's own calendar.
    public let fireDate: String
    public let hour: Int
    public let minute: Int
    public let title: String
    public let body: String
    /// What the reminder is about, so a test can assert the counting rather
    /// than the prose.
    public let occurrenceCount: Int
    /// Of those, how many will be entered without being asked.
    public let automaticCount: Int
    /// Occurrences already overdue when this plan was made, mentioned on the
    /// earliest reminder only.
    public let overdueCount: Int
}

public enum DueReminders {
    /// Half of iOS's 64-request budget for the whole app. See the header: the
    /// system discards the excess silently, and it discards the far ones.
    public static let maximumReminders = 30

    /// The reminders for what is due.
    ///
    /// PURE. `now` is passed in rather than read, for the same reason every
    /// other clock in this package is: a function that reads the time cannot be
    /// tested at the edge that matters -- the reminder whose moment has already
    /// gone.
    ///
    /// - Parameters:
    ///   - occurrences: what is due, overdue included.
    ///   - remindingScheduleIds: the schedules the owner wants reminders for. A
    ///     schedule with reminders switched off contributes nothing, and its
    ///     absence changes the COUNTS in the text -- a body that said "3
    ///     payments" while the screen listed one would read as a bug.
    ///   - today: the device's own calendar day.
    ///   - nowMinutes: minutes since local midnight. A reminder whose moment
    ///     has passed is not scheduled -- iOS would never fire it -- and its
    ///     occurrences are counted as overdue instead of vanishing.
    public static func plan(
        occurrences: [DueOccurrence],
        remindingScheduleIds: Set<String>,
        settings: ReminderSettings,
        today: String,
        nowMinutes: Int
    ) -> [DueReminder] {
        guard settings.enabled, let todayDate = CalendarDate(iso: today) else { return [] }
        let wanted = occurrences.filter { remindingScheduleIds.contains($0.scheduleId) }
        guard !wanted.isEmpty else { return [] }

        let fireMinutes = settings.hour * 60 + settings.minute

        // Group by the day the reminder would fire, which is the occurrence's
        // day minus the lead. Anything whose moment has already gone becomes
        // backlog rather than a request the system would drop on the floor.
        var byDay: [String: [DueOccurrence]] = [:]
        var backlog = 0
        for occurrence in wanted {
            guard let date = CalendarDate(iso: occurrence.date) else {
                backlog += 1
                continue
            }
            let fire = date.addingDays(-settings.leadDays)
            if fire < todayDate || (fire == todayDate && fireMinutes <= nowMinutes) {
                backlog += 1
                continue
            }
            byDay[fire.iso, default: []].append(occurrence)
        }

        let days = byDay.keys.sorted().prefix(maximumReminders)
        return days.enumerated().map { position, day in
            let items = (byDay[day] ?? []).sorted { $0.id < $1.id }
            let automatic = items.filter(\.postsItself).count
            // The backlog is mentioned ONCE, on the first reminder that will
            // fire. Repeating it on every day would turn a fact into nagging,
            // and dropping it would leave the overdue pile with no voice at all
            // until the owner happens to open the app.
            let overdue = position == 0 ? backlog : 0
            return DueReminder(
                fireDate: day,
                hour: settings.hour,
                minute: settings.minute,
                title: title(for: items, on: day, dueOn: dueDay(day, settings.leadDays)),
                body: body(
                    for: items, automatic: automatic, overdue: overdue,
                    showsDetail: settings.showsDetail
                ),
                occurrenceCount: items.count,
                automaticCount: automatic,
                overdueCount: overdue
            )
        }
    }

    /// The day the payments themselves fall on, given the day the reminder
    /// fires.
    private static func dueDay(_ fireDay: String, _ leadDays: Int) -> String {
        guard let date = CalendarDate(iso: fireDay) else { return fireDay }
        return date.addingDays(leadDays).iso
    }

    /// "2 payments due tomorrow".
    ///
    /// The count leads, because it is the part that is read at a glance on a
    /// lock screen, and "tomorrow" beats a date for the same reason.
    static func title(for items: [DueOccurrence], on fireDay: String, dueOn: String) -> String {
        let count = items.count
        let noun = count == 1 ? "payment" : "payments"
        return "\(count) \(noun) due \(when(fireDay: fireDay, dueDay: dueOn))"
    }

    private static func when(fireDay: String, dueDay: String) -> String {
        guard let fire = CalendarDate(iso: fireDay), let due = CalendarDate(iso: dueDay) else {
            return "on \(dueDay)"
        }
        switch due.daysSince(fire) {
        case 0: return "today"
        case 1: return "tomorrow"
        case let days where days < 7: return "in \(days) days"
        default: return "on \(due.iso)"
        }
    }

    static func body(
        for items: [DueOccurrence], automatic: Int, overdue: Int, showsDetail: Bool
    ) -> String {
        var sentences: [String] = []
        if showsDetail {
            // Names and figures, which is what the owner asked for by switching
            // the detail on. Capped at three so a busy day does not produce a
            // notification nobody reads to the end.
            let listed = items.prefix(3).map { item in
                "\(item.scheduleName) \(Money.format(abs(item.amountMinor), currency: item.currency))"
            }
            var line = listed.joined(separator: ", ")
            if items.count > listed.count { line += " and \(items.count - listed.count) more" }
            sentences.append(line)
        }
        if automatic == items.count, automatic > 0 {
            sentences.append(
                "\(automatic == 1 ? "It" : "They") will be entered automatically the next time "
                    + "you open MyMoney."
            )
        } else if automatic > 0 {
            sentences.append(
                "\(automatic) will be entered automatically; open MyMoney to enter the "
                    + "\(items.count - automatic == 1 ? "other" : "others")."
            )
        } else {
            sentences.append("Open MyMoney to enter \(items.count == 1 ? "it" : "them").")
        }
        if overdue > 0 {
            sentences.append(
                "\(overdue) earlier \(overdue == 1 ? "payment is" : "payments are") still waiting."
            )
        }
        return sentences.joined(separator: " ")
    }
}
