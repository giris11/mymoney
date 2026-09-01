// The canonical form, checked against the JavaScript that defines it.
//
// Every `expected` hash and every `expected` string in this file was produced
// by running src/backup/canonical.ts -- the implementation the browser
// actually writes backups with -- over the same value. They are not my opinion
// about what JSON.stringify does. They are what it did.
//
// The inputs are deliberately given as TEXT with the keys in a scrambled order
// and awkward whitespace, so that parsing and re-emitting has to do real work:
// handing the emitter an already-sorted structure would test nothing.
import Foundation
import Testing

@testable import MyMoneyKit

struct CanonicalJSONTests {

    func canonicalise(_ text: String, indent: Int = 0) throws -> String {
        CanonicalJSON.text(try JSONParser.parse(text), indent: indent)
    }

    // MARK: - Key order

    @Test("keys sort by UTF-16 code unit, which is not alphabetical and not numeric")
    func keyOrder() throws {
        // The three traps in one object:
        //  * "10" sorts BEFORE "2", because '1' < '2' as code units. A JS
        //    object would have listed the integer-like keys first in NUMERIC
        //    order, which is why canonical.ts emits by hand instead of
        //    rebuilding an object -- and settings.savedMappings is keyed by CSV
        //    file signatures, one of which could be all digits.
        //  * "Beta" sorts before "a b", because uppercase letters come first.
        //    A locale-aware sort would put "alpha", "Beta" together.
        //  * "a b" sorts before "alpha", because space (0x20) < 'l'.
        let input = """
        { "zeta":1 , "10":2, "2":3,
          "alpha":4, "Beta":5, "":6, "a b":7 }
        """
        let expected = #"{"":6,"10":2,"2":3,"Beta":5,"a b":7,"alpha":4,"zeta":1}"#
        #expect(try canonicalise(input) == expected)
        #expect(
            ContentHash.sha256Hex(try canonicalise(input))
                == "daa7f78a35853571d826975466cd64511f4b2894b0373d91ac1f003ee565d5fd"
        )
    }

    @Test("Swift's own String ordering is NOT the ordering this format needs")
    func swiftOrderingWouldDiverge() {
        // Recorded as a test because it is the single easiest way for a port to
        // produce a different file for the same book: `keys.sorted()` looks
        // obviously correct and is quietly wrong.
        //
        // "a" + COMBINING DIAERESIS is the demonstration. Swift compares
        // Strings under Unicode canonical equivalence, so it treats that as
        // U+00E4 and sorts it AFTER "b". JavaScript compares raw UTF-16 code
        // units, so it sees a leading 'a' and sorts it BEFORE "b". Same keys,
        // different file, same book.
        let keys = ["a\u{0308}", "b", "Z"]
        #expect(keys.sorted(by: jsStringLess) == ["Z", "a\u{0308}", "b"])
        #expect(keys.sorted() == ["Z", "b", "a\u{0308}"])
        #expect(keys.sorted() != keys.sorted(by: jsStringLess))
        // A prefix always sorts before the string that extends it.
        #expect(["ab", "a"].sorted(by: jsStringLess) == ["a", "ab"])
    }

    // MARK: - Numbers

    @Test("numbers print exactly as JavaScript prints them")
    func numberFormatting() throws {
        let input = """
        {"tiny":5e-324,"third":0.3333333333333333,"small2":0.000001,"small":1e-7,
         "rate3":0.015291717027388076,"rate2":0.002250655594593477,
         "rate1":0.007758418188252167,"one":1.0,"negZero":-0,"mixed":1.2345678901234568e20,
         "maxSafe":9007199254740991,"int":1234,"huge":1.7976931348623157e308,
         "half":190.5,"eightyfive":0.85,"bigger":1e21,"big":1e20}
        """
        // Straight from the browser's own canonical.ts. Note the four things
        // that would each be wrong with Swift's `Double.description`:
        // 1e20 spelled out in full, 1e21 in exponent form, 1e-7 with a
        // one-digit exponent (not "1e-07"), and 1.0 printed as "1".
        let expected = """
        {"big":100000000000000000000,"bigger":1e+21,"eightyfive":0.85,"half":190.5,\
        "huge":1.7976931348623157e+308,"int":1234,"maxSafe":9007199254740991,\
        "mixed":123456789012345680000,"negZero":0,"one":1,\
        "rate1":0.007758418188252167,"rate2":0.002250655594593477,\
        "rate3":0.015291717027388076,"small":1e-7,"small2":0.000001,\
        "third":0.3333333333333333,"tiny":5e-324}
        """
        #expect(try canonicalise(input) == expected)
        #expect(
            ContentHash.sha256Hex(try canonicalise(input))
                == "1c1bd2b4690566d377016f29a315f82996fa38b6d24172ee9215a0164c4de542"
        )
    }

    @Test("the exponent-notation boundaries are where ECMAScript puts them")
    func exponentBoundaries() throws {
        // 1e20 is written out; 1e21 is not. 1e-6 is written out; 1e-7 is not.
        // Both boundaries come straight from Number::toString, and both were
        // checked against the browser.
        #expect(try canonicalise("[1e-6,1e-7,1e20,1e21,-0,1e-323]")
            == "[0.000001,1e-7,100000000000000000000,1e+21,0,1e-323]")
    }

    @Test("the three FX rates in the owner's frozen backup print identically")
    func fxRatesRoundTrip() throws {
        // These are the rates the frozen file's manifest states. They are the
        // only fractional numbers a real backup contains, so if the number
        // printer is wrong anywhere it is wrong here, and the file's hash would
        // not reproduce.
        let rates = [0.007758418188252167, 0.002250655594593477, 0.015291717027388076]
        for rate in rates {
            let text = JSNumber.string(rate)
            #expect(Double(text) == rate, "\(text) must round-trip")
            #expect(!text.contains("e"), "\(text) should not need exponent notation")
        }
        #expect(JSNumber.string(rates[0]) == "0.007758418188252167")
        #expect(JSNumber.string(rates[1]) == "0.002250655594593477")
        #expect(JSNumber.string(rates[2]) == "0.015291717027388076")
    }

    // MARK: - Strings

    @Test("string escaping matches JSON.stringify exactly, including what it leaves alone")
    func stringEscaping() throws {
        let input = """
        {"slash":"a/b","del":"x\\u007fy","emoji":"\\ud83d\\udcb7 money",\
        "controls":" \\b\\t\\n\\f\\r",\
        "quotes":"he said \\"hi\\" and a backslash \\\\",\
        "accented":"Caf\\u00e9 Paris \\u2014 \\u00a3 \\u20ac","plain":"Simple"}
        """
        // The hash rather than the literal, because the expected text contains
        // a raw DEL byte that has no business being pasted into source.
        #expect(
            ContentHash.sha256Hex(try canonicalise(input))
                == "e3dddb5f7c9dbe35cf1eb4cbc0480c82827bebf371b5e184a0357b9db5a6a3c5"
        )
        // What that hash is asserting, spelled out: non-ASCII goes out RAW in
        // UTF-8 (escaping it would change the bytes for every accented payee
        // name), and so does the solidus, and so does anything at or above 0x20.
        let output = try canonicalise(input)
        #expect(output.contains("Café Paris"))
        #expect(output.contains("a/b"))
        #expect(output.contains("\u{1F4B7}"))
    }

    @Test("control characters below 0x20 are escaped, and nothing above is")
    func controlCharacterEscaping() throws {
        let input = "{\"s\":\"\\u0000\\u0001\\u001f\\u007f\\u00a0\\u2028\"}"
        #expect(
            ContentHash.sha256Hex(try canonicalise(input))
                == "1a83f6fc0218c7c4f5f30a467c07b9d11184c3701c33439b34d8cf3e93e11dbb"
        )
        let output = try canonicalise(input)
        // Escaped: four lowercase hex digits, exactly as JavaScript writes them.
        #expect(output.contains("\\u0000"))
        #expect(output.contains("\\u0001"))
        #expect(output.contains("\\u001f"))
        // NOT escaped, and this half matters just as much: escaping something
        // JavaScript leaves alone changes the bytes and therefore the hash.
        #expect(output.contains("\u{7f}"))     // DEL
        #expect(output.contains("\u{a0}"))     // non-breaking space
        #expect(output.contains("\u{2028}"))   // LINE SEPARATOR
        #expect(!output.contains("\\u007f"))
        #expect(!output.contains("\\u2028"))
    }

    // MARK: - Structure

    @Test("empty containers and the indented form")
    func emptyContainersAndIndentation() throws {
        #expect(try canonicalise(#"{"c":"","b":[],"a":{}}"#) == #"{"a":{},"b":[],"c":""}"#)
        #expect(
            try canonicalise(#"{"c":"","b":[],"a":{}}"#, indent: 2)
                == "{\n  \"a\": {},\n  \"b\": [],\n  \"c\": \"\"\n}"
        )
        let nested = #"{"list":[1,[2,[3,{"z":1,"a":2}]],null,true,false]}"#
        #expect(try canonicalise(nested) == #"{"list":[1,[2,[3,{"a":2,"z":1}]],null,true,false]}"#)
        #expect(
            ContentHash.sha256Hex(try canonicalise(nested))
                == "491b30a119dfa34e6bd21a08e2203bf9614d5c1d9e75de3e52a40493c984f411"
        )
        // The indented form, byte for byte -- two spaces per level, ": " after
        // a key, and a newline before every closing bracket that had content.
        #expect(
            try canonicalise(nested, indent: 2)
                == "{\n  \"list\": [\n    1,\n    [\n      2,\n      [\n        3,\n"
                + "        {\n          \"a\": 2,\n          \"z\": 1\n        }\n      ]\n"
                + "    ],\n    null,\n    true,\n    false\n  ]\n}"
        )
    }

    @Test("array order is data and is never touched")
    func arrayOrderIsData() throws {
        // Rows are sorted by primary key by the EXPORTER, once. If this
        // function sorted them too it would be deciding something it has no
        // right to decide -- and a transaction list is not a set.
        #expect(try canonicalise("[3,1,2]") == "[3,1,2]")
        #expect(try canonicalise(#"[{"id":"z"},{"id":"a"}]"#) == #"[{"id":"z"},{"id":"a"}]"#)
    }

    @Test("whitespace is not data: the compact hash is the same either way")
    func whitespaceIsNotData() throws {
        let compact = #"{"a":1,"b":[2,3]}"#
        let spaced = "{\n  \"a\" : 1,\n  \"b\" : [ 2, 3 ]\n}"
        #expect(try canonicalise(compact) == (try canonicalise(spaced)))
    }

    // MARK: - SHA-256

    @Test("SHA-256 matches the hand-written JavaScript digest for the same bytes")
    func sha256Vectors() {
        // The first two are the FIPS 180-4 published vectors; all four were
        // also run through src/backup/canonical.ts's own sha256Hex, which is
        // the implementation a browser-written backup is fingerprinted with.
        #expect(
            ContentHash.sha256Hex("")
                == "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        )
        #expect(
            ContentHash.sha256Hex("abc")
                == "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad"
        )
        // UTF-8 bytes, not UTF-16: an accented payee name and an emoji.
        #expect(
            ContentHash.sha256Hex("Café \u{1F4B7}")
                == "5cf81072e5c21f340b49b2979815e888afd8d966882daa1cb1d2090ac13615b7"
        )
        // Long enough to cross several 64-byte blocks and exercise padding.
        #expect(
            ContentHash.sha256Hex(String(repeating: "x", count: 1000))
                == "44f8354494a5ba03ba1792a8d3e9c534c47a9181980fde7a3f44b06ef2ae7c7f"
        )
    }
}
