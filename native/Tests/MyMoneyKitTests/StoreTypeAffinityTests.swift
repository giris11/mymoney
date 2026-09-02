// Where money silently becomes a float, and the four things that stop it.
//
// EVERY CLAIM IN StoreSchema.swift's AND SQLite.swift's HEADER COMMENTS IS
// EXECUTED HERE. That is the point of this file: the comments make specific,
// checkable statements about how SQLite behaves, and a comment that is merely
// believed is a comment that goes stale the year the library changes. If SQLite
// ever stops behaving this way, this file goes red and the design is
// reconsidered -- rather than the design quietly stopping working.
//
// The layers, in the order a value meets them:
//
//   1. The BINDER refuses a Double at COMPILE time -- `bind(_:minorUnits:)`
//      takes an Int64 and there is no other overload. Not testable at runtime
//      by design; a test that could call it with a Double would mean the layer
//      was not there.
//   2. The SCHEMA refuses a float, an integral float and a numeric string, at
//      run time, for any SQL from anywhere.
//   3. The AUDIT finds a non-integer amount that got in some other way.
//   4. The ACCESSOR refuses to hand back a non-integer as money.
import Foundation
import SQLite3
import Testing

@testable import MyMoneyKit

struct StoreTypeAffinityTests {

    // MARK: - 0. Why the schema is shaped the way it is

    @Test("a plain INTEGER column stores 100.5 as a float, which is the whole problem")
    func plainIntegerColumnAcceptsAFloat() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        // A table shaped the way an unsuspecting schema would be. NOT part of
        // the ledger -- it exists to demonstrate what the ledger avoids.
        try store.connection.execute("CREATE TABLE naive (m INTEGER)")
        try store.connection.execute("INSERT INTO naive VALUES (100.5)")
        #expect(try store.connection.scalarText("SELECT typeof(m) FROM naive") == "real")
        // And this is how it hurts: read it back as an integer and it is 100.
        // No error, no warning, fifty pence gone.
        #expect(try store.connection.scalarInt("SELECT CAST(m AS INTEGER) FROM naive") == 100)
    }

    @Test("a typeof CHECK on an INTEGER column misses the string '100'")
    func checkAloneMissesAString() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.connection.execute(
            "CREATE TABLE half_guarded (m INTEGER CHECK (typeof(m) = 'integer'))"
        )
        // The float is caught...
        #expect(throws: SQLiteError.self) {
            try store.connection.execute("INSERT INTO half_guarded VALUES (100.5)")
        }
        // ...and the string sails straight through, because affinity converted
        // it to an integer BEFORE the CHECK ever looked at it.
        try store.connection.execute("INSERT INTO half_guarded VALUES ('100')")
        #expect(try store.connection.scalarText("SELECT typeof(m) FROM half_guarded") == "integer")
    }

    @Test("a STRICT INTEGER column STILL accepts 100.0 and '100' -- the last hole")
    func strictIntegerStillTakesAnIntegralFloat() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.connection.execute("CREATE TABLE strict_int (m INTEGER NOT NULL) STRICT")

        // STRICT refuses what it cannot convert without losing something.
        for lossy in ["100.5", "'100.5'", "'abc'"] {
            #expect(throws: SQLiteError.self, "strict INTEGER accepted \(lossy)") {
                try store.connection.execute("INSERT INTO strict_int VALUES (\(lossy))")
            }
        }

        // And accepts everything it CAN convert -- which is the finding that
        // decided the schema. `INTEGER` in a STRICT table is not "integers
        // only", it is "anything that becomes an integer without complaint",
        // and a value that arrived as a Double is a Double in somebody's
        // arithmetic upstream whether or not it happened to be whole.
        for lossless in ["100.0", "'100'", "'100.0'"] {
            try store.connection.execute("INSERT INTO strict_int VALUES (\(lossless))")
        }
        #expect(try store.connection.scalarInt("SELECT count(*) FROM strict_int") == 3)
        #expect(
            try store.connection.scalarInt("SELECT count(*) FROM strict_int WHERE typeof(m) = 'integer'") == 3
        )
        // This is exactly why the ledger's money columns are ANY, not INTEGER.
    }

    // MARK: - 2. The schema the ledger actually uses

    @Test("THE MONEY COLUMNS REFUSE EVERY SHAPE OF FLOAT, FOR ANY SQL FROM ANYWHERE")
    func moneyColumnsRefuseNonIntegers() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        // Raw SQL, going nowhere near the typed binders -- which is the case
        // that matters, because a future query, a migration, or another tool
        // is exactly the writer that has not read SQLite.swift.
        let rejected = [
            "-2500.5",  // a float with a fraction
            "-2500.0",  // a float that happens to be whole
            "'-2500'",  // a numeric string
            "'abc'",  // not a number at all
        ]
        for literal in rejected {
            #expect(
                throws: SQLiteError.self,
                "amount_minor accepted \(literal)"
            ) {
                try store.connection.execute(
                    "UPDATE transactions SET amount_minor = \(literal) WHERE id = 't1'"
                )
            }
        }

        // The amount is untouched by any of those attempts.
        #expect(try store.connection.scalarInt("SELECT amount_minor FROM transactions WHERE id = 't1'") == -2500)
        #expect(try store.connection.scalarText("SELECT typeof(amount_minor) FROM transactions WHERE id = 't1'") == "integer")

        // And an ordinary integer is still perfectly welcome, including one
        // past 2^53 -- which is the entire reason this port exists, since a
        // browser cannot hold that number and CloudKit's Int64 can.
        try store.connection.execute(
            "UPDATE transactions SET amount_minor = 9007199254740993 WHERE id = 't1'"
        )
        #expect(try store.connection.scalarInt("SELECT amount_minor FROM transactions WHERE id = 't1'") == 9_007_199_254_740_993)
    }

    @Test("every money column in the schema, not just the one it is easy to test")
    func everyMoneyColumnIsGuarded() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        for (table, column) in StoreSchema.moneyColumns {
            #expect(
                throws: SQLiteError.self,
                "\(table).\(column) accepted a float"
            ) {
                try store.connection.execute("UPDATE \(table) SET \(column) = 1.5")
            }
            #expect(
                throws: SQLiteError.self,
                "\(table).\(column) accepted an integral float"
            ) {
                try store.connection.execute("UPDATE \(table) SET \(column) = 1.0")
            }
            #expect(
                throws: SQLiteError.self,
                "\(table).\(column) accepted a numeric string"
            ) {
                try store.connection.execute("UPDATE \(table) SET \(column) = '1'")
            }
        }
    }

    @Test("a refusal is a CHECK constraint failure, and it names the column")
    func refusalIsDiagnosable() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        do {
            try store.connection.execute("UPDATE transactions SET amount_minor = 1.5")
            Issue.record("a float must not reach a money column")
        } catch let error as SQLiteError {
            // The PRIMARY code is the familiar 19; the extended code says
            // which constraint, and here it is the typeof CHECK rather than
            // STRICT's own datatype refusal -- because an `ANY` column has no
            // datatype for STRICT to object to, which is the point of it.
            #expect(error.code == SQLITE_CONSTRAINT)
            #expect(error.extendedCode == SQLITE_CONSTRAINT | (1 << 8))  // _CHECK
            #expect(!error.isDatatypeMismatch)
            #expect(error.message.contains("amount_minor"))
        }
    }

    // MARK: - 3. The audit

    @Test("the audit is empty on a real book -- and CAN SEE a float when there is one")
    func auditFindsAFloat() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        #expect(try store.auditMoneyColumns().isEmpty)

        // A check that has never been shown to fire is not a check. The ledger
        // tables cannot hold a float, so the audit is pointed at a table built
        // WITHOUT the guard -- which is precisely the thing it exists to catch:
        // a table some future migration rebuilds and forgets to protect.
        try store.connection.execute("CREATE TABLE loose (id TEXT, amount_minor REAL)")
        try store.connection.execute("INSERT INTO loose VALUES ('x', 12.5)")
        let problems = try store.auditMoneyColumns([("loose", "amount_minor")])
        #expect(problems.count == 1)
        let message = try #require(problems.first.map { String(describing: $0) })
        #expect(message.contains("loose.amount_minor"))
        #expect(message.contains("\"x\""))
        #expect(message.contains("real"))
        #expect(message.contains("not money"))
    }

    // MARK: - 4. The read side

    @Test("reading a non-integer AS MONEY throws instead of quietly truncating")
    func readingAFloatAsMoneyThrows() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)

        // The C API is what makes this necessary: sqlite3_column_int64 on the
        // real -25.005 returns -25 and sets no error at all. An expression
        // column is the honest way to produce that situation without corrupting
        // the store to do it.
        let statement = try store.connection.prepare(
            "SELECT amount_minor / 100.0 FROM transactions WHERE id = 't1'"
        )
        defer { statement.finalize() }
        #expect(try statement.step())
        #expect(throws: StoreError.self) { _ = try statement.minorUnits(0) }
        // ...and the same column read as what it is comes back exactly.
        #expect(try statement.real(0) == -25.0)
    }

    @Test("reading text, a null or a boolean as money throws too")
    func readingOtherTypesAsMoneyThrows() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        let statement = try store.connection.prepare("SELECT 'x', NULL, 1.5, 7")
        defer { statement.finalize() }
        #expect(try statement.step())
        #expect(throws: StoreError.self) { _ = try statement.minorUnits(0) }  // text
        #expect(throws: StoreError.self) { _ = try statement.minorUnits(1) }  // null
        #expect(throws: StoreError.self) { _ = try statement.minorUnits(2) }  // real
        #expect(try statement.minorUnits(3) == 7)  // and an integer is an integer
    }

    // MARK: - The two columns that ARE allowed to be floats

    @Test("an FX rate round-trips bit for bit, because a rate is not money")
    func ratesRoundTripExactly() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.importBackup(text: StoreFixture.backupText)
        let rates = try store.book().fxRates
        let source = try StoreFixture.imported().book.fxRates.sorted { $0.id < $1.id }
        #expect(rates.count == source.count)
        for (got, want) in zip(rates, source) {
            // `==` on Double is exact equality and that is what is wanted: a
            // rate written back as 0.1234567890123457 instead of ...56 is a
            // different file, and it is the kind of difference no balance check
            // would ever notice.
            #expect(got.rate == want.rate, "\(got.id): \(got.rate) != \(want.rate)")
            #expect(got.rate.bitPattern == want.rate.bitPattern)
        }
    }

    @Test("SUM over money raises on overflow rather than wrapping -- but total() lies")
    func aggregatesAreNotToBeTrusted() throws {
        let scratch = try ScratchDirectory()
        let store = try scratch.store()
        try store.connection.execute(
            "CREATE TABLE big (m ANY NOT NULL CHECK (typeof(m) = 'integer')) STRICT"
        )
        try store.connection.execute("INSERT INTO big VALUES (9223372036854775807), (1)")

        // sum() over integers stays an integer and REFUSES to overflow, which
        // is the behaviour a ledger wants.
        #expect(throws: SQLiteError.self) { _ = try store.connection.scalarInt("SELECT sum(m) FROM big") }

        // total() is the trap: same query, always a REAL, no error, and the
        // answer is wrong by 1 with a straight face. Nothing in this package
        // aggregates money in SQL -- Money.swift's overflow-checked adds do it
        // -- and this is why.
        #expect(try store.connection.scalarText("SELECT typeof(total(m)) FROM big") == "real")
    }
}
