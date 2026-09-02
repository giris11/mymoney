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
// THE READ-ONLY BANNER IS OUTSIDE THE LIST, above it, so it cannot scroll away.
// It is not dismissible.
import MyMoneyKit
import SwiftUI

/// Where the detail column is pointed. Hashable because it is the value a
/// `NavigationLink` carries and the thing the sidebar list selects.
enum Route: Hashable {
    case allTransactions
    case account(String)
    case importBackup
}

struct RootView: View {
    @Environment(AppModel.self) private var app
    @State private var selection: Route?
    /// The register currently open in the detail column, rebuilt whenever the
    /// route changes so its paging and its running balance start fresh.
    @State private var register: RegisterModel?

    var body: some View {
        NavigationSplitView {
            sidebar
                .navigationSplitViewColumnWidth(min: 280, ideal: 340)
        } detail: {
            NavigationStack {
                detail
            }
        }
        .task { await app.load() }
        .onChange(of: selection) { _, route in
            rebuildRegister(for: route)
        }
    }

    // MARK: - Sidebar

    private var sidebar: some View {
        VStack(spacing: 0) {
            ReadOnlyBanner()
            content
        }
        .navigationTitle("MyMoney")
        .toolbar {
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
                        "Export a backup from your web app, then import it here. "
                        + "This app only ever reads it."
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
            AccountsView(summary: summary, selection: $selection, importLink: { importLink })
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
        case .none:
            placeholder
        case .allTransactions, .account:
            if let register {
                RegisterView(model: register)
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
        case .importBackup, .none:
            register = nil
        }
    }
}
