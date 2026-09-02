// What is due, and the arrangements behind it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SCREEN IS IN TWO HALVES AND THE ORDER IS THE POINT. What is DUE comes
// first, because it is what somebody opens this screen to deal with; the
// SCHEDULES themselves come second, because they are set up once and then
// looked at rarely. A list of arrangements with the due items buried inside it
// would be a list nobody acts on.
//
// ENTERING IS A DELIBERATE ACT. Tapping a due row opens a sheet showing exactly
// what will be written -- account, date, amount, category -- with the amount and
// the date editable, and nothing is written until the button in that sheet is
// pressed. There is no swipe that posts silently. A schedule with auto-post
// switched on says so on its row, in words, every time.
//
// THE WARNING IS ABOVE EVERYTHING. "The 24th takes Everyday below zero" is the
// reason this feature exists, and burying it under the list would waste it. It
// says what it counted, in one line, because a forecast whose inputs are not
// stated is either over-trusted or ignored.
//
// NOTHING HERE COMPUTES ANYTHING. Every date, figure, total and warning is
// `Upcoming.plan`'s, carried through `SchedulesScreen` unchanged. This file
// chooses words.
import MyMoneyKit
import SwiftUI

/// Where the schedules screen is pointed.
struct ScheduleRoute: Hashable {
    let id: String
}

struct SchedulesView: View {
    @Environment(AppModel.self) private var app

    /// The book's revision, passed in rather than read inside `.task(id:)` --
    /// see `BudgetsView.revision` for the bug that makes this structural.
    let revision: Int

    @State private var screen: SchedulesScreen?
    @State private var failure: String?
    @State private var horizon = Upcoming.defaultHorizonDays
    @State private var editing: ScheduleEditorSheet?
    @State private var confirming: DueOccurrence?
    @State private var refusal: EditRefusal?

    var body: some View {
        // A MEASUREMENT ASKING FOR THE DETAIL SCREEN gets it here, in the same
        // container a push would have put it in -- the detail column's
        // navigation stack -- so its bottom bar composes with exactly the
        // insets it does in a real run. `Reach.isOpening` is false in every
        // launch that is not a measurement. See `Reach.opening`.
        if Reach.isOpening("scheduled.detail"), let first = screen?.schedules.first {
            ScheduleDetailView(scheduleId: first.id, revision: revision)
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if let refusal {
                Section { RefusalNotice(refusal: refusal) }
            }
            if let result = app.lastAutoPost {
                Section { AutoPostNotice(result: result) { app.acknowledgeAutoPost() } }
            }
            if let screen {
                if screen.schedules.isEmpty {
                    Section {
                        Notice(
                            symbol: "calendar.badge.clock",
                            title: "No scheduled payments yet",
                            message:
                                "A schedule is a standing arrangement \u{2014} rent on the 3rd, a "
                                + "season ticket every four weeks. This app shows you what is "
                                + "coming, warns you when one would take an account below zero, "
                                + "and enters it only when you say so."
                        )
                        .frame(maxWidth: .infinity)
                    }
                } else {
                    warningsSection(screen)
                    overdueSection(screen)
                    dueSection(screen)
                    problemsSection(screen)
                    schedulesSection(screen)
                }
            } else if let failure {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "Scheduled payments could not be read",
                        message: failure,
                        tone: .problem,
                        action: ("Try again", { Task { await load() } })
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle("Scheduled")
        .safeAreaInset(edge: .bottom) {
            if screen != nil {
                ActionBar {
                    PrimaryAction(title: "New schedule", systemImage: "plus") {
                        editing = .creating
                    }
                    .reachProbe("Scheduled \u{2014} New schedule")
                }
            }
        }
        .navigationDestination(for: ScheduleRoute.self) { route in
            ScheduleDetailView(scheduleId: route.id, revision: revision)
        }
        .sheet(item: $editing) { which in
            ScheduleEditor(existing: which.schedule)
        }
        .sheet(item: $confirming) { occurrence in
            ConfirmPostSheet(
                occurrence: occurrence, categoryPath: screen?.categoryPath(occurrence.categoryId)
            )
        }
        .task(id: "\(revision):\(horizon)") {
            await load()
            // The two sheets a measurement can ask for. Nothing else opens a
            // sheet on its own, and this cannot fire without MYMONEY_REACH=1.
            if Reach.isOpening("scheduled.new") { editing = .creating }
            if Reach.isOpening("scheduled.confirm") { confirming = screen?.plan.all.first }
        }
    }

    // MARK: - Sections

    @ViewBuilder private func warningsSection(_ screen: SchedulesScreen) -> some View {
        if !screen.plan.warnings.isEmpty {
            Section {
                ForEach(screen.plan.warnings) { warning in
                    BalanceWarningRow(warning: warning)
                }
            } header: {
                Text("Watch out")
            } footer: {
                // THE INPUTS, STATED. Without this line the figure looks like a
                // prediction of the owner's spending, which it is not and could
                // not honestly be.
                Text(
                    "Counting what is already in your book and what is scheduled below. It does "
                        + "not know what you are about to spend."
                )
            }
        }
    }

    @ViewBuilder private func overdueSection(_ screen: SchedulesScreen) -> some View {
        if !screen.plan.overdue.isEmpty {
            Section {
                ForEach(screen.plan.overdue) { occurrence in
                    dueRow(occurrence, screen)
                }
            } header: {
                Text("Waiting \u{2014} \(Display.count(screen.plan.overdue.count, "payment"))")
            } footer: {
                Text(
                    "These were due before today and are not in your book. Enter one, or skip it "
                        + "if it did not happen."
                )
            }
        }
    }

    @ViewBuilder private func dueSection(_ screen: SchedulesScreen) -> some View {
        Section {
            Picker("Looking ahead", selection: $horizon) {
                Text("7 days").tag(7)
                Text("30 days").tag(30)
                Text("90 days").tag(90)
            }
            .pickerStyle(.segmented)
            .accessibilityLabel("How far ahead to look")

            if screen.plan.due.isEmpty {
                Text("Nothing due in the next \(horizon) days.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(screen.plan.due) { occurrence in
                    dueRow(occurrence, screen)
                }
            }
        } header: {
            Text("Due")
        } footer: {
            totalsFooter(screen)
        }
    }

    @ViewBuilder private func totalsFooter(_ screen: SchedulesScreen) -> some View {
        if !screen.plan.totals.isEmpty {
            VStack(alignment: .leading, spacing: 4) {
                ForEach(screen.plan.totals) { total in
                    // OUT AND IN, NEVER NETTED, and never added across
                    // currencies -- see `Upcoming.totals`.
                    Text(totalLine(total))
                }
                if screen.plan.totals.count > 1 {
                    Text(
                        "Kept apart by currency: adding pence to cents would be a figure nobody "
                            + "could check."
                    )
                    .foregroundStyle(.secondary)
                }
            }
        }
    }

    private func totalLine(_ total: DueTotal) -> String {
        var parts: [String] = []
        if total.outMinor != 0 {
            parts.append("\(Display.money(total.outMinor, total.currency)) out")
        }
        if total.inMinor != 0 {
            parts.append("\(Display.money(total.inMinor, total.currency)) in")
        }
        return parts.joined(separator: ", ") + " over this window and anything waiting"
    }

    @ViewBuilder private func problemsSection(_ screen: SchedulesScreen) -> some View {
        if !screen.plan.problems.isEmpty {
            Section("Needs attention") {
                ForEach(screen.plan.problems) { problem in
                    Label {
                        VStack(alignment: .leading, spacing: 2) {
                            Text(problem.scheduleName)
                            Text(problemText(problem.kind))
                                .font(.footnote)
                                .foregroundStyle(.secondary)
                                .fixedSize(horizontal: false, vertical: true)
                        }
                    } icon: {
                        Image(systemName: problem.kind == .finished ? "checkmark.circle" : "exclamationmark.triangle")
                            .foregroundStyle(problem.kind == .finished ? Color.secondary : .orange)
                    }
                }
            }
        }
    }

    private func problemText(_ kind: ScheduleProblem.Kind) -> String {
        switch kind {
        case .accountMissing:
            return
                "The account it pays from is not in this copy of the book, so nothing can be "
                + "entered. Open the schedule and choose another."
        case .categoryMissing:
            return
                "The category it files under is not in this copy of the book. Entering a payment "
                + "would be refused \u{2014} choose another category first."
        case .unreadableDates:
            return "Its dates cannot be read, so nothing can be worked out from it."
        case .finished:
            return "Every payment has been and gone. It is kept for its history."
        }
    }

    @ViewBuilder private func schedulesSection(_ screen: SchedulesScreen) -> some View {
        Section {
            ForEach(screen.schedules) { schedule in
                NavigationLink(value: ScheduleRoute(id: schedule.id)) {
                    ScheduleRow(
                        schedule: schedule,
                        currency: screen.currency(of: schedule.accountId) ?? "",
                        accountName: screen.account(schedule.accountId)?.name
                    )
                }
            }
        } header: {
            Text("Schedules")
        } footer: {
            // THE FACT A COUNT COULD NOT CONVEY. Schedules are not in the
            // backup file (the format has nowhere to put them), so they are not
            // something the web app will ever know about.
            //
            // AND WHAT A SCHEDULE CANNOT BE, said here rather than discovered
            // as a missing option in the editor. A transfer needs a second
            // account, a second amount when the currencies differ, and a
            // below-zero projection that moves money out of one account and
            // into another on one day; half of that, shipped for real money,
            // is worse than none. A split has to sum exactly to its parent,
            // which an amount that varies per occurrence cannot promise months
            // in advance.
            VStack(alignment: .leading, spacing: 6) {
                Text(
                    "Schedules live on this device. They are not part of the backup file your "
                        + "web app reads, and entering one adds an ordinary transaction to this "
                        + "copy."
                )
                Text(
                    "A schedule is one payment from one account. Transfers between your own "
                        + "accounts, and payments split across categories, are entered by hand "
                        + "\u{2014} or entered from here and then edited."
                )
            }
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private func dueRow(_ occurrence: DueOccurrence, _ screen: SchedulesScreen) -> some View {
        Button {
            confirming = occurrence
        } label: {
            DueRow(occurrence: occurrence)
        }
        .buttonStyle(.plain)
        .swipeActions(edge: .trailing) {
            Button {
                Task { await skip(occurrence) }
            } label: {
                Label("Skip", systemImage: "forward.end")
            }
            .tint(.orange)
        }
        .contextMenu {
            Button {
                confirming = occurrence
            } label: {
                Label("Enter\u{2026}", systemImage: "square.and.pencil")
            }
            Button {
                Task { await skip(occurrence) }
            } label: {
                Label("Skip this one", systemImage: "forward.end")
            }
        }
    }

    // MARK: - Work

    @MainActor private func load() async {
        do {
            screen = try await app.service.schedulesScreen(
                today: todayISO(), horizonDays: horizon
            )
            failure = nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }

    @MainActor private func skip(_ occurrence: DueOccurrence) async {
        let outcome = await app.skip(
            scheduleId: occurrence.scheduleId, occurrenceDate: occurrence.date
        )
        refusal = outcome.refusal
    }
}

// MARK: - Rows

/// One occurrence, as a line: what it is, when, and how much.
struct DueRow: View {
    let occurrence: DueOccurrence

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(occurrence.scheduleName)
                HStack(spacing: 6) {
                    Text(ScheduleWords.when(occurrence))
                        .foregroundStyle(occurrence.isOverdue ? AnyShapeStyle(Color.orange) : AnyShapeStyle(.secondary))
                    Text("\u{00B7} \(occurrence.accountName)")
                        .foregroundStyle(.secondary)
                }
                .font(.footnote)
                if occurrence.postsItself {
                    // Said on the row, every time. "This will happen without
                    // me" is not something to discover afterwards.
                    Label("Enters itself", systemImage: "bolt")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                }
                if occurrence.reopened {
                    Text("Entered before, and that transaction is no longer in your book.")
                        .font(.caption2)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
            }
            Spacer(minLength: 12)
            Text(Display.money(occurrence.amountMinor, occurrence.currency))
                .monospacedDigit()
                .foregroundStyle(amountColour(occurrence.amountMinor))
        }
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(
            "\(occurrence.scheduleName), \(ScheduleWords.when(occurrence)), "
                + "\(Display.moneyFlowSpoken(occurrence.amountMinor, occurrence.currency)), "
                + "\(occurrence.accountName)"
        )
        .accessibilityHint("Opens the sheet that enters it")
    }
}

/// One schedule in the list.
struct ScheduleRow: View {
    let schedule: Schedule
    let currency: String
    let accountName: String?

    var body: some View {
        VStack(alignment: .leading, spacing: 2) {
            HStack(alignment: .firstTextBaseline) {
                Text(schedule.name)
                    .foregroundStyle(schedule.paused ? AnyShapeStyle(.secondary) : AnyShapeStyle(.primary))
                Spacer(minLength: 12)
                Text(Display.money(schedule.amountMinor, currency))
                    .monospacedDigit()
                    .foregroundStyle(amountColour(schedule.amountMinor))
            }
            HStack(spacing: 6) {
                Text(schedule.cadence.label)
                if let accountName { Text("\u{00B7} \(accountName)") }
                if schedule.paused { Text("\u{00B7} Paused") }
                if schedule.autoPost { Text("\u{00B7} Enters itself") }
            }
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .accessibilityElement(children: .combine)
    }
}

/// The line the whole feature exists for.
struct BalanceWarningRow: View {
    let warning: BalanceWarning

    var body: some View {
        Label {
            VStack(alignment: .leading, spacing: 4) {
                Text(headline)
                    .fixedSize(horizontal: false, vertical: true)
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } icon: {
            Image(systemName: "exclamationmark.triangle.fill")
                .foregroundStyle(.orange)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(headline). \(detail)")
    }

    private var headline: String {
        if warning.alreadyBelowZero {
            return "\(warning.accountName) is already below zero."
        }
        let schedule = warning.scheduleName.map { " after \u{201C}\($0)\u{201D}" } ?? ""
        return
            "\(warning.accountName) goes below zero on \(Display.dateText(warning.date))\(schedule)."
    }

    private var detail: String {
        let projected = Display.money(warning.projectedMinor, warning.currency)
        if warning.alreadyBelowZero {
            return
                "It stands at \(projected) today, with "
                + "\(Display.count(warning.dueCount, "scheduled payment")) still to come."
        }
        return
            "Projected \(projected), from \(Display.money(warning.balanceTodayMinor, warning.currency)) today."
    }
}

/// What the automatic run did, said once.
struct AutoPostNotice: View {
    let result: AutoPostResult
    let dismiss: () -> Void

    var body: some View {
        VStack(alignment: .leading, spacing: 8) {
            if !result.posted.isEmpty {
                Label(
                    "\(Display.count(result.posted.count, "payment")) entered automatically.",
                    systemImage: "bolt"
                )
                .font(.callout)
            }
            if result.heldBack > 0 {
                Text(
                    "\(Display.count(result.heldBack, "more")) could have been entered "
                        + "automatically and were not \u{2014} they are in the list below, "
                        + "waiting for you."
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
            ForEach(result.refusals, id: \.self) { refusal in
                Label(refusal, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Button("Got it", action: dismiss)
                .font(.footnote)
        }
    }
}

// MARK: - Words

enum ScheduleWords {
    /// "Today", "Tomorrow", "in 4 days", "3 days late". Relative, because that
    /// is how a due date is read, with the actual date behind it on the sheet.
    static func when(_ occurrence: DueOccurrence) -> String {
        switch occurrence.daysAway {
        case 0: return "Today"
        case 1: return "Tomorrow"
        case let days where days > 1 && days < 14: return "In \(days) days"
        case let days where days < 0:
            let late = -days
            return late == 1 ? "1 day late" : "\(late) days late"
        default: return Display.dateText(occurrence.date)
        }
    }
}
