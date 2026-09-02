// The starting point a fresh book gets, held against the web app's.
//
// WHY THE EXPECTED TREE IS WRITTEN OUT IN FULL BELOW RATHER THAN READ FROM
// `StarterBook`. A test that compared the seed to itself would pass no matter
// what the seed said; the only version of this check worth having is a SECOND
// transcription of src/db/seed.ts, made independently, that has to agree with
// the first. Sixty-one lines of category names is a small price for the one
// property that matters: somebody starting fresh on the phone and somebody
// starting fresh in the browser land in the same book.
//
// NOTHING HERE IS PERSONAL. Every name is a dictionary word out of the shared
// seed, and no amount, payee or balance appears anywhere in this file.
import Foundation
import Testing

@testable import MyMoneyKit

struct StarterBookTests {

    /// src/db/seed.ts's EXPENSE_TREE, transcribed a second time: name, colour,
    /// children in order.
    static let expected: [(kind: CategoryKind, name: String, colour: String, children: [String])] = [
        (.expense, "Food & Drink", "#ea580c", ["Groceries", "Restaurants", "Takeaway", "Coffee & Snacks"]),
        (.expense, "Bills & Utilities", "#0284c7", ["Electricity", "Gas", "Water", "Internet", "Mobile", "Council Tax"]),
        (.expense, "Transport", "#2563eb", ["Fuel", "Public Transport", "Taxi & Ride-hailing", "Parking", "Car Maintenance", "Car Insurance"]),
        (.expense, "Housing", "#7c3aed", ["Rent", "Mortgage", "Repairs & Maintenance", "Furniture & Appliances"]),
        (.expense, "Shopping", "#db2777", ["Clothing", "Electronics", "Household", "Gifts"]),
        (.expense, "Health", "#dc2626", ["Pharmacy", "Doctor & Dental", "Fitness"]),
        (.expense, "Entertainment", "#c026d3", ["Streaming & Subscriptions", "Cinema & Events", "Games", "Books"]),
        (.expense, "Personal", "#a16207", ["Education", "Personal Care", "Charity"]),
        (.expense, "Travel", "#059669", ["Flights", "Accommodation", "Holiday Spending"]),
        (.expense, "Family", "#65a30d", ["Childcare", "Pets"]),
        (.expense, "Finance", "#0d9488", ["Bank Fees", "Interest Charges", "Insurance", "Taxes"]),
        (.expense, "Other", "#6b7280", []),
        (.income, "Salary", "#059669", []),
        (.income, "Freelance & Side Income", "#0d9488", []),
        (.income, "Interest & Dividends", "#2563eb", []),
        (.income, "Gifts Received", "#db2777", []),
        (.income, "Refunds & Reimbursements", "#7c3aed", []),
        (.income, "Other Income", "#6b7280", []),
    ]

    /// Counted ids, so a parent link is a value a test can state.
    static func seeded(_ prefix: String = "seed") -> [MyMoneyKit.Category] {
        var counter = 0
        return StarterBook.categories(newId: {
            counter += 1
            return "\(prefix)-\(counter)"
        })
    }

    @Test("THE SEEDED TREE IS THE WEB APP'S TREE, row for row")
    func theTreeMatchesTheWebApp() {
        let seeded = Self.seeded()
        let byId = Dictionary(uniqueKeysWithValues: seeded.map { ($0.id, $0) })

        // Every root, in the order the web app writes them, with its own
        // sortOrder counting from zero WITHIN ITS KIND -- the expense list and
        // the income list are two lists on screen, and renumbering one to sit
        // after the other would put this app's category screen in a different
        // order from the browser's.
        var expectedRoots: [CategoryKind: Int] = [:]
        var index = 0
        for want in Self.expected {
            let root = seeded[index]
            #expect(root.name == want.name, "root \(index)")
            #expect(root.kind == want.kind, "\(want.name) kind")
            #expect(root.colour == want.colour, "\(want.name) colour")
            #expect(root.parentId == nil, "\(want.name) is top level")
            #expect(!root.archived, "\(want.name) archived")
            #expect(root.icon == nil, "\(want.name) icon")
            let position = expectedRoots[want.kind, default: 0]
            #expect(root.sortOrder == position, "\(want.name) sortOrder")
            expectedRoots[want.kind] = position + 1
            index += 1

            // Then its children, immediately after it, in order, each carrying
            // its parent's colour and its own position among its siblings.
            for (childIndex, childName) in want.children.enumerated() {
                let child = seeded[index]
                #expect(child.name == childName, "child \(childIndex) of \(want.name)")
                #expect(child.parentId == root.id, "\(childName) parent")
                #expect(child.kind == want.kind, "\(childName) kind")
                #expect(child.colour == want.colour, "\(childName) inherits its parent's colour")
                #expect(child.sortOrder == childIndex, "\(childName) sortOrder")
                #expect(byId[child.parentId ?? ""]?.name == want.name, "\(childName) resolves")
                index += 1
            }
        }

        // And nothing else. 61 is the figure src/db/seed.ts's own comment
        // quotes when it explains why seeding twice would be visible.
        #expect(index == seeded.count)
        #expect(seeded.count == 61)
        #expect(seeded.filter { $0.kind == .expense }.count == 55)
        #expect(seeded.filter { $0.kind == .income }.count == 6)
        #expect(seeded.filter { $0.parentId == nil }.count == 18)
    }

    @Test("THE IDS ARE GENERATED, NOT COPIED from the browser")
    func idsAreFreshEveryTime() {
        // Copying the web app's ids would claim that a category created here is
        // the same ROW as one created there -- two books that were never
        // connected would merge their "Groceries" the day anything tried to
        // reconcile them. So: every id comes from the injected source, every id
        // is distinct, and two seedings of the same tree share none of them.
        let first = Self.seeded("a")
        let second = Self.seeded("b")

        #expect(Set(first.map(\.id)).count == first.count)
        #expect(first.allSatisfy { $0.id.hasPrefix("a-") })
        #expect(Set(first.map(\.id)).isDisjoint(with: Set(second.map(\.id))))
        // Same names, different identities.
        #expect(first.map(\.name) == second.map(\.name))

        // The live source is a lowercase v4 UUID, like every other record's.
        let live = StarterBook.categories(newId: Identity.newId)
        #expect(live.allSatisfy { $0.id.count == 36 && $0.id == $0.id.lowercased() })
        #expect(Set(live.map(\.id)).count == live.count)
    }

    @Test("the seeded tree is a TREE the money rules can walk")
    func theRollupRulesSeeIt() throws {
        // The point of the parent links is D16: a budget covers its categories
        // plus everything beneath them, and a report row is the sum of a
        // subtree. A seed whose links were wrong would not be visibly wrong --
        // it would just quietly stop counting the subcategory somebody files
        // half their groceries under.
        let seeded = Self.seeded()
        let food = try #require(seeded.first { $0.name == "Food & Drink" })
        let subtree = Categories.descendantIds(seeded, rootIds: [food.id])
        #expect(subtree.count == 5)  // itself plus four children
        #expect(seeded.filter { subtree.contains($0.id) }.map(\.name).sorted()
            == ["Coffee & Snacks", "Food & Drink", "Groceries", "Restaurants", "Takeaway"])

        // A childless root is its own subtree, not an error.
        let other = try #require(seeded.first { $0.name == "Other" && $0.kind == .expense })
        #expect(Categories.descendantIds(seeded, rootIds: [other.id]).count == 1)

        // Every parent link resolves, and no category is its own ancestor.
        let ids = Set(seeded.map(\.id))
        #expect(seeded.allSatisfy { $0.parentId == nil || ids.contains($0.parentId!) })
        #expect(seeded.allSatisfy { $0.parentId != $0.id })

        // The path rendering the UI and the import warnings both use.
        let byId = Dictionary(uniqueKeysWithValues: seeded.map { ($0.id, $0) })
        let groceries = try #require(seeded.first { $0.name == "Groceries" })
        #expect(Categories.categoryPathName(byId, id: groceries.id)
            == "Food & Drink \u{203A} Groceries")
    }

    @Test("THE ACCOUNT TEMPLATES ARE NAMES AND TYPES, and nothing else")
    func accountTemplates() {
        // src/db/seed.ts's ACCOUNT_TEMPLATES, transcribed again.
        let want: [(String, AccountType, String)] = [
            ("Current Account", .current, "#2563eb"),
            ("Savings", .savings, "#059669"),
            ("Credit Card", .creditCard, "#db2777"),
            ("Cash", .cash, "#b45309"),
        ]
        #expect(StarterBook.accountTemplates.count == want.count)
        for (template, expected) in zip(StarterBook.accountTemplates, want) {
            #expect(template.name == expected.0)
            #expect(template.type == expected.1)
            #expect(template.colour == expected.2)
            // The template's colour is the type's colour: a starter row and a
            // row the owner adds later of the same type look the same.
            #expect(template.colour == StarterBook.colour(for: expected.1))
        }

        // NO MONEY IN A TEMPLATE. The draft it hands back carries a zero
        // opening balance for the caller to replace with what the owner types,
        // and no id -- the store decides identity.
        let draft = StarterBook.accountTemplates[0].draft(currency: "GBP")
        #expect(draft.id == nil)
        #expect(draft.openingBalanceMinor == 0)
        #expect(draft.currency == "GBP")
        #expect(draft.name == "Current Account")
        #expect(draft.type == .current)
        #expect(draft.sortOrder == nil)
        #expect(draft.groupId == nil)
        #expect(draft.archived == nil)
    }

    @Test("every account type has a colour and a label the store will accept")
    func everyTypeIsCovered() {
        for type in AccountType.allCases {
            let colour = StarterBook.colour(for: type)
            #expect(Validate.isHexColour(colour), "\(type.rawValue) colour \(colour)")
            #expect(!StarterBook.label(for: type).isEmpty, "\(type.rawValue) label")
        }
        // Ported values, not invented ones: src/ui/onboarding/AccountsStep.tsx.
        #expect(StarterBook.colour(for: .loan) == "#dc2626")
        #expect(StarterBook.colour(for: .investment) == "#7c3aed")
        #expect(StarterBook.label(for: .creditCard) == "Credit card")
        #expect(StarterBook.label(for: .current) == "Current account")
    }

    @Test("the currency list is the web app's, and every entry is a code")
    func currencyList() {
        #expect(StarterBook.commonCurrencies.first == "GBP")
        #expect(StarterBook.commonCurrencies.count == 45)
        #expect(Set(StarterBook.commonCurrencies).count == StarterBook.commonCurrencies.count)
        #expect(StarterBook.commonCurrencies.allSatisfy(Validate.isCurrencyCode))
    }
}
