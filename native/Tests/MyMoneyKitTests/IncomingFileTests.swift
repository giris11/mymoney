// What a file that arrived from another app actually is.
//
// THE TEST THAT MATTERS IS `renamedBackup`. Everything else here is
// housekeeping; that one is the safety property. A backup that reaches the CSV
// path is a backup whose manifest is never checked, whose balances are never
// recomputed and whose round trip is never verified -- not because a check
// failed, but because the code that runs the checks was never called. Deciding
// on the bytes rather than on the name is what makes that impossible.
import Foundation
import Testing

@testable import MyMoneyKit

struct IncomingFileTests {

    private let csv = "Date,Amount,Payee\n2026-03-04,-12.50,Bramble Coffee\n2026-03-05,-4.20,Marlow Hardware\n"

    @Test("THE BYTES DECIDE, NOT THE NAME: a backup called .csv still goes to the importer")
    func renamedBackup() {
        let backup = Data(StoreFixture.backupText.utf8)
        // Every name somebody might have given it on the way here.
        for name in ["backup.csv", "backup.txt", "statement.CSV", "", "no-extension"] {
            #expect(
                IncomingFile.kind(of: backup, fileName: name) == .backup,
                "\(name) must still be routed to the backup importer"
            )
        }
        // And the converse: a statement called .json is not sent down the
        // backup path, where it would produce a refusal about a manifest for a
        // file that never had one.
        #expect(IncomingFile.kind(of: Data(csv.utf8), fileName: "export.json") == .csv)
    }

    @Test("a real backup and a real statement are each recognised")
    func theTwoDoors() {
        #expect(IncomingFile.kind(of: Data(StoreFixture.backupText.utf8), fileName: "b.json")
            == .backup)
        #expect(IncomingFile.kind(of: Data(csv.utf8), fileName: "s.csv") == .csv)
        // Semicolons, which is what a European bank export uses -- the same
        // delimiter guessing the web app does.
        let german = "Datum;Betrag;Empfänger\n04.03.2026;-1.234,56;Bramble\n05.03.2026;-4,20;Marlow\n"
        #expect(IncomingFile.kind(of: Data(german.utf8), fileName: "s.csv") == .csv)
    }

    @Test("everything else is refused, and the refusal says what this app takes")
    func refusals() {
        func reason(_ data: Data, _ name: String) -> String? {
            if case .unreadable(let message) = IncomingFile.kind(of: data, fileName: name) {
                return message
            }
            return nil
        }

        #expect(reason(Data(), "empty.json")?.contains("empty") == true)

        // Not text at all -- a JPEG's first bytes.
        let jpeg = Data([0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46])
        #expect(reason(jpeg, "photo.jpg")?.contains("not text") == true)

        // JSON-shaped and broken. Distinguished from "not a backup" because the
        // owner's next step is different: take a fresh export.
        #expect(reason(Data("{\"app\": \"MyMoney\"".utf8), "half.json")?.contains("fresh") == true)

        // One line with no table in it.
        #expect(reason(Data("just a sentence\n".utf8), "note.txt") != nil)

        // Too big to be either. Built as repeated bytes rather than held in
        // memory twice.
        let huge = Data(repeating: 0x41, count: IncomingFile.maximumBytes + 1)
        #expect(reason(huge, "video.mov")?.contains("too big") == true)
    }

    @Test("a CSV is described without being imported")
    func preview() throws {
        let preview = try #require(CSVPreview.of(csv))
        #expect(preview.rowCount == 2)
        #expect(preview.columnNames == ["Date", "Amount", "Payee"])
        #expect(preview.sampleRows.count == 2)
        #expect(preview.sampleRows[0] == ["2026-03-04", "-12.50", "Bramble Coffee"])
        #expect(preview.warnings.isEmpty)

        // A header with nothing under it is not a table.
        #expect(CSVPreview.of("Date,Amount\n") == nil)
        #expect(CSVPreview.of("") == nil)

        // Long files are described, not listed: the sample is capped.
        let many = (["Date,Amount"] + (1...500).map { "2026-01-01,-\($0).00" })
            .joined(separator: "\n")
        let big = try #require(CSVPreview.of(many))
        #expect(big.rowCount == 500)
        #expect(big.sampleRows.count == CSVPreview.sampleLimit)
    }
}
