// How a typed name becomes a stored name, and how two typed names are decided
// to be the same name.
//
// ONE DEFINITION, because the alternative is a ledger with two payees called
// "Sainsburys" that differ by a space nobody can see. The web app states this
// rule as `nameKey` in src/lib/util.ts and applies it in payees.ts, tags.ts and
// accounts.ts; this is the same rule, character for character, so a payee
// created on the phone and a payee created in the browser collapse onto the
// same row rather than becoming two.
//
// THE WHITESPACE SET IS JAVASCRIPT'S, NOT FOUNDATION'S. `Money.jsWhitespace`
// already carries it (it is what `String.prototype.trim` and `\s` mean), and it
// differs from `.whitespacesAndNewlines` at U+00A0 and U+FEFF among others --
// both of which arrive routinely from a copy-paste out of a bank statement. A
// port that trimmed with Foundation's set would decide that " Tesco" pasted
// with a non-breaking space is a DIFFERENT payee from "Tesco", and would be
// right about the bytes and wrong about the money.
import Foundation

public enum Names {
    /// The name as it will be STORED: trimmed, with every run of whitespace
    /// collapsed to one ordinary space.
    ///
    /// This is what the owner sees afterwards, so it keeps their capitals.
    public static func clean(_ input: String) -> String {
        var out = ""
        var pendingSpace = false
        for character in Money.trimmingJSWhitespace(input) {
            if Money.jsWhitespace.contains(character) {
                pendingSpace = true
                continue
            }
            if pendingSpace {
                out.append(" ")
                pendingSpace = false
            }
            out.append(character)
        }
        return out
    }

    /// The name as it will be MATCHED: `clean`, lowercased. This is what goes
    /// into `payees.name_lower` and `tags.name_lower`, and what the
    /// case-insensitive indexes are over.
    public static func key(_ input: String) -> String {
        clean(input).lowercased()
    }

    /// Is this name empty once cleaned? Asked before a save, so that a field
    /// containing only spaces is refused as blank rather than stored as "".
    public static func isBlank(_ input: String) -> Bool {
        clean(input).isEmpty
    }
}
