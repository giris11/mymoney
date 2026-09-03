// The shell: one `NavigationSplitView` for both platforms.
//
// It collapses to a stack on an iPhone and stands as a two-column window on a
// Mac and an iPad, which is the shape this app wants anyway -- accounts on the
// left, the register on the right. One code path rather than a phone layout and
// a Mac layout that drift apart.
//
// NAVIGATION IS DRIVEN BY THE SIDEBAR LIST'S OWN SELECTION, not by a variable
// the view happens to keep. That distinction is the difference between working
// and not: a `NavigationSplitView` collapsed onto an iPhone only PUSHES the
// detail column when the sidebar's `List(selection:)` changes, so every route
// here is a `NavigationLink(value:)` inside that list, and the toolbar button
// sets the same binding. A button that merely set a private `@State` would look
// right on a Mac and do nothing at all on a phone.
//
// EDITING IS ALWAYS A SHEET, never a push. A sheet cannot be navigated away
// from by accident, it dismisses only when the save has actually succeeded, and
// on a phone it is the shape that gets the keyboard up fastest -- which is what
// Quick Add is for.
//
// THE BANNER IS OUTSIDE THE LIST, above it, so it cannot scroll away, and the
// UNDO BAR is pinned under everything, so a delete can be taken back from
// wherever the owner happens to be.
import MyMoneyKit
import SwiftUI

/// Where the detail column is pointed. Hashable because it is the value a
/// `NavigationLink` carries and the thing the sidebar list selects.
enum Route: Hashable {
    case dashboard
    case budgets
    case scheduled
    case reports
    case insights
    case allTransactions
    case account(String)
    case importBackup
    /// Writing the book out to a file. A route rather than a plain push so it
    /// can be reached from the sidebar the way import is, and so a reach
    /// measurement can open it without hands.
    case exportBackup
    case groups
    case settings
}

/// Which editor is open. One enum rather than five booleans: two sheets can
/// never be asked for at once, and the compiler knows it.
enum EditorSheet: Identifiable {
    case quickAdd
    case newTransaction
    case editTransaction(TransactionDraft)
    case transfer(TransferDraft?, legId: String?)
    case account(AccountBalance?)

    var id: String {
        switch self {
        case .quickAdd: return "quickAdd"
        case .newTransaction: return "newTransaction"
        case .editTransaction(let draft): return "tx:\(draft.id ?? "")"
        case .transfer(let draft, let leg):
            return "transfer:\(draft?.transferGroupId ?? "new"):\(leg ?? "")"
        case .account(let balance): return "account:\(balance?.account.id ?? "new")"
        }
    }
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    /// The lock. Owned by the App so that it exists before the first frame --
    /// see `AppLockModel.init`, which decides "locked" there rather than in a
    /// `.task`, so there is no moment in which the book is drawn behind an
    /// arriving lock screen.
    let lock: AppLockModel
    @Environment(\.scenePhase) private var scenePhase
    @State private var selection: Route?
    /// The register currently open in the detail column, rebuilt whenever the
    /// route changes -- or whenever the book changes -- so its paging and its
    /// running balance start fresh.
    @State private var register: RegisterModel?
    @State private var sheet: EditorSheet?
    /// The book's own lists, for the editors. Read once and re-read after every
    /// change, because an edit can create a payee, a tag or an account that the
    /// next sheet has to be able to offer.
    @State private var context: QuickAddContext?

    /// The account groups, taken from the SAME snapshot the accounts screen
    /// draws rather than read again. Two reads a moment apart could show a
    /// group in the sidebar that the editor's picker does not offer, and a
    /// picker that cannot select the group an account is already in is a
    /// picker that silently moves it out.
    private var groups: [AccountGroup] { app.summary?.snapshot.groups ?? [] }

    var body: some View {
        // THE UNDO BAR IS A VSTACK ROW, NOT A `safeAreaInset`, AND THAT IS A BUG
        // FIX RATHER THAN A STYLE. It used to be a bottom safe-area inset on the
        // `NavigationSplitView`. Now that the screens INSIDE the split view have
        // bottom bars of their own, the two did not stack: the outer inset was
        // drawn over the inner one, and an undo bar arriving after a delete
        // sliced the Quick Add button in half. Nested safe-area insets across a
        // split view's columns do not compose, and this was found by taking a
        // screenshot of an actual delete rather than by reasoning about it.
        //
        // A `VStack` composes by construction. The split view is proposed the
        // height that is left, so every bar inside it -- Quick Add, Save, New
        // budget -- lands ABOVE the undo bar instead of underneath it, and the
        // undo bar keeps the very bottom of the screen, which is the easiest
        // place on the phone to reach and the right place for "put that back".
        VStack(spacing: 0) {
            // FIRST RUN REPLACES THE WHOLE SHELL, rather than sitting inside
            // the sidebar column where the empty state used to.
            //
            // Two reasons, and the first is not cosmetic. A wizard drawn in a
            // 340pt sidebar on an iPad or a Mac is a form in a slot, with a
            // detail column beside it saying "choose an account" about a book
            // that does not exist yet. The second: while there is no book there
            // is nothing for the sidebar's own furniture -- the copy banner,
            // the Add bar, the net-worth headline -- to be about, and every one
            // of them would have to grow a special case for a state that lasts
            // ninety seconds.
            if app.isFirstRun {
                FirstRunView()
            } else {
                NavigationSplitView {
                    sidebar
                        .navigationSplitViewColumnWidth(min: 280, ideal: 340)
                } detail: {
                    NavigationStack {
                        detail
                    }
                }
            }
            if let pending = app.pendingUndo {
                UndoBar(
                    message: pending.message,
                    undo: { Task { await app.undoLastDelete() } },
                    dismiss: { app.dismissUndo() }
                )
                .transition(.move(edge: .bottom))
            }
        }
        .animation(.default, value: app.pendingUndo?.id)
        // THE COVER IS OVER EVERYTHING, INCLUDING THE UNDO BAR AND ANY SHEET.
        // Placed on the outermost view for that reason: a lock that left one
        // strip of the register visible would be a lock that had not worked.
        .overlay {
            if lock.isObscured {
                LockCover(lock: lock)
                    .transition(.opacity)
            }
        }
        .animation(.easeInOut(duration: 0.15), value: lock.isObscured)
        .onChange(of: scenePhase) { _, phase in
            lock.scenePhaseChanged(to: phase)
            // COMING BACK ON A NEW DAY runs the automatic postings, because
            // "the next time you open the app" has to include the time somebody
            // comes back to it rather than launching it cold. Coming back ten
            // minutes later does nothing -- `AppModel.foregrounded` checks the
            // day.
            if phase == .active { Task { await app.foregrounded() } }
        }
        // A file handed over by another app -- the share sheet, Files, AirDrop,
        // a mail attachment. It lands on the Import screen with its own
        // description and the ordinary confirmation; it does NOT import itself.
        .onOpenURL { url in
            app.receive(url)
            selection = .importBackup
        }
        // Something wrote to the book from outside these screens: an App Intent
        // run by Siri while the app was open. Re-read rather than let the
        // register go quietly out of date.
        .onReceive(NotificationCenter.default.publisher(for: .ledgerChangedOutsideTheApp)) { _ in
            Task { await app.load() }
        }
        .task {
            await app.load()
            await loadContext()
            // A reach measurement, and nothing else, can ask to start on a
            // particular screen. `Reach.openingRoute` is nil unless
            // MYMONEY_REACH=1 is also set. See `Reach.opening`.
            //
            // After a beat, because a collapsed split view only PUSHES when its
            // sidebar list's selection changes and the list has to exist first
            // -- setting it in the same turn the book arrives changes a
            // binding nothing is watching yet.
            if let route = Reach.openingRoute {
                try? await Task.sleep(for: .milliseconds(600))
                selection = route
            }
            // The four editor sheets the sidebar's own bar opens. Same beat,
            // and for the same reason: the context they need is loaded above.
            if let asked = Reach.openingSheet {
                try? await Task.sleep(for: .milliseconds(600))
                sheet = asked
            }
        }
        .onChange(of: selection) { _, route in
            rebuildRegister(for: route)
        }
        .onChange(of: app.revision) { _, _ in
            // ONE SOURCE FOR EVERY SCREEN. A change re-reads the book and
            // rebuilds the register rather than patching the row that moved:
            // a patched running balance would be a second implementation of
            // the arithmetic, and the first symptom of it drifting would be
            // a register that disagreed with the accounts screen.
            rebuildRegister(for: selection)
            Task { await loadContext() }
        }
        .sheet(item: $sheet) { which in
            editor(for: which)
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            // NIL DRAWS NOTHING, and both nils matter. There is nothing to say
            // on a device with no book -- the banner used to print "0 changes
            // not in your web app" over an empty state, which is a sentence
            // about a web app copy of a book that does not exist -- and there
            // is nothing to say about a book CREATED here, which has no
            // counterpart anywhere to have drifted from. `LocalEdits` decides
            // which is which; this view is not asked to remember.
            LocalCopyBanner(edits: app.localEdits)
            content
        }
        .navigationTitle("MyMoney")
        // THE ADD MENU USED TO BE A "+" IN THE NAVIGATION BAR. It is the single
        // most-pressed control in the app -- it is the only door to Quick Add,
        // which is the reason the app exists -- and it was in the one place a
        // thumb on a 6.9" phone cannot get to. It is a bar now, and Quick Add
        // is its own button rather than the first item of a menu, so the fast
        // path is one tap from the accounts screen instead of two.
        //
        // AND WHAT THE BAR OFFERS DEPENDS ON WHETHER THERE IS ANYTHING TO ADD
        // TO. A book with no accounts in it -- which is exactly where "start
        // empty" lands -- cannot take a transaction, a transfer or a quick
        // entry: they all need an account to go in. A bar whose big filled
        // button could only ever refuse is the dead end this whole phase is
        // about, so with no accounts the bar carries one action, "Add an
        // account", and nothing else.
        .safeAreaInset(edge: .bottom) {
            if context != nil {
                AddActionBar(
                    hasAccounts: app.hasAccounts,
                    probe: app.hasAccounts
                        ? "Accounts \u{2014} Quick add" : "Accounts \u{2014} Add an account"
                ) { sheet = $0 }
            }
        }
        // THE IMPORT BUTTON IS GONE FROM THE TOOLBAR AND NOT REPLACED. It was
        // already duplicated as a row in the accounts list, and in the empty
        // and failed states as the one route out of them; a second copy of a
        // once-a-year action was not worth a permanent seat at the top of the
        // screen. Every path to it still exists.
    }

    @ViewBuilder private var content: some View {
        switch app.phase {
        case .loading:
            ProgressView("Opening your copy\u{2026}")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .empty:
            // UNREACHABLE, AND KEPT ANYWAY. `body` sends `.empty` to
            // `FirstRunView` before the split view is built, so this case
            // cannot be drawn today. It is here so that a later change to that
            // branch degrades to the first-run flow rather than back to the
            // dead end this arm used to hold -- an explanation with no way to
            // start a book, only a way to go and use a different app.
            FirstRunView()

        case .failed(let message):
            failedState(
                Notice(
                    symbol: "exclamationmark.triangle",
                    title: "The copy on this device could not be opened",
                    message: message
                        + "\n\nYour web app is unaffected \u{2014} it holds the real ledger.",
                    tone: .problem,
                    action: ("Try again", { Task { await app.load() } })
                )
            )

        case .ready(let summary):
            AccountsView(
                summary: summary,
                selection: $selection,
                importLink: { importLink },
                exportLink: { exportLink },
                onEditAccount: { sheet = .account($0) },
                onAddAccount: { sheet = .account(nil) }
            )
        }
    }

    /// A full-width explanation, then a list carrying the one route out.
    ///
    /// ONLY THE FAILED STATE USES THIS NOW. The empty state used to share it,
    /// and sharing it was the shape of the problem: "nothing here yet" and
    /// "your book will not open" are not the same situation and do not have the
    /// same one way out. A device with no book has three, and they are on the
    /// first-run screen; a device whose book will not open has exactly this
    /// one, and must not be walked through setting up a second book over the
    /// top of the first.
    private func failedState(_ notice: Notice) -> some View {
        VStack(spacing: 0) {
            notice
                .frame(maxWidth: .infinity)
                .padding(.top, 24)
            List(selection: $selection) {
                Section { importLink }
            }
        }
    }

    private var importLink: some View {
        NavigationLink(value: Route.importBackup) {
            Label("Import a backup\u{2026}", systemImage: "square.and.arrow.down")
        }
    }

    /// EXPORT SITS NEXT TO IMPORT, not three screens away from it. They are the
    /// two halves of the same idea -- a book and a file -- and the moment a
    /// book can be CREATED here, the out direction stops being a convenience:
    /// it is the only thing that makes the in direction survivable.
    private var exportLink: some View {
        NavigationLink(value: Route.exportBackup) {
            Label("Back up this book\u{2026}", systemImage: "square.and.arrow.up")
        }
    }

    // MARK: - Detail

    @ViewBuilder private var detail: some View {
        switch selection {
        // `revision` is handed to each of these rather than read inside them.
        // See `BudgetsView.revision`: read only as a `.task(id:)` argument it
        // did not register as an Observation dependency, and every one of
        // these screens went on showing pre-edit figures.
        case .dashboard:
            DashboardView(
                revision: app.revision,
                selection: $selection,
                onSelectTransaction: openEditor(for:)
            )
        case .budgets:
            BudgetsView(revision: app.revision)
        case .scheduled:
            SchedulesView(revision: app.revision)
        case .reports:
            ReportsView(revision: app.revision)
        case .insights:
            InsightsView(revision: app.revision, onSelectTransaction: openEditor(for:))
        case .importBackup:
            ImportView()
        case .exportBackup:
            ExportView()
        case .groups:
            AccountGroupsView(groups: groups, counts: accountCountsByGroup)
        case .settings:
            SettingsView(lock: lock)
        case .none:
            placeholder
        case .allTransactions, .account:
            if let register {
                RegisterView(
                    model: register,
                    openEditor: openEditor(for:),
                    // ON A PHONE THE REGISTER HAD NO ADD BUTTON AT ALL. The
                    // split view collapses to a stack, the sidebar's toolbar
                    // goes with it, and adding a transaction from the screen
                    // that shows transactions meant navigating back first. The
                    // register gets its own bar in the collapsed layout;
                    // `RegisterView` hides it when the sidebar is on screen
                    // beside it, so an iPad never shows two.
                    openSheet: { sheet = $0 }
                )
                // A new model means a new register: without an identity the
                // list would keep the previous account's rows while the new
                // ones loaded, and for a moment show one account's
                // transactions under another account's name.
                .id(ObjectIdentifier(register))
            } else {
                placeholder
            }
        }
    }

    private var placeholder: some View {
        Notice(
            symbol: "list.bullet.rectangle",
            title: "Choose an account",
            message: "Its transactions appear here, newest first, with a running balance."
        )
        .frame(maxWidth: .infinity, maxHeight: .infinity)
    }

    private var accountCountsByGroup: [String: Int] {
        var counts: [String: Int] = [:]
        for row in app.summary?.snapshot.balances ?? [] {
            guard let groupId = row.account.groupId else { continue }
            counts[groupId, default: 0] += 1
        }
        return counts
    }

    // MARK: - Editors

    @ViewBuilder private func editor(for which: EditorSheet) -> some View {
        if let context {
            switch which {
            case .quickAdd:
                QuickAddView(context: context)
            case .newTransaction:
                TransactionEditor(
                    context: context,
                    draft: TransactionDraft(
                        accountId: context.defaultAccountId ?? "",
                        date: todayISO(),
                        amountMinor: 0
                    )
                )
            case .editTransaction(let draft):
                TransactionEditor(context: context, draft: draft)
            case .transfer(let draft, let legId):
                TransferEditor(context: context, draft: draft, legId: legId)
            case .account(let balance):
                AccountEditor(
                    groups: groups, existing: balance,
                    defaultCurrency: app.baseCurrency ?? "GBP"
                )
            }
        } else {
            // Unreachable while the Add menu is disabled without a context, and
            // present anyway: a sheet that came up blank would be a dead end
            // with no way to say what went wrong.
            Notice(
                symbol: "hourglass",
                title: "Still opening your copy",
                message: "Close this and try again in a moment.",
                tone: .warning
            )
        }
    }

    /// Opening a transaction is the shell's job wherever the tap came from --
    /// the register, or the dashboard's recent list. One route in, so the
    /// two-doors rule about transfers (see `AppModel.editorSheet`) cannot be
    /// bypassed by a screen that opened an editor itself.
    @MainActor private func openEditor(for id: String) {
        Task { @MainActor in
            if let which = await app.editorSheet(forTransaction: id) {
                sheet = which
            }
        }
    }

    /// `@MainActor` for the reason spelled out in `ReportsView.load`, and it is
    /// load-bearing rather than tidy. `app.service` is an `actor`, so the
    /// `await` hops off this view and the continuation resumes on the GENERIC
    /// executor -- and `State`'s setter is `nonisolated`, so writing `context`
    /// there compiles silently and SwiftUI never sees the change. The symptom
    /// was not a crash: the Add menu stayed `.disabled` forever, because its
    /// `context == nil` test kept reading the value this function believed it
    /// had already replaced. Every editor in the app opens through that menu.
    @MainActor private func loadContext() async {
        // NO `guard app.hasBook` ANY MORE, and removing it is half the answer
        // to "I could not add an account".
        //
        // It used to return here without loading anything whenever the device
        // held no book, which left `context` nil, which left the Add bar
        // hidden -- so on the one screen where somebody needed to create
        // something, every door was shut. The other half of the answer is that
        // a book can now BE created (`FirstRunView`), so by the time this shell
        // is on screen there is one; but the guard is gone regardless, because
        // the store answers this question perfectly well on its own. An empty
        // store hands back an empty context, a broken one throws, and both of
        // those are better handled by the code below than by a precondition
        // that turned "nothing yet" into "no controls at all".
        context = try? await app.service.quickAddContext()
    }

    // MARK: - Opening a register

    private func rebuildRegister(for route: Route?) {
        guard let lookups = app.lookups, let summary = app.summary else {
            register = nil
            return
        }
        switch route {
        case .allTransactions:
            register = RegisterModel(
                scope: .allAccounts,
                title: "All transactions",
                account: nil,
                // No running balance across accounts: see RegisterModel's header.
                openingRunningBalanceMinor: nil,
                service: app.service,
                lookups: lookups
            )
        case .account(let id):
            guard let balance = summary.snapshot.balances.first(where: { $0.account.id == id })
            else {
                register = nil
                return
            }
            register = RegisterModel(
                scope: .account(id),
                title: balance.account.name,
                account: balance.account,
                // THE REGISTER STARTS AT THE ACCOUNT'S OWN BALANCE, the same
                // integer the accounts screen just drew. The running balance is
                // then a subtraction down the list, so the two figures cannot
                // disagree.
                openingRunningBalanceMinor: balance.balanceMinor,
                service: app.service,
                lookups: lookups
            )
        case .dashboard, .budgets, .scheduled, .reports, .insights, .importBackup, .exportBackup,
            .groups, .settings, .none:
            register = nil
        }
    }
}

/// The bar that adds things, wherever adding things makes sense.
///
/// QUICK ADD IS THE BUTTON, not the first line of a menu. It is the one action
/// this app is built around, so it gets the wide filled target on the right,
/// where a thumb lands without aiming. The other three kinds -- a full
/// transaction, a transfer, an account -- are behind the small menu at the far
/// end, because between them they are a handful of taps a month.
///
/// AND WITH NO ACCOUNTS IT IS ONE BUTTON: "Add an account". Quick Add, a
/// transaction and a transfer all need an account to write into -- the store
/// refuses without one and Quick Add's Save cannot even be enabled -- so
/// offering them to a book that has none is offering three buttons that can
/// only disappoint. The account editor is the one thing that works, so it gets
/// the whole bar and the same wide filled target Quick Add gets afterwards.
struct AddActionBar: View {
    /// Whether this book has anything to add a transaction TO.
    var hasAccounts = true
    /// What this bar's primary button is called in the reach log.
    let probe: String
    let open: (EditorSheet) -> Void

    var body: some View {
        if hasAccounts { full } else { accountOnly }
    }

    /// The first thing a brand-new book needs, and the only thing that works
    /// before it has been done.
    private var accountOnly: some View {
        ActionBar {
            PrimaryAction(
                title: "Add an account", systemImage: "building.columns", probe: probe
            ) {
                open(.account(nil))
            }
        }
    }

    private var full: some View {
        ActionBar {
            HStack(spacing: 16) {
                Menu {
                    Button {
                        open(.newTransaction)
                    } label: {
                        Label("Transaction\u{2026}", systemImage: "square.and.pencil")
                    }
                    Button {
                        open(.transfer(nil, legId: nil))
                    } label: {
                        Label("Transfer\u{2026}", systemImage: "arrow.left.arrow.right")
                    }
                    Divider()
                    Button {
                        open(.account(nil))
                    } label: {
                        Label("Account\u{2026}", systemImage: "building.columns")
                    }
                } label: {
                    Image(systemName: "ellipsis")
                        .frame(minWidth: 28, minHeight: 24)
                }
                .buttonStyle(.bordered)
                .controlSize(.large)
                .accessibilityLabel("Add a transaction, a transfer or an account")
                .help("Add a transaction, a transfer or an account")

                PrimaryAction(title: "Quick add", systemImage: "bolt.fill", probe: probe) {
                    open(.quickAdd)
                }
            }
        }
    }
}
