// The first thing anybody sees, and the screen this app did not have.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT WAS WRONG. Opening the app on a device with no book showed one sentence
// -- "Export a backup from your web app, then import it here" -- and one route,
// Import. That is the right shape for exactly one person on one day: the owner
// of the web app's ledger, moving it across. For everybody else, including that
// same owner on a second device, it is an app that will not start until you go
// and use a different app first. There was no path to a fresh book anywhere in
// the Swift code: no seed, no create, and an Add menu that stayed disabled
// while `hasBook` was false, so even finding the button led nowhere.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SHAPE: WELCOME -> BASE CURRENCY -> HOW TO START, and the third step
// offers three ways in AS EQUALS -- three rows of the same weight, one of them
// preselected, not one button and two apologies underneath it. "Add my
// accounts" is the preselected one because it is what most people opening a
// money app want, and because it is the only one of the three that lands in a
// book you can immediately do something with. It is a DEFAULT, not a verdict:
// the other two are one tap away and read exactly the same.
//
// WHY A SELECTION AND A CONTINUE RATHER THAN THREE BUTTONS. Three tappable
// cards would put the choice in the middle of the screen, which on a 6.9" phone
// is the band a thumb cannot reach without regripping -- and it would make the
// bottom third empty on the one screen where the whole point is getting
// started. So the three rows are a `Picker`-shaped list and the ACTION is a
// single full-width Continue in the bar at the bottom, measured like every
// other primary action in this app (see `ActionBar` and `Reach`).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT EACH PATH WRITES, WHICH IS THE PART THAT HAS TO BE RIGHT
//
//   * ADD MY ACCOUNTS -> `createBook(baseCurrency:startingAccounts:)`: the
//     settings row, the seeded categories and the ticked accounts in ONE
//     commit, exactly as src/ui/onboarding/setup.ts does it in the browser.
//     No half-created book to open the app into.
//   * START EMPTY -> the same call with no accounts. The accounts screen then
//     opens with "Add an account" as its primary action, in the bottom third.
//   * IMPORT A BACKUP -> WRITES NOTHING AT ALL, and that is deliberate. A
//     backup carries its own settings row, its own base currency and its own
//     `onboarded` flag; creating a book here first would only make rows the
//     import is about to replace, and would then have to be replaced with
//     `replacingExistingBook` -- a destructive path entered by somebody who
//     asked for a fresh start. The web app's onboarding refuses to write before
//     a restore for the same reason. So the import step pushes the ordinary
//     Import screen, and the book appears when the file is verified.
//
// AN OPENING BALANCE IS NEVER DEFAULTED TO ZERO. A blank field means zero and
// says so; text the money parser refuses BLOCKS the step and names the row,
// ported from `openingBalanceProblem` in AccountsStep.tsx. The opening balance
// is the one figure every future balance of an account is built on.
import MyMoneyKit
import SwiftUI

struct FirstRunView: View {

    /// The three ways in, as the third step lists them.
    enum StartChoice: String, CaseIterable, Identifiable {
        case addAccounts
        case importBackup
        case startEmpty

        var id: String { rawValue }

        var title: String {
            switch self {
            case .addAccounts: return "Add my accounts"
            case .importBackup: return "Import a backup"
            case .startEmpty: return "Start empty"
            }
        }

        var detail: String {
            switch self {
            case .addAccounts:
                return
                    "Pick the accounts you use, name them, and put in what each one holds today."
            case .importBackup:
                return
                    "Bring across a book you already have, from a backup file your web app "
                    + "exported."
            case .startEmpty:
                return "Straight in with nothing in it. Add accounts and payments as you go."
            }
        }

        var symbol: String {
            switch self {
            case .addAccounts: return "building.columns"
            case .importBackup: return "square.and.arrow.down"
            case .startEmpty: return "square.and.pencil"
            }
        }
    }

    enum Step: Int, CaseIterable {
        case welcome, currency, howToStart, accounts

        /// The accounts step exists only on the path that uses it, so the dots
        /// count three on every other one rather than promising a fourth that
        /// never arrives.
        static func count(for choice: StartChoice) -> Int {
            choice == .addAccounts ? 4 : 3
        }
    }

    @Environment(AppModel.self) private var app

    @State private var step: Step = .welcome
    @State private var currency: String = FirstRunView.currencyFromThisDevice()
    @State private var choice: StartChoice = .addAccounts
    @State private var rows: [StarterRow] = StarterRow.templates()
    @State private var refusal: EditRefusal?
    @State private var working = false
    /// The Import screen, pushed rather than replaced, so there is always a way
    /// back to the other two choices.
    @State private var path: [ImportDestination] = []

    /// A `Hashable` stand-in for "the import screen", so the push is a value
    /// rather than a boolean somebody has to keep in step with the stack.
    private struct ImportDestination: Hashable {}

    var body: some View {
        NavigationStack(path: $path) {
            ScrollView {
                VStack(alignment: .leading, spacing: 22) {
                    StepDots(index: step.rawValue, of: Step.count(for: choice))
                        .frame(maxWidth: .infinity)
                        .padding(.top, 8)
                    content
                    if let refusal {
                        RefusalNotice(refusal: refusal)
                    }
                }
                .padding(.horizontal, 20)
                .padding(.bottom, 24)
                .frame(maxWidth: 560, alignment: .leading)
                .frame(maxWidth: .infinity)
            }
            .navigationTitle(step == .welcome ? "" : "Set up")
            #if os(iOS)
                .navigationBarTitleDisplayMode(.inline)
            #endif
            .safeAreaInset(edge: .bottom) { bar }
            .toolbar {
                if step != .welcome {
                    // Back is top-left, where Cancel is everywhere else in this
                    // app: it is pressed rarely, and a swipe already does it.
                    ToolbarItem(placement: .cancellationAction) {
                        // Greyed only while the book is being written, which
                        // the bottom bar's own "Setting up…" already says.
                        Button("Back") { goBack() }
                            .disabled(working)
                            .accessibilityHint(working ? "Not while your book is being set up" : "")
                    }
                }
            }
            .navigationDestination(for: ImportDestination.self) { _ in
                // THE CURRENCY THIS SCREEN ALREADY ASKED FOR travels with the
                // push. A statement can now start a book on a device that has
                // none, and the base currency that book takes must be the one
                // chosen two steps ago rather than a second guess from the
                // locale -- asking twice, or ignoring the answer, would be the
                // app not listening.
                ImportView(newBookCurrency: currency)
            }
        }
        // A FILE THAT ARRIVES DURING FIRST RUN GOES STRAIGHT TO THE IMPORT
        // SCREEN. Somebody who taps Share on a backup in Mail before they have
        // set anything up has said what they want more clearly than any of
        // these three rows could ask; landing them on step one to choose it
        // again would be the app ignoring them. It still does not IMPORT on its
        // own -- the Import screen asks.
        .onChange(of: app.incoming?.id) { _, id in
            if id != nil, path.isEmpty { path = [ImportDestination()] }
        }
        .task {
            if app.incoming != nil, path.isEmpty { path = [ImportDestination()] }
            // A reach measurement, and nothing else, can ask to start at a
            // particular step. Nil unless MYMONEY_REACH=1 is set.
            //
            // AFTER A BEAT, and the beat is load-bearing rather than polite --
            // the same one `RootView.task` takes, found the same way. A probe
            // reports through a preference, and a preference only reports again
            // when its value CHANGES: swapping the step in the same turn the
            // view first appears replaces the bar before its first layout pass
            // has settled, so the only sample that ever arrives is the
            // pre-layout one (mid=4.0, fraction=0.004) and the run looks like a
            // button at the top of the screen. Letting the first layout finish
            // first produces the number the hand actually meets.
            if let asked = Reach.openingFirstRunStep {
                try? await Task.sleep(for: .milliseconds(600))
                step = asked
                if asked == .accounts { choice = .addAccounts }
            }
        }
    }

    // MARK: - The steps

    @ViewBuilder private var content: some View {
        switch step {
        case .welcome: welcome
        case .currency: currencyStep
        case .howToStart: howToStart
        case .accounts: accountsStep
        }
    }

    private var welcome: some View {
        VStack(alignment: .leading, spacing: 14) {
            // Not a pound sign: this screen is shown BEFORE the currency
            // question, to somebody whose money may well not be in pounds.
            Image(systemName: "banknote.fill")
                .font(.system(size: 44))
                .foregroundStyle(.tint)
                .accessibilityHidden(true)
            Text("MyMoney")
                .font(.largeTitle.weight(.bold))
            Text(
                "Your money, on this device. There is no account to make and no server to sign "
                    + "in to \u{2014} the book lives here, in this app, and nothing about it "
                    + "leaves the phone."
            )
            .font(.body)
            .fixedSize(horizontal: false, vertical: true)
            Text(
                "Two questions and you are in. You can change either answer afterwards."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var currencyStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Which currency are your totals in?")
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(
                "Net worth, budgets and reports are added up in this one. Individual accounts "
                    + "keep their own currency \u{2014} an account in another currency is "
                    + "converted only when it goes into a total."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            CurrencyChoice(currency: $currency)

            // THE GUESS IS ONLY CLAIMED WHILE IT IS STILL THE GUESS. Saying
            // "guessed from this device's region" under a currency somebody
            // has just chosen by hand is a small false statement, and this is
            // the screen that has only just promised that nothing about the
            // book leaves the phone -- the one place where being caught
            // narrating something the owner can see is untrue costs the most.
            // The half that is always true is the half about converting
            // nothing, so that is what is left when the guess is gone.
            Text(
                currency == FirstRunView.currencyFromThisDevice()
                    ? "Guessed from this device's region. You can change it later in Settings, "
                        + "and changing it converts nothing \u{2014} every amount stays the "
                        + "amount it is."
                    : "You can change this later in Settings, and changing it converts nothing "
                        + "\u{2014} every amount stays the amount it is."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var howToStart: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("How would you like to start?")
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)

            // THE THREE, AS EQUALS. Same row, same weight, same size; the only
            // difference is which one is selected when the screen opens.
            VStack(spacing: 10) {
                ForEach(StartChoice.allCases) { option in
                    ChoiceRow(
                        option: option,
                        isSelected: choice == option,
                        select: { choice = option }
                    )
                }
            }

            Text(
                choice == .importBackup
                    ? "Nothing is written until the file has been checked. Your web app is not "
                        + "touched either way."
                    : "Everything here can be added to, renamed or removed afterwards."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    private var accountsStep: some View {
        VStack(alignment: .leading, spacing: 14) {
            Text("Which accounts do you use?")
                .font(.title2.weight(.semibold))
                .fixedSize(horizontal: false, vertical: true)
            Text(
                "Untick what you do not have, rename anything, and put in what each one holds "
                    + "today. Leave a balance blank for zero."
            )
            .font(.callout)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)

            VStack(spacing: 10) {
                ForEach($rows) { $row in
                    StarterAccountRow(
                        row: $row,
                        currency: currency,
                        remove: rows.count > 1 ? { remove(row.id) } : nil
                    )
                }
            }

            Button {
                rows.append(StarterRow.blank())
            } label: {
                Label("Add another account", systemImage: "plus.circle")
            }
            .buttonStyle(.bordered)
            .controlSize(.large)

            Text(
                "Blank means zero, and a negative figure means money owed. These start in "
                    + "\(currency); an account that holds another currency can be changed to it "
                    + "straight afterwards \u{2014} the currency is only locked once the account "
                    + "has transactions in it."
            )
            .font(.footnote)
            .foregroundStyle(.secondary)
            .fixedSize(horizontal: false, vertical: true)
        }
    }

    // MARK: - The bar

    /// The one action of whichever step is showing, full width, at the bottom.
    private var bar: some View {
        ActionBar {
            // THE REASON LIVES WITH THE BUTTON IT IS DISABLING, and it is now
            // `PrimaryAction` that draws it -- one implementation for every bar
            // in the app rather than this screen's own copy. Stranded at the
            // top of a scrolling form it would be a question and its answer at
            // opposite ends of the screen.
            PrimaryAction(
                title: primaryTitle,
                systemImage: primarySymbol,
                disabledReason: working ? .working : blockingProblem.map { .because($0) },
                probe: probeName
            ) {
                advance()
            }
        }
    }

    private var primaryTitle: String {
        switch step {
        case .welcome: return "Get started"
        case .currency: return "Continue"
        case .howToStart:
            switch choice {
            case .addAccounts: return "Continue"
            case .importBackup: return "Choose a backup"
            case .startEmpty: return working ? "Setting up\u{2026}" : "Start"
            }
        case .accounts: return working ? "Setting up\u{2026}" : "Create my book"
        }
    }

    private var primarySymbol: String? {
        switch step {
        case .welcome: return nil
        case .currency: return nil
        case .howToStart: return choice == .importBackup ? "square.and.arrow.down" : nil
        case .accounts: return "checkmark"
        }
    }

    /// One probe name per screen, so a sweep can measure each of them without
    /// hands. See `Reach`.
    private var probeName: String {
        switch step {
        case .welcome: return "First run \u{2014} Get started"
        case .currency: return "First run \u{2014} Base currency continue"
        case .howToStart: return "First run \u{2014} How to start continue"
        case .accounts: return "First run \u{2014} Create my book"
        }
    }

    /// Why the step cannot go on yet, in a sentence, or nil.
    ///
    /// Ported from `accountsStepError` in AccountsStep.tsx, including the order
    /// it asks the questions in, so the phone refuses what the browser refuses.
    private var blockingProblem: String? {
        switch step {
        case .welcome:
            return nil
        case .currency:
            return CurrencyCode.normalised(currency) == nil
                ? "A currency is three letters, like GBP or EUR." : nil
        case .howToStart:
            return nil
        case .accounts:
            let ticked = rows.filter(\.ticked)
            if ticked.isEmpty { return "Tick at least one account, or go back and start empty." }
            if ticked.contains(where: { Names.isBlank($0.name) }) {
                return "Give every ticked account a name."
            }
            for row in ticked where row.openingMinor(currency: currency) == nil {
                let name = row.name.trimmingCharacters(in: .whitespaces)
                return
                    "\u{201C}\(row.openingText)\u{201D} is not an amount \(currency) can hold, so "
                    + "\(name) cannot be created yet."
            }
            return nil
        }
    }

    // MARK: - Moving

    private func advance() {
        refusal = nil
        switch step {
        case .welcome:
            step = .currency
        case .currency:
            step = .howToStart
        case .howToStart:
            switch choice {
            case .addAccounts:
                step = .accounts
            case .importBackup:
                // NOTHING IS WRITTEN. See the header: the file carries its own
                // settings row, and a book made here first would only be a book
                // the import has to replace.
                path = [ImportDestination()]
            case .startEmpty:
                create(accounts: [])
            }
        case .accounts:
            create(accounts: rows.compactMap { $0.draft(currency: currency, in: rows) })
        }
    }

    private func goBack() {
        switch step {
        case .welcome: break
        case .currency: step = .welcome
        case .howToStart: step = .currency
        case .accounts: step = .howToStart
        }
    }

    private func remove(_ id: String) {
        rows.removeAll { $0.id == id }
    }

    /// Write the book. One call, one commit; on success this whole view goes
    /// away because `app.phase` stops being `.empty`.
    private func create(accounts: [AccountDraft]) {
        guard !working else { return }
        working = true
        Task {
            let outcome = await app.createBook(
                baseCurrency: currency, startingAccounts: accounts
            )
            working = false
            // A refusal keeps the screen exactly as it is, with both of the
            // store's sentences: what was wrong, and what was NOT changed.
            refusal = outcome.refusal
        }
    }

    // MARK: - The default currency

    /// What this device's region suggests, when it suggests something usable.
    ///
    /// A GUESS, AND LABELLED AS ONE on the screen. GBP is the fallback rather
    /// than an empty picker: an empty answer to "which currency" is not a
    /// better guess, it is the same guess with an extra tap. `Locale` can hand
    /// back a code that is not three ASCII letters, so it goes through the same
    /// validation the store uses.
    static func currencyFromThisDevice() -> String {
        let suggested = Locale.current.currency?.identifier ?? ""
        return CurrencyCode.normalised(suggested) ?? "GBP"
    }
}

// MARK: - One starter account, as the screen holds it

/// A row of the accounts step.
///
/// THE OPENING BALANCE IS HELD AS THE TEXT THAT WAS TYPED, not as parsed minor
/// units, and that is the same decision AccountsStep.tsx documents: an
/// `Int64?` could not tell "left blank" (which means zero) from "typed
/// something the parser refused" (which must block), so a refused amount would
/// be stored as zero while the owner's text sat on screen above it -- under the
/// one figure every future balance of that account is built on.
struct StarterRow: Identifiable, Equatable {
    let id: String
    var ticked: Bool
    var name: String
    var type: AccountType
    var openingText: String

    static func templates() -> [StarterRow] {
        StarterBook.accountTemplates.map { template in
            StarterRow(
                id: "template:\(template.id)",
                ticked: true,
                name: template.name,
                type: template.type,
                openingText: ""
            )
        }
    }

    static func blank() -> StarterRow {
        StarterRow(
            id: "added:\(UUID().uuidString)", ticked: true, name: "", type: .current,
            openingText: ""
        )
    }

    /// The opening balance this row will create, or nil when the text cannot be
    /// read as an amount. Blank is zero.
    func openingMinor(currency: String) -> Int64? {
        let trimmed = openingText.trimmingCharacters(in: .whitespaces)
        if trimmed.isEmpty { return 0 }
        return Money.parseToMinor(trimmed, currency: currency)
    }

    /// This row as the store takes it, or nil when it is unticked.
    ///
    /// The sort order is this row's position among the TICKED rows, so the
    /// accounts screen lists them in the order they were agreed to rather than
    /// with gaps where an unticked template was.
    ///
    /// THE COLOUR FOLLOWS THE TYPE, through `StarterBook.colour(for:)` -- the
    /// same values seed.ts gives, so a Savings account created on the phone is
    /// the colour a Savings account created in the browser is. Changing a
    /// template row's type therefore changes its colour with it, rather than
    /// leaving a credit card wearing the current account's blue.
    func draft(currency: String, in all: [StarterRow]) -> AccountDraft? {
        guard ticked, let opening = openingMinor(currency: currency) else { return nil }
        let order = all.filter(\.ticked).firstIndex(where: { $0.id == id }) ?? 0
        return AccountDraft(
            name: name,
            type: type,
            currency: currency,
            openingBalanceMinor: opening,
            colour: StarterBook.colour(for: type),
            sortOrder: order
        )
    }
}

// MARK: - Pieces

/// How far along, without claiming a step that will not happen.
private struct StepDots: View {
    let index: Int
    let of: Int

    var body: some View {
        HStack(spacing: 6) {
            ForEach(0..<of, id: \.self) { i in
                Capsule()
                    .fill(i == index ? AnyShapeStyle(.tint) : AnyShapeStyle(.quaternary))
                    .frame(width: i == index ? 20 : 6, height: 6)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("Step \(index + 1) of \(of)")
    }
}

/// One of the three ways in.
///
/// A ROW, NOT A BUTTON THAT ACTS. Tapping selects; the bar at the bottom acts.
/// That is what lets all three read as equals and still leaves the screen with
/// one primary action, in the place a thumb reaches.
private struct ChoiceRow: View {
    let option: FirstRunView.StartChoice
    let isSelected: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(alignment: .top, spacing: 12) {
                Image(systemName: option.symbol)
                    .font(.title3)
                    .frame(width: 28)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.secondary))
                    .accessibilityHidden(true)
                VStack(alignment: .leading, spacing: 3) {
                    Text(option.title)
                        .font(.body.weight(.semibold))
                        .foregroundStyle(.primary)
                    Text(option.detail)
                        .font(.footnote)
                        .foregroundStyle(.secondary)
                        .fixedSize(horizontal: false, vertical: true)
                        .multilineTextAlignment(.leading)
                }
                Spacer(minLength: 8)
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.tertiary))
                    .accessibilityHidden(true)
            }
            .padding(14)
            .frame(maxWidth: .infinity, alignment: .leading)
            .background(
                RoundedRectangle(cornerRadius: 14)
                    .fill(
                        isSelected
                            ? AnyShapeStyle(.tint.opacity(0.10))
                            : AnyShapeStyle(.quaternary.opacity(0.25))
                    )
            )
            .overlay(
                RoundedRectangle(cornerRadius: 14)
                    .strokeBorder(
                        isSelected ? AnyShapeStyle(.tint) : AnyShapeStyle(.clear), lineWidth: 1.5
                    )
            )
            .contentShape(RoundedRectangle(cornerRadius: 14))
        }
        .buttonStyle(.plain)
        .accessibilityElement(children: .combine)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }
}

/// The base currency, as a menu of the codes the web app offers plus anything
/// else that can be typed.
///
/// THE LIST IS NOT A LIMIT. `COMMON_CURRENCIES` is what a picker shows first;
/// the store accepts any three-letter code, so the field underneath takes one
/// the list does not have rather than making somebody's currency unavailable
/// because it did not make a top-45.
struct CurrencyChoice: View {
    @Binding var currency: String
    @State private var typing = false

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            if typing {
                TextField("Currency code, e.g. GBP", text: $currency)
                    .textFieldStyle(.roundedBorder)
                    .font(.body.monospaced())
                    #if os(iOS)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                    #endif
                Button("Choose from the list instead") {
                    typing = false
                    if CurrencyCode.normalised(currency) == nil { currency = "GBP" }
                }
                .font(.footnote)
            } else {
                Picker("Base currency", selection: $currency) {
                    ForEach(options, id: \.self) { code in
                        Text(Self.label(code)).tag(code)
                    }
                }
                .pickerStyle(.menu)
                .padding(.vertical, 4)
                Button("Use a currency that is not listed") { typing = true }
                    .font(.footnote)
            }
        }
    }

    /// The common list, with whatever is currently chosen kept in it -- a
    /// picker whose selection is not one of its own rows shows nothing at all.
    private var options: [String] {
        StarterBook.commonCurrencies.contains(currency)
            ? StarterBook.commonCurrencies
            : [currency] + StarterBook.commonCurrencies
    }

    /// "GBP — British Pound", when this device can name the currency.
    static func label(_ code: String) -> String {
        guard let name = Locale.current.localizedString(forCurrencyCode: code), name != code
        else { return code }
        return "\(code) \u{2014} \(name)"
    }
}

/// One editable starter account.
///
/// THREE ROWS, NOT ONE, and that is a bug fix rather than a preference. The
/// type picker, the word "Holds" and the amount field started life side by
/// side; at the default text size on a 6.9" phone the picker's own label
/// ("Current account", "Credit card") wrapped onto a second line, and the
/// caption underneath was drawn straight through it. A menu label's width is
/// not something this layout gets to assume -- it is the localised name of
/// whichever type is chosen, at whatever Dynamic Type size the reader uses --
/// so nothing here is asked to share a line with it.
private struct StarterAccountRow: View {
    @Binding var row: StarterRow
    let currency: String
    /// nil on the last remaining row: a list you can empty is a list you can
    /// get stuck in.
    let remove: (() -> Void)?

    private var opening: Int64? { row.openingMinor(currency: currency) }

    var body: some View {
        VStack(alignment: .leading, spacing: 10) {
            HStack(spacing: 10) {
                Toggle(isOn: $row.ticked) {
                    Text(row.name.isEmpty ? "New account" : row.name)
                }
                .toggleStyle(.switch)
                .labelsHidden()
                .accessibilityLabel(
                    "Include \(row.name.isEmpty ? "this new account" : row.name)"
                )

                TextField("Name", text: $row.name)
                    .textFieldStyle(.roundedBorder)

                if let remove {
                    Button(role: .destructive, action: remove) {
                        Image(systemName: "minus.circle")
                    }
                    .buttonStyle(.borderless)
                    .accessibilityLabel("Remove this row")
                }
            }

            if row.ticked {
                HStack {
                    Text("Type")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    Picker("Type", selection: $row.type) {
                        ForEach(AccountType.allCases, id: \.self) { type in
                            Text(StarterBook.label(for: type)).tag(type)
                        }
                    }
                    .pickerStyle(.menu)
                    .labelsHidden()
                }

                HStack {
                    Text("Holds today")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                    Spacer(minLength: 8)
                    TextField("0", text: $row.openingText)
                        .multilineTextAlignment(.trailing)
                        .monospacedDigit()
                        .frame(maxWidth: 150)
                        .textFieldStyle(.roundedBorder)
                        #if os(iOS)
                            .keyboardType(.numbersAndPunctuation)
                        #endif
                        .accessibilityLabel(
                            "Opening balance for \(row.name.isEmpty ? "this account" : row.name)"
                        )
                }

                // WHAT THE APP READ, BACK IN THE APP'S OWN WORDS, and only when
                // there is something to say. The same confirmation the account
                // editor gives: an opening balance is the one figure every
                // later balance is built on, so the reader sees the parse
                // rather than trusting it. A blank field says nothing here --
                // the step's own footer already explains that blank is zero,
                // and repeating it under four rows is four lines of furniture.
                if let opening, !row.openingText.isEmpty {
                    Text(Display.money(opening, currency))
                        .font(.footnote)
                        .foregroundStyle(amountColour(opening))
                        .frame(maxWidth: .infinity, alignment: .trailing)
                } else if opening == nil {
                    Text("Not an amount \(currency) can hold.")
                        .font(.footnote)
                        .foregroundStyle(.orange)
                        .frame(maxWidth: .infinity, alignment: .trailing)
                }
            }
        }
        .padding(12)
        .background(
            RoundedRectangle(cornerRadius: 12).fill(.quaternary.opacity(row.ticked ? 0.25 : 0.12))
        )
        .opacity(row.ticked ? 1 : 0.65)
    }
}

// MARK: - Shared validation

/// The app-side half of what the store already checks.
///
/// IT DOES NOT REPLACE THE STORE'S CHECK, it anticipates it. `createBook` and
/// `saveAccount` both refuse a code that is not three letters, and that refusal
/// is what actually protects the book; this exists so the screen can grey the
/// button and say why BEFORE the tap, because a refusal you could have been
/// warned about reads as a bug.
///
/// Named differently from the kit's own `Validate` on purpose: two types with
/// one name, one of them authoritative and one of them a courtesy, is how a
/// later edit ends up trusting the wrong one.
enum CurrencyCode {
    /// The normalised code, or nil when it is not three ASCII letters. The same
    /// rule as `Validate.isCurrencyCode` in the kit, which is the one that
    /// counts.
    static func normalised(_ input: String) -> String? {
        let code = input.trimmingCharacters(in: .whitespacesAndNewlines).uppercased()
        let scalars = Array(code.unicodeScalars)
        guard scalars.count == 3, scalars.allSatisfy({ ("A"..."Z").contains($0) }) else {
            return nil
        }
        return code
    }
}
