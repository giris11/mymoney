// "Add a four pound coffee" -- entering a transaction without opening the app.
//
// ─────────────────────────────────────────────────────────────────────────────
// THERE IS NO SECOND WRITE PATH, AND THAT IS THE WHOLE DESIGN OF THIS FILE
//
// An intent runs in the background, with no screen, often when the app was not
// even running. That is exactly the situation in which a shortcut would be
// taken -- "just write the row, the UI's validation is for the UI" -- and it is
// exactly the situation in which nobody would ever see the consequence.
//
// So every intent here goes through `LedgerService`, which is the same actor
// the Quick Add sheet goes through, which calls `LedgerStore.saveTransaction`,
// which validates and counts the local edit inside one transaction. If a
// spoken entry can create a bad row, so can the button -- and the button has
// 536 tests looking at it.
//
// THE INTENTS LIVE IN THE APP TARGET, not in an App Intents extension, for the
// same reason: an extension is a separate process, and a separate process with
// its own copy of the store would be a second writer to one SQLite file. In the
// app target the system launches the app in the background and runs the intent
// inside it, so there is one process, one store, one lock.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IT CAN AND CANNOT DO IN ONE SENTENCE
//
// An App Shortcut phrase carries at most ONE parameter. So "Add a four pound
// expense to MyMoney" works in a single breath -- the amount is in the phrase,
// and everything else falls back to the same defaults Quick Add opens with (the
// account last written to; the category the payee is usually filed under). To
// say the payee in the same breath, the owner builds a shortcut in the
// Shortcuts app with both boxes filled in, which is one setup and then one
// phrase for ever. That is stated here rather than claimed away.
//
// AND IT SAYS WHAT IT DID. `QuickEntry.spokenConfirmation` names the ACCOUNT
// every time, because landing in the wrong account is the one mistake a spoken
// entry can make that nobody is looking at a screen to catch.
import AppIntents
import Foundation
import MyMoneyKit

// MARK: - The things a shortcut can pick

/// An account, as the Shortcuts app offers it.
struct AccountEntity: AppEntity, Identifiable {
    let id: String
    let name: String
    let currency: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Account" }

    var displayRepresentation: DisplayRepresentation {
        DisplayRepresentation(title: "\(name)", subtitle: "\(currency)")
    }

    // COMPUTED, not a stored static. A stored `static var` is shared mutable
    // state that Swift 6 refuses in a concurrent world, and a query object has
    // nothing worth keeping between uses.
    static var defaultQuery: AccountQuery { AccountQuery() }
}

struct AccountQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [AccountEntity] {
        try await all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [AccountEntity] { try await all() }

    private func all() async throws -> [AccountEntity] {
        // ARCHIVED ACCOUNTS ARE OFFERED, last, exactly as they are in every
        // other picker in this app: an archived account can still take a
        // correction, and a picker that hid it would leave the owner unable to
        // fix history.
        try await IntentServices.shared.service.intentContext().accounts.map {
            AccountEntity(id: $0.id, name: $0.name, currency: $0.currency)
        }
    }
}

/// A category, offered by its full path so "Rail" and "Railcards" are told
/// apart in the list rather than in the owner's head.
struct CategoryEntity: AppEntity, Identifiable {
    let id: String
    let path: String

    static var typeDisplayRepresentation: TypeDisplayRepresentation { "Category" }

    var displayRepresentation: DisplayRepresentation { DisplayRepresentation(title: "\(path)") }

    static var defaultQuery: CategoryQuery { CategoryQuery() }
}

struct CategoryQuery: EntityQuery {
    func entities(for identifiers: [String]) async throws -> [CategoryEntity] {
        try await all().filter { identifiers.contains($0.id) }
    }

    func suggestedEntities() async throws -> [CategoryEntity] { try await all() }

    private func all() async throws -> [CategoryEntity] {
        try await IntentServices.shared.service.intentContext().categories
            .filter { !$0.archived }
            .map { CategoryEntity(id: $0.id, path: $0.path) }
    }
}

// MARK: - Adding an expense

struct AddExpenseIntent: AppIntent {
    static var title: LocalizedStringResource { "Add an expense" }

    static var description: IntentDescription {
        // ONE STRING LITERAL, and it has to be. `appintentsmetadataprocessor`
        // extracts these at build time and refuses anything it cannot read
        // statically -- a concatenation, or a `LocalizedStringResource` built
        // from a variable, fails the build rather than shipping an intent with
        // no description. A multi-line literal is still a literal.
        IntentDescription(
            """
            Adds a payment to the copy of your book on this device. Your web app is not changed \
            \u{2014} it is still the real ledger, and MyMoney counts this as one more change it \
            has that your web app does not.
            """,
            categoryName: "Money"
        )
    }

    /// RUNS WITHOUT OPENING THE APP. The point of the feature: the coffee is
    /// entered while the phone is still in a pocket.
    static var openAppWhenRun: Bool { false }

    /// A `Double`, because that is the type the system hands over for a spoken
    /// number and there is no way to ask iOS for minor units. It is converted
    /// EXACTLY or refused -- see `QuickEntry.minorUnits(spokenAmount:currency:)`,
    /// which is the only place in this project a Double gets near money.
    @Parameter(
        title: "Amount",
        description: "How much was spent, in the account's own currency.",
        requestValueDialog: "How much?"
    )
    var amount: Double

    @Parameter(title: "Payee", description: "Who it was paid to. Optional.")
    var payee: String?

    @Parameter(title: "Category", description: "Optional. Left off if not given.")
    var category: CategoryEntity?

    @Parameter(title: "Account", description: "Optional. Defaults to the one you used last.")
    var account: AccountEntity?

    @Parameter(title: "Note", description: "Optional.")
    var note: String?

    static var parameterSummary: some ParameterSummary {
        Summary("Add a \(\.$amount) expense") {
            \.$payee
            \.$category
            \.$account
            \.$note
        }
    }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let services = IntentServices.shared
        let context: QuickAddContext
        do {
            context = try await services.service.intentContext()
        } catch {
            throw AppLedgerError.noBook
        }

        // WHICH ACCOUNT. The one named, else the one Quick Add would have
        // opened on -- the account last written to. There is no third answer:
        // an entry with nowhere to go is refused rather than parked somewhere.
        let target: Account
        if let chosen = account, let match = context.accounts.first(where: { $0.id == chosen.id }) {
            target = match
        } else if let fallback = context.defaultAccount {
            target = fallback
        } else {
            throw AppLedgerError.noBook
        }

        guard let minor = QuickEntry.minorUnits(spokenAmount: amount, currency: target.currency),
            minor != 0
        else {
            throw AppLedgerError.badAmount(
                QuickEntry.amountRefusal(amount, currency: target.currency)
            )
        }

        let payeeName = payee.map { Names.clean($0) } ?? ""

        // THE CATEGORY THE PAYEE IS USUALLY FILED UNDER, when none was given.
        // The same learned default the Quick Add sheet fills in when you choose
        // a payee -- so a coffee entered by voice lands where a coffee entered
        // by hand lands.
        let categoryId =
            category?.id
            ?? context.payees.exactMatch(payeeName)?.defaultCategoryId

        let draft = QuickEntry.expenseDraft(
            accountId: target.id,
            date: todayISO(),
            amountMinor: minor,
            payeeName: payeeName,
            categoryId: categoryId,
            notes: note.map { Names.clean($0) } ?? ""
        )

        do {
            _ = try await services.service.save(draft)
        } catch let error as EditError {
            // The store's own refusal, in its own words. Not swallowed and not
            // turned into "something went wrong": the owner is standing in a
            // shop and needs to know whether it went in.
            throw AppLedgerError.refused(error.problem + " " + error.unchanged)
        }

        await services.didWrite()

        let path = categoryId.flatMap { id in
            context.categories.first { $0.id == id }?.path
        }
        return .result(
            dialog: IntentDialog(
                stringLiteral: QuickEntry.spokenConfirmation(
                    amountMinor: minor,
                    currency: target.currency,
                    payeeName: payeeName,
                    accountName: target.name,
                    categoryPath: path
                )
            )
        )
    }
}

// MARK: - Asking what things stand at

struct NetWorthIntent: AppIntent {
    static var title: LocalizedStringResource { "Check net worth" }

    static var description: IntentDescription {
        IntentDescription(
            """
            Reads back what the copy of your book on this device says your accounts are worth, \
            and when it was last worked out.
            """,
            categoryName: "Money"
        )
    }

    static var openAppWhenRun: Bool { false }

    @MainActor
    func perform() async throws -> some IntentResult & ProvidesDialog {
        let services = IntentServices.shared
        // READ FROM THE SNAPSHOT WHEN THERE IS ONE, for the same reason the
        // widget does: it is already computed. Falling back to the book keeps
        // the intent working on a build with no shared container.
        if let directory = SharedContainer.url,
            let snapshot = SnapshotFile.read(from: directory),
            let freshness = SnapshotFreshness.of(asOf: snapshot.asOf, now: Date())
        {
            return .result(dialog: IntentDialog(stringLiteral: Spoken.netWorth(snapshot, freshness)))
        }
        guard let summary = try? await services.service.summary() else {
            throw AppLedgerError.noBook
        }
        let worth = summary.snapshot.netWorth
        var sentence =
            "Your accounts come to "
            + Display.moneySpoken(worth.totalBaseMinor, worth.baseCurrency) + "."
        // A CREATED BOOK SAYS NOTHING HERE, and it says nothing because there
        // is nothing to say rather than because this line remembered to check.
        // `countLine` is nil for a book with no counterpart anywhere, so Siri
        // cannot read out a sentence about a web app that has never held it.
        if summary.localEdits.count > 0, let line = summary.localEdits.countLine {
            sentence += " " + line + "."
        }
        return .result(dialog: IntentDialog(stringLiteral: sentence))
    }
}

/// The sentences the intents speak. Here rather than inline so they are one
/// paragraph to read and change.
enum Spoken {
    static func netWorth(_ snapshot: LedgerSnapshot, _ freshness: SnapshotFreshness) -> String {
        var sentence =
            "Your accounts come to "
            + Display.moneySpoken(snapshot.netWorthMinor, snapshot.baseCurrency)
            + ", " + freshness.phrase + "."
        if !snapshot.missingRateCurrencies.isEmpty {
            sentence +=
                " That leaves out "
                + snapshot.missingRateCurrencies.joined(separator: " and ")
                + ", which has no exchange rate."
        }
        // The snapshot carries a COUNT and not an origin, and it does not need
        // one: nothing counts an edit on a book created here, so the count is
        // zero for exactly the books that must stay silent. The `if let` is
        // belt as well as braces -- `countLine` is the only thing entitled to
        // decide whether this sentence exists.
        if snapshot.localEditCount > 0,
            let line = LocalEdits(
                count: snapshot.localEditCount, firstAt: nil, lastAt: nil
            ).countLine
        {
            sentence += " " + line + "."
        }
        return sentence
    }
}

// MARK: - Failures a person can act on

enum AppLedgerError: Error, CustomLocalizedStringResourceConvertible {
    case noBook
    case badAmount(String)
    case refused(String)

    var localizedStringResource: LocalizedStringResource {
        switch self {
        case .noBook:
            // Through `stringLiteral:` so the sentence can be written across
            // two lines: a `LocalizedStringResource` returned from a bare
            // literal cannot be a concatenation.
            return LocalizedStringResource(
                stringLiteral:
                    "There is no book on this device yet. Open MyMoney to set one up \u{2014} "
                    + "add your accounts, start empty, or import a backup."
            )
        case .badAmount(let why):
            return LocalizedStringResource(stringLiteral: why)
        case .refused(let why):
            return LocalizedStringResource(stringLiteral: why)
        }
    }
}

// MARK: - The phrases

struct MyMoneyShortcuts: AppShortcutsProvider {
    static var appShortcuts: [AppShortcut] {
        AppShortcut(
            intent: AddExpenseIntent(),
            // A SPOKEN PHRASE CANNOT CARRY THE AMOUNT, and that is the
            // platform rather than a choice: App Shortcut phrases may only
            // interpolate an `AppEntity` or an `AppEnum`, and an amount is a
            // number. `appintentsmetadataprocessor` fails the build rather
            // than shipping a phrase that would not work -- which is how this
            // was found.
            //
            // So the amount is ASKED FOR: "Add an expense to MyMoney" ->
            // "How much?" -> "four pounds", and the transaction is written
            // without the app ever coming to the front. To say the whole thing
            // in one breath -- "Add a four pound coffee" -- the owner builds
            // that shortcut once in the Shortcuts app with the amount and payee
            // filled in, and gives it that name; every parameter below is
            // exposed for exactly that.
            phrases: [
                "Add an expense to \(.applicationName)",
                "Log a payment in \(.applicationName)",
                "Add a payment to \(.applicationName)",
            ],
            shortTitle: "Add an expense",
            systemImageName: "bolt.fill"
        )
        AppShortcut(
            intent: NetWorthIntent(),
            phrases: [
                "What am I worth in \(.applicationName)",
                "Check my \(.applicationName) net worth",
            ],
            shortTitle: "Net worth",
            systemImageName: "chart.line.uptrend.xyaxis"
        )
    }
}

// MARK: - The one service the intents share

/// The `LedgerService` an intent uses, and the widget refresh that follows a
/// write.
///
/// A SINGLETON, DELIBERATELY, and this is the one in the app. An intent may run
/// while the app is already in the foreground with its own `AppModel`; two
/// `LedgerService` actors would then be two SQLite connections writing the same
/// file. One is not a convenience here, it is a correctness requirement -- so
/// `AppModel` takes ITS service from here too, and there is exactly one.
final class IntentServices: Sendable {
    static let shared = IntentServices()

    let service = LedgerService()

    private init() {}

    /// After a write from outside the app's own UI: republish the widget
    /// snapshot and tell the running app, if there is one, to re-read.
    @MainActor
    func didWrite() async {
        await WidgetPublishing.publish(using: service)
        NotificationCenter.default.post(name: .ledgerChangedOutsideTheApp, object: nil)
    }
}

extension Notification.Name {
    /// Posted when something other than the app's own screens changed the book
    /// -- today, an App Intent. `RootView` listens and re-reads, so a
    /// transaction added by voice while the app is open on the register appears
    /// there without the owner doing anything.
    static let ledgerChangedOutsideTheApp = Notification.Name("mymoney.ledgerChangedOutsideTheApp")
}
