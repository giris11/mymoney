// Scaffolding the store tests share: a scratch directory that cleans itself up,
// and the fabricated book they all run against.
//
// EVERY FIGURE IN THIS FILE IS INVENTED. It is the same fixture
// BackupWriterTests uses -- three accounts, two transactions, one of every
// awkward shape the format has -- reused deliberately rather than copied, so
// that the store is held to exactly the book the writer is already held to. No
// real account, payee or amount appears in this repository, ever.
import Foundation
import Testing

@testable import MyMoneyKit

/// A directory that exists for the length of one test and then does not.
final class ScratchDirectory {
    let url: URL

    init() throws {
        url = URL(fileURLWithPath: NSTemporaryDirectory())
            .appendingPathComponent("mymoney-store-tests")
            .appendingPathComponent(UUID().uuidString)
        try FileManager.default.createDirectory(at: url, withIntermediateDirectories: true)
    }

    deinit { try? FileManager.default.removeItem(at: url) }

    func file(_ name: String) -> URL { url.appendingPathComponent(name) }

    /// A fresh store on disk. On disk rather than in memory on purpose: a
    /// claim about crash safety cannot be made about a database with no file.
    func store(_ name: String = "ledger.sqlite", upTo: Int = StoreSchema.version) throws
        -> LedgerStore
    {
        try LedgerStore.open(path: file(name).path, upTo: upTo)
    }
}

enum StoreFixture {
    /// The BackupWriterTests document, which is the one fixture in this suite
    /// built to contain one of everything a writer -- or a store -- can quietly
    /// get wrong: a row that OMITS `excludeFromNetWorth` and a row that states
    /// it as `false`; a category with a colour and one without; a split with
    /// notes and one without; an import batch with the sample-only arrays and
    /// one without; a rate written as an integer and one to sixteen decimal
    /// places; and a settings row carrying the device-local `sync*` half this
    /// package deliberately does not model.
    static var backupText: String { BackupWriterTests.backup }

    static func imported() throws -> ImportedBackup {
        try BackupImporter.load(text: backupText)
    }

    /// The repository's v1-manifest fixture -- the one whose net worth is 1198
    /// under the v1 rule and 1199 under v2. The penny is the point.
    static func v1BackupText() throws -> String {
        try ManifestVersionTests.fixtureText()
    }
}

/// Compare two books table by table, so a failure names the table that moved
/// instead of saying that something did.
func expectSameBook(_ got: Book, _ want: Book, _ label: String = "") {
    #expect(got.accounts == want.accounts, "\(label) accounts")
    #expect(got.accountGroups == want.accountGroups, "\(label) accountGroups")
    #expect(got.transactions == want.transactions, "\(label) transactions")
    #expect(got.categories == want.categories, "\(label) categories")
    #expect(got.payees == want.payees, "\(label) payees")
    #expect(got.tags == want.tags, "\(label) tags")
    #expect(got.budgets == want.budgets, "\(label) budgets")
    #expect(got.fxRates == want.fxRates, "\(label) fxRates")
    #expect(got.importBatches == want.importBatches, "\(label) importBatches")
    #expect(got.settings == want.settings, "\(label) settings")
    #expect(got.baseCurrency == want.baseCurrency, "\(label) baseCurrency")
}

/// Records come out of the store in id order; the fixture's arrays are in file
/// order. Sorting both by id makes the comparison about content rather than
/// about which order somebody happened to write the rows in.
extension Book {
    func sortedById() -> Book {
        Book(
            accounts: accounts.sorted { $0.id < $1.id },
            accountGroups: accountGroups.sorted { $0.id < $1.id },
            transactions: transactions.sorted { $0.id < $1.id },
            categories: categories.sorted { $0.id < $1.id },
            payees: payees.sorted { $0.id < $1.id },
            tags: tags.sorted { $0.id < $1.id },
            budgets: budgets.sorted { $0.id < $1.id },
            fxRates: fxRates.sorted { $0.id < $1.id },
            importBatches: importBatches.sorted { $0.id < $1.id },
            settings: settings,
            baseCurrency: baseCurrency
        )
    }
}
