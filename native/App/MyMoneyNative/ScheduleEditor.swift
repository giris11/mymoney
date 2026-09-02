// Making a schedule, entering one of its payments, and looking at what it has
// done.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE FORM VALIDATES NOTHING ITSELF. It disables Save while the draft cannot
// possibly be valid -- no name, no amount, no account -- and otherwise sends it
// and shows what comes back. `LedgerStore.saveSchedule`'s refusals are the
// rules, they are tested, and a second copy of them here would be a second set
// to keep in step.
//
// THE DATE FOOTER IS NOT DECORATION. A schedule anchored on the 31st behaves in
// a way people are entitled to be told about before they save it, and the
// sentence changes with the day they pick. The same is true of the auto-post
// switch: it says when it will happen and what it will never do.
//
// THE SIGN IS A CONTROL, NOT A CHARACTER -- `AmountField`, like every other
// amount in this app. A schedule is nearly always money out; a scheduled salary
// is money in, and it is one tap away rather than a minus sign somebody has to
// notice.
import MyMoneyKit
import SwiftUI

/// Which schedule editor is open.
enum ScheduleEditorSheet: Identifiable {
    case creating
    case editing(Schedule)

    var id: String {
        switch self {
        case .creating: return "new"
        case .editing(let schedule): return schedule.id
        }
    }

    var schedule: Schedule? {
        if case .editing(let schedule) = self { return schedule }
        return nil
    }
}

/// How a schedule ends, as the form holds it: a segmented choice plus the one
/// value that choice needs.
private enum EndChoice: String, CaseIterable, Identifiable {
    case never, onDate, afterCount
    var id: String { rawValue }
    var label: String {
        switch self {
        case .never: return "Carries on"
        case .onDate: return "Until a date"
        case .afterCount: return "A set number"
        }
    }
}

struct ScheduleEditor: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let existing: Schedule?
    /// A schedule the app has offered to make, already filled in -- today the
    /// only source is a pattern the insights screen detected
    /// (`ScheduleDraft.from(series:today:)`). It is a STARTING POINT and
    /// nothing more: the sheet still has to be saved, and every field is still
    /// editable, because a detected pattern is a claim about the past and a
    /// schedule is a commitment about the future.
    var prefill: ScheduleDraft?

    @State private var context: QuickAddContext?
    @State private var name = ""
    @State private var accountId = ""
    @State private var amount = TypedAmount()
    @State private var payeeName = ""
    @State private var categoryId: String?
    @State private var notes = ""
    @State private var cadence: Cadence = .monthly
    @State private var startDate = todayISO()
    @State private var endChoice: EndChoice = .never
    @State private var endDate = todayISO()
    @State private var endCount = 12
    @State private var autoPost = false
    @State private var remind = true
    @State private var paused = false
    @State private var refusal: EditRefusal?
    @State private var saving = false

    private var accounts: [Account] { context?.accounts ?? [] }
    private var currency: String {
        accounts.first { $0.id == accountId }?.currency ?? "GBP"
    }

    private var typedMinor: Int64? { amount.minor(currency: currency) }

    private var canSave: Bool {
        !Names.isBlank(name) && !accountId.isEmpty && (typedMinor ?? 0) != 0 && !saving
    }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Name", text: $name)
                        .accessibilityLabel("Schedule name")
                } footer: {
                    Text(
                        "What you will recognise this by \u{2014} \u{201C}Rent\u{201D}, "
                            + "\u{201C}Season ticket\u{201D}."
                    )
                }

                Section {
                    AccountPicker(accounts: accounts, title: "Account", selection: $accountId)
                    AmountField(title: "Amount", currency: currency, amount: $amount)
                } footer: {
                    Text(
                        "In \(currency), the account\u{2019}s own currency. Money out for a bill; "
                            + "money in for something you are paid."
                    )
                }

                Section {
                    if let context {
                        PayeeField(
                            index: context.payees,
                            name: $payeeName,
                            categoryId: $categoryId,
                            categoryName: { id in context.categories.first { $0.id == id }?.path }
                        )
                        CategoryRow(
                            categories: context.categories,
                            frequentIds: context.frequentCategoryIds,
                            selection: $categoryId
                        )
                    }
                    TextField("Notes", text: $notes, axis: .vertical)
                }

                Section {
                    Picker("Every", selection: $cadence) {
                        ForEach(Cadence.allCases, id: \.self) { option in
                            Text(option.label).tag(option)
                        }
                    }
                    CalendarDateField(title: "First one", iso: $startDate)
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        Text(dateExplanation)
                        Text(perYearExplanation)
                            .foregroundStyle(.secondary)
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }

                Section {
                    Picker("Ends", selection: $endChoice) {
                        ForEach(EndChoice.allCases) { choice in
                            Text(choice.label).tag(choice)
                        }
                    }
                    switch endChoice {
                    case .never:
                        EmptyView()
                    case .onDate:
                        CalendarDateField(title: "Last one on or before", iso: $endDate)
                    case .afterCount:
                        Stepper(
                            "\(endCount) payments", value: $endCount, in: 1...600
                        )
                        .accessibilityLabel("Number of payments")
                        .accessibilityValue("\(endCount)")
                    }
                } footer: {
                    if endChoice == .afterCount {
                        // The rule somebody will otherwise discover by skipping
                        // one and finding the schedule ran a month longer.
                        Text(
                            "Counted from the first one. Skipping a payment does not add another "
                                + "at the end \u{2014} the count describes the arrangement, not "
                                + "this app\u{2019}s record of it."
                        )
                    }
                }

                Section {
                    Toggle(isOn: $autoPost) {
                        Label("Enter it for me", systemImage: "bolt")
                    }
                    Toggle(isOn: $remind) {
                        Label("Remind me", systemImage: "bell")
                    }
                    if existing != nil {
                        Toggle(isOn: $paused) {
                            Label("Paused", systemImage: "pause.circle")
                        }
                    }
                } footer: {
                    VStack(alignment: .leading, spacing: 6) {
                        // BOTH HALVES. What it does, and the thing it will
                        // never do -- which is what makes it safe to switch on.
                        Text(
                            "Entered automatically the next time you open MyMoney on or after the "
                                + "day it is due. It never enters anything dated before the day "
                                + "you switch this on, and it always says what it entered."
                        )
                        Text(
                            "Reminders are local to this phone, and only if you have switched "
                                + "them on in Settings."
                        )
                        .foregroundStyle(.secondary)
                        if existing != nil {
                            Text(
                                "A paused schedule enters nothing and is not due. It keeps "
                                    + "everything it has already done."
                            )
                            .foregroundStyle(.secondary)
                        }
                    }
                    .fixedSize(horizontal: false, vertical: true)
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }
            }
            .navigationTitle(existing == nil ? "New schedule" : "Edit schedule")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                SaveBar(
                    title: "Save",
                    isEnabled: canSave,
                    probe: "Schedule editor \u{2014} Save",
                    save: { Task { await save() } }
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
            .task { await prepare() }
        }
    }

    /// "Every month on the 3rd." -- and, for a day past the 28th, the sentence
    /// that stops a surprise in February.
    private var dateExplanation: String {
        let day = Int(startDate.suffix(2)) ?? 1
        switch cadence {
        case .weekly, .fortnightly, .fourWeekly:
            return
                "Counted in days from the first one, so it keeps the same weekday. Four weeks is "
                + "not a month: it moves earlier through the calendar."
        case .monthly, .quarterly:
            let every = cadence == .monthly ? "month" : "third month"
            if day > 28 {
                return
                    "Every \(every) on the \(ordinalDay(day)). In a month with no \(ordinalDay(day)) "
                    + "it falls on the last day instead \u{2014} and the month after that it is "
                    + "back on the \(ordinalDay(day))."
            }
            return "Every \(every) on the \(ordinalDay(day))."
        case .annual:
            return
                "Once a year on the same date. A 29 February schedule falls on the 28th in the "
                + "years that have no 29th."
        }
    }

    /// "12 payments a year, about £5,400.00." The multiplication the owner can
    /// check in their head -- `Cadence.occurrencesPerYear`, which is whole
    /// numbers on purpose.
    private var perYearExplanation: String {
        guard let minor = typedMinor else { return cadence.perYearPhrase }
        let annual = minor.multipliedReportingOverflow(by: Int64(cadence.occurrencesPerYear))
        guard !annual.overflow else { return cadence.perYearPhrase }
        return
            "\(cadence.perYearPhrase) \u{2014} about "
            + "\(Display.money(abs(annual.partialValue), currency)) a year at this amount."
    }

    @MainActor private func prepare() async {
        context = try? await app.service.quickAddContext()
        if let existing {
            name = existing.name
            accountId = existing.accountId
            amount = TypedAmount(
                signed: existing.amountMinor,
                currency: accounts.first { $0.id == existing.accountId }?.currency ?? "GBP"
            )
            payeeName = existing.payeeName
            categoryId = existing.categoryId
            notes = existing.notes
            cadence = existing.cadence
            startDate = existing.startDate
            switch existing.end {
            case .never: endChoice = .never
            case .onDate(let iso):
                endChoice = .onDate
                endDate = iso
            case .afterOccurrences(let count):
                endChoice = .afterCount
                endCount = count
            }
            autoPost = existing.autoPost
            remind = existing.remind
            paused = existing.paused
        } else if let prefill {
            name = prefill.name
            accountId = prefill.accountId
            amount = TypedAmount(
                signed: prefill.amountMinor,
                currency: context?.accounts.first { $0.id == prefill.accountId }?.currency ?? "GBP"
            )
            payeeName = prefill.payeeName
            // The category the payee is usually filed under, learned from the
            // book (D17) -- the same completion the payee field would offer if
            // the name were typed by hand.
            categoryId = prefill.categoryId
                ?? context?.payees.exactMatch(prefill.payeeName)?.defaultCategoryId
            notes = prefill.notes
            cadence = prefill.cadence
            startDate = prefill.startDate
        } else {
            accountId = context?.defaultAccountId ?? context?.accounts.first?.id ?? ""
        }
    }

    @MainActor private func save() async {
        guard let minor = typedMinor else { return }
        saving = true
        defer { saving = false }
        let end: ScheduleEnd
        switch endChoice {
        case .never: end = .never
        case .onDate: end = .onDate(endDate)
        case .afterCount: end = .afterOccurrences(endCount)
        }
        let outcome = await app.save(
            ScheduleDraft(
                id: existing?.id,
                name: name,
                accountId: accountId,
                amountMinor: minor,
                payeeName: payeeName,
                categoryId: categoryId,
                notes: notes,
                cadence: cadence,
                startDate: startDate,
                end: end,
                // A NEW SCHEDULE EXPECTS ENTRIES FROM TODAY. The anchor is
                // often deliberately in the past -- it is how you get "the 3rd
                // of the month" -- and without this the app would decide every
                // occurrence since then had been missed. Ignored on an edit.
                expectsFrom: todayISO(),
                autoPost: autoPost,
                paused: paused,
                remind: remind
            )
        )
        switch outcome {
        case .saved: dismiss()
        case .refused(let why): refusal = why
        }
    }
}

// MARK: - Entering one

/// The sheet that turns a due occurrence into a transaction.
///
/// THIS SHEET IS THE "DELIBERATE ACT". It shows exactly what will be written --
/// which account, which day, how much, filed where -- and writes nothing until
/// the button at the bottom is pressed. The amount and the date are editable
/// because a real bill is not always the figure in the schedule and a Sunday
/// direct debit is taken on the Monday; the OCCURRENCE it settles is the one on
/// the schedule's calendar either way.
struct ConfirmPostSheet: View {
    @Environment(AppModel.self) private var app
    @Environment(\.dismiss) private var dismiss

    let occurrence: DueOccurrence

    @State private var amount: TypedAmount
    @State private var date: String
    @State private var notes: String
    @State private var refusal: EditRefusal?
    @State private var saving = false

    init(occurrence: DueOccurrence) {
        self.occurrence = occurrence
        _amount = State(
            initialValue: TypedAmount(
                signed: occurrence.amountMinor, currency: occurrence.currency
            )
        )
        _date = State(initialValue: occurrence.date)
        _notes = State(initialValue: occurrence.notes)
    }

    private var typedMinor: Int64? { amount.minor(currency: occurrence.currency) }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    FigureRow(label: "Schedule", value: occurrence.scheduleName)
                    FigureRow(label: "Account", value: occurrence.accountName)
                    if !occurrence.payeeName.isEmpty {
                        FigureRow(label: "Payee", value: occurrence.payeeName)
                    }
                } header: {
                    Text("Entering")
                } footer: {
                    Text(
                        "Due \(Display.dateText(occurrence.date)). This adds one transaction to "
                            + "this copy of your book."
                    )
                }

                Section {
                    AmountField(
                        title: "Amount", currency: occurrence.currency, amount: $amount
                    )
                    CalendarDateField(title: "Dated", iso: $date)
                    TextField("Notes", text: $notes, axis: .vertical)
                } footer: {
                    Text(
                        "Change either if the real payment differed. It still settles the "
                            + "\(Display.dateText(occurrence.date)) one on this schedule."
                    )
                }

                if occurrence.reopened {
                    Section {
                        Label(
                            "This was entered before, and that transaction is no longer in your "
                                + "book \u{2014} deleted, or replaced when you last imported a "
                                + "backup. Entering it again adds a new one.",
                            systemImage: "arrow.uturn.backward"
                        )
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                    }
                }

                if let refusal {
                    Section { RefusalNotice(refusal: refusal) }
                }

                Section {
                    // NOT `role: .destructive`. A skip destroys nothing -- it
                    // records a decision, and it can be taken back. Painting it
                    // red would put it in the same visual class as deleting a
                    // transaction, which is the one thing on this sheet that
                    // touches the book.
                    Button {
                        Task { await skip() }
                    } label: {
                        Label("Skip this one", systemImage: "forward.end")
                    }
                } footer: {
                    Text(
                        "Skipping records that it did not happen. The schedule carries on, and "
                            + "you can take a skip back."
                    )
                }
            }
            .navigationTitle("Enter payment")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) {
                SaveBar(
                    title: "Enter it",
                    isEnabled: typedMinor != nil && typedMinor != 0 && !saving,
                    probe: "Confirm payment \u{2014} Enter",
                    save: { Task { await post() } }
                )
            }
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button("Cancel") { dismiss() }
                }
            }
        }
    }

    @MainActor private func post() async {
        guard let minor = typedMinor else { return }
        saving = true
        defer { saving = false }
        let outcome = await app.post(
            SchedulePosting(
                scheduleId: occurrence.scheduleId,
                occurrenceDate: occurrence.date,
                date: date == occurrence.date ? nil : date,
                amountMinor: minor == occurrence.amountMinor ? nil : minor,
                notes: notes == occurrence.notes ? nil : notes
            )
        )
        switch outcome {
        case .saved: dismiss()
        case .refused(let why): refusal = why
        }
    }

    @MainActor private func skip() async {
        saving = true
        defer { saving = false }
        let outcome = await app.skip(
            scheduleId: occurrence.scheduleId, occurrenceDate: occurrence.date
        )
        switch outcome {
        case .saved: dismiss()
        case .refused(let why): refusal = why
        }
    }
}

// MARK: - One schedule

/// A schedule, opened: what it is, what it has done, and the two switches that
/// change how it behaves.
struct ScheduleDetailView: View {
    @Environment(AppModel.self) private var app

    let scheduleId: String
    let revision: Int

    @State private var screen: ScheduleDetailScreen?
    @State private var failure: String?
    @State private var editing: ScheduleEditorSheet?
    @State private var confirmingDelete = false
    @State private var refusal: EditRefusal?

    var body: some View {
        List {
            if let refusal {
                Section { RefusalNotice(refusal: refusal) }
            }
            if let screen {
                summarySection(screen)
                switchesSection(screen)
                nextSection(screen)
                historySection(screen)
            } else if let failure {
                Section {
                    Notice(
                        symbol: "exclamationmark.triangle",
                        title: "This schedule could not be read",
                        message: failure,
                        tone: .problem
                    )
                    .frame(maxWidth: .infinity)
                }
            } else {
                Section { ProgressView().frame(maxWidth: .infinity) }
            }
        }
        .navigationTitle(screen?.schedule.name ?? "Schedule")
        .toolbar {
            if let screen {
                ToolbarItem {
                    Button("Edit") { editing = .editing(screen.schedule) }
                }
            }
        }
        .sheet(item: $editing) { which in
            ScheduleEditor(existing: which.schedule)
        }
        .confirmationDialog(
            "Delete \u{201C}\(screen?.schedule.name ?? "")\u{201D}?",
            isPresented: $confirmingDelete,
            titleVisibility: .visible
        ) {
            Button("Delete schedule", role: .destructive) {
                Task { await delete() }
            }
            Button("Cancel", role: .cancel) {}
        } message: {
            Text(
                "The payments it has already entered stay in your book. You can undo this "
                    + "straight afterwards."
            )
        }
        .task(id: revision) { await load() }
    }

    private func summarySection(_ screen: ScheduleDetailScreen) -> some View {
        Section {
            FigureRow(
                label: "Amount",
                value: Display.money(screen.schedule.amountMinor, screen.currency),
                spoken: Display.moneyFlowSpoken(screen.schedule.amountMinor, screen.currency),
                emphasised: true
            )
            FigureRow(label: "Every", value: screen.schedule.cadence.label)
            FigureRow(label: "Account", value: screen.accountName)
            if !screen.schedule.payeeName.isEmpty {
                FigureRow(label: "Payee", value: screen.schedule.payeeName)
            }
            if let path = screen.categoryPath {
                FigureRow(label: "Category", value: path)
            }
            FigureRow(label: "First one", value: Display.dateText(screen.schedule.startDate))
            FigureRow(label: "Ends", value: endText(screen))
            if let annual = screen.schedule.annualMinor {
                FigureRow(
                    label: "About a year of it",
                    value: Display.money(abs(annual), screen.currency)
                )
            }
        } footer: {
            Text(
                "\(screen.schedule.cadence.perYearPhrase). The yearly figure is that "
                    + "multiplication, at this amount."
            )
        }
    }

    private func endText(_ screen: ScheduleDetailScreen) -> String {
        switch screen.schedule.end {
        case .never: return "Carries on"
        case .onDate(let iso): return "By \(Display.dateText(iso))"
        case .afterOccurrences(let count):
            guard let remaining = screen.remainingCount else { return "\(count) payments" }
            return "\(count) payments, \(remaining) to go"
        }
    }

    private func switchesSection(_ screen: ScheduleDetailScreen) -> some View {
        Section {
            Toggle(
                isOn: Binding(
                    get: { screen.schedule.paused },
                    set: { paused in Task { await set { try await $0.setSchedulePaused(id: scheduleId, paused: paused) } } }
                )
            ) {
                Label("Paused", systemImage: "pause.circle")
            }
            Toggle(
                isOn: Binding(
                    get: { screen.schedule.autoPost },
                    set: { on in Task { await set { try await $0.setScheduleAutoPost(id: scheduleId, autoPost: on) } } }
                )
            ) {
                Label("Enter it for me", systemImage: "bolt")
            }
            Toggle(
                isOn: Binding(
                    get: { screen.schedule.remind },
                    set: { on in Task { await set { try await $0.setScheduleRemind(id: scheduleId, remind: on) } } }
                )
            ) {
                Label("Remind me", systemImage: "bell")
            }
            Button(role: .destructive) { confirmingDelete = true } label: {
                Label("Delete schedule\u{2026}", systemImage: "trash")
            }
        } footer: {
            if let from = screen.schedule.autoPostFrom {
                Text(
                    "Entering for you from \(Display.dateText(from)) onwards \u{2014} anything "
                        + "dated before that is still offered for you to confirm."
                )
            }
        }
    }

    @ViewBuilder private func nextSection(_ screen: ScheduleDetailScreen) -> some View {
        if !screen.nextDates.isEmpty {
            Section("Next dates") {
                ForEach(screen.nextDates, id: \.self) { date in
                    Text(Display.dateText(date))
                        .foregroundStyle(.secondary)
                }
            }
        }
    }

    @ViewBuilder private func historySection(_ screen: ScheduleDetailScreen) -> some View {
        Section {
            if screen.history.isEmpty {
                Text("Nothing has been entered or skipped yet.")
                    .foregroundStyle(.secondary)
            } else {
                ForEach(screen.history) { row in
                    ScheduleHistoryRowView(row: row)
                }
            }
        } header: {
            Text("What has happened")
        } footer: {
            Text(
                "Each line is one decision about one date. A payment whose transaction is no "
                    + "longer in your book becomes due again."
            )
        }
    }

    @MainActor private func load() async {
        do {
            screen = try await app.service.scheduleDetail(id: scheduleId, today: todayISO())
            failure = screen == nil ? "It is not in this copy of the book." : nil
        } catch {
            screen = nil
            failure = AppModel.message(for: error)
        }
    }

    @MainActor private func set(_ body: @escaping (LedgerService) async throws -> Void) async {
        // Routed through `AppModel.run` shapes elsewhere; here the three
        // switches share one path so that each of them re-reads the book and
        // re-plans the reminders exactly like every other change.
        let outcome = await app.runService(body)
        refusal = outcome.refusal
    }

    @MainActor private func delete() async {
        guard let screen else { return }
        let outcome = await app.deleteSchedule(id: scheduleId, named: screen.schedule.name)
        refusal = outcome.refusal
    }
}

/// One line of a schedule's history.
struct ScheduleHistoryRowView: View {
    let row: ScheduleHistoryRow

    var body: some View {
        HStack(alignment: .firstTextBaseline) {
            VStack(alignment: .leading, spacing: 2) {
                Text(Display.dateText(row.occurrenceDate))
                Text(detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }
            Spacer(minLength: 12)
            Image(systemName: symbol)
                .foregroundStyle(row.kind == .posted && row.transactionIsPresent ? Color.secondary : .orange)
                .accessibilityHidden(true)
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("\(Display.dateSpoken(row.occurrenceDate)). \(detail)")
    }

    private var symbol: String {
        switch row.kind {
        case .posted: return row.transactionIsPresent ? "checkmark.circle" : "questionmark.circle"
        case .skipped: return "forward.end.circle"
        }
    }

    private var detail: String {
        var text: String
        switch row.kind {
        case .posted:
            text = row.transactionIsPresent
                ? "Entered in your book."
                : "Entered, and that transaction is no longer in your book \u{2014} so it is due "
                    + "again."
        case .skipped:
            text = "Skipped."
        }
        if !row.isOnTheGrid {
            // Not a bug and not a deletion: the schedule's dates were changed
            // afterwards. The transaction is still the owner's.
            text += " This date is no longer one the schedule falls on."
        }
        return text
    }
}
