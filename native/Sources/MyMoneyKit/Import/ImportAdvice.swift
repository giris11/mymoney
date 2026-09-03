// Why an action is not available, in a sentence that says what to do about it.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE DEFECT THIS FILE EXISTS TO NOT HAVE AGAIN
//
// A fresh install, a real MoneyWiz export, 348 rows read correctly, every
// column named on screen -- and then "Set up this import…" greyed out with
// nothing anywhere on the screen saying why. "Not now" was the only live
// button. The rule behind it ("a statement adds rows to a book, and there is no
// book") was wrong for that file, and the sentence that would have said so was
// three screens up in a card the owner had already scrolled past.
//
// Two lessons, and this file is the second one:
//
//   1. A DISABLED PRIMARY ACTION MUST STATE ITS REASON NEXT TO ITSELF. Not in a
//      card above, not in a footer, not in a tooltip -- beside the button, in
//      the bar, where a thumb is already looking. `PrimaryAction` in the app
//      takes a `disabledReason` rather than an `isEnabled` for exactly this:
//      the type makes a silent disable unwritable.
//   2. WHERE NO USEFUL REASON CAN BE GIVEN, THE BUTTON SHOULD NOT BE DISABLED.
//      It should be live and refuse with an explanation, which is at least
//      readable.
//
// The sentences live HERE, in the kit, rather than in the views, because a
// sentence in a SwiftUI body is a sentence no test can read. Every one of them
// is a pure function of the state that disabled the button, and every one is
// held to the two rules below by `ImportAdviceTests`:
//
//   * it names what is missing, and
//   * it says what to do next -- an instruction, not a diagnosis.
import Foundation

/// The sentences that go beside an action that will not run yet.
public enum ImportAdvice {

    // MARK: - Bringing a statement in

    /// What "Set up this import…" is about to do, said before it is pressed.
    ///
    /// NEVER NIL, AND NEVER A REFUSAL ANY MORE. A statement is no longer
    /// refused for want of a book: a file that declares its own accounts can
    /// create them, and a file that does not can be given one. So this returns
    /// what pressing it will DO, and the one case that used to be a dead end --
    /// no book at all -- is now the case with the most to say.
    ///
    /// - Parameters:
    ///   - hasBook: whether this device holds a book at all.
    ///   - accountCount: live accounts in it. Zero is the "start empty" state.
    ///   - baseCurrency: the currency a book created here would be kept in.
    public static func statementSetupNote(
        hasBook: Bool, accountCount: Int, baseCurrency: String
    ) -> String {
        guard hasBook else {
            return "There is no book on this device yet, so this import would start one, "
                + "in \(baseCurrency). Nothing is written by setting it up \u{2014} you see "
                + "every account and every row it would create first, and it writes only when "
                + "you say so."
        }
        if accountCount == 0 {
            return "Your book has no accounts yet. If this file names its own accounts they "
                + "will be created for you; if it does not, you can name one. Nothing is "
                + "written until you have seen what it would do."
        }
        return "Nothing has been added. Setting up the import shows you exactly what it would "
            + "do first, row by row, and writes only when you say so."
    }

    // MARK: - The mapping step

    /// Why a file with no Account column cannot be previewed yet.
    ///
    /// Different advice on a book with accounts and a book without, because on
    /// an empty book "choose an account above" is an instruction that cannot be
    /// followed -- the picker is empty. That was the second dead end.
    public static func accountRequirement(bookHasAccounts: Bool) -> String {
        bookHasAccounts
            ? "an account \u{2014} choose one above, or map an Account column"
            : "an account \u{2014} name a new one above, or map an Account column"
    }

    /// Why an account being created for this file cannot be used yet.
    ///
    /// nil means it can: a name that is not blank and a currency this app can
    /// count in.
    public static func newAccountProblem(name: String, currency: String) -> String? {
        if Names.isBlank(name) {
            return "Give the new account a name \u{2014} whatever you will recognise it by on "
                + "the accounts screen."
        }
        // The kit's own rule, which is the one `saveAccount` will apply a
        // moment later. A screen that accepted what the writer refuses would be
        // a screen that gets as far as the confirmation and then fails.
        guard Validate.isCurrencyCode(Names.clean(currency).uppercased()) else {
            return "\u{201C}\(Names.clean(currency))\u{201D} is not a currency code. Three "
                + "letters, like GBP or EUR \u{2014} it fixes how many decimal places this "
                + "account\u{2019}s amounts have, so it cannot be guessed."
        }
        return nil
    }

    // MARK: - The preview step

    /// Why "Import n transactions" would write nothing, or nil when it would.
    ///
    /// FOUR CAUSES AND THEY ARE NOT THE SAME NEWS. The commonest by far is the
    /// good one -- the file is already in the book, which is what bringing the
    /// same statement back a second time looks like -- and telling somebody
    /// that in the same words as "every row failed" would be a lie by tone.
    public static func nothingToImportNote(
        rowsRead: Int, importableCount: Int, exactDuplicateCount: Int, nearDuplicateCount: Int,
        errorCount: Int, accountsToCreateCount: Int, hasNewAccounts: Bool
    ) -> String? {
        guard importableCount == 0 else { return nil }
        if rowsRead == 0 {
            return "There are no rows in this file to import. Check it is the export you meant "
                + "\u{2014} a file with only a header row reads as nothing."
        }
        if errorCount == rowsRead {
            return "Not one row in this file could be read. The counts above say why, and it is "
                + "almost always one column read the wrong way rather than a bad file."
        }
        if exactDuplicateCount + nearDuplicateCount == rowsRead {
            return "Every row in this file is already in your book, so there is nothing to add. "
                + "That is what bringing the same statement back a second time looks like."
        }
        if accountsToCreateCount == 0 && hasNewAccounts {
            return "Nothing will be added because every account this file needs is unticked "
                + "above. Tick at least one to bring its rows in."
        }
        return "Nothing in this file would be added. The counts above say why \u{2014} rows "
            + "already in your book, rows waiting on a decision, and rows that could not be read."
    }
}
