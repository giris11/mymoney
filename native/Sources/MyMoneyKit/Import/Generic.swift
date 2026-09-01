// Generic CSV import with a column mapping, ported from src/import/generic.ts
// (SPEC §7.2).
//
// THE ONE RULE THIS FILE EXISTS TO ENFORCE: detection is PER FILE, never per
// row. The date format and the decimal style are decided once, over the whole
// column, before a single row is read. A per-row guess would let one file mix
// interpretations — "05/06" read as June in one row and May in the next,
// "1.234" as a thousand in one row and as one-point-two in the next — and
// nothing downstream could ever detect it, because every individual row would
// look reasonable.
//
// AND THE SECOND RULE: an amount with more precision than the currency has is
// REFUSED, not rounded. "12.345" in GBP comes back nil and the row surfaces as
// an error the owner can see. Rounding it to £12.35 would silently change a
// number the file stated, which is the failure this whole port is built to
// prevent. Nothing here does float arithmetic: the string is normalised and
// handed to `Money.parseToMinor`, which is integer maths on the digits.
import Foundation

/// What the date column turned out to be.
public enum DateOrder: String, Sendable, Hashable {
    case dmy = "DMY"
    case mdy = "MDY"
    case ymd = "YMD"
}

/// '1,234.56' vs '1.234,56'.
public enum DecimalStyle: String, Sendable, Hashable {
    case dot
    case comma
}

/// A caller's choice, which may be "work it out from the file".
public enum DateOrderOption: Sendable, Hashable {
    case auto
    case fixed(DateOrder)

    /// Decodes the fixture's and the mapping record's string form.
    public init(_ raw: String) {
        switch raw.uppercased() {
        case "DMY": self = .fixed(.dmy)
        case "MDY": self = .fixed(.mdy)
        case "YMD": self = .fixed(.ymd)
        default: self = .auto
        }
    }
}

public enum DecimalStyleOption: Sendable, Hashable {
    case auto
    case fixed(DecimalStyle)

    public init(_ raw: String) {
        switch raw {
        case "dot": self = .fixed(.dot)
        case "comma": self = .fixed(.comma)
        default: self = .auto
        }
    }
}

/// How a raw amount cell becomes a signed amount.
public enum AmountRule: String, Sendable, Hashable {
    /// Keep the sign the cell carries.
    case asWritten = "as-written"
    /// Flip it (`mapping.negate`).
    case flip
    /// Force a negative magnitude (the cell came from a debit column).
    case debit
}

/// One normalised data row from any import format.
///
/// `amountText` and `amountRule` travel with the row because a parser must
/// pick a currency BEFORE the row's account is known, so its minor-unit scale
/// can be wrong — a ¥500 row parsed at 2 decimals becomes ¥5.00, and a valid
/// 3-decimal "12.345" is rejected outright. The importer re-derives the amount
/// from the text once the real currency is known. nil means no single cell
/// produced the amount (debit AND credit both filled, or no amount column), so
/// it cannot be re-derived.
public struct ParsedRow: Sendable, Hashable {
    /// 1-based data-row number in the source file, for error display.
    public let index: Int
    public let date: String?          // 'YYYY-MM-DD'; nil = unparseable
    public let amountMinor: Int64?    // signed; nil = unparseable
    public let currency: String?      // from the file, or nil
    public let accountName: String?
    public let payeeName: String?
    public let description: String?
    public let categoryPath: [String] // [] = none
    public let tags: [String]
    public let notes: String?
    /// The MoneyWiz "Transfers" column: the other account's name.
    public let transferAccountName: String?
    public let amountText: String?
    public let amountRule: AmountRule
    /// Why this row cannot be imported, else nil.
    public let error: String?
}

public enum Import {
    // MARK: - Character classes
    //
    // Spelled out rather than using a regex engine. ICU's `\d` matches every
    // Unicode decimal digit (Arabic-Indic included) where JavaScript's `\d`
    // without the `u` flag is ASCII 0-9 only, and ICU's `\s` and JavaScript's
    // differ on U+0085 and U+FEFF. Those differences are invisible until a
    // file arrives with a digit from another script, at which point the two
    // implementations disagree about what a date is.

    static func isASCIIDigit(_ c: Character) -> Bool { c.isASCII && c.isNumber }
    static func isASCIILetter(_ c: Character) -> Bool {
        ("a"..."z").contains(c) || ("A"..."Z").contains(c)
    }
    static func isJSSpace(_ c: Character) -> Bool { Money.jsWhitespace.contains(c) }
    static func allDigits(_ s: some StringProtocol) -> Bool {
        !s.isEmpty && s.allSatisfy(isASCIIDigit)
    }

    /// `String.prototype.trim`.
    static func trim(_ s: String) -> String { Money.trimmingJSWhitespace(s) }

    /// `v.split(/\s+/)[0]` — the leading run of non-space characters. Only the
    /// first element is ever used (a trailing time component is dropped).
    static func firstToken(_ s: String) -> String {
        String(s.prefix { !isJSSpace($0) })
    }

    // MARK: - Dates

    /// Explicit month-name table. dayjs's own name parsing is locale-dependent
    /// and would read a file differently depending on where the phone was
    /// bought.
    static let monthNames: [String: Int] = [
        "jan": 1, "feb": 2, "mar": 3, "apr": 4, "may": 5, "jun": 6,
        "jul": 7, "aug": 8, "sep": 9, "sept": 9, "oct": 10, "nov": 11, "dec": 12,
        "january": 1, "february": 2, "march": 3, "april": 4, "june": 6, "july": 7,
        "august": 8, "september": 9, "october": 10, "november": 11, "december": 12,
    ]

    /// Validate and format. Two-digit years pivot at 50: <50 ⇒ 20xx, else 19xx,
    /// the common CSV convention. A THREE-digit year is refused outright rather
    /// than guessed at — "226" is a typo, and every reading of it is wrong.
    static func buildDate(year yearRaw: String, month: Int?, day dayRaw: String) -> String? {
        guard let month, month >= 1, month <= 12 else { return nil }
        guard allDigits(yearRaw), allDigits(dayRaw) else { return nil }
        guard var year = Int(yearRaw), let day = Int(dayRaw) else { return nil }
        if yearRaw.count <= 2 {
            year = year < 50 ? 2000 + year : 1900 + year
        } else if yearRaw.count == 3 {
            return nil
        }
        guard let date = CalendarDate(year: year, month: month, day: day) else { return nil }
        return date.iso  // rejects 31/02, 29/02 in a non-leap year, and so on
    }

    /// Column-level date-format detection, over the WHOLE column.
    ///
    /// A four-digit leading segment in ANY value settles it as YMD; otherwise
    /// any first segment above 12 means the day comes first, any second
    /// segment above 12 means it comes second, and an all-ambiguous column
    /// defaults to en-GB day-first (D20). That default is a real decision: an
    /// all-ambiguous US MM/DD export is INDISTINGUISHABLE from a British one,
    /// which is why the caller can override it.
    public static func detectDateFormat(_ values: [String]) -> DateOrder {
        var numeric: [[Int]] = []
        for raw in values {
            let first = firstToken(trim(raw))
            let segs = first.split(separator: "/", omittingEmptySubsequences: false)
                .flatMap { $0.split(separator: ".", omittingEmptySubsequences: false) }
                .flatMap { $0.split(separator: "-", omittingEmptySubsequences: false) }
            guard segs.count == 3, segs.allSatisfy({ allDigits($0) && $0.count <= 4 }) else { continue }
            if segs[0].count == 4 { return .ymd }
            numeric.append(segs.compactMap { Int($0) })
        }
        if numeric.contains(where: { $0[0] > 12 }) { return .dmy }
        if numeric.contains(where: { $0[1] > 12 }) { return .mdy }
        return .dmy
    }

    /// Parse one date cell to 'YYYY-MM-DD', or nil.
    public static func parseDateString(_ value: String, format: DateOrderOption) -> String? {
        let v = trim(value)
        if v.isEmpty { return nil }

        // Month-name forms first: 'DD MMM YYYY' and 'MMM DD, YYYY', 2- or
        // 4-digit year. They cannot be confused with the numeric forms, and
        // trying them first means a numeric parse never sees letters.
        if let m = matchDayMonthYear(v) { return buildDate(year: m.year, month: m.month, day: m.day) }
        if let m = matchMonthDayYear(v) { return buildDate(year: m.year, month: m.month, day: m.day) }

        // Numeric forms — drop a trailing time component ('25/06/2026 14:30').
        let first = firstToken(v)
        let segs = first.split(separator: "/", omittingEmptySubsequences: false)
            .flatMap { $0.split(separator: ".", omittingEmptySubsequences: false) }
            .flatMap { $0.split(separator: "-", omittingEmptySubsequences: false) }
            .map(String.init)
        guard segs.count == 3, segs.allSatisfy({ allDigits($0) && $0.count <= 4 }) else { return nil }

        let order: DateOrder
        switch format {
        case .fixed(let fixed):
            order = fixed
        case .auto:
            if segs[0].count == 4 { order = .ymd }
            else if (Int(segs[0]) ?? 0) > 12 { order = .dmy }
            else if (Int(segs[1]) ?? 0) > 12 { order = .mdy }
            else { order = .dmy }  // ambiguous ⇒ en-GB default
        }
        switch order {
        case .ymd: return buildDate(year: segs[0], month: Int(segs[1]), day: segs[2])
        case .dmy: return buildDate(year: segs[2], month: Int(segs[1]), day: segs[0])
        case .mdy: return buildDate(year: segs[2], month: Int(segs[0]), day: segs[1])
        }
    }

    /// `/^(\d{1,2})[\s-]+([A-Za-z]{3,9})\.?,?[\s-]+(\d{2}|\d{4})$/`
    private static func matchDayMonthYear(_ v: String) -> (day: String, month: Int?, year: String)? {
        var chars = Array(v)[...]
        guard let day = take(&chars, while: isASCIIDigit, min: 1, max: 2) else { return nil }
        guard takeRun(&chars, of: { isJSSpace($0) || $0 == "-" }) else { return nil }
        guard let name = take(&chars, while: isASCIILetter, min: 3, max: 9) else { return nil }
        if chars.first == "." { chars = chars.dropFirst() }
        if chars.first == "," { chars = chars.dropFirst() }
        guard takeRun(&chars, of: { isJSSpace($0) || $0 == "-" }) else { return nil }
        guard let year = take(&chars, while: isASCIIDigit, min: 2, max: 4), chars.isEmpty,
              year.count == 2 || year.count == 4
        else { return nil }
        return (day, monthNames[name.lowercased()], year)
    }

    /// `/^([A-Za-z]{3,9})\.?\s+(\d{1,2}),?\s+(\d{2}|\d{4})$/`
    private static func matchMonthDayYear(_ v: String) -> (day: String, month: Int?, year: String)? {
        var chars = Array(v)[...]
        guard let name = take(&chars, while: isASCIILetter, min: 3, max: 9) else { return nil }
        if chars.first == "." { chars = chars.dropFirst() }
        guard takeRun(&chars, of: isJSSpace) else { return nil }
        guard let day = take(&chars, while: isASCIIDigit, min: 1, max: 2) else { return nil }
        if chars.first == "," { chars = chars.dropFirst() }
        guard takeRun(&chars, of: isJSSpace) else { return nil }
        guard let year = take(&chars, while: isASCIIDigit, min: 2, max: 4), chars.isEmpty,
              year.count == 2 || year.count == 4
        else { return nil }
        return (day, monthNames[name.lowercased()], year)
    }

    /// The maximal run matching `predicate`, if its length is in `min...max`.
    private static func take(
        _ chars: inout ArraySlice<Character>,
        while predicate: (Character) -> Bool,
        min minCount: Int, max maxCount: Int
    ) -> String? {
        let run = chars.prefix(while: predicate)
        guard run.count >= minCount, run.count <= maxCount else { return nil }
        chars = chars.dropFirst(run.count)
        return String(run)
    }

    /// One or more characters matching `predicate` (`+` in the regex).
    private static func takeRun(
        _ chars: inout ArraySlice<Character>, of predicate: (Character) -> Bool
    ) -> Bool {
        let run = chars.prefix(while: predicate)
        guard !run.isEmpty else { return false }
        chars = chars.dropFirst(run.count)
        return true
    }

    // MARK: - Amounts

    private static func count(_ s: String, of ch: Character) -> Int {
        s.reduce(0) { $1 == ch ? $0 + 1 : $0 }
    }

    /// Detect '1,234.56' vs '1.234,56' from a column of samples.
    ///
    /// `decimals` is how many decimal places the TARGET CURRENCY actually has,
    /// because that decides what a trailing group can be. "12.345" is
    /// thousands-grouped in a 2-decimal currency and a plain amount in a
    /// 3-decimal one (KWD); a 0-decimal currency (JPY) can have no decimal
    /// separator at all, so every separator it shows is grouping. Getting this
    /// wrong is a hundredfold error, and no GBP test can catch it.
    public static func detectDecimalStyle(_ values: [String], decimals: Int = 2) -> DecimalStyle {
        var comma = 0
        var dot = 0
        func isDecimalTail(_ s: String, _ sep: Character) -> Bool {
            guard decimals > 0, count(s, of: sep) == 1 else { return false }
            guard let idx = s.firstIndex(of: sep), idx > s.startIndex else { return false }
            guard isASCIIDigit(s[s.index(before: idx)]) else { return false }
            let tail = s[s.index(after: idx)...]
            return tail.count >= 1 && tail.count <= decimals && allDigits(tail)
        }
        for raw in values {
            let s = String(raw.filter { isASCIIDigit($0) || $0 == "." || $0 == "," })
            if s.isEmpty { continue }
            let hasComma = s.contains(",")
            let hasDot = s.contains(".")
            if hasComma && hasDot {
                // Both separators in one value: the LAST one is the decimal.
                if s.lastIndex(of: ",")! > s.lastIndex(of: ".")! { comma += 1 } else { dot += 1 }
            } else if hasComma {
                if isDecimalTail(s, ",") { comma += 1 } else { dot += 1 }
            } else if hasDot {
                if isDecimalTail(s, ".") { dot += 1 } else { comma += 1 }
            }
        }
        return comma > dot ? .comma : .dot  // ties and no evidence ⇒ 'dot'
    }

    /// Flexible import-amount parser: currency symbols, thousands separators,
    /// parentheses negatives, trailing ISO codes.
    public static func parseImportAmount(
        _ value: String, currency: String, decimal: DecimalStyleOption
    ) -> Int64? {
        var s = trim(value)
        if s.isEmpty { return nil }
        var negative = false
        // `/^\(.*\)$/` — `.` does not match a line terminator and `$` without
        // the `m` flag anchors at the very end, so a bracketed value containing
        // a newline is NOT negative there and must not be here either.
        if s.count >= 2, s.hasPrefix("("), s.hasSuffix(")"),
           !s.contains(where: { $0 == "\n" || $0 == "\r" || $0 == "\u{2028}" || $0 == "\u{2029}" }) {
            negative = true
            s = String(s.dropFirst().dropLast())
        }
        // Strip currency symbols, letter codes ('GBP') and all whitespace.
        s = String(s.filter { isASCIIDigit($0) || $0 == "." || $0 == "," || $0 == "+" || $0 == "-" })
        if s.hasPrefix("-") {
            negative = true
            s = String(s.dropFirst())
        } else if s.hasPrefix("+") {
            s = String(s.dropFirst())
        }
        // A sign INSIDE the number ("1-2") is refused: there is no reading of
        // it that is certainly what the file meant.
        if s.isEmpty || s.contains("-") || s.contains("+") { return nil }

        let style: DecimalStyle
        switch decimal {
        case .fixed(let forced):
            style = forced  // a forced style means the separator IS the decimal
        case .auto:
            let hasComma = s.contains(",")
            let hasDot = s.contains(".")
            if hasComma && hasDot {
                style = s.lastIndex(of: ",")! > s.lastIndex(of: ".")! ? .comma : .dot
            } else if hasComma {
                style = count(s, of: ",") == 1 && hasShortTail(s, ",") ? .comma : .dot
            } else if hasDot {
                style = count(s, of: ".") == 1 && hasShortTail(s, ".") ? .dot : .comma
            } else {
                style = .dot
            }
        }
        // `Money.parseToMinor` is integer string maths and returns nil for an
        // amount with more precision than the currency — exactly the "reject as
        // a row error" behaviour imports need.
        guard let minor = Money.parseToMinor(s, currency: currency, decimal: style == .dot ? .dot : .comma)
        else { return nil }
        // A negative zero is plain zero: −0 is not a thing a ledger can hold.
        return negative && minor != 0 ? -minor : minor
    }

    /// `/,\d{1,2}$/` — one or two digits after the separator, at the end. A
    /// separator with THREE trailing digits is grouping ('1,234' is £1,234.00,
    /// not £12.34), which is the single most expensive misreading available.
    private static func hasShortTail(_ s: String, _ sep: Character) -> Bool {
        guard let idx = s.lastIndex(of: sep) else { return false }
        let tail = s[s.index(after: idx)...]
        return tail.count >= 1 && tail.count <= 2 && allDigits(tail)
    }

    // MARK: - Column mapping

    public static func emptyMapping() -> ColumnMapping {
        ColumnMapping(
            date: -1, amount: -1, debit: -1, credit: -1, payee: -1, description: -1,
            category: -1, account: -1, currency: -1, tags: -1, notes: -1,
            dateFormat: "auto", decimal: "auto", negate: false, headerRow: true
        )
    }

    /// Case/whitespace-insensitive key for name lookups (`nameKey` in
    /// src/lib/util.ts).
    static func nameKey(_ s: String) -> String {
        var out = ""
        var pendingSpace = false
        for ch in trim(s).lowercased() {
            if isJSSpace(ch) {
                pendingSpace = !out.isEmpty
                continue
            }
            if pendingSpace {
                out.append(" ")
                pendingSpace = false
            }
            out.append(ch)
        }
        return out
    }

    /// Does a cell look like DATA (a date or an amount) rather than a header?
    static func looksLikeDataCell(_ cell: String) -> Bool {
        let t = trim(cell)
        if t.isEmpty { return false }
        if parseDateString(t, format: .auto) != nil { return true }
        return parseImportAmount(t, currency: "GBP", decimal: .auto) != nil
    }

    /// `/\bdate\b/` — "date" as a whole word.
    static func containsDateWord(_ h: String) -> Bool {
        let chars = Array(h)
        let needle = Array("date")
        guard chars.count >= needle.count else { return false }
        func isWordChar(_ c: Character) -> Bool {
            (c.isASCII && (c.isLetter || c.isNumber)) || c == "_"
        }
        for start in 0...(chars.count - needle.count) {
            guard Array(chars[start..<(start + needle.count)]) == needle else { continue }
            let beforeOK = start == 0 || !isWordChar(chars[start - 1])
            let afterIndex = start + needle.count
            let afterOK = afterIndex == chars.count || !isWordChar(chars[afterIndex])
            if beforeOK && afterOK { return true }
        }
        return false
    }

    /// Best-guess column mapping from headers plus sample rows.
    ///
    /// 'description' counts as a PAYEE synonym only when no separate
    /// description column ends up chosen: payee matching runs first, so a lone
    /// Description column becomes the payee — the primary label a register row
    /// shows — while a Payee+Description file maps each to its own slot.
    public static func guessMapping(headers: [String], sampleRows: [[String]]) -> ColumnMapping {
        let norm = headers.map { nameKey($0) }
        var used = Set<Int>()
        func pick(_ synonyms: [String]) -> Int {
            for syn in synonyms {
                if let i = norm.indices.first(where: { !used.contains($0) && norm[$0] == syn }) {
                    used.insert(i)
                    return i
                }
            }
            return -1
        }

        let account = pick(["account", "account name"])
        let date0 = pick([
            "date", "transaction date", "posted", "posting date", "booking date",
            "date posted", "value date",
        ])
        let debit = pick(["debit", "paid out", "money out", "withdrawal", "withdrawals", "debit amount", "out"])
        let credit = pick(["credit", "paid in", "money in", "deposit", "deposits", "credit amount", "in"])
        var amount = pick(["amount", "value", "transaction amount", "amount (gbp)", "net amount"])
        if amount == -1 {
            // 'Amount (EUR)', 'Amount GBP', … — any unused header starting with
            // 'amount'.
            if let i = norm.indices.first(where: { !used.contains($0) && norm[$0].hasPrefix("amount") }) {
                used.insert(i)
                amount = i
            }
        }
        let payee = pick(["payee", "payee name", "merchant", "name", "description"])
        let description = pick([
            "description", "details", "narrative", "reference", "transaction description", "memo",
        ])
        let category = pick(["category"])
        let currency = pick(["currency", "currency code", "ccy"])
        let tags = pick(["tags", "tag"])
        let notes = pick(["notes", "note", "memo"])
        var date = date0
        if date == -1 {
            if let i = norm.indices.first(where: { !used.contains($0) && containsDateWord(norm[$0]) }) {
                used.insert(i)
                date = i
            }
        }

        // A header row when the first row LOOKS like headers: something in it,
        // and no cell that parses as a date or an amount.
        let headerRow = norm.contains { !$0.isEmpty } && !headers.contains(where: looksLikeDataCell)

        if headerRow {
            return ColumnMapping(
                date: date, amount: amount, debit: debit, credit: credit, payee: payee,
                description: description, category: category, account: account,
                currency: currency, tags: tags, notes: notes,
                dateFormat: "auto", decimal: "auto", negate: false, headerRow: true
            )
        }

        // The "headers" are really data — guess by column CONTENT instead.
        let rows = [headers] + sampleRows
        let columnCount = rows.reduce(0) { max($0, $1.count) }
        var dateHits = [Int](repeating: 0, count: columnCount)
        var amountHits = [Int](repeating: 0, count: columnCount)
        var nonEmpty = [Int](repeating: 0, count: columnCount)
        for c in 0..<columnCount {
            for r in rows {
                let cell = c < r.count ? trim(r[c]) : ""
                if cell.isEmpty { continue }
                nonEmpty[c] += 1
                if parseDateString(cell, format: .auto) != nil { dateHits[c] += 1 }
                else if parseImportAmount(cell, currency: "GBP", decimal: .auto) != nil { amountHits[c] += 1 }
            }
        }
        func good(_ hits: [Int], _ c: Int) -> Bool {
            nonEmpty[c] > 0 && hits[c] >= Int((Double(nonEmpty[c]) / 2).rounded(.up))
        }
        let guessedDate = (0..<columnCount).first { good(dateHits, $0) } ?? -1
        let guessedAmount = (0..<columnCount).first { $0 != guessedDate && good(amountHits, $0) } ?? -1
        var guessedPayee = -1
        for c in 0..<columnCount
        where c != guessedDate && c != guessedAmount && nonEmpty[c] > 0 && amountHits[c] < nonEmpty[c] {
            guessedPayee = c
            break
        }
        return ColumnMapping(
            date: guessedDate, amount: guessedAmount, debit: debit, credit: credit,
            payee: guessedPayee, description: description, category: category, account: account,
            currency: currency, tags: tags, notes: notes,
            dateFormat: "auto", decimal: "auto", negate: false, headerRow: false
        )
    }

    // MARK: - Applying a mapping

    /// Category cell → path: split on '>' when present, else a single segment.
    static func splitGenericCategory(_ v: String) -> [String] {
        if v.isEmpty { return [] }
        let parts = v.contains(">") ? v.split(separator: ">", omittingEmptySubsequences: false).map(String.init) : [v]
        return parts.map { trim($0) }.filter { !$0.isEmpty }
    }

    static func splitTagsOnCommaOrSemicolon(_ v: String) -> [String] {
        if v.isEmpty { return [] }
        return v.split(whereSeparator: { $0 == ";" || $0 == "," })
            .map { trim(String($0)) }
            .filter { !$0.isEmpty }
    }

    static func cell(_ row: [String], _ i: Int) -> String {
        i >= 0 && i < row.count ? trim(row[i]) : ""
    }

    /// Apply a mapping to raw rows.
    ///
    /// Rows with an unparseable date or amount are still RETURNED, with
    /// `error` set, so the preview can show a count and the owner can see which
    /// lines to fix. Dropping them would make an import quietly smaller than
    /// the file.
    public static func parseWithMapping(
        _ data: [[String]], mapping: ColumnMapping, fixedCurrency: String
    ) -> [ParsedRow] {
        let rows = (mapping.headerRow ? Array(data.dropFirst()) : data)
            .filter { row in row.contains { !trim($0).isEmpty } }

        // Detect formats ONCE for the whole file (per column, never per row).
        let dateOrder: DateOrder
        switch DateOrderOption(mapping.dateFormat) {
        case .fixed(let fixed): dateOrder = fixed
        case .auto: dateOrder = detectDateFormat(rows.map { cell($0, mapping.date) })
        }
        let amountSamples = rows.flatMap { row in
            [cell(row, mapping.amount), cell(row, mapping.debit), cell(row, mapping.credit)]
                .filter { !$0.isEmpty }
        }
        let decimal: DecimalStyle
        switch DecimalStyleOption(mapping.decimal) {
        case .fixed(let fixed): decimal = fixed
        case .auto: decimal = detectDecimalStyle(amountSamples)
        }

        return rows.enumerated().map { offset, row in
            var error: String? = nil
            let currencyRaw = cell(row, mapping.currency)
            let currency: String? =
                currencyRaw.count == 3 && currencyRaw.allSatisfy(isASCIILetter)
                ? currencyRaw.uppercased()
                : (fixedCurrency.isEmpty ? nil : fixedCurrency)
            let minorCurrency = currency ?? "GBP"

            let dateRaw = cell(row, mapping.date)
            let date = mapping.date >= 0 ? parseDateString(dateRaw, format: .fixed(dateOrder)) : nil
            if date == nil {
                error = mapping.date >= 0 ? "Unrecognised date “\(dateRaw)”" : "No date column mapped"
            }

            var amountMinor: Int64? = nil
            var amountText: String? = nil
            var amountRule: AmountRule = .asWritten
            if mapping.debit >= 0 || mapping.credit >= 0 {
                let debitRaw = cell(row, mapping.debit)
                let creditRaw = cell(row, mapping.credit)
                // Only a SINGLE cell can be re-derived later; when both are
                // filled the amount is a combination of two cells, so the text
                // is left nil rather than naming one of them.
                if !debitRaw.isEmpty && creditRaw.isEmpty {
                    amountText = debitRaw
                    amountRule = .debit
                } else if !creditRaw.isEmpty && debitRaw.isEmpty {
                    amountText = creditRaw
                }
                let debit = debitRaw.isEmpty
                    ? Int64(0)
                    : parseImportAmount(debitRaw, currency: minorCurrency, decimal: .fixed(decimal))
                let credit = creditRaw.isEmpty
                    ? Int64(0)
                    : parseImportAmount(creditRaw, currency: minorCurrency, decimal: .fixed(decimal))
                if debit == nil || credit == nil {
                    if error == nil {
                        error = "Unrecognised amount “\(debit == nil ? debitRaw : creditRaw)”"
                    }
                } else if debitRaw.isEmpty && creditRaw.isEmpty {
                    if error == nil { error = "No amount" }
                } else {
                    amountMinor = credit! - abs(debit!)  // a debit is stored negative
                }
            } else if mapping.amount >= 0 {
                let amountRaw = cell(row, mapping.amount)
                amountText = amountRaw.isEmpty ? nil : amountRaw
                amountRule = mapping.negate ? .flip : .asWritten
                let parsed = amountRaw.isEmpty
                    ? nil
                    : parseImportAmount(amountRaw, currency: minorCurrency, decimal: .fixed(decimal))
                if let parsed {
                    amountMinor = mapping.negate ? -parsed : parsed
                } else if error == nil {
                    error = "Unrecognised amount “\(amountRaw)”"
                }
            } else if error == nil {
                error = "No amount column mapped"
            }

            let accountName = cell(row, mapping.account)
            let payeeName = cell(row, mapping.payee)
            let descriptionCell = cell(row, mapping.description)
            let notes = cell(row, mapping.notes)
            return ParsedRow(
                index: offset + 1,
                date: date,
                amountMinor: amountMinor,
                currency: currency,
                accountName: accountName.isEmpty ? nil : accountName,
                payeeName: payeeName.isEmpty ? nil : payeeName,
                description: descriptionCell.isEmpty ? nil : descriptionCell,
                categoryPath: splitGenericCategory(cell(row, mapping.category)),
                tags: splitTagsOnCommaOrSemicolon(cell(row, mapping.tags)),
                notes: notes.isEmpty ? nil : notes,
                transferAccountName: nil,  // generic CSVs have no transfers column
                amountText: amountText,
                amountRule: amountRule,
                error: error
            )
        }
    }
}
