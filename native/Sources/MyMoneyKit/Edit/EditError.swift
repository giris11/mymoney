// Every way an edit is refused, and the two sentences each refusal owes the
// person who hit it.
//
// THE CONTRACT: a refusal says WHAT WAS WRONG and WHAT WAS NOT CHANGED. Both
// halves, always, and the second half is not politeness. Somebody who taps Save
// on a split that is a penny short, sees "Invalid", and closes the sheet has no
// way of knowing whether the other four fields they just edited went in. They
// will re-enter them. Half the time they will re-enter them onto a row that
// already took them, and the ledger acquires a duplicate that nobody can
// explain a month later. "Nothing was saved" is the sentence that stops that,
// and it is TRUE here structurally rather than by intention: every mutation in
// this package runs inside one SQLite transaction, and every one of these
// errors is thrown from inside it, so the rollback has already happened by the
// time anybody reads the words.
//
// The two halves are separate properties, not one string, because the UI wants
// them in different weights -- the problem is the headline, "nothing was
// changed" is the reassurance underneath it -- and because a test that asserts
// the reassurance is present can then do so without matching prose.
import Foundation

public enum EditError: Error, Sendable, Hashable, CustomStringConvertible {

    // MARK: - Shapes of value

    /// A name field that is empty, or is only whitespace.
    case blankName(what: String)
    /// A date that is not a real calendar day in YYYY-MM-DD form.
    case badDate(String)
    /// A currency code that is not three letters.
    case badCurrency(String)
    /// A colour that is not "#rgb" or "#rrggbb".
    case badColour(String)

    // MARK: - Things that are not there

    /// An edit asked for on a device that holds no book at all. Not "the row
    /// is missing": there is nothing here to edit yet, and the answer is to
    /// start a book or import one rather than to try again.
    case noBook
    case unknownAccount(String)
    case unknownGroup(String)
    case unknownCategory(String)
    case unknownTransaction(String)
    case unknownBudget(String)
    /// A transfer group with no legs, or with a number of legs other than two.
    case transferNotFound(groupId: String, legs: Int)
    /// Two legs, but not one out and one in.
    case transferLegsInconsistent(groupId: String)

    // MARK: - Splits

    /// The splits do not add up to the parent. Carries both figures and the
    /// currency, so the message is money rather than minor units.
    case splitsDoNotBalance(splitTotalMinor: Int64, amountMinor: Int64, currency: String)
    /// The split lines do not fit in Int64, so there is no total to compare.
    /// Not money; a typo.
    case splitsUnrepresentable

    // MARK: - Transfers

    case transferNeedsTwoAccounts
    /// A transfer amount that is zero or negative. The SIGN is decided by which
    /// leg it is, so the magnitude has to be positive.
    case transferAmountNotPositive(side: TransferSide, amountMinor: Int64, currency: String)
    /// Editing one leg of a transfer as though it were an ordinary
    /// transaction. Refused, because writing one leg without the other is how a
    /// transfer becomes two unrelated rows that no longer cancel.
    case transactionIsTransferLeg(otherAccountName: String?)

    // MARK: - Things being protected

    /// Changing an account's currency when it already has transactions in the
    /// old one.
    case currencyIsLocked(accountName: String, from: String, to: String, transactionCount: Int)
    /// Deleting an account that still has transactions. Archiving is the
    /// supported way to retire an account with history.
    case accountHasTransactions(accountName: String, count: Int)
    /// Deleting a group that still contains accounts.
    case groupHasAccounts(groupName: String, count: Int)
    /// A name that another row of the same kind already has.
    case nameTaken(what: String, name: String)

    // MARK: - Budgets

    /// A budget limit that is zero or negative. Refused rather than stored,
    /// matching `saveBudget` in the web app: a budget of nothing is not a
    /// limit anybody can be under or over, and the progress bar it produces
    /// would divide by zero to draw itself.
    case budgetAmountNotPositive(Int64)
    /// A budget covering no categories. It would match no spending at all, so
    /// it would report 0 spent for ever and look like the owner was doing
    /// wonderfully.
    case budgetNeedsACategory

    // MARK: - Schedules

    case unknownSchedule(String)
    /// A schedule for nothing. Refused by the schema too -- see migration 4.
    case scheduleAmountIsZero
    /// An end date before the start date: a schedule with no occurrences.
    case scheduleEndsBeforeItStarts(start: String, end: String)
    /// "Ends after 0 payments", which is not an arrangement.
    case scheduleCountNotPositive(Int)
    /// Entering a payment from a schedule that is switched off.
    case scheduleIsPaused(name: String)
    /// A date that is not on the schedule's calendar at all. Usually means the
    /// schedule's dates were changed since the screen was drawn.
    case notAnOccurrence(scheduleName: String, date: String)
    /// This occurrence has already been entered, or already skipped.
    case occurrenceAlreadySettled(scheduleName: String, date: String, posted: Bool)

    // MARK: - Importing a statement

    /// An import batch that is not in the book: already undone, or never here.
    case unknownImportBatch(String)
    /// A preview that would write nothing at all -- every row of the file is
    /// either already in the book or could not be read, and there is no new
    /// account to make either. Refused rather than committed as an empty batch:
    /// "nothing happened" is a sentence, and a batch of nothing in the import
    /// list is a puzzle.
    case importWouldWriteNothing(rowsRead: Int, duplicates: Int, unreadable: Int)
    /// The account a preview worked its figures out against now holds a
    /// different currency, so the amounts in the preview are at the wrong
    /// SCALE (D31) -- and a hundredfold error written into a ledger is not
    /// recoverable by looking at it.
    case importPlanIsStale(accountName: String, plannedIn: String, nowHolds: String)

    // MARK: - Undo

    /// An undo for something that is not deleted (already restored, or never
    /// deleted at all).
    case nothingToRestore(what: String)

    public enum TransferSide: String, Sendable, Hashable {
        case sent, received
    }

    // MARK: - The two sentences

    /// What was wrong. One sentence, in the owner's vocabulary, naming the
    /// actual values wherever naming them helps.
    public var problem: String {
        switch self {
        case .blankName(let what):
            return "A \(what) needs a name."
        case .badDate(let date):
            return "\u{201C}\(date)\u{201D} is not a date. Use the form 2026-09-02."
        case .badCurrency(let code):
            return
                "\u{201C}\(code)\u{201D} is not a currency code. Use three letters, like GBP or EUR."
        case .badColour(let colour):
            return "\u{201C}\(colour)\u{201D} is not a colour. Use a hex value like #2563eb."

        case .noBook:
            return
                "There is no book on this device yet. Start one, or import a backup, and then "
                + "this can be changed."
        case .unknownAccount(let id):
            return "That account is not in this copy of the book (\(short(id)))."
        case .unknownGroup(let id):
            return "That account group is not in this copy of the book (\(short(id)))."
        case .unknownCategory(let id):
            return "That category is not in this copy of the book (\(short(id)))."
        case .unknownTransaction(let id):
            return "That transaction is not in this copy of the book (\(short(id)))."
        case .unknownBudget(let id):
            return "That budget is not in this copy of the book (\(short(id)))."
        case .transferNotFound(let groupId, let legs):
            return
                "This transfer has \(legs) leg\(legs == 1 ? "" : "s") in the book, and a transfer "
                + "is always exactly two (\(short(groupId)))."
        case .transferLegsInconsistent(let groupId):
            return
                "This transfer\u{2019}s two legs do not read as one out and one in "
                + "(\(short(groupId))), so there is no safe way to apply an edit to both."

        case .splitsDoNotBalance(let splitTotal, let amount, let currency):
            // SAME DIRECTION RULE AS `SplitTally`, and for the same reason: an
            // expense is negative, so lines that have not yet reached it leave
            // a NEGATIVE remainder and are nonetheless SHORT. Deciding the word
            // from the sign alone gets every expense in the book backwards.
            let difference = amount &- splitTotal
            let short = amount != 0 && (difference > 0) == (amount > 0)
            return
                "The splits come to \(Money.format(splitTotal, currency: currency)) but the "
                + "transaction is \(Money.format(amount, currency: currency)) \u{2014} "
                + "\(short ? "short by" : "over by") "
                + "\(Money.format(abs(difference), currency: currency))."
        case .splitsUnrepresentable:
            return
                "These split figures are too large to be money \u{2014} adding them up does not "
                + "fit in a whole number of pence."

        case .transferNeedsTwoAccounts:
            return "A transfer needs two different accounts \u{2014} money cannot move to itself."
        case .transferAmountNotPositive(let side, let amount, let currency):
            return
                "The amount \(side.rawValue) is \(Money.format(amount, currency: currency)). "
                + "Enter how much moved, as a positive figure; which way it goes is decided by "
                + "the two accounts."
        case .transactionIsTransferLeg(let other):
            let where_ = other.map { " with \($0)" } ?? ""
            return
                "This row is one half of a transfer\(where_). Editing it on its own would leave "
                + "the two halves disagreeing, so transfers are edited as a pair."

        case .currencyIsLocked(let name, let from, let to, let count):
            return
                "\u{201C}\(name)\u{201D} already holds \(count) transaction"
                + "\(count == 1 ? "" : "s") recorded in \(from), and every one of those amounts "
                + "IS a \(from) amount. Switching the account to \(to) would silently re-label "
                + "them all. Make a new \(to) account instead."
        case .accountHasTransactions(let name, let count):
            return
                "\u{201C}\(name)\u{201D} still has \(count) transaction\(count == 1 ? "" : "s") "
                + "in it. Archive it instead \u{2014} an archived account keeps its history and "
                + "its balance, and drops out of your totals."
        case .groupHasAccounts(let name, let count):
            return
                "\u{201C}\(name)\u{201D} still contains \(count) account"
                + "\(count == 1 ? "" : "s"). Move them somewhere else first."
        case .nameTaken(let what, let name):
            return "There is already a \(what) called \u{201C}\(name)\u{201D}."

        case .budgetAmountNotPositive(let amount):
            return amount == 0
                ? "A budget needs an amount to be a limit. Enter what you want to keep under."
                : "A budget amount has to be a positive figure \u{2014} enter the limit itself, "
                    + "not what is left."
        case .budgetNeedsACategory:
            return
                "Choose at least one category. A budget over no categories would match no "
                + "spending, and would report nothing spent for ever."

        case .unknownSchedule(let id):
            return "That schedule is not in this copy of the book (\(short(id)))."
        case .scheduleAmountIsZero:
            return
                "A schedule needs an amount. A standing payment of nothing would sit in your "
                + "list looking real and enter rows of zero for ever."
        case .scheduleEndsBeforeItStarts(let start, let end):
            return
                "This schedule would end on \(end), before it starts on \(start), so it has no "
                + "payments in it at all."
        case .scheduleCountNotPositive(let count):
            return
                "\u{201C}Ends after \(count) payments\u{201D} is not an arrangement. Enter how "
                + "many there are, or choose an end date instead."
        case .scheduleIsPaused(let name):
            return
                "\u{201C}\(name)\u{201D} is paused, so its payments are not due. Resume it "
                + "first if you want to enter this one."
        case .notAnOccurrence(let name, let date):
            return
                "\(date) is not a date \u{201C}\(name)\u{201D} falls on. Its dates may have "
                + "been changed since this screen was drawn \u{2014} open it again to see what "
                + "is due now."
        case .occurrenceAlreadySettled(let name, let date, let posted):
            return posted
                ? "The \(date) payment for \u{201C}\(name)\u{201D} is already in your book. "
                    + "Delete that transaction if it should not be."
                : "The \(date) payment for \u{201C}\(name)\u{201D} was skipped. Take the skip "
                    + "back if you want to enter it after all."

        case .unknownImportBatch(let id):
            return
                "That import is not in this copy of the book (\(short(id))). It may already "
                + "have been undone."
        case .importWouldWriteNothing(let rowsRead, let duplicates, let unreadable):
            var reasons: [String] = []
            if duplicates > 0 {
                reasons.append(
                    "\(duplicates) \(duplicates == 1 ? "is" : "are") already in your book")
            }
            if unreadable > 0 {
                reasons.append("\(unreadable) could not be read")
            }
            let because = reasons.isEmpty ? "" : " \u{2014} " + reasons.joined(separator: ", ")
            return
                "There is nothing in this file to add. Of \(rowsRead) row"
                + "\(rowsRead == 1 ? "" : "s")\(because)."
        case .importPlanIsStale(let name, let plannedIn, let nowHolds):
            return
                "\u{201C}\(name)\u{201D} is now held in \(nowHolds), and this preview worked "
                + "its amounts out in \(plannedIn). Those two do not divide into pence the same "
                + "way, so importing now could be out by a factor of a hundred. Read the file "
                + "again to get a fresh preview."

        case .nothingToRestore(let what):
            return "That \(what) is not in the bin \u{2014} there is nothing to bring back."
        }
    }

    /// What was NOT changed. The half that stops somebody re-entering work the
    /// app already has, or re-entering work the app does not have.
    public var unchanged: String {
        switch self {
        case .accountHasTransactions, .groupHasAccounts:
            // Nothing was even attempted here: the refusal is the answer to a
            // request to delete, so "nothing was saved" would be the wrong
            // shape of sentence.
            return "Nothing was deleted."
        case .nothingToRestore:
            return "Nothing was changed."
        case .unknownImportBatch, .importWouldWriteNothing, .importPlanIsStale:
            // The half that matters most on this path: an import writes money,
            // so somebody who taps Import, reads a refusal and taps it again
            // must know the first tap put nothing in.
            return "Nothing was imported, and your book is unchanged."
        case .transactionIsTransferLeg:
            return "Nothing was saved \u{2014} both halves are still exactly as they were."
        case .currencyIsLocked:
            return
                "Nothing was saved \u{2014} the account, its currency and all its transactions "
                + "are exactly as they were."
        case .splitsDoNotBalance, .splitsUnrepresentable:
            return "Nothing was saved \u{2014} the transaction is still as it was."
        case .budgetAmountNotPositive, .budgetNeedsACategory:
            return "Nothing was saved \u{2014} the budget is still as it was."
        case .scheduleAmountIsZero, .scheduleEndsBeforeItStarts, .scheduleCountNotPositive:
            return "Nothing was saved \u{2014} the schedule is still as it was."
        case .scheduleIsPaused, .notAnOccurrence, .occurrenceAlreadySettled:
            // The half that matters most here: somebody who taps Enter twice
            // must know the second tap did not enter a second payment.
            return "No transaction was entered, and your book is unchanged."
        default:
            return "Nothing was changed."
        }
    }

    /// Both sentences, which is what a caller with one label to fill shows.
    public var description: String { "\(problem) \(unchanged)" }

    /// An id, shortened for a message. The whole thing is 36 characters of
    /// hex that means nothing to a reader; the first eight are enough to tell
    /// two of them apart in a bug report.
    private func short(_ id: String) -> String {
        id.count <= 12 ? id : String(id.prefix(8)) + "\u{2026}"
    }
}
