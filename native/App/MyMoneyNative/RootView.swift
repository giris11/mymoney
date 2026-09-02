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
    case allTransactions
    case account(String)
    case importBackup
    case groups
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
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 280, ideal: 340)
        } detail: {
            NavigationStack {
                detail
            }
        }
        .safeAreaInset(edge: .bottom) {
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
        .task {
            await app.load()
            await loadContext()
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
            LocalCopyBanner(edits: app.localEdits)
            content
        }
        .navigationTitle("MyMoney")
        .toolbar {
            ToolbarItem {
                Menu {
                    Button {
                        sheet = .quickAdd
                    } label: {
                        Label("Quick add", systemImage: "bolt")
                    }
                    Button {
                        sheet = .newTransaction
                    } label: {
                        Label("Transaction\u{2026}", systemImage: "square.and.pencil")
                    }
                    Button {
                        sheet = .transfer(nil, legId: nil)
                    } label: {
                        Label("Transfer\u{2026}", systemImage: "arrow.left.arrow.right")
                    }
                    Divider()
                    Button {
                        sheet = .account(nil)
                    } label: {
                        Label("Account\u{2026}", systemImage: "building.columns")
                    }
                } label: {
                    Label("Add", systemImage: "plus")
                }
                .disabled(context == nil || !app.hasBook)
                .help("Add a transaction, a transfer or an account")
            }
            ToolbarItem {
                Button {
                    selection = .importBackup
                } label: {
                    Label("Import a backup", systemImage: "square.and.arrow.down")
                }
                .help("Import a backup file exported from the web app")
            }
        }
    }

    @ViewBuilder private var content: some View {
        switch app.phase {
        case .loading:
            ProgressView("Opening your copy\u{2026}")
                .frame(maxWidth: .infinity, maxHeight: .infinity)

        case .empty:
            // The explanation sits ABOVE the list rather than in it, and the
            // one action is a `NavigationLink` INSIDE it.
            //
            // Both halves of that are load-bearing. A bare Button would be a
            // dead end on a phone, where only a change to the sidebar list's
            // selection pushes the detail column. And a paragraph of prose in a
            // macOS List row is proposed an unbounded width, takes its ideal
            // one -- a single line -- and gets clipped: the sentence explaining
            // what to do next would stop mid-word.
            emptyOrFailed(
                Notice(
                    symbol: "tray.and.arrow.down",
                    title: "Nothing on this device yet",
                    message:
                        "Export a backup from your web app, then import it here. This app edits "
                        + "its own copy of it and never writes back."
                )
            )

        case .failed(let message):
            emptyOrFailed(
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
                onEditAccount: { sheet = .account($0) },
                onAddAccount: { sheet = .account(nil) }
            )
        }
    }

    /// A full-width explanation, then a list carrying the one route out.
    private func emptyOrFailed(_ notice: Notice) -> some View {
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

    // MARK: - Detail

    @ViewBuilder private var detail: some View {
        switch selection {
        case .importBackup:
            ImportView()
        case .groups:
            AccountGroupsView(groups: groups, counts: accountCountsByGroup)
        case .none:
            placeholder
        case .allTransactions, .account:
            if let register {
                RegisterView(model: register) { id in
                    Task {
                        if let which = await app.editorSheet(forTransaction: id) {
                            sheet = which
                        }
                    }
                }
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
                AccountEditor(groups: groups, existing: balance)
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

    private func loadContext() async {
        guard app.hasBook else {
            context = nil
            return
        }
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
        case .importBackup, .groups, .none:
            register = nil
        }
    }
}
