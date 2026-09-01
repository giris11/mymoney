// CSV reading, ported from the PapaParse call in src/import/generic.ts.
//
// WHY A HAND-WRITTEN PARSER. The TypeScript delegates to PapaParse, and two of
// PapaParse's behaviours are load-bearing for the oracle rather than
// incidental: it AUTO-DETECTS the delimiter (the German bank fixture is
// semicolon-separated and its amounts contain commas, so guessing wrong turns
// "-1.234,56" into two fields and loses the row), and `skipEmptyLines:
// 'greedy'` drops whitespace-only lines before the header row is picked. A
// port that quietly assumed a comma would read one of the owner's real files
// as a single column and call it a bank statement.
//
// So this file reproduces those two behaviours, and only those two. It is not
// a general CSV library and does not try to be: no streaming, no headers mode,
// no type coercion, no dynamic typing. Everything it returns is a String,
// because in this pipeline everything a file says is a string until a parser
// that knows the currency turns it into money.
//
// WHAT IS DELIBERATELY SIMPLER THAN PAPAPARSE. PapaParse guesses the line
// ending first and then splits on that one sequence, so a stray '\r' inside a
// '\n' file stays in the field. Here both '\r\n' and '\n' end a row and a lone
// '\r' does too. On any file that uses one convention consistently -- which is
// every file either implementation will ever see -- the two agree; on a file
// that mixes them, this one is more forgiving, and being more forgiving about
// line endings has never cost anybody a transaction.
import Foundation

public struct CSVTable: Sendable, Hashable {
    /// Rows of cells. Row 0 is the header row when the file has one; this
    /// parser does not decide that, the caller does.
    public let data: [[String]]
    /// Problems worth showing a human. Empty for every well-formed file:
    /// PapaParse's field-count mismatch errors only fire in header mode, which
    /// the TypeScript does not use, so a ragged row is data here, not an error.
    public let errors: [String]
}

public enum CSV {
    /// The delimiters PapaParse tries, in its order. The order matters: ties
    /// are broken by "first one seen wins" via the `<=` in the scoring below.
    static let delimitersToGuess: [Character] = [",", "\t", "|", ";", "\u{1E}", "\u{1F}"]

    /// Drop a leading Excel separator hint (`sep=,`).
    ///
    /// It is the line some exporters -- MoneyWiz's Report export among them --
    /// put ABOVE the header row to tell Excel which delimiter follows. It is a
    /// directive to a spreadsheet, not data: left in place it becomes row 1,
    /// the real header row is read as data, every column mapping is off by a
    /// row, and the delimiter guess is fed a one-comma line that disagrees with
    /// the rest of the file.
    ///
    /// ONLY a line that is exactly `sep=` plus ONE delimiter character is
    /// dropped. That also settles "the remaining cells must be empty" by
    /// construction: a real header whose first column is literally named `sep=`
    /// necessarily has more on the line.
    static func strippingSeparatorHint(_ text: String) -> String {
        guard let nl = text.firstIndex(of: "\n") else {
            return isSeparatorHint(text) ? "" : text
        }
        var firstLine = String(text[text.startIndex..<nl])
        if firstLine.hasSuffix("\r") { firstLine.removeLast() }
        guard isSeparatorHint(firstLine) else { return text }
        return String(text[text.index(after: nl)...])
    }

    /// `/^sep=.$/i` — `.` in JavaScript does not match a line terminator, and
    /// the line has already been cut at one, so a plain character test is the
    /// same predicate.
    private static func isSeparatorHint(_ line: String) -> Bool {
        let chars = Array(line)
        guard chars.count == 5 else { return false }
        let prefix = String(chars[0..<4]).lowercased()
        return prefix == "sep=" && chars[4] != "\n" && chars[4] != "\r"
    }

    /// Parse CSV text into rows of cells.
    ///
    /// A UTF-8 BOM is stripped first, then the `sep=` hint — that order,
    /// because the BOM comes first in the file and would otherwise make the
    /// hint line read as "\u{FEFF}sep=,".
    public static func parse(_ text: String) -> CSVTable {
        var clean = text
        if clean.hasPrefix("\u{FEFF}") { clean.removeFirst() }
        clean = strippingSeparatorHint(clean)
        let delimiter = guessDelimiter(clean) ?? ","
        let rows = parse(clean, delimiter: delimiter)
        return CSVTable(data: rows.filter { !isEmptyLine($0) }, errors: [])
    }

    /// `skipEmptyLines: 'greedy'` — a row is empty when everything in it,
    /// joined, is whitespace. Not just `[]` and not just `[""]`: a line of
    /// nothing but commas is as empty as a blank one.
    static func isEmptyLine(_ row: [String]) -> Bool {
        Money.trimmingJSWhitespace(row.joined()).isEmpty
    }

    /// RFC 4180 with PapaParse's quoting rules: a field is quoted only when the
    /// quote is its FIRST character, and `""` inside a quoted field is a
    /// literal quote.
    static func parse(_ text: String, delimiter: Character) -> [[String]] {
        var rows: [[String]] = []
        var row: [String] = []
        var field = ""
        var inQuotes = false
        var fieldStarted = false  // has anything (quote or char) been seen yet?

        var iterator = text.makeIterator()
        var pending: Character? = nil
        func next() -> Character? {
            if let p = pending { pending = nil; return p }
            return iterator.next()
        }

        while let c = next() {
            if inQuotes {
                if c == "\"" {
                    if let after = next() {
                        if after == "\"" {
                            field.append("\"")
                        } else {
                            inQuotes = false
                            pending = after
                        }
                    } else {
                        inQuotes = false
                    }
                } else {
                    field.append(c)
                }
                continue
            }
            if c == "\"" && !fieldStarted {
                inQuotes = true
                fieldStarted = true
                continue
            }
            if c == delimiter {
                row.append(field)
                field = ""
                fieldStarted = false
                continue
            }
            if c == "\n" || c == "\r" {
                if c == "\r" {
                    if let after = next(), after != "\n" { pending = after }
                }
                row.append(field)
                rows.append(row)
                row = []
                field = ""
                fieldStarted = false
                continue
            }
            field.append(c)
            fieldStarted = true
        }
        // A file ending in a newline leaves nothing pending; anything else is a
        // final row that never got its terminator.
        if !field.isEmpty || !row.isEmpty {
            row.append(field)
            rows.append(row)
        }
        return rows
    }

    /// PapaParse's `guessDelimiter`, reproduced.
    ///
    /// For each candidate it parses the first 10 rows and scores two things:
    /// `delta`, the total row-to-row change in field count (0 means every row
    /// has the same shape), and the average field count. It takes the lowest
    /// delta, then the highest average, and refuses any candidate averaging
    /// 1.99 fields or fewer — a single-column reading is never a successful
    /// guess. nil means "no candidate qualified"; the caller falls back to a
    /// comma, exactly as PapaParse does.
    static func guessDelimiter(_ text: String) -> Character? {
        var best: (delimiter: Character, delta: Int, average: Double)? = nil
        for delimiter in delimitersToGuess {
            let preview = Array(parse(text, delimiter: delimiter).prefix(10))
            var delta = 0
            var total = 0
            var counted = 0
            var previous: Int? = nil
            for row in preview {
                if isEmptyLine(row) { continue }
                let count = row.count
                total += count
                counted += 1
                if let prev = previous {
                    if count > 0 {
                        delta += abs(count - prev)
                        previous = count
                    }
                } else {
                    previous = count
                }
            }
            guard counted > 0 else { continue }
            let average = Double(total) / Double(counted)
            guard average > 1.99 else { continue }
            if let current = best {
                // `<=` on delta and `>` on average: PapaParse's exact
                // comparison, which lets a later candidate take over only when
                // it is at least as consistent AND strictly wider.
                guard delta <= current.delta, average > current.average else { continue }
            }
            best = (delimiter, delta, average)
        }
        return best?.delimiter
    }
}
