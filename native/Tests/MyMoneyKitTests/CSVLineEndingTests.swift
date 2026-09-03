// The line endings a real export arrives with.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT THIS SUITE EXISTS TO NOT HAVE AGAIN
//
// Every CSV fixture in this repository was written with "\n", so every one of
// them agreed with the parser. A file with "\r\n" endings -- the ending RFC
// 4180 specifies, the one every spreadsheet on Windows writes, and the one an
// export carrying a `sep=` hint for Excel almost certainly has -- came back as
// ONE row several thousand fields wide, because Swift's `Character` makes
// "\r\n" a single grapheme cluster that compares equal to neither "\r" nor
// "\n". `IncomingFile.kind` saw one row, and the owner was told their export
// "is not something this app can read", with nothing on screen about line
// endings and no way to find out.
//
// So these tests hold the SAME file in three line-ending conventions and
// require the three readings to be identical. Nothing here is about a corner
// case; LF is the only one of the three the parser had ever been shown.
//
// EVERY FIGURE, NAME AND PAYEE BELOW IS INVENTED.
import Foundation
import Testing

@testable import MyMoneyKit

struct CSVLineEndingTests {

    /// One small Report-shaped export, written with LF and nothing else.
    static let lf = """
        sep=,
        Name,Current balance,Account,Transfers,Description,Payee,Category,Date,Memo,Amount,Currency,Cheque N°,Tags,Balance
        Everyday,150.00,GBP,,,,,,,,,,,
        ,,Everyday,,Coffee,Kiosk,Food►Drinks,01/03/2026,,-3.50,GBP,,,146.50
        ,,Everyday,,Wages,Employer,Income►Salary,02/03/2026,,100.00,GBP,,,246.50
        Holiday,80.00,EUR,,,,,,,,,,,
        ,,Holiday,,Ferry,Ferries,Transport►Boat,03/03/2026,,-20.00,EUR,,,60.00
        """

    static var crlf: String { lf.replacingOccurrences(of: "\n", with: "\r\n") }
    /// Classic Mac endings. Rows still split, but the `sep=` hint is NOT
    /// stripped -- see `separatorHintFollowsTheOracle`.
    static var cr: String { lf.replacingOccurrences(of: "\n", with: "\r") }

    /// The two conventions a file in this century actually arrives with, and
    /// which must be indistinguishable to everything downstream.
    static let endings: [(name: String, text: String)] = [("LF", lf), ("CRLF", crlf)]

    // MARK: - The table

    @Test("THE SAME FILE READS THE SAME WAY WITH LF AND CRLF ENDINGS")
    func everyEndingReadsTheSame() {
        let expected = CSV.parse(Self.lf).data
        // Guard the guard: if the LF reading itself were one row, the
        // comparisons below would pass by agreeing on nonsense.
        #expect(expected.count == 6)
        #expect(expected.first?.count == 14)

        for (name, text) in Self.endings {
            let table = CSV.parse(text)
            #expect(table.data == expected, "\(name) disagreed with LF")
        }
    }

    @Test("a CR-only file still splits into rows")
    func carriageReturnOnlySplitsRows() {
        // Not folded into the loop above because of the hint line below: seven
        // rows here against six there, and that difference is the oracle's.
        let table = CSV.parse(Self.cr)
        #expect(table.data.count == 7)
        #expect(table.data.last?.count == 14)
    }

    @Test("the sep= hint is dropped for LF and CRLF, and the CR case follows the oracle")
    func separatorHintFollowsTheOracle() {
        for (name, text) in Self.endings {
            let table = CSV.parse(text)
            #expect(table.data.first?.first == "Name", "\(name) kept the sep= line")
            #expect(!(table.data.first?.contains { $0.contains("sep=") } ?? true))
        }
        // AND THE ONE PLACE THE THREE DELIBERATELY DIFFER. `stripSeparatorHint`
        // in src/import/generic.ts is `text.indexOf('\n')`, which is -1 on a
        // CR-only file, so the whole file becomes the "first line", the
        // `/^sep=.$/i` test fails against it and the hint stays. Matching the
        // web app matters more than tidiness here: the two must read every file
        // the same way, including the ones they both read imperfectly.
        #expect(CSV.parse(Self.cr).data.first == ["sep=", ""])
    }

    // MARK: - The door the owner actually met

    @Test("A CRLF STATEMENT IS ROUTED AS A STATEMENT, NOT REFUSED AS UNREADABLE")
    func crlfIsRecognisedAsAStatement() {
        for (name, text) in Self.endings {
            let data = Data(text.utf8)
            #expect(
                IncomingFile.kind(of: data, fileName: "Report.csv") == .csv,
                "\(name) was not recognised as a statement"
            )
        }
    }

    @Test("a CRLF file is recognised as the MoneyWiz Report layout")
    func crlfIsRecognisedAsAReport() {
        for (name, text) in Self.endings {
            let headers = (CSV.parse(text).data.first ?? []).map {
                $0.trimmingCharacters(in: .whitespaces)
            }
            #expect(Import.isMoneyWizReportCsv(headers: headers), "\(name) missed the layout")
        }
    }

    // MARK: - And the money that comes out of it

    @Test("EVERY ENDING PRODUCES THE SAME ROWS, ACCOUNTS AND OPENING BALANCES")
    func moneyIsIdenticalAcrossEndings() {
        // 150.00 − (−3.50 + 100.00) = 53.50, and 80.00 − (−20.00) = 100.00.
        for (name, text) in Self.endings {
            let parsed = Import.parseMoneyWizReportCsv(text, dateFormat: .auto)
            #expect(parsed.rows.count == 3, "\(name) read the wrong number of rows")
            #expect(parsed.accounts.map(\.name) == ["Everyday", "Holiday"], "\(name)")
            #expect(parsed.accounts.map(\.currency) == ["GBP", "EUR"], "\(name)")
            #expect(
                parsed.accounts.map(\.openingBalanceMinor) == [5350, 10000],
                "\(name) derived a different opening balance"
            )
            #expect(parsed.rows.compactMap(\.amountMinor) == [-350, 10000, -2000], "\(name)")
            // The category separator survives the ending it was written with.
            #expect(parsed.rows.first?.categoryPath == ["Food", "Drinks"], "\(name)")
        }
    }

    @Test("a quoted field may hold a CRLF of its own without ending the row")
    func quotedNewlinesSurvive() {
        let text = "a,b\r\n\"line one\r\nline two\",second\r\n"
        let table = CSV.parse(text)
        #expect(table.data.count == 2)
        #expect(table.data[1] == ["line one\r\nline two", "second"])
    }

    // MARK: - The register's own first-line rule

    @Test("the first line of a CRLF note is its first line")
    func firstLineOfACRLFNote() {
        // The TypeScript's `indexOf('\n')` finds the LF of the pair and the
        // slice keeps the CR, so "one\r" is the answer to match -- not the
        // whole note, which is what a grapheme search returned.
        #expect(Register.firstLine("one\r\ntwo") == "one\r")
        #expect(Register.firstLine("one\ntwo") == "one")
        #expect(Register.firstLine("one line") == "one line")
    }
}
