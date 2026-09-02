// Turning something said out loud into a draft the store will accept.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE ONE PLACE A DOUBLE IS ALLOWED NEAR MONEY, AND WHY
//
// This package's first rule is that money is an Int64 of minor units and never
// a Double. That rule is about STORAGE and ARITHMETIC, and it is not negotiable.
//
// But an App Intent parameter is typed by the system, and the type the system
// hands over for a spoken number is a `Double`. There is no way to ask iOS for
// minor units. So the Double arrives whether this package likes it or not, and
// the only question is what happens at the boundary: a multiply by 100 and a
// rounding rule invented here, or a conversion that REFUSES anything it cannot
// represent exactly.
//
// It refuses. `minorUnits(spokenAmount:currency:)` turns the Double into its
// own shortest decimal text -- which is what Swift's `description` is, and it
// round-trips -- and hands that to `Money.parseToMinor`, the same parser every
// amount field in the app uses. Everything follows from that:
//
//   * "four pounds" arrives as 4.0, becomes "4.0", becomes 400. Exact.
//   * 4.2 arrives as the Double nearest 4.2, whose shortest text is "4.2",
//     becomes 420. Exact.
//   * a value that is genuinely not a two-decimal amount -- 0.1 + 0.2 as a
//     Double, whose shortest text is "0.30000000000000004" -- is REFUSED, and
//     Siri says so, rather than a penny being invented or discarded.
//   * a currency with no minor units refuses "4.20" outright, because in that
//     currency there is no such amount.
//
// A REFUSAL IS THE FEATURE, exactly as it is in `Money.parseToMinor`. The one
// thing this must never do is silently produce a number the owner did not say.
//
// ─────────────────────────────────────────────────────────────────────────────
// AND THE SIGN IS DECIDED IN ONE PLACE
//
// A spoken "add a four pound coffee" is money LEAVING. The amount that arrives
// is a magnitude, and `expenseDraft` is the only thing that makes it negative --
// so a future second entry point cannot get the sign the other way round and
// turn a month of coffees into income.
import Foundation

public enum QuickEntry {

    /// A spoken or typed decimal amount, as minor units -- or nil, when it is
    /// not an amount this currency can hold. See the header.
    ///
    /// `magnitude` first: the caller asks for an amount, and the sign is
    /// applied afterwards by `expenseDraft`. A negative arriving here is taken
    /// as a magnitude rather than refused, because "minus four pounds" spoken
    /// into an expense means four pounds out, twice over -- and refusing it
    /// would be pedantry about a sentence with only one possible meaning.
    public static func minorUnits(spokenAmount value: Double, currency: String) -> Int64? {
        guard value.isFinite else { return nil }
        let magnitude = abs(value)
        // A ceiling well below the point where a Double's shortest text turns
        // into exponent notation ("1e+16"), which `parseToMinor` would refuse
        // anyway -- refused here instead so the reason is stateable.
        guard magnitude < 1e12 else { return nil }
        // Swift's `description` for a Double is its SHORTEST round-tripping
        // decimal, which is exactly the question being asked: what decimal
        // number did this Double come from?
        //
        // WITH ONE CORRECTION, and it is not cosmetic. That description always
        // carries a decimal point -- 420.0, never 420 -- and in a currency with
        // no minor units `parseToMinor` refuses "420.0" for having more decimal
        // places than the currency has. It is right to: "420.0" is a claim
        // about a tenth of a yen. But a Double that IS a whole number is not
        // making that claim, so it is written as the whole number it is, and
        // "four hundred and twenty yen" works.
        let text: String
        if magnitude == magnitude.rounded(.towardZero), let whole = Int64(exactly: magnitude) {
            text = String(whole)
        } else {
            text = "\(magnitude)"
        }
        return Money.parseToMinor(text, currency: currency)
    }

    /// Why an amount was not accepted, in the words Siri should say.
    public static func amountRefusal(_ value: Double, currency: String) -> String {
        guard value.isFinite, abs(value) < 1e12 else {
            return "That is not an amount I can add."
        }
        let places = Money.decimals(for: currency)
        if places == 0 {
            return "\(currency) has no pennies, so \"\(value)\" is not an amount in it."
        }
        return "\(currency) amounts go to \(places) decimal place\(places == 1 ? "" : "s"), and "
            + "\"\(value)\" has more. Nothing was added."
    }

    /// THE ONLY PLACE THE SIGN OF A QUICK ENTRY IS DECIDED.
    ///
    /// `amountMinor` is a magnitude; what comes back is negative, because
    /// spending is money out. Everything else on the draft is left exactly as
    /// the caller supplied it, so the store's own validation -- account exists,
    /// date is a date, splits add up -- is the only validation there is.
    public static func expenseDraft(
        accountId: String,
        date: String,
        amountMinor: Int64,
        payeeName: String = "",
        categoryId: String? = nil,
        notes: String = ""
    ) -> TransactionDraft {
        TransactionDraft(
            accountId: accountId,
            date: date,
            // `0 - x` is written as a guard rather than `-x` for the same
            // reason it is in `RegisterSearch.amounts`: negating `Int64.min`
            // traps, and this value came in from outside.
            amountMinor: amountMinor == Int64.min ? Int64.min : -abs(amountMinor),
            payeeName: payeeName,
            categoryId: categoryId,
            notes: notes
        )
    }

    /// The category a spoken or typed name means, or nil.
    ///
    /// THE ORDER IS: an exact leaf name, then an exact full path, then a leaf
    /// that contains the words, then a path that does. Exact first, because
    /// "Rail" must mean the category called Rail even in a book that also has
    /// "Railcards"; contains last, because a person saying "eating" means
    /// "Eating out" and should not have to say all of it.
    ///
    /// AMBIGUITY RESOLVES TO NOTHING, not to a guess. Two categories that match
    /// equally well return nil, and the transaction is written UNCATEGORISED --
    /// which the owner can see and fix in one tap, unlike a coffee quietly
    /// filed under Fuel.
    ///
    /// Archived categories are excluded: a new entry should not revive one.
    public static func category(named name: String, in choices: [CategoryChoice])
        -> CategoryChoice?
    {
        let key = Names.key(name)
        guard !key.isEmpty else { return nil }
        let live = choices.filter { !$0.archived }

        func only(_ matching: (CategoryChoice) -> Bool) -> CategoryChoice?? {
            let hits = live.filter(matching)
            if hits.isEmpty { return nil }      // nothing at this level; try the next
            if hits.count == 1 { return .some(hits[0]) }
            return .some(nil)                   // ambiguous; stop, and choose nothing
        }

        if let decided = only({ Names.key($0.name) == key }) { return decided }
        if let decided = only({ Names.key($0.path) == key }) { return decided }
        if let decided = only({ Names.key($0.name).contains(key) }) { return decided }
        if let decided = only({ Names.key($0.path).contains(key) }) { return decided }
        return nil
    }

    /// What Siri says back after a transaction is written.
    ///
    /// IT NAMES THE ACCOUNT, ALWAYS. The one thing that can go wrong with a
    /// spoken entry and never be noticed is landing in the wrong account, and
    /// the owner is not looking at a screen. It also says the CATEGORY when
    /// there is one and says "no category" when there is not, because silence
    /// reads as "filed correctly".
    public static func spokenConfirmation(
        amountMinor: Int64,
        currency: String,
        payeeName: String,
        accountName: String,
        categoryPath: String?
    ) -> String {
        let amount = Money.format(abs(amountMinor), currency: currency)
        var sentence = "Added \(amount)"
        let payee = Names.clean(payeeName)
        if !payee.isEmpty { sentence += " at \(payee)" }
        sentence += " to \(accountName)"
        if let categoryPath, !categoryPath.isEmpty {
            sentence += ", under \(categoryPath)"
        } else {
            sentence += ", with no category"
        }
        return sentence + "."
    }
}
