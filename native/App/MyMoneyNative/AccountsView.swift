// Accounts and net worth: the screen that has to be right.
//
// IT IS LAID OUT THE WAY THE WEB APP'S SIDEBAR IS LAID OUT, because it is the
// same book and the owner already knows where things are: net worth on top,
// then the groups in their own sort order, each account with its real balance
// in its own currency, ungrouped accounts last under "Other accounts".
//
// THE THREE RULES ABOUT WHAT COUNTS, all visible on this screen:
//
//   * A BALANCE IS NEVER CONVERTED. Each account shows its own money in its own
//     currency. Only the TOTAL is converted, once per currency, by
//     `Balances.netWorth`.
//   * EXCLUDED IS NOT HIDDEN. An account the owner has flagged out of net worth
//     appears here with its real balance and the words "Not counted". You must
//     never be unable to find your own money.
//   * ARCHIVED IS NOT DELETED. Archived accounts are out of the total and out
//     of the main list -- as they are in the web app's sidebar -- but they are
//     one tap away in their own section, with their balances, rather than gone.
//
// And when a currency has no rate, the headline says so instead of quietly
// leaving an account out of a number that looks complete.
//
// THE EDITING AFFORDANCES ARE SWIPES AND A LONG-PRESS MENU, deliberately, so
// that the list still reads as a list of balances rather than as a form. Every
// one of them is reversible in a tap: archive un-archives, "not counted" counts
// again, and moving a row up moves it back down. None of them can change an
// amount -- the only thing on this screen that can is the account editor's
// opening balance, which is a field with a confirmation of what it read.
import MyMoneyKit
import SwiftUI

struct AccountsView<ImportLink: View>: View {
    @Environment(AppModel.self) private var app

    let summary: LedgerSummary
    @Binding var selection: Route?
    /// The import row, handed in by the shell so every route in this list is a
    /// `NavigationLink` of the same kind. See RootView's header for why that
    /// matters on a phone.
    @ViewBuilder let importLink: () -> ImportLink
    /// Editing is owned by the shell, which holds the sheet.
    let onEditAccount: (AccountBalance) -> Void
    let onAddAccount: () -> Void

    @State private var refusal: EditRefusal?

    private var netWorth: NetWorth { summary.snapshot.netWorth }

    /// Visible (non-archived) accounts, grouped and ordered exactly as the web
    /// app's sidebar groups and orders them: groups in `sortOrder`, then the
    /// ungrouped ones, and within a group by the account's own sort order.
    ///
    /// `Balances.accountBalances` has already sorted the accounts, so this only
    /// buckets them -- one ordering rule, in the kit, held to the oracle.
    private var sections: [(id: String, name: String, rows: [AccountBalance])] {
        let visible = summary.snapshot.balances.filter { !$0.account.archived }
        var byGroup: [String: [AccountBalance]] = [:]
        var ungrouped: [AccountBalance] = []
        for row in visible {
            if let groupId = row.account.groupId, !groupId.isEmpty {
                byGroup[groupId, default: []].append(row)
            } else {
                ungrouped.append(row)
            }
        }
        var out = summary.snapshot.groups.compactMap { group -> (String, String, [AccountBalance])? in
            guard let rows = byGroup[group.id], !rows.isEmpty else { return nil }
            return (group.id, group.name, rows)
        }
        // An account whose groupId names a group that is not in the book is not
        // lost: it falls in with the ungrouped ones rather than vanishing.
        let orphaned = byGroup
            .filter { key, _ in !summary.snapshot.groups.contains { $0.id == key } }
            .flatMap(\.value)
            .sorted { ($0.account.sortOrder, $0.account.name) < ($1.account.sortOrder, $1.account.name) }
        let rest = ungrouped + orphaned
        if !rest.isEmpty {
            out.append(
                ("__ungrouped", summary.snapshot.groups.isEmpty ? "Accounts" : "Other accounts", rest)
            )
        }
        return out.map { (id: $0.0, name: $0.1, rows: $0.2) }
    }

    private var archived: [AccountBalance] {
        summary.snapshot.balances.filter(\.account.archived)
    }

    var body: some View {
        List(selection: $selection) {
            Section {
                netWorthHeadline
            }

            // THE THREE SCREENS THAT ANSWER A QUESTION, above the one that
            // answers "what happened". Somebody opening this app daily wants
            // "how am I doing" first and the register second; the accounts and
            // their balances stay below, where they were.
            Section {
                NavigationLink(value: Route.dashboard) {
                    Label("Dashboard", systemImage: "square.grid.2x2")
                }
                NavigationLink(value: Route.budgets) {
                    Label("Budgets", systemImage: "chart.pie")
                }
                NavigationLink(value: Route.reports) {
                    Label("Reports", systemImage: "chart.xyaxis.line")
                }
                // The one screen that says something the owner did not ask for.
                // It sits with the other three because it answers the same kind
                // of question -- "how am I doing" -- and not with the register,
                // which answers "what happened".
                NavigationLink(value: Route.insights) {
                    Label("Recurring & insights", systemImage: "arrow.trianglehead.2.clockwise")
                }
            }

            Section {
                NavigationLink(value: Route.allTransactions) {
                    HStack {
                        Label("All transactions", systemImage: "list.bullet")
                        Spacer()
                        Text(Display.grouped(summary.transactionCount))
                            .monospacedDigit()
                            .foregroundStyle(.secondary)
                    }
                }
                .accessibilityLabel(
                    "All transactions, \(Display.count(summary.transactionCount, "transaction"))"
                )
            }

            if let refusal {
                Section { RefusalNotice(refusal: refusal) }
            }

            ForEach(sections, id: \.id) { section in
                Section(section.name) {
                    ForEach(section.rows, id: \.account.id) { row in
                        NavigationLink(value: Route.account(row.account.id)) {
                            AccountRow(balance: row)
                        }
                        .modifier(AccountActions(balance: row, edit: onEditAccount, refusal: $refusal))
                    }
                }
            }

            if !archived.isEmpty {
                Section {
                    ForEach(archived, id: \.account.id) { row in
                        NavigationLink(value: Route.account(row.account.id)) {
                            AccountRow(balance: row, archived: true)
                        }
                        .modifier(AccountActions(balance: row, edit: onEditAccount, refusal: $refusal))
                    }
                } header: {
                    Text("Archived")
                } footer: {
                    Text(
                        "Archived accounts keep every transaction and their real balance. "
                            + "They are not part of the net-worth total."
                    )
                }
            }

            Section {
                Button(action: onAddAccount) {
                    Label("Add an account\u{2026}", systemImage: "plus.circle")
                }
                NavigationLink(value: Route.groups) {
                    Label("Account groups\u{2026}", systemImage: "folder")
                }
            } footer: {
                Text(
                    "Swipe an account for archive, \u{201C}\(Display.notCountedLabel)\u{201D} and "
                        + "reordering. Both of those change what your totals COUNT and never what "
                        + "is shown \u{2014} the account stays on this list with its real balance."
                )
            }

            Section {
                importLink()
            }

            Section {
                ProvenanceFooter(summary: summary)
            }
        }
        .listStyle(.sidebar)
        .navigationTitle("Accounts")
    }

    private var netWorthHeadline: some View {
        VStack(alignment: .leading, spacing: 6) {
            Text("Net worth")
                .font(.subheadline)
                .foregroundStyle(.secondary)
                .textCase(.uppercase)

            Text(Display.money(netWorth.totalBaseMinor, netWorth.baseCurrency))
                .font(.system(.largeTitle, design: .default).weight(.semibold))
                .monospacedDigit()
                .foregroundStyle(amountColour(netWorth.totalBaseMinor))
                .lineLimit(2)
                .minimumScaleFactor(0.6)
                .accessibilityLabel("Net worth")
                .accessibilityValue(
                    Display.moneySpoken(netWorth.totalBaseMinor, netWorth.baseCurrency)
                )

            if !netWorth.missingRateCurrencies.isEmpty {
                // Not a footnote: this figure is INCOMPLETE and the owner has to
                // know which currencies are missing from it.
                Label(
                    "Excludes \(netWorth.missingRateCurrencies.joined(separator: ", ")) "
                        + "\u{2014} no exchange rate set",
                    systemImage: "exclamationmark.triangle"
                )
                .font(.footnote)
                .foregroundStyle(.orange)
                .fixedSize(horizontal: false, vertical: true)
            }

            if let line = Display.notCountedSummary(
                count: netWorth.excludedCount,
                baseMinor: netWorth.excludedBaseMinor,
                baseCurrency: netWorth.baseCurrency
            ) {
                Text(line)
                    .font(.footnote)
                    .foregroundStyle(
                        netWorth.excludedBaseMinor == nil ? Color.orange : Color.secondary
                    )
                    .fixedSize(horizontal: false, vertical: true)
            }

            Text(
                "\(Display.count(summary.accountCount, "account")) \u{00B7} "
                    + "\(Display.count(summary.transactionCount, "transaction"))"
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
        }
        .padding(.vertical, 4)
    }
}

private struct AccountRow: View {
    let balance: AccountBalance
    var archived = false

    private var account: Account { balance.account }

    /// Everything a screen reader needs about this row, in one sentence, in the
    /// order it matters: which account, what it holds, and why it might not be
    /// in the total.
    private var spokenLabel: String {
        var parts = [account.name]
        parts.append(Display.moneySpoken(balance.balanceMinor, account.currency))
        if balance.excludedFromNetWorth { parts.append("not counted in net worth") }
        if archived { parts.append("archived") }
        parts.append(Display.count(balance.txCount, "transaction"))
        return parts.joined(separator: ", ")
    }

    var body: some View {
        ViewThatFits(in: .horizontal) {
            HStack(spacing: 10) {
                AccountDot(hex: account.colour)
                names
                Spacer(minLength: 12)
                amount
            }
            VStack(alignment: .leading, spacing: 4) {
                HStack(spacing: 10) {
                    AccountDot(hex: account.colour)
                    names
                }
                amount
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(spokenLabel)
        .accessibilityHint("Opens this account\u{2019}s transactions")
    }

    private var names: some View {
        VStack(alignment: .leading, spacing: 1) {
            Text(account.name)
                // Muted, never faded: the name of an account you still own has
                // to stay readable.
                .foregroundStyle(balance.excludedFromNetWorth || archived ? .secondary : .primary)
                .lineLimit(2)
            if balance.excludedFromNetWorth {
                Text(Display.notCountedLabel)
                    .font(.caption2)
                    .foregroundStyle(.tertiary)
            }
        }
    }

    private var amount: some View {
        Text(Display.money(balance.balanceMinor, account.currency))
            .monospacedDigit()
            .font(.callout)
            .foregroundStyle(amountColour(balance.balanceMinor))
            .lineLimit(1)
            .minimumScaleFactor(0.7)
    }
}

/// The swipe actions and context menu on an account row.
///
/// A MODIFIER RATHER THAN CODE IN TWO PLACES, because the visible list and the
/// archived list both need exactly these and a copy of them would drift. Every
/// action here writes ONE column through the store, and every one of them is
/// undone by doing it again.
private struct AccountActions: ViewModifier {
    @Environment(AppModel.self) private var app
    let balance: AccountBalance
    let edit: (AccountBalance) -> Void
    @Binding var refusal: EditRefusal?

    private var account: Account { balance.account }

    func body(content: Content) -> some View {
        content
            .swipeActions(edge: .trailing) {
                Button {
                    edit(balance)
                } label: {
                    Label("Edit", systemImage: "pencil")
                }
                .tint(.blue)
                Button {
                    run { await app.setAccountArchived(id: account.id, archived: !account.archived) }
                } label: {
                    Label(
                        account.archived ? "Unarchive" : "Archive",
                        systemImage: account.archived ? "tray.and.arrow.up" : "archivebox"
                    )
                }
                .tint(.orange)
            }
            .swipeActions(edge: .leading) {
                Button {
                    run { await app.reorderAccount(id: account.id, .up) }
                } label: {
                    Label("Move up", systemImage: "arrow.up")
                }
                .tint(.indigo)
                Button {
                    run { await app.reorderAccount(id: account.id, .down) }
                } label: {
                    Label("Move down", systemImage: "arrow.down")
                }
                .tint(.indigo)
            }
            .contextMenu {
                Button { edit(balance) } label: { Label("Edit account\u{2026}", systemImage: "pencil") }
                Button {
                    run {
                        await app.setAccountExcluded(
                            id: account.id, excluded: !(account.excludeFromNetWorth == true)
                        )
                    }
                } label: {
                    Label(
                        balance.excludedFromNetWorth
                            ? "Count in net worth" : "Don\u{2019}t count in net worth",
                        systemImage: balance.excludedFromNetWorth ? "sum" : "minus.circle"
                    )
                }
                Button {
                    run { await app.setAccountArchived(id: account.id, archived: !account.archived) }
                } label: {
                    Label(
                        account.archived ? "Unarchive" : "Archive",
                        systemImage: account.archived ? "tray.and.arrow.up" : "archivebox"
                    )
                }
            }
    }

    /// `@MainActor` so the `Task` it spawns inherits the main actor: `refusal`
    /// is `@State`, and a write to it from the generic executor compiles
    /// silently and is not reliably seen -- see `RootView.loadContext`.
    @MainActor private func run(_ body: @escaping () async -> EditOutcome) {
        Task { refusal = (await body()).refusal }
    }
}

/// Where this copy came from, and when. Quiet, and at the bottom, but present:
/// a shadow copy that will not say which file it is a copy of is a screen full
/// of numbers with no provenance.
private struct ProvenanceFooter: View {
    let summary: LedgerSummary

    var body: some View {
        VStack(alignment: .leading, spacing: 6) {
            if let exportedAt = summary.provenance.exportedAt {
                FigureRow(label: "Backup taken", value: Display.timestampText(exportedAt))
            }
            if let importedAt = summary.provenance.importedAt {
                FigureRow(label: "Copied to this device", value: Display.timestampText(importedAt))
            }
            if let hash = summary.provenance.contentHash {
                FigureRow(
                    label: "File fingerprint",
                    value: String(hash.prefix(12)),
                    spoken: "SHA 256, beginning \(hash.prefix(12).map(String.init).joined(separator: " "))"
                )
            }
            // WHAT THIS COPY HAS THAT THE FILE DID NOT. The banner at the top
            // carries the headline; this is the detail, beside the provenance
            // it is a departure from.
            if summary.localEdits.hasDiverged {
                FigureRow(
                    label: "Changed here since",
                    value: summary.localEdits.firstAt.map(Display.timestampText) ?? "\u{2014}"
                )
                FigureRow(
                    label: "Changes not in your web app",
                    value: Display.grouped(summary.localEdits.count),
                    emphasised: true
                )
            }
        }
        .font(.footnote)
        .padding(.vertical, 2)
    }
}
