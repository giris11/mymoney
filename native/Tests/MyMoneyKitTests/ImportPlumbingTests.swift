// What the oracle cannot reach about reading a file.
//
// The import fixtures state what the PARSERS produce for particular files.
// They cannot state the things underneath: that a quoted field may contain the
// delimiter and a newline, that `sep=,` is a directive and not a row, that a
// tag cell containing a semicolon does not also split on its commas. Each of
// those is a place where a plausible implementation silently loses or invents
// one of the owner's transactions, so each gets a test here.
import Testing

@testable import MyMoneyKit

struct CSVTests {
    @Test("a quoted field may contain the delimiter, a newline and an escaped quote")
    func quoting() {
        let table = CSV.parse("a,b,c\n\"x,1\",\"line1\nline2\",\"say \"\"hi\"\"\"\n")
        #expect(table.data.count == 2)
        #expect(table.data[1] == ["x,1", "line1\nline2", "say \"hi\""])
    }

    @Test("a quote that is not the first character of its field is a literal quote")
    func lateQuoteIsLiteral() {
        // PapaParse only treats a field as quoted when the quote opens it, and
        // bank exports really do contain values like 12" — reading that as the
        // start of a quoted field would swallow the rest of the file.
        let table = CSV.parse("a,b\n12\" pipe,ok\n")
        #expect(table.data[1] == ["12\" pipe", "ok"])
    }

    @Test("a UTF-8 BOM does not become part of the first header")
    func bom() {
        let table = CSV.parse("\u{FEFF}Date,Amount\n2026-01-01,1.00\n")
        #expect(table.data[0] == ["Date", "Amount"])
    }

    @Test("`sep=,` is a directive to a spreadsheet, and only when that is the whole line")
    func separatorHint() {
        let hinted = CSV.parse("sep=,\nDate,Amount\n2026-01-01,1.00\n")
        #expect(hinted.data[0] == ["Date", "Amount"], "the hint line must not become the header")

        // A real header that merely STARTS with 'sep=' keeps all of its rows —
        // the test is "sep= plus exactly one character", not a prefix match.
        let notAHint = CSV.parse("sep=,Date,Amount\n2026-01-01,1.00,x\n")
        #expect(notAHint.data.count == 2)
        #expect(notAHint.data[0] == ["sep=", "Date", "Amount"])

        // And the BOM comes first in the file, so the hint is still found.
        let both = CSV.parse("\u{FEFF}sep=;\nDate;Amount\n2026-01-01;1,00\n")
        #expect(both.data[0] == ["Date", "Amount"])
    }

    @Test("blank and whitespace-only lines are dropped before the header is picked")
    func greedyEmptyLines() {
        let table = CSV.parse("\n   \nDate,Amount\n\n2026-01-01,1.00\n,,\n")
        #expect(table.data.count == 2)
        #expect(table.data[0] == ["Date", "Amount"])
    }

    @Test("the delimiter is detected from the file, and falls back to a comma")
    func delimiterDetection() {
        // Semicolons, with commas inside the amounts: the German bank layout.
        #expect(CSV.guessDelimiter("Date;Desc;Amount\n01.02.2026;Shop;-1.234,56\n") == ";")
        // Commas, with a semicolon inside a quoted tag cell.
        #expect(CSV.guessDelimiter("Date,Tags,Amount\n2026-01-01,\"a;b\",-1.00\n") == ",")
        #expect(CSV.guessDelimiter("Date\tDesc\tAmount\n2026-01-01\tShop\t-1.00\n") == "\t")
        // A single-column file gives no candidate two fields wide, so nothing
        // qualifies and the caller's comma stands.
        #expect(CSV.guessDelimiter("Balance\n1.00\n2.00\n") == nil)
    }
}

struct MoneyWizParsingTests {
    private let header =
        "Account,Transfers,Description,Payee,Category,Date,Time,Memo,Amount,Currency,Check #,Tags,Balance\n"

    @Test("a semicolon in a tag cell means its commas are part of the tag names")
    func tagSplitting() {
        let csv = header
            + "Cur,,Trip,Airline,Travel,01/02/2026,,,\"-100.00\",GBP,,\"Holiday, Spain;work\",\n"
        let result = Import.parseMoneyWizCsv(csv)
        // Splitting on both separators at once tore this into three tags and
        // threw away information the file stated unambiguously.
        #expect(result.rows[0].tags == ["Holiday, Spain", "work"])

        let commaOnly = header
            + "Cur,,Trip,Airline,Travel,01/02/2026,,,\"-100.00\",GBP,,\"food,weekly\",\n"
        #expect(Import.parseMoneyWizCsv(commaOnly).rows[0].tags == ["food", "weekly"])
    }

    @Test("a '/' category is only split when the column contains no '>' anywhere, and it is said out loud")
    func slashFallbackIsWarned() {
        let slashed = header
            + "Cur,,One,Shop,Kids/School,01/02/2026,,,-10.00,GBP,,,\n"
        let result = Import.parseMoneyWizCsv(slashed)
        #expect(result.rows[0].categoryPath == ["Kids", "School"])
        #expect(
            result.warnings.contains { $0.contains("Kids/School") },
            "inventing a category level must be reported, not done quietly"
        )

        // One '>' anywhere in the column and the slash stops being a separator.
        let mixed = slashed + "Cur,,Two,Shop,Bills > Water,02/02/2026,,,-20.00,GBP,,,\n"
        let mixedResult = Import.parseMoneyWizCsv(mixed)
        #expect(mixedResult.rows[0].categoryPath == ["Kids/School"])
        #expect(mixedResult.rows[1].categoryPath == ["Bills", "Water"])
        #expect(!mixedResult.warnings.contains { $0.contains("split on") })
    }

    @Test("the Report test must be asked before the flat test, and this is why")
    func detectionPrecedence() {
        let reportHeaders = [
            "Name", "Current balance", "Account", "Transfers", "Description", "Payee",
            "Category", "Date", "Memo", "Amount", "Currency", "Cheque N°", "Tags", "Balance",
        ]
        // BOTH are true for a Report file. A caller that asks the flat question
        // first reads every account header row as a dateless transaction and
        // derives no opening balance at all.
        #expect(Import.isMoneyWizReportCsv(headers: reportHeaders))
        #expect(Import.isMoneyWizCsv(headers: reportHeaders))
    }
}

struct MoneyWizReportBalanceTests {
    private let header =
        "\"Name\",\"Current balance\",\"Account\",\"Transfers\",\"Description\",\"Payee\","
        + "\"Category\",\"Date\",\"Memo\",\"Amount\",\"Currency\",\"Cheque N°\",\"Tags\",\"Balance\"\n"

    @Test("the opening balance is refused, not guessed, when the currency cannot be read")
    func unknownCurrencyRefusesTheBalance() {
        // Without a currency there is no minor-unit SCALE. Reading "42.00" at
        // the 2-decimal fallback and then landing the account in JPY would put
        // the opening balance out by a factor of 100, invisibly and for ever.
        let csv = header
            + "\"Pocket\",\"42.00\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"\n"
        let result = Import.parseMoneyWizReportCsv(csv)
        #expect(result.accounts[0].currency == "")
        #expect(result.accounts[0].openingBalanceMinor == nil)
        #expect(result.warnings.contains { $0.contains("No currency could be read") })
    }

    @Test("an unreadable current balance refuses the opening balance and names the account")
    func unreadableBalance() {
        let csv = header
            + "\"Pocket\",\"about fifty quid\",\"GBP\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"\n"
        let result = Import.parseMoneyWizReportCsv(csv)
        #expect(result.accounts[0].currentBalanceMinor == nil)
        #expect(result.accounts[0].openingBalanceMinor == nil)
        #expect(result.warnings.contains { $0.contains("unreadable “Current balance”") })
    }

    @Test("a repeated account header keeps the FIRST balance and says the file repeated itself")
    func duplicateAccountHeaders() {
        let csv = header
            + "\"Pocket\",\"10.00\",\"GBP\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"\n"
            + "\"POCKET\",\"99.00\",\"GBP\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"\n"
        let result = Import.parseMoneyWizReportCsv(csv)
        // Matching is case- and whitespace-insensitive, so "POCKET" is the same
        // account, not a second one.
        #expect(result.accounts.count == 1)
        #expect(result.accounts[0].currentBalanceMinor == 1000)
        #expect(result.warnings.contains { $0.contains("repeated in this file") })
    }

    @Test("the derivation is order-independent, so the export's own running balance is irrelevant")
    func orderIndependence() {
        func rows(_ order: [String]) -> String {
            header
                + "\"Pocket\",\"100.00\",\"GBP\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\",\"\"\n"
                + order.joined()
        }
        let a = "\"\",\"\",\"Pocket\",\"\",\"A\",\"P\",\"\",\"01/03/2026\",\"\",\"-10.00\",\"GBP\",\"\",\"\",\"999.99\"\n"
        let b = "\"\",\"\",\"Pocket\",\"\",\"B\",\"P\",\"\",\"01/03/2026\",\"\",\"25.00\",\"GBP\",\"\",\"\",\"0.01\"\n"
        // The running "Balance" column is deliberate nonsense in both files.
        let forwards = Import.parseMoneyWizReportCsv(rows([a, b])).accounts[0].openingBalanceMinor
        let backwards = Import.parseMoneyWizReportCsv(rows([b, a])).accounts[0].openingBalanceMinor
        #expect(forwards == 8500)  // 10000 − (−1000 + 2500)
        #expect(forwards == backwards)
    }
}

struct DedupePlumbingTests {
    @Test("normalisation keeps letters and digits from every script, and drops the rest")
    func normalisationKeepsLetters() {
        #expect(Dedupe.normalizeForHash("Café Paris") == "café paris")
        #expect(Dedupe.normalizeForHash("Ελλάδα") == "ελλάδα")
        #expect(Dedupe.normalizeForHash("東京 Store #3") == "東京 store 3")
        // Stripping to ASCII instead would make this "caf paris" and stop the
        // same payee, written the same way, matching itself.
        #expect(Dedupe.normalizeForHash("Café") != "caf")
    }

    @Test("distance and containment are measured in the same units the TypeScript uses")
    func utf16Units() {
        // A combining acute is two UTF-16 units and one Swift Character. The
        // TypeScript measures the first; so must this, or the 25% threshold in
        // similarPayee means something different in each language.
        let composed = "e\u{0301}"
        #expect(Dedupe.levenshtein("e", composed) == 1)
        #expect(Dedupe.levenshtein("", composed) == 2)
    }

    @Test("an exact duplicate wins over a near one, whatever order the rows arrive in")
    func exactBeatsNear() {
        func tx(_ id: String, _ date: String, _ payee: String) -> Transaction {
            Transaction(
                id: id, accountId: "a", date: date, amountMinor: -500, currency: "GBP",
                dedupeHash: Dedupe.makeDedupeHash(
                    accountId: "a", date: date, amountMinor: -500, payeeOrDescription: payee
                )
            )
        }
        let candidate = Dedupe.Candidate(
            accountId: "a", date: "2026-03-05", amountMinor: -500, payeeOrDescription: "Tesco"
        )
        // The near candidate is listed first; the exact one must still win,
        // because an exact duplicate is auto-skipped and a near one is a
        // question for a human.
        let result = Dedupe.checkDuplicate(
            candidate,
            existingByAccount: [tx("near", "2026-03-04", "Tesco"), tx("exact", "2026-03-05", "Tesco")],
            payeeNameOf: { _ in "Tesco" }
        )
        #expect(result.exact)
        #expect(result.nearDuplicateOf == nil)
    }
}
