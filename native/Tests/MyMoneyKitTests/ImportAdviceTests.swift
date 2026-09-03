// The sentences that go beside an action that will not run yet.
//
// A DISABLED BUTTON IS A QUESTION. If the screen does not answer it in the same
// glance, the owner is left tapping a grey rectangle and guessing -- which is
// exactly what happened with a real 348-row export on a fresh install: the file
// read perfectly, "Set up this import…" was grey, and there was no sentence
// anywhere on the screen.
//
// So these are pure functions in the kit rather than strings in a SwiftUI body,
// and every one of them is held to the same two rules here: it names what is
// missing, and it says what to do next. A sentence that only diagnoses ("no
// book") is a sentence that fails this suite.
import Foundation
import Testing

@testable import MyMoneyKit

struct ImportAdviceTests {

    /// Does this read like an instruction rather than a diagnosis? Crude on
    /// purpose: it looks for a verb the owner can act on, and it is enough to
    /// catch a sentence rewritten into a bare statement of fact later.
    private func tellsYouWhatToDo(_ text: String) -> Bool {
        let cues = [
            "start", "choose", "name", "map", "tick", "check", "try", "go back", "you can",
            "you say so", "bringing", "will be created", "shows you",
        ]
        let lower = text.lowercased()
        return cues.contains { lower.contains($0) }
    }

    // MARK: - Setting a statement up

    @Test("WITH NO BOOK, THE NOTE SAYS THE IMPORT WILL START ONE AND IN WHICH CURRENCY")
    func noBookExplainsItself() {
        let note = ImportAdvice.statementSetupNote(
            hasBook: false, accountCount: 0, baseCurrency: "GBP"
        )
        #expect(note.contains("no book on this device"))
        // The old sentence was a refusal: "a statement adds rows to a book
        // rather than creating one. Import a backup first." It is not true any
        // more and it must not come back.
        #expect(!note.lowercased().contains("import a backup first"))
        #expect(note.contains("GBP"))
        #expect(note.contains("start one"))
        #expect(note.contains("writes only when you say so"))
        #expect(tellsYouWhatToDo(note))
    }

    @Test("the currency named is the one a book would actually be created in")
    func namesTheCurrencyItWouldUse() {
        for code in ["GBP", "EUR", "LKR", "JPY"] {
            let note = ImportAdvice.statementSetupNote(
                hasBook: false, accountCount: 0, baseCurrency: code
            )
            #expect(note.contains(code))
        }
    }

    @Test("a book with no accounts is told BOTH ways in, not refused")
    func bookWithNoAccounts() {
        let note = ImportAdvice.statementSetupNote(
            hasBook: true, accountCount: 0, baseCurrency: "GBP"
        )
        #expect(note.contains("no accounts yet"))
        #expect(note.contains("created for you"))  // a file that names its own
        #expect(note.contains("you can name one"))  // a file that does not
        #expect(tellsYouWhatToDo(note))
    }

    @Test("an ordinary book is told that nothing has been written yet")
    func ordinaryBook() {
        let note = ImportAdvice.statementSetupNote(
            hasBook: true, accountCount: 4, baseCurrency: "GBP"
        )
        #expect(note.contains("Nothing has been added"))
        #expect(note.contains("writes only when you say so"))
    }

    @Test("there is a sentence in every state \u{2014} the note is never empty")
    func neverEmpty() {
        for hasBook in [true, false] {
            for accounts in [0, 1, 58] {
                let note = ImportAdvice.statementSetupNote(
                    hasBook: hasBook, accountCount: accounts, baseCurrency: "GBP"
                )
                #expect(!note.isEmpty)
                #expect(tellsYouWhatToDo(note))
            }
        }
    }

    // MARK: - The mapping step

    @Test("THE ACCOUNT REQUIREMENT OFFERS AN INSTRUCTION THAT CAN ACTUALLY BE FOLLOWED")
    func accountRequirementFitsTheBook() {
        // With accounts, "choose one" is followable. Without, the picker is
        // empty and "choose one above" is an instruction to do the impossible
        // -- which is the second dead end this work exists to remove.
        let withAccounts = ImportAdvice.accountRequirement(bookHasAccounts: true)
        let without = ImportAdvice.accountRequirement(bookHasAccounts: false)

        #expect(withAccounts.contains("choose one above"))
        #expect(!without.contains("choose one above"))
        #expect(without.contains("name a new one above"))
        #expect(withAccounts.contains("Account column"))
        #expect(without.contains("Account column"))
    }

    @Test("naming a new account is refused only for a reason it states")
    func newAccountProblems() {
        #expect(ImportAdvice.newAccountProblem(name: "Card", currency: "GBP") == nil)
        #expect(ImportAdvice.newAccountProblem(name: " Card ", currency: " gbp ") == nil)

        let blank = try? #require(ImportAdvice.newAccountProblem(name: "  ", currency: "GBP"))
        #expect(blank?.contains("Give the new account a name") == true)

        let bad = try? #require(ImportAdvice.newAccountProblem(name: "Card", currency: "pounds"))
        #expect(bad?.contains("pounds") == true)
        #expect(bad?.contains("Three letters") == true)
        // WHY it cannot be guessed, which is the part that stops it feeling
        // like pedantry: the code fixes the decimal places.
        #expect(bad?.contains("decimal places") == true)
    }

    @Test("a blank name is answered before a bad currency, so one problem shows at a time")
    func oneProblemAtATime() {
        let both = ImportAdvice.newAccountProblem(name: "", currency: "nonsense")
        #expect(both?.contains("name") == true)
        #expect(both?.contains("nonsense") == false)
    }

    // MARK: - The preview step

    @Test("NOTHING TO IMPORT HAS FOUR CAUSES AND THEY ARE NOT THE SAME NEWS")
    func nothingToImportDistinguishesItsCauses() {
        func note(
            rows: Int, importable: Int = 0, exact: Int = 0, near: Int = 0, errors: Int = 0,
            toCreate: Int = 0, hasNew: Bool = false
        ) -> String? {
            ImportAdvice.nothingToImportNote(
                rowsRead: rows, importableCount: importable, exactDuplicateCount: exact,
                nearDuplicateCount: near, errorCount: errors, accountsToCreateCount: toCreate,
                hasNewAccounts: hasNew
            )
        }

        // The good one, and by far the commonest: the same statement twice.
        let duplicate = try? #require(note(rows: 12, exact: 12))
        #expect(duplicate?.contains("already in your book") == true)
        #expect(duplicate?.contains("second time") == true)

        // Every row failed -- fixable, and the counts say how.
        let failed = try? #require(note(rows: 12, errors: 12))
        #expect(failed?.contains("Not one row") == true)
        #expect(failed?.contains("one column read the wrong way") == true)

        // The owner unticked the accounts.
        let unticked = try? #require(note(rows: 12, importable: 0, toCreate: 0, hasNew: true))
        #expect(unticked?.contains("unticked") == true)
        #expect(unticked?.contains("Tick at least one") == true)

        // A file with a header row and nothing under it.
        let empty = try? #require(note(rows: 0))
        #expect(empty?.contains("no rows in this file") == true)

        // And when there IS something to write, there is nothing to say.
        #expect(note(rows: 12, importable: 3, exact: 9) == nil)
    }

    @Test("a mixture that adds up to nothing still gets a sentence rather than silence")
    func mixedCauseStillSpeaks() {
        let note = ImportAdvice.nothingToImportNote(
            rowsRead: 10, importableCount: 0, exactDuplicateCount: 4, nearDuplicateCount: 2,
            errorCount: 4, accountsToCreateCount: 0, hasNewAccounts: false
        )
        #expect(note != nil)
        #expect(note?.contains("The counts above say why") == true)
    }
}
