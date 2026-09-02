// What the phone would say, and what it would not say out loud.
//
// EVERY FIGURE AND NAME IS INVENTED. `DueReminders.plan` is pure -- no
// notification centre, no authorisation prompt, no device -- so the two things
// worth proving are provable here: that the request count stays inside iOS's
// budget, and that the default text carries no figures.
import Foundation
import Testing

@testable import MyMoneyKit

struct DueReminderTests {

    private func occurrence(
        schedule: String = "s1",
        name: String = "Rent",
        date: String,
        amountMinor: Int64 = -45000,
        automatic: Bool = false
    ) -> DueOccurrence {
        DueOccurrence(
            scheduleId: schedule, scheduleName: name, date: date, index: 0,
            amountMinor: amountMinor, currency: "GBP", accountId: "a1", accountName: "Everyday",
            payeeName: "Landlord", categoryId: nil, notes: "", postsItself: automatic,
            isOverdue: date < "2026-09-02", daysAway: 0, reopened: false
        )
    }

    private func plan(
        _ occurrences: [DueOccurrence],
        settings: ReminderSettings = ReminderSettings(enabled: true),
        reminding: Set<String>? = nil,
        today: String = "2026-09-02",
        nowMinutes: Int = 9 * 60
    ) -> [DueReminder] {
        DueReminders.plan(
            occurrences: occurrences,
            remindingScheduleIds: reminding ?? Set(occurrences.map(\.scheduleId)),
            settings: settings,
            today: today,
            nowMinutes: nowMinutes
        )
    }

    @Test("off is off: no reminders at all until the owner switches them on")
    func offByDefault() {
        #expect(ReminderSettings.off.enabled == false)
        #expect(plan([occurrence(date: "2026-09-10")], settings: .off).isEmpty)
    }

    @Test("ONE REMINDER PER DAY, not one per payment")
    func aggregatedByDay() {
        let reminders = plan([
            occurrence(schedule: "s1", name: "Rent", date: "2026-09-10"),
            occurrence(schedule: "s2", name: "Broadband", date: "2026-09-10", amountMinor: -3200),
            occurrence(schedule: "s3", name: "Gym", date: "2026-09-17", amountMinor: -2500),
        ])
        #expect(reminders.count == 2)
        #expect(reminders.map(\.fireDate) == ["2026-09-09", "2026-09-16"])
        #expect(reminders[0].occurrenceCount == 2)
        #expect(reminders[0].title == "2 payments due tomorrow")
        #expect(reminders[1].title == "1 payment due tomorrow")
    }

    @Test("THE DEFAULT TEXT CARRIES NO FIGURES AND NO NAMES, because a lock screen is public")
    func noFiguresByDefault() {
        let quiet = plan([occurrence(date: "2026-09-10")])[0]
        #expect(quiet.body == "Open MyMoney to enter it.")
        #expect(!quiet.body.contains("450"))
        #expect(!quiet.body.contains("Rent"))
        #expect(!quiet.title.contains("Rent"))

        // Switched on deliberately, it says what is due.
        let loud = plan(
            [occurrence(date: "2026-09-10")],
            settings: ReminderSettings(enabled: true, showsDetail: true)
        )[0]
        #expect(loud.body.contains("Rent \u{00A3}450.00"))
    }

    @Test("the detail form lists three and counts the rest")
    func detailIsCapped() {
        let items = (1...5).map {
            occurrence(schedule: "s\($0)", name: "Bill \($0)", date: "2026-09-10")
        }
        let reminder = plan(items, settings: ReminderSettings(enabled: true, showsDetail: true))[0]
        #expect(reminder.body.contains("Bill 1"))
        #expect(reminder.body.contains("and 2 more"))
        #expect(!reminder.body.contains("Bill 4"))
    }

    @Test("the lead time decides the day it fires, and the wording follows it")
    func leadTime() {
        let onTheDay = plan(
            [occurrence(date: "2026-09-10")],
            settings: ReminderSettings(enabled: true, leadDays: 0)
        )[0]
        #expect(onTheDay.fireDate == "2026-09-10")
        #expect(onTheDay.title == "1 payment due today")

        let threeDays = plan(
            [occurrence(date: "2026-09-10")],
            settings: ReminderSettings(enabled: true, leadDays: 3)
        )[0]
        #expect(threeDays.fireDate == "2026-09-07")
        #expect(threeDays.title == "1 payment due in 3 days")

        let fortnight = plan(
            [occurrence(date: "2026-09-30")],
            settings: ReminderSettings(enabled: true, leadDays: 14)
        )[0]
        #expect(fortnight.fireDate == "2026-09-16")
        #expect(fortnight.title == "1 payment due on 2026-09-30")
    }

    @Test("A MOMENT THAT HAS ALREADY GONE IS NOT SCHEDULED, it is counted as waiting")
    func pastMomentsBecomeBacklog() {
        // 8am has been and gone; the reminder for a payment due today would
        // never fire, and iOS would drop it without a word.
        let reminders = plan(
            [
                occurrence(schedule: "s1", date: "2026-09-02"),
                occurrence(schedule: "s2", name: "Later", date: "2026-09-10"),
            ],
            settings: ReminderSettings(enabled: true, hour: 8, leadDays: 0),
            nowMinutes: 14 * 60
        )
        #expect(reminders.count == 1)
        #expect(reminders[0].fireDate == "2026-09-10")
        #expect(reminders[0].overdueCount == 1)
        #expect(reminders[0].body.contains("1 earlier payment is still waiting"))
    }

    @Test("overdue payments are mentioned once, on the first reminder that will fire")
    func backlogIsMentionedOnce() {
        let reminders = plan([
            occurrence(schedule: "s1", date: "2026-08-03"),
            occurrence(schedule: "s2", date: "2026-08-10"),
            occurrence(schedule: "s3", date: "2026-09-10"),
            occurrence(schedule: "s4", date: "2026-09-17"),
        ])
        #expect(reminders.count == 2)
        #expect(reminders[0].overdueCount == 2)
        #expect(reminders[1].overdueCount == 0)
        #expect(reminders[0].body.contains("2 earlier payments are still waiting"))
        #expect(!reminders[1].body.contains("waiting"))
    }

    @Test("a schedule with reminders switched off is not counted, not merely not mentioned")
    func remindFlagIsRespected() {
        let reminders = plan(
            [
                occurrence(schedule: "s1", date: "2026-09-10"),
                occurrence(schedule: "s2", name: "Quiet", date: "2026-09-10"),
            ],
            reminding: ["s1"]
        )
        // A body that said "2 payments" while the screen listed one would read
        // as a bug in the counting.
        #expect(reminders[0].occurrenceCount == 1)
        #expect(reminders[0].title == "1 payment due tomorrow")
    }

    @Test("a day whose payments all enter themselves says so instead of asking for a tap")
    func automaticWording() {
        let all = plan([
            occurrence(schedule: "s1", date: "2026-09-10", automatic: true),
            occurrence(schedule: "s2", date: "2026-09-10", automatic: true),
        ])[0]
        #expect(all.automaticCount == 2)
        #expect(all.body.contains("will be entered automatically the next time you open MyMoney"))

        let some = plan([
            occurrence(schedule: "s1", date: "2026-09-10", automatic: true),
            occurrence(schedule: "s2", date: "2026-09-10"),
        ])[0]
        #expect(some.body.contains("1 will be entered automatically"))
        #expect(some.body.contains("open MyMoney to enter the other"))
    }

    @Test("THE PLAN STAYS INSIDE iOS'S BUDGET, which discards the excess silently")
    func theCap() {
        // A daily-ish book: sixty days each with something due. iOS keeps 64
        // pending requests for the WHOLE app and drops the rest without an
        // error, so the planner takes half of that and no more.
        let items = (1...60).map { day -> DueOccurrence in
            let date = CalendarDate(iso: "2026-09-03")!.addingDays(day)
            return occurrence(schedule: "s\(day)", date: date.iso)
        }
        let reminders = plan(items)
        #expect(reminders.count == DueReminders.maximumReminders)
        #expect(reminders.count <= 32)
        // And it keeps the NEAREST days, which are the ones that matter.
        #expect(reminders.first?.fireDate == "2026-09-03")
    }

    @Test("a reminder's identifier is its day, so re-planning replaces rather than duplicates")
    func stableIdentifiers() {
        let first = plan([occurrence(date: "2026-09-10")])[0]
        let again = plan([
            occurrence(date: "2026-09-10"),
            occurrence(schedule: "s2", name: "Another", date: "2026-09-10"),
        ])[0]
        #expect(first.id == again.id)
        #expect(first.id == "mymoney.due.2026-09-09")
        #expect(first.occurrenceCount != again.occurrenceCount)
    }

    @Test("nonsense in the settings is clamped rather than producing a reminder that never fires")
    func settingsAreClamped() {
        let silly = ReminderSettings(enabled: true, hour: 99, minute: -4, leadDays: 900)
        #expect(silly.hour == 23)
        #expect(silly.minute == 0)
        #expect(silly.leadDays == 14)
    }

    @Test("nothing due is no reminders, and an unreadable date is backlog rather than a crash")
    func emptyAndBroken() {
        #expect(plan([]).isEmpty)
        let broken = plan([
            occurrence(schedule: "s1", date: "the tenth"),
            occurrence(schedule: "s2", date: "2026-09-10"),
        ])
        #expect(broken.count == 1)
        #expect(broken[0].overdueCount == 1)
    }
}
