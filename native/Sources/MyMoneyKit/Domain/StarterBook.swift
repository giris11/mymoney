// What a book looks like on the day it is created, before anybody has typed
// anything into it: a category tree and a handful of account templates.
//
// PORTED FROM src/db/seed.ts, AND THE PORT IS THE POINT. A person who starts
// fresh in the browser and a person who starts fresh on the phone must land in
// the same book -- the same category names, the same parents, the same kinds,
// the same colours, the same order. Two apps that seed differently produce two
// books that cannot be compared, and the first time anybody notices is when a
// backup from one is opened in the other and every report has different rows.
// So this file is a transcription, not an interpretation: the trees below are
// the TypeScript's EXPENSE_TREE and INCOME_TREE line for line, and
// `StarterBookTests` checks the shape rather than trusting the transcription.
//
// THE IDS ARE GENERATED, NOT COPIED. The names are shared; the identities are
// not. Copying the browser's ids would claim that a category created here is
// the same ROW as one created there, which sync would then have to believe --
// two books that were never connected would silently merge their "Groceries"
// and disagree about which transactions belong to it. Ids come from
// `StoreEnvironment.newId`, the same lowercase v4 UUIDs every other record here
// gets.
//
// NOTHING IN THIS FILE IS PERSONAL, and nothing in it ever may be. These are
// dictionary words and account TYPES -- "Groceries", "Current Account" -- with
// no amounts, no payees and no balances. A starting point is a suggestion; the
// owner renames, archives and deletes from here, and every one of those verbs
// already exists.
import Foundation

/// A starting account the owner can accept, edit or ignore: a NAME and a TYPE,
/// and nothing else.
///
/// NO AMOUNT. The web app's onboarding also collects an opening balance on this
/// screen, and that number is deliberately NOT here: an opening balance is the
/// one figure every future balance of an account is built on, and it belongs to
/// the person typing it, not to a template. `draft(currency:)` hands back a
/// draft with a zero opening balance for the caller to fill in and validate the
/// way the account editor already does.
public struct AccountTemplate: Sendable, Hashable, Identifiable {
    /// The template's name, which is also its identity in a list. The four
    /// templates have four different names, and a `ForEach` over them needs
    /// something stable that is not an array index.
    public var id: String { name }
    public let name: String
    public let type: AccountType
    /// "#rrggbb", the same entity colour src/db/seed.ts gives this type.
    public let colour: String

    public init(name: String, type: AccountType, colour: String) {
        self.name = name
        self.type = type
        self.colour = colour
    }

    /// This template as the account editor would hold it: the name and type
    /// stated, the currency the caller chose, no money in it yet.
    ///
    /// A DRAFT, NOT AN ACCOUNT, for the reason Drafts.swift gives: the store is
    /// the only correct source of an id and a sort order, and a template that
    /// minted its own would be inventing identity for a row the owner has not
    /// agreed to yet.
    public func draft(currency: String, sortOrder: Int? = nil) -> AccountDraft {
        AccountDraft(
            name: name,
            type: type,
            currency: currency,
            openingBalanceMinor: 0,
            colour: colour,
            sortOrder: sortOrder
        )
    }
}

public enum StarterBook {

    // MARK: - The category tree

    /// One line of the seed tree: a top-level category, its colour, and the
    /// children that inherit that colour.
    struct SeedNode {
        let name: String
        let colour: String
        let children: [String]

        init(_ name: String, _ colour: String, _ children: [String] = []) {
            self.name = name
            self.colour = colour
            self.children = children
        }
    }

    /// src/db/seed.ts's EXPENSE_TREE.
    ///
    /// The colours are a hue-spread set the web app checked with a palette
    /// validator on both theme surfaces; "Other" is deliberately grey. They are
    /// copied rather than rechosen because a category's colour travels in the
    /// backup file, and a phone that seeded different colours would make the
    /// same book look like a different one in the browser.
    static let expenseTree: [SeedNode] = [
        SeedNode("Food & Drink", "#ea580c", ["Groceries", "Restaurants", "Takeaway", "Coffee & Snacks"]),
        SeedNode("Bills & Utilities", "#0284c7", ["Electricity", "Gas", "Water", "Internet", "Mobile", "Council Tax"]),
        SeedNode("Transport", "#2563eb", ["Fuel", "Public Transport", "Taxi & Ride-hailing", "Parking", "Car Maintenance", "Car Insurance"]),
        SeedNode("Housing", "#7c3aed", ["Rent", "Mortgage", "Repairs & Maintenance", "Furniture & Appliances"]),
        SeedNode("Shopping", "#db2777", ["Clothing", "Electronics", "Household", "Gifts"]),
        SeedNode("Health", "#dc2626", ["Pharmacy", "Doctor & Dental", "Fitness"]),
        SeedNode("Entertainment", "#c026d3", ["Streaming & Subscriptions", "Cinema & Events", "Games", "Books"]),
        SeedNode("Personal", "#a16207", ["Education", "Personal Care", "Charity"]),
        SeedNode("Travel", "#059669", ["Flights", "Accommodation", "Holiday Spending"]),
        SeedNode("Family", "#65a30d", ["Childcare", "Pets"]),
        SeedNode("Finance", "#0d9488", ["Bank Fees", "Interest Charges", "Insurance", "Taxes"]),
        SeedNode("Other", "#6b7280"),
    ]

    /// src/db/seed.ts's INCOME_TREE. Six top-level rows, no children.
    static let incomeTree: [SeedNode] = [
        SeedNode("Salary", "#059669"),
        SeedNode("Freelance & Side Income", "#0d9488"),
        SeedNode("Interest & Dividends", "#2563eb"),
        SeedNode("Gifts Received", "#db2777"),
        SeedNode("Refunds & Reimbursements", "#7c3aed"),
        SeedNode("Other Income", "#6b7280"),
    ]

    /// The whole seed tree as records, expenses first, each parent immediately
    /// followed by its own children.
    ///
    /// `sortOrder` follows the TypeScript exactly: a parent's is its index in
    /// its own tree, a child's is its index among ITS SIBLINGS. So the expense
    /// and income roots both count from zero -- they are different lists on
    /// screen, separated by `kind`, and renumbering one to sit after the other
    /// would put the phone's category screen in a different order from the
    /// browser's.
    ///
    /// `newId` is injected rather than called so that a test can state exactly
    /// which id it expects to see as a parent link. See `StoreEnvironment`.
    public static func categories(newId: () -> String) -> [Category] {
        build(expenseTree, kind: .expense, newId: newId)
            + build(incomeTree, kind: .income, newId: newId)
    }

    private static func build(
        _ tree: [SeedNode], kind: CategoryKind, newId: () -> String
    ) -> [Category] {
        var out: [Category] = []
        for (index, node) in tree.enumerated() {
            let parent = Category(
                id: newId(),
                name: node.name,
                parentId: nil,
                kind: kind,
                colour: node.colour,
                archived: false,
                sortOrder: index
            )
            out.append(parent)
            for (childIndex, childName) in node.children.enumerated() {
                out.append(
                    Category(
                        id: newId(),
                        name: childName,
                        parentId: parent.id,
                        kind: kind,
                        // Inherited from the parent, as the web app does it: a
                        // subcategory that reported in a different colour from
                        // the row it rolls up into would make a chart lie about
                        // which slice is which.
                        colour: node.colour,
                        archived: false,
                        sortOrder: childIndex
                    )
                )
            }
        }
        return out
    }

    // MARK: - Account templates

    /// The starting accounts onboarding offers, in the order it offers them.
    /// src/db/seed.ts's ACCOUNT_TEMPLATES.
    ///
    /// FOUR, NOT FORTY. This is the shortest list that covers how most people
    /// actually hold money -- a current account, somewhere it accumulates, a
    /// card that runs negative, and cash -- and every one of them is a
    /// suggestion the owner can rename, retype or leave unticked. Loan and
    /// investment accounts exist as types (`colour(for:)` knows them) but are
    /// not offered up front: an empty book that opened with six accounts to
    /// delete would be a worse start than one with four to accept.
    public static let accountTemplates: [AccountTemplate] = [
        AccountTemplate(name: "Current Account", type: .current, colour: "#2563eb"),
        AccountTemplate(name: "Savings", type: .savings, colour: "#059669"),
        AccountTemplate(name: "Credit Card", type: .creditCard, colour: "#db2777"),
        AccountTemplate(name: "Cash", type: .cash, colour: "#b45309"),
    ]

    /// The entity colour for an account the owner adds themselves, so a row
    /// typed on the phone looks like the same row typed in the browser.
    /// src/ui/onboarding/AccountsStep.tsx's TYPE_COLOURS, which states the same
    /// values seed.ts uses for the four templates.
    public static func colour(for type: AccountType) -> String {
        switch type {
        case .current: return "#2563eb"
        case .savings: return "#059669"
        case .creditCard: return "#db2777"
        case .cash: return "#b45309"
        case .loan: return "#dc2626"
        case .investment: return "#7c3aed"
        }
    }

    /// What each account type is called on screen.
    /// src/db/seed.ts's ACCOUNT_TYPE_LABELS, word for word.
    public static func label(for type: AccountType) -> String {
        switch type {
        case .current: return "Current account"
        case .savings: return "Savings"
        case .creditCard: return "Credit card"
        case .cash: return "Cash"
        case .loan: return "Loan"
        case .investment: return "Investment"
        }
    }

    /// The currency codes the pickers offer first, in the web app's order.
    /// src/db/seed.ts's COMMON_CURRENCIES.
    ///
    /// A LIST, NOT A LIMIT. `saveAccount` accepts any three-letter code, and
    /// `createBook` does too; this is what a picker shows before somebody types
    /// something else.
    public static let commonCurrencies: [String] = [
        "GBP", "EUR", "USD", "INR", "LKR", "JPY", "AUD", "CAD", "CHF", "CNY", "SEK", "NOK",
        "DKK", "PLN", "CZK", "AED", "SGD", "HKD", "NZD", "ZAR", "THB", "MYR", "PKR", "BDT",
        "NPR", "PHP", "IDR", "VND", "SAR", "QAR", "KWD", "BHD", "OMR", "TRY", "MXN", "BRL",
        "KRW", "TWD", "ILS", "EGP", "NGN", "KES", "GHS", "MUR", "MVR",
    ]
}
