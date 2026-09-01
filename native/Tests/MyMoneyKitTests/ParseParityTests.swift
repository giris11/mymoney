// Parity with the TypeScript parser, on a table far wider than the oracle's.
//
// WHERE THESE EXPECTATIONS CAME FROM, and why saying so matters. Every value in
// the table below was produced by calling the REAL `parseAmountToMinor` in
// src/money/money.ts, once, and writing down what it said. That makes them
// "derived" in the oracle's own sense: they prove AGREEMENT between two
// implementations, never that either is right. The oracle's hand-calculated
// cases are what prove the answers are right. This proves that the hundred
// small decisions the TypeScript makes and the oracle never asks about -- what
// happens to a stray group separator, whether a lowercase currency code is
// stripped, what a bare "1." means, how fullwidth digits are treated -- were
// PORTED rather than reinvented.
//
// A DIVERGENCE HERE IS NOT AUTOMATICALLY A BUG, but it is automatically a
// DECISION. Exactly one is permitted, and the test below insists on knowing
// precisely how many there are, so a second one cannot arrive unnoticed.
import Testing

@testable import MyMoneyKit

struct ParseParityTests {
    /// (input, GBP with dot decimals, JPY with dot decimals, EUR with comma decimals)
    static let table: [(String, Int64?, Int64?, Int64?)] = [
        ("0", 0, 0, 0),
        ("12", 1200, 12, 1200),
        ("12.34", 1234, nil, 123400),
        ("0.05", 5, nil, 500),
        ("1,234.56", 123456, nil, nil),
        ("-45.67", -4567, nil, -456700),
        ("(45.67)", -4567, nil, -456700),
        ("£99.99", 9999, nil, 999900),
        ("GBP 5.00", 500, nil, 50000),
        ("5.00 GBP", 500, nil, 50000),
        ("+5.00", 500, nil, 50000),
        ("1.5", 150, nil, 1500),
        (".5", 50, nil, 500),
        ("-0.00", 0, nil, 0),
        ("1,,2.00", 1200, nil, nil),
        ("1,2,3,4.56", 123456, nil, nil),
        (",1234.56", 123456, nil, nil),
        ("  12.34  ", 1234, nil, 123400),
        ("1 234.56", 123456, nil, 12345600),
        ("(£45.67)", -4567, nil, -456700),
        ("(-45.67)", -4567, nil, -456700),
        ("abc", nil, nil, nil),
        ("1.2.3", nil, nil, 12300),
        ("--5", nil, nil, nil),
        ("1e5", nil, nil, nil),
        ("5 - 3", nil, nil, nil),
        ("£", nil, nil, nil),
        ("()", nil, nil, nil),
        ("+-1", nil, nil, nil),
        ("1.239", nil, nil, 123900),
        ("$1,000.00", 100000, nil, nil),
        ("USD5.00", 500, nil, 50000),
        ("5.00USD", 500, nil, 50000),
        ("5.00usd", 500, nil, 50000),
        ("abcd", nil, nil, nil),
        ("GBPGBP", nil, nil, nil),
        ("1.", 100, 1, 100),
        ("", nil, nil, nil),
        (".", nil, nil, nil),
        ("-", nil, nil, nil),
        (".00", 0, nil, 0),
        ("00012.34", 1234, nil, 123400),
        ("1 2 3.45", 12345, nil, 1234500),
        ("€12,34", 123400, 1234, 1234),
        ("12,5", 12500, 125, 1250),
        ("1.234,56", nil, nil, 123456),
        ("99999999999999999999", nil, nil, nil),
        ("90071992547409.93", nil, nil, nil),
        ("92233720368547758.07", nil, nil, nil),
        ("92233720368547758.08", nil, nil, nil),
        ("(1.5", nil, nil, nil),
        ("1.5)", nil, nil, nil),
        ("₹500", 50000, 500, 50000),
        ("¥500", 50000, 500, 50000),
        ("1,234", 123400, 1234, nil),
        ("-£1.00", -100, nil, -10000),
        ("£-1.00", -100, nil, -10000),
        ("1_000.00", nil, nil, nil),
        ("１２.３４", nil, nil, nil),
    ]

    /// The one sanctioned divergence: the TypeScript REFUSED because the answer
    /// is past Number.MAX_SAFE_INTEGER, and Swift accepted it because Int64
    /// holds it exactly. Anything else is a port bug.
    ///
    /// Note the asymmetry: Swift accepting more is safe for reading the owner's
    /// data and unsafe only for writing a file the browser will later read --
    /// which is why BackupImporter warns about exactly these amounts rather
    /// than pretending the ceiling is still there.
    func isTheSanctionedDivergence(swift: Int64?, typeScript: Int64?) -> Bool {
        guard typeScript == nil, let swift else { return false }
        return swift.magnitude > UInt64(BackupImporter.javaScriptSafeInteger)
    }

    @Test("parseToMinor agrees with src/money/money.ts across the whole table")
    func agreesWithTypeScript() {
        var divergences = 0
        for (input, gbp, jpy, eurComma) in Self.table {
            for (currency, separator, expected) in [
                ("GBP", DecimalSeparator.dot, gbp),
                ("JPY", DecimalSeparator.dot, jpy),
                ("EUR", DecimalSeparator.comma, eurComma),
            ] {
                let got = Money.parseToMinor(input, currency: currency, decimal: separator)
                if got == expected { continue }
                if isTheSanctionedDivergence(swift: got, typeScript: expected) {
                    divergences += 1
                    continue
                }
                Issue.record(
                    """
                    \(currency)/\(separator) parse of \(String(reflecting: input)): \
                    Swift says \(got.map(String.init) ?? "refused"), \
                    TypeScript says \(expected.map(String.init) ?? "refused")
                    """
                )
            }
        }
        // Three: "90071992547409.93" read as GBP and as EUR-with-comma, and
        // "92233720368547758.07" read as GBP. If this number moves, a new
        // divergence has appeared and needs a reason.
        #expect(divergences == 3, "the set of sanctioned divergences has changed")
    }

    @Test("the table is the size it was captured at")
    func tableIsIntact() {
        // A guard against a row being deleted to make a failure go away.
        #expect(Self.table.count == 59)
    }
}
