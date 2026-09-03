// The three things this app can be told to do differently, and what each of
// them actually does.
//
// EVERY SECTION HERE SAYS WHAT IT DOES *NOT* DO. That is the pattern the rest
// of the app already follows -- the copy banner counts rather than warns, the
// import screen lists what was checked rather than saying "verified" -- and it
// matters most on this screen, because these three features are the ones a
// person is most likely to assume more of than they deliver:
//
//   * the lock hides the screen; it does not encrypt the book;
//   * the widget shows figures from the last time the app ran; it is not live;
//   * Siri writes to the copy on this device, exactly like every other button
//     in the app, and never to the web app.
import AppIntents
import MyMoneyKit
import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var app
    let lock: AppLockModel

    @State private var enabling = false
    @State private var lastPublished: SnapshotSummary?
    /// The currency the picker is showing, which is the book's until somebody
    /// changes it. Held here rather than read from the book on every frame so
    /// the picker does not fight the write that is in flight.
    @State private var currency = ""
    @State private var changingCurrency = false
    @State private var currencyRefusal: EditRefusal?

    var body: some View {
        List {
            bookSection
            lockSection
            remindersSection
            widgetSection
            siriSection
        }
        .navigationTitle("Settings")
        .task {
            lastPublished = SnapshotSummary.read()
            currency = app.baseCurrency ?? ""
            await app.reminders.refreshPendingCount()
        }
        .onChange(of: app.revision) { _, _ in
            lastPublished = SnapshotSummary.read()
            // Follow the book. A change made here lands through `revision`
            // like every other write, and a change made ANYWHERE else -- an
            // import, most obviously, which brings its own base currency --
            // must move this picker rather than leave it claiming the old one.
            currency = app.baseCurrency ?? currency
        }
    }

    // MARK: - The book itself

    /// Where this book came from, what its totals are counted in, and the door
    /// to importing one.
    ///
    /// ─────────────────────────────────────────────────────────────────────
    /// IMPORT LIVES HERE FOR EVER, not only on the first screen. Somebody who
    /// starts fresh on the phone in September and exports their web app's book
    /// in November must not have to reinstall the app to bring it across, and
    /// a route that exists only during onboarding is a route that has been
    /// taken away from everybody who has finished onboarding. It is also on the
    /// accounts list, where it has always been; two doors to a once-a-year
    /// action is the right number when one of them is the screen people go to
    /// when they are looking for something they cannot find.
    ///
    /// THE BASE CURRENCY IS CHANGEABLE FOR THE SAME REASON. It is asked on the
    /// second screen anybody sees, before they have entered an account, and a
    /// first-run answer that cannot be revised is a trap.
    private var bookSection: some View {
        Section {
            if app.hasBook {
                Picker(selection: currencyBinding) {
                    ForEach(currencyOptions, id: \.self) { code in
                        Text(CurrencyChoice.label(code)).tag(code)
                    }
                } label: {
                    // A NEUTRAL SYMBOL, not a pound sign. This row is where
                    // the currency STOPS being GBP, and a £ glyph beside the
                    // words "LKR" is the screen arguing with itself.
                    Label("Base currency", systemImage: "banknote")
                }
                .disabled(changingCurrency)
                .accessibilityHint(changingCurrency ? "Not while the last change is saving" : "")

                if changingCurrency {
                    // GREYED WITH A REASON. Changing the base currency rewrites
                    // every total in the book, and a second change on top of an
                    // unfinished one is a question the screen cannot answer.
                    Label("Changing it\u{2026} every total is being redone.", systemImage: "clock")
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                }
                if let currencyRefusal {
                    RefusalNotice(refusal: currencyRefusal)
                }
            }

            NavigationLink {
                ExportView()
            } label: {
                Label("Back up this book\u{2026}", systemImage: "square.and.arrow.up")
            }

            NavigationLink {
                ImportView()
            } label: {
                Label("Import a backup\u{2026}", systemImage: "square.and.arrow.down")
            }
        } header: {
            Text("Your book")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                // WHAT CHANGING IT DOES NOT DO, first, because that is the
                // question somebody is actually asking when they hesitate over
                // this row.
                Text(
                    "Changing the base currency converts nothing. Every account keeps its own "
                        + "currency and every amount stays exactly the amount it is \u{2014} only "
                        + "the totals are counted in the new one, using the exchange rates this "
                        + "book holds."
                )
                Text(
                    "A currency with no rate is left OUT of net worth, and the accounts screen "
                        + "says which one. No account is ever hidden."
                )
                Text(originLine)
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    /// What importing would do to the book that is here now, in one sentence
    /// that is true of THIS book rather than of books in general.
    private var originLine: String {
        guard app.hasBook else {
            return "Importing a backup checks the file against itself before anything is written."
        }
        switch app.bookOrigin {
        case .imported:
            return
                "This book was imported from a backup. Importing again replaces it with the file "
                + "you choose \u{2014} your web app is not touched either way."
        case .created:
            return
                "This book was started on this device, and this app is its only home. Importing "
                + "a backup REPLACES it with the file you choose, so export this one first if "
                + "you want to keep it."
        }
    }

    /// The common list with the book's own currency kept in it: a picker whose
    /// selection is not one of its rows shows nothing at all.
    private var currencyOptions: [String] {
        let current = currency.isEmpty ? (app.baseCurrency ?? "GBP") : currency
        return StarterBook.commonCurrencies.contains(current)
            ? StarterBook.commonCurrencies
            : [current] + StarterBook.commonCurrencies
    }

    /// Writing through the store, and moving the picker only when the store
    /// agreed. A picker that showed the new currency after a refusal would be
    /// the screen disagreeing with the book.
    private var currencyBinding: Binding<String> {
        Binding(
            get: { currency.isEmpty ? (app.baseCurrency ?? "GBP") : currency },
            set: { code in
                let previous = currency
                currency = code
                currencyRefusal = nil
                changingCurrency = true
                Task {
                    let outcome = await app.setBaseCurrency(code)
                    changingCurrency = false
                    if let refusal = outcome.refusal {
                        currencyRefusal = refusal
                        currency = previous.isEmpty ? (app.baseCurrency ?? "GBP") : previous
                    }
                }
            }
        )
    }

    // MARK: - Lock

    private var lockSection: some View {
        Section {
            Toggle(
                isOn: Binding(
                    get: { lock.isEnabled },
                    set: { wanted in
                        if wanted {
                            enabling = true
                            Task {
                                _ = await lock.enable()
                                enabling = false
                            }
                        } else {
                            lock.disable()
                        }
                    }
                )
            ) {
                Label("Lock this app", systemImage: "lock")
            }
            .disabled(enabling)
            .accessibilityHint(enabling ? "Waiting for Face ID or your passcode" : "")

            if enabling {
                Label(
                    "Waiting for Face ID or your passcode \u{2014} the switch comes back as soon "
                        + "as it answers.",
                    systemImage: "clock"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            if lock.isEnabled {
                Picker(selection: Binding(get: { lock.grace }, set: { lock.setGrace($0) })) {
                    ForEach(AppLockGrace.allCases) { grace in
                        Text(grace.label).tag(grace)
                    }
                } label: {
                    Label("Lock when I leave", systemImage: "clock")
                }
                Text(lock.grace.detail)
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
            }

            if let message = lock.message, !lock.isEnabled {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Locking")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                // THE SENTENCE THAT MUST TRAVEL WITH THE FEATURE. It comes from
                // the kit, where a test asserts it still says "does not
                // encrypt" -- so it cannot be softened into a promise by a
                // later edit of this view.
                Text(AppLockSettings.honestyLine)
                Text(
                    "It always opens on launch, and it always offers your passcode when Face ID "
                        + "will not do. If neither works, it stays shut."
                )
                Text(lock.biometryDescription)
                    .foregroundStyle(.secondary)
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Widgets

    private var widgetSection: some View {
        Section {
            if let published = lastPublished {
                FigureRow(label: "Last published", value: published.freshness.phrase)
                FigureRow(
                    label: "Net worth on the widget",
                    value: Display.money(published.netWorthMinor, published.baseCurrency)
                )
                if published.freshness.isStale {
                    Label(
                        "The widget is showing figures from \(published.freshness.phrase). "
                            + "Opening the app brings it up to date.",
                        systemImage: "clock.arrow.circlepath"
                    )
                    .font(.footnote)
                    .foregroundStyle(.secondary)
                    .fixedSize(horizontal: false, vertical: true)
                }
            } else {
                Label(
                    SharedContainer.isAvailable
                        ? "Nothing published yet. It appears once this device has a book with "
                            + "something in it."
                        : "Not available in this build.",
                    systemImage: "square.grid.2x2"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Widgets")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text(SharedContainer.explanation)
                Text(
                    "A widget is never live. It shows what the book said when you last opened "
                        + "the app, and it prints how long ago that was underneath every figure."
                )
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - Reminders

    /// Local notifications for what is due. Off until asked for, like the lock.
    private var remindersSection: some View {
        Section {
            Toggle(
                isOn: Binding(
                    get: { app.reminders.settings.enabled },
                    set: { wanted in
                        Task {
                            if wanted {
                                // The switch moves only if iOS grants
                                // permission -- a setting that says it is on
                                // while doing nothing is worse than one that is
                                // off.
                                if await app.reminders.enable() {
                                    await app.remindersSettingsChanged()
                                }
                            } else {
                                app.reminders.disable()
                            }
                        }
                    }
                )
            ) {
                Label("Remind me what is due", systemImage: "bell")
            }
            .disabled(app.reminders.isWorking)
            .accessibilityHint(app.reminders.isWorking ? "Waiting for iOS to answer" : "")

            if app.reminders.isWorking {
                Label(
                    "Asking iOS for permission to send reminders \u{2014} the switch comes back "
                        + "as soon as it answers.",
                    systemImage: "clock"
                )
                .font(.footnote)
                .foregroundStyle(.secondary)
                .fixedSize(horizontal: false, vertical: true)
            }

            if app.reminders.settings.enabled {
                Picker(selection: leadBinding) {
                    Text("On the day").tag(0)
                    Text("The day before").tag(1)
                    Text("Two days before").tag(2)
                    Text("Three days before").tag(3)
                    Text("A week before").tag(7)
                } label: {
                    Label("When", systemImage: "calendar")
                }
                DatePicker(
                    selection: timeBinding, displayedComponents: .hourAndMinute
                ) {
                    Label("At", systemImage: "clock")
                }
                Toggle(isOn: detailBinding) {
                    Label("Show what is due", systemImage: "eye")
                }
                FigureRow(
                    label: "Reminders set",
                    value: Display.grouped(app.reminders.pendingCount)
                )
            }

            if let message = app.reminders.message {
                Label(message, systemImage: "exclamationmark.triangle")
                    .font(.footnote)
                    .foregroundStyle(.orange)
                    .fixedSize(horizontal: false, vertical: true)
            }
        } header: {
            Text("Reminders")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                // WHAT IT IS NOT, first. These are set by the app while it is
                // running, on this phone, from the book this phone holds.
                Text(
                    "These are set by this app on this phone. There is no server: nothing about "
                        + "your money leaves the device, and a payment you enter in your web app "
                        + "will not stop a reminder here until you open this app again."
                )
                Text(
                    "One notification per day that has something due, not one per payment "
                        + "\u{2014} iOS keeps a limited number and silently drops the rest."
                )
                Text(
                    app.reminders.settings.showsDetail
                        ? "Notifications will name the schedules and their amounts. That text is "
                            + "drawn on your lock screen, where other people can see it."
                        : "Notifications say how many are due and nothing else. A lock screen is "
                            + "a public surface, so no names and no figures unless you ask."
                )
                .foregroundStyle(.secondary)
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var leadBinding: Binding<Int> {
        Binding(
            get: { app.reminders.settings.leadDays },
            set: { days in
                app.reminders.setLeadDays(days)
                Task { await app.remindersSettingsChanged() }
            }
        )
    }

    private var detailBinding: Binding<Bool> {
        Binding(
            get: { app.reminders.settings.showsDetail },
            set: { shows in
                app.reminders.setShowsDetail(shows)
                Task { await app.remindersSettingsChanged() }
            }
        )
    }

    /// The reminder time, as a `Date` for the picker and as two integers
    /// everywhere else.
    ///
    /// A REMINDER IS A WALL-CLOCK EVENT, not an instant, so what is stored is
    /// an hour and a minute. The `Date` exists for the picker's sake alone and
    /// is thrown away -- the same trick `CalendarDateField` plays, and for the
    /// same reason.
    private var timeBinding: Binding<Date> {
        Binding(
            get: {
                var components = DateComponents()
                components.year = 2000
                components.month = 1
                components.day = 1
                components.hour = app.reminders.settings.hour
                components.minute = app.reminders.settings.minute
                return Calendar.current.date(from: components) ?? Date()
            },
            set: { date in
                let parts = Calendar.current.dateComponents([.hour, .minute], from: date)
                app.reminders.setTime(hour: parts.hour ?? 8, minute: parts.minute ?? 0)
                Task { await app.remindersSettingsChanged() }
            }
        )
    }

    // MARK: - Siri

    private var siriSection: some View {
        Section {
            // `SiriTipView` is iOS-only. On the Mac the same two phrases are
            // just written out, rather than the section quietly disappearing
            // and leaving a feature nobody knows exists.
            #if os(iOS)
                SiriTipView(intent: AddExpenseIntent())
                    .padding(.vertical, 4)
                SiriTipView(intent: NetWorthIntent())
                    .padding(.vertical, 4)
            #else
                Label("\u{201C}Add a four pound expense to MyMoney\u{201D}", systemImage: "mic")
                Label("\u{201C}What am I worth in MyMoney\u{201D}", systemImage: "mic")
            #endif
        } header: {
            Text("Siri and Shortcuts")
        } footer: {
            VStack(alignment: .leading, spacing: 8) {
                Text(
                    "\u{201C}Add a four pound expense to MyMoney\u{201D} writes a payment without "
                        + "opening the app. It goes to the account you used last, under the "
                        + "category that payee usually goes under, and Siri reads back which "
                        + "account it landed in."
                )
                Text(
                    "A spoken phrase can carry one figure, so to say the payee in the same breath "
                        + "build a shortcut in the Shortcuts app with the payee filled in \u{2014} "
                        + "once, and then it is one phrase for ever."
                )
                Text(
                    "It writes to the copy on this device and counts as one more change your web "
                        + "app does not have, exactly like every button in the app."
                )
            }
            .font(.footnote)
            .fixedSize(horizontal: false, vertical: true)
        }
    }
}

/// What the settings screen shows about the published snapshot, read straight
/// from the file the widget reads -- so this screen cannot claim something was
/// published that the widget cannot see.
struct SnapshotSummary {
    let netWorthMinor: Int64
    let baseCurrency: String
    let freshness: SnapshotFreshness

    static func read() -> SnapshotSummary? {
        guard let directory = SharedContainer.url,
            let snapshot = SnapshotFile.read(from: directory),
            let freshness = SnapshotFreshness.of(asOf: snapshot.asOf, now: Date())
        else { return nil }
        return SnapshotSummary(
            netWorthMinor: snapshot.netWorthMinor,
            baseCurrency: snapshot.baseCurrency,
            freshness: freshness
        )
    }
}
