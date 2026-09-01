// The parser, and what it refuses.
//
// A backup is the owner's entire financial history. A parser that is generous
// about what it accepts is a parser that will one day accept a corrupt file and
// hand back plausible rows -- which is worse than refusing, because refusing is
// visible and a plausible wrong number is not.
import Foundation
import Testing

@testable import MyMoneyKit

struct JSONParserTests {

    // MARK: - The reason this parser exists at all

    @Test("an integer past 2^53 keeps every digit")
    func largeIntegersAreExact() throws {
        // This is the whole point. A JSON number is a Double to JavaScript, so
        // the browser cannot read this value back as itself; Int64 can, and
        // CloudKit was verified to preserve Int64 exactly, so the chain from
        // file to record to cloud is exact end to end.
        let parsed = try JSONParser.parse(#"{"amountMinor":9007199254740993}"#)
        #expect(parsed["amountMinor"] == .int(9_007_199_254_740_993))
        #expect(parsed["amountMinor"]?.intValue == 9_007_199_254_740_993)

        // What the alternative would have done, demonstrated rather than
        // asserted in prose.
        #expect(Int64(Double(9_007_199_254_740_993) as Double) == 9_007_199_254_740_992)

        #expect(try JSONParser.parse("9223372036854775807")  == .int(Int64.max))
        #expect(try JSONParser.parse("-9223372036854775808") == .int(Int64.min))
    }

    @Test("an integer too large even for Int64 becomes a Double, exactly as a browser would")
    func integersBeyondInt64() throws {
        // Refusing would make a file the web app can still restore unreadable
        // here, which is a worse failure than matching the browser's own loss.
        let parsed = try JSONParser.parse("99999999999999999999")
        guard case .double(let d) = parsed else {
            Issue.record("expected a double, got \(parsed.kindName)")
            return
        }
        #expect(d == 1e20)
        #expect(CanonicalJSON.text(parsed) == "100000000000000000000")
    }

    @Test("an integer written with a decimal point is still an exact amount")
    func integralDoublesAreAcceptedAsAmounts() throws {
        // "1234.0" is the same JSON number as "1234", and a file carrying it is
        // not wrong. "1234.5" as a count of minor units IS wrong, and must not
        // be silently rounded into one.
        #expect(try JSONParser.parse("1234.0").intValue == 1234)
        #expect(try JSONParser.parse("1234.5").intValue == nil)
        #expect(try JSONParser.parse("1e3").intValue == 1000)
    }

    // MARK: - Refusals

    @Test("a duplicate key is corruption, not a preference")
    func duplicateKeysAreRefused() {
        // JavaScript keeps the last silently. If the two implementations
        // disagreed about which of two balances the file states, one of them
        // would be quietly wrong -- so neither gets to choose.
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse(#"{"a":1,"a":2}"#)
        }
    }

    @Test("the grammar is RFC 8259 and nothing more")
    func malformedInputIsRefused() {
        let bad = [
            "",                      // nothing at all
            "{",                     // truncated
            "{\"a\":1,}",            // trailing comma
            "[1,2,]",                // trailing comma
            "{'a':1}",               // single quotes
            "{a:1}",                 // unquoted key
            "007",                   // leading zeros
            "-",                     // bare sign
            "1.",                    // no digit after the point
            ".5",                    // no digit before the point
            "1e",                    // no exponent digits
            "NaN",
            "Infinity",
            "undefined",
            "{} {}",                 // trailing content
            "// comment\n{}",
            "\"unterminated",
            "[1 2]",
        ]
        for text in bad {
            #expect(throws: JSONParseError.self, "should refuse \(String(reflecting: text))") {
                _ = try JSONParser.parse(text)
            }
        }
    }

    @Test("a raw control character inside a string is refused")
    func unescapedControlCharacters() {
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse("{\"a\":\"line\nbreak\"}")
        }
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse("{\"a\":\"tab\there\"}")
        }
    }

    @Test("a lone surrogate is refused rather than replaced")
    func loneSurrogatesAreRefused() throws {
        // A Swift String cannot hold one. The nearest thing is U+FFFD, which
        // would silently change the bytes and therefore the canonical hash --
        // so the hash comparison would go on succeeding while describing
        // different data. Failing loudly is the only honest option.
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse("{\"a\":\"\\ud800\"}")
        }
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse("{\"a\":\"\\udc00x\"}")
        }
        // A well-formed pair is fine.
        #expect(try JSONParser.parse("{\"a\":\"\\ud83d\\udcb7\"}")["a"]?.stringValue == "\u{1F4B7}")
    }

    @Test("nesting is bounded, so a hostile file cannot crash the reader")
    func depthIsBounded() {
        // A crash while reading a backup is indistinguishable, to the person
        // holding the phone, from losing it.
        let deep = String(repeating: "[", count: 200) + String(repeating: "]", count: 200)
        #expect(throws: JSONParseError.self) {
            _ = try JSONParser.parse(deep)
        }
        let fine = String(repeating: "[", count: 50) + String(repeating: "]", count: 50)
        #expect(throws: Never.self) {
            _ = try JSONParser.parse(fine)
        }
    }

    @Test("an error says where it is")
    func errorsCarryAnOffset() {
        // Against a 3 MB file, "invalid JSON" is not a diagnosis.
        do {
            _ = try JSONParser.parse(#"{"a":1,"b":}"#)
            Issue.record("should have thrown")
        } catch let error as JSONParseError {
            #expect(error.offset == 11)
            #expect(error.description.contains("byte 11"))
        } catch {
            Issue.record("wrong error type: \(error)")
        }
    }

    // MARK: - Accepted shapes

    @Test("absent and null are different claims and both survive")
    func absentIsNotNull() throws {
        let parsed = try JSONParser.parse(#"{"present":null}"#)
        #expect(parsed["present"] == .null)
        #expect(parsed["absent"] == nil)
        // The oracle's rule 5, and it decides real behaviour: a null
        // `openingBalanceMinor` means "we decline to state one", where an
        // absent one means the column was never written.
        #expect(parsed["present"]?.isNull == true)
    }

    @Test("UTF-8 passes through untouched")
    func unicodeSurvives() throws {
        let parsed = try JSONParser.parse("{\"name\":\"Café \u{1F4B7} — £\"}")
        #expect(parsed["name"]?.stringValue == "Café \u{1F4B7} — £")
    }
}
