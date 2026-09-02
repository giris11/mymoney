// The thinnest possible wrapper over the system libsqlite3, and the place
// where SQLite's type system is disarmed.
//
// NO THIRD-PARTY DEPENDENCY. `import SQLite3` is the SDK's own module map for
// the libsqlite3 that ships with the OS; it costs nothing to build, adds
// nothing to resolve, and cannot be yanked. This package decides whether a
// number is correct, and a dependency is a place where somebody else decides
// that instead (Package.swift says so at length). A sync-era dependency is a
// decision for a later phase, not a default taken today because a wrapper
// looked tedious.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS FILE IS LONGER THAN "call sqlite3_step in a loop"
//
// SQLite does not have column types. It has column AFFINITY, which is a
// *preference* applied to whatever you hand it, and the difference is where
// money quietly becomes a float. Everything below was measured against the
// libsqlite3 on this machine (3.51.0), not remembered:
//
//   1. A plain `INTEGER` column accepts 100.5 and stores it as the REAL 100.5.
//      Affinity converts only when the conversion is LOSSLESS; when it is not,
//      it shrugs and stores what you gave it. `amountMinor` is then a float,
//      for ever, with no error at any layer.
//
//   2. A plain `INTEGER` column accepts the STRING '100' and silently stores
//      the integer 100. So a `CHECK (typeof(x) = 'integer')` does NOT catch a
//      string: by the time the CHECK runs, affinity has already converted it.
//
//   3. A STRICT table with an INTEGER column refuses 100.5 and 'abc' -- and
//      STILL accepts 100.0 and '100', because both of those convert to 100
//      LOSSLESSLY and lossless is all STRICT asks for.
//
//   4. So the money columns are declared `ANY` with a `typeof = 'integer'`
//      CHECK, which is the one combination that refuses all three. The
//      measurements are in StoreSchema.swift's header and are executed by
//      StoreTypeAffinityTests. This file then closes the same hole a SECOND
//      time, at the binding site: `bind(_:minorUnits:)` takes an Int64 and has
//      no Double overload to pick by accident. Two layers because they fail
//      differently -- one on a device at run time, one here at compile time.
//
//   5. Reading is the mirror image and is worse, because it never errors.
//      `sqlite3_column_int64` on the text '12.9' returns 12. On the real 12.9
//      it returns 12. On NULL it returns 0. All three silently. So every
//      accessor here asks `sqlite3_column_type` FIRST and throws if the answer
//      is not the one the column is supposed to hold.
//
// Layered on purpose: `ANY` + CHECK stops anything but an integer being
// stored, the typed binders stop a Double being offered in the first place, and
// the typed accessors stop a non-integer being read back as money. Any single
// layer alone has a hole; the reason each exists is written where it is used.
import Foundation
import SQLite3

/// SQLite's own answer when it refuses something, kept whole.
///
/// The EXTENDED code is carried as well as the primary one, because they are
/// what separate "your data is wrong" from "your disk is full":
/// `SQLITE_CONSTRAINT` (19) is not a diagnosis, `SQLITE_CONSTRAINT_DATATYPE`
/// (3091) is -- it means a STRICT table just refused a value of the wrong type,
/// which for this package means somebody tried to store money as a float.
public struct SQLiteError: Error, Sendable, Hashable, CustomStringConvertible {
    public let code: Int32
    public let extendedCode: Int32
    public let message: String
    /// The statement that failed, when there was one. Truncated: a failing
    /// INSERT of 5,127 rows must not paste the book into a log.
    public let sql: String?

    /// `SQLITE_CONSTRAINT_DATATYPE`, spelled out.
    ///
    /// The C header defines it as `SQLITE_CONSTRAINT | (12 << 8)`, and Swift
    /// does not import a macro built from an expression ("structure not
    /// supported"). Written here rather than left unavailable, because this is
    /// the code that says a STRICT table just refused a value of the wrong type
    /// -- which in this package means somebody tried to store money as a float,
    /// and that deserves to be distinguishable from a UNIQUE violation.
    public static let constraintDatatype: Int32 = SQLITE_CONSTRAINT | (12 << 8)

    /// A STRICT table refusing a value whose type it cannot losslessly hold.
    /// The one this package cares about most.
    public var isDatatypeMismatch: Bool { extendedCode == Self.constraintDatatype }

    public var description: String {
        var text = "SQLite error \(code)"
        if extendedCode != code { text += "/\(extendedCode)" }
        text += ": \(message)"
        if let sql { text += " [\(sql.prefix(200))]" }
        return text
    }
}

/// One open database handle.
///
/// NOT Sendable, and that is a statement rather than an oversight: a handle is
/// owned by whoever opened it. Making it `@unchecked Sendable` because
/// SQLITE_OPEN_FULLMUTEX serialises the C calls would be true of the C library
/// and false of this class, whose Swift-side state (the open transaction depth)
/// is not protected by SQLite's mutex at all. A later phase that needs a store
/// on several tasks should put an actor in front of this, not a lie on top of
/// it.
final class SQLiteConnection {
    /// The oldest libsqlite3 that has STRICT tables (3.37.0). Below it, the
    /// schema in StoreSchema.swift does not merely run slower -- it silently
    /// loses its type guarantees, because `... ) STRICT` is a syntax error in
    /// older versions and the CREATE would fail outright. macOS 14 and iOS 17,
    /// the floor this package targets, both ship far newer.
    static let minimumLibVersionNumber: Int32 = 3_037_000

    let handle: OpaquePointer
    let path: String
    private var transactionDepth = 0
    private var isClosed = false

    /// A one-time record of a failed ROLLBACK, which is the only situation in
    /// which this class cannot honour its own promise (see `transaction`).
    private(set) var isPoisoned = false

    init(path: String, readOnly: Bool = false) throws {
        guard sqlite3_libversion_number() >= Self.minimumLibVersionNumber else {
            throw StoreError.unsupportedSQLite(
                found: String(cString: sqlite3_libversion()),
                needed: "3.37.0 (for STRICT tables, which are what keep money an integer)"
            )
        }
        var handle: OpaquePointer?
        // FULLMUTEX: serialised. This class is single-owner by contract, so the
        // mutex is not load-bearing; it costs a few nanoseconds per call and
        // removes a whole class of "it worked on my machine" from a future
        // phase that gets the threading wrong.
        let flags =
            (readOnly ? SQLITE_OPEN_READONLY : SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE)
            | SQLITE_OPEN_FULLMUTEX
        let rc = sqlite3_open_v2(path, &handle, flags, nil)
        guard rc == SQLITE_OK, let handle else {
            let message = handle.map { String(cString: sqlite3_errmsg($0)) } ?? "unable to open"
            if handle != nil { sqlite3_close_v2(handle) }
            throw SQLiteError(code: rc & 0xFF, extendedCode: rc, message: message, sql: nil)
        }
        self.handle = handle
        self.path = path
        // Extended codes on, from the first statement: without this every
        // constraint failure is an indistinguishable 19.
        sqlite3_extended_result_codes(handle, 1)
    }

    deinit {
        if !isClosed { sqlite3_close_v2(handle) }
    }

    /// Close now rather than whenever the last reference goes.
    ///
    /// close_v2 rather than close: it does not FAIL when a statement was
    /// leaked, it defers the close until the last one is finalized. A caller
    /// asking to close has nowhere useful to put an error, so the version that
    /// cannot fail is the honest one.
    ///
    /// Every later use throws. Using a closed handle is undefined behaviour in
    /// C, so "throws" is the only safe alternative to "crashes on a good day".
    func close() {
        if isClosed { return }
        isClosed = true
        sqlite3_close_v2(handle)
    }

    // MARK: - Errors

    func lastError(sql: String? = nil) -> SQLiteError {
        SQLiteError(
            // MASKED to the primary code. With extended result codes switched
            // on, sqlite3_errcode and every API return value carry the EXTENDED
            // code, so an unmasked `code` would be 3091 where every reference
            // and every `switch` in the world says 19. The extended one is kept
            // beside it, which is the whole reason both fields exist.
            code: sqlite3_errcode(handle) & 0xFF,
            extendedCode: sqlite3_extended_errcode(handle),
            message: String(cString: sqlite3_errmsg(handle)),
            sql: sql
        )
    }

    // MARK: - Statements

    /// Run one or more statements for their effect.
    func execute(_ sql: String) throws {
        try checkUsable()
        var raw: UnsafeMutablePointer<CChar>?
        let rc = sqlite3_exec(handle, sql, nil, nil, &raw)
        guard rc == SQLITE_OK else {
            let message = raw.map { String(cString: $0) } ?? String(cString: sqlite3_errmsg(handle))
            if raw != nil { sqlite3_free(raw) }
            throw SQLiteError(
                code: rc & 0xFF, extendedCode: sqlite3_extended_errcode(handle),
                message: message, sql: sql
            )
        }
        if raw != nil { sqlite3_free(raw) }
    }

    func prepare(_ sql: String) throws -> SQLiteStatement {
        try checkUsable()
        var statement: OpaquePointer?
        let rc = sqlite3_prepare_v2(handle, sql, -1, &statement, nil)
        guard rc == SQLITE_OK, let statement else {
            throw lastError(sql: sql)
        }
        return SQLiteStatement(handle: statement, connection: self, sql: sql)
    }

    /// A single-row, single-column read. For PRAGMAs and counts.
    func scalarInt(_ sql: String) throws -> Int64? {
        let statement = try prepare(sql)
        defer { statement.finalize() }
        guard try statement.step() else { return nil }
        return try statement.integer(0)
    }

    func scalarText(_ sql: String) throws -> String? {
        let statement = try prepare(sql)
        defer { statement.finalize() }
        guard try statement.step() else { return nil }
        return try statement.optionalText(0)
    }

    // MARK: - Transactions

    /// Run `body` inside one transaction. Commit on return, ROLL BACK on any
    /// error thrown out of it, and rethrow.
    ///
    /// BEGIN IMMEDIATE, not BEGIN. A deferred transaction takes its write lock
    /// at the first write, so two writers can both start, both read, and one of
    /// them then fails with SQLITE_BUSY partway through work it thought it had
    /// begun. IMMEDIATE takes the lock up front: it either starts or it does
    /// not, which is the only shape an all-or-nothing import can be built on.
    ///
    /// NESTING is by depth counting rather than SAVEPOINTs, and the inner
    /// levels are deliberately NOT independently abortable. A savepoint that
    /// can roll back part of an import is exactly the tool that turns
    /// "all-or-nothing" into "mostly": there is one unit of work here, and it
    /// is the outermost call.
    ///
    /// IF THE ROLLBACK ITSELF FAILS the connection is marked poisoned and every
    /// later use of it throws. That case is nearly unreachable (SQLite rolls
    /// back automatically on the errors that matter) but "nearly unreachable"
    /// is not "cannot happen", and a half-applied import that carried on being
    /// used would be precisely the data loss this whole layer exists to
    /// prevent. Refusing to continue is the only safe answer.
    func transaction<T>(_ body: () throws -> T) throws -> T {
        try checkUsable()
        if transactionDepth > 0 {
            transactionDepth += 1
            defer { transactionDepth -= 1 }
            return try body()
        }
        try execute("BEGIN IMMEDIATE")
        transactionDepth = 1
        do {
            let result = try body()
            try execute("COMMIT")
            transactionDepth = 0
            return result
        } catch let failure {
            transactionDepth = 0
            do {
                try execute("ROLLBACK")
            } catch let rollback {
                isPoisoned = true
                throw StoreError.rollbackFailed(
                    original: String(describing: failure), rollback: String(describing: rollback)
                )
            }
            throw failure
        }
    }

    var isInTransaction: Bool { transactionDepth > 0 }

    func checkUsable() throws {
        if isClosed { throw StoreError.connectionClosed }
        if isPoisoned { throw StoreError.connectionPoisoned }
    }
}

/// One prepared statement, with binders and accessors that will not let a
/// money column become a float.
final class SQLiteStatement {
    private let handle: OpaquePointer
    private unowned let connection: SQLiteConnection
    let sql: String
    private var finalized = false

    init(handle: OpaquePointer, connection: SQLiteConnection, sql: String) {
        self.handle = handle
        self.connection = connection
        self.sql = sql
    }

    deinit { if !finalized { sqlite3_finalize(handle) } }

    func finalize() {
        if finalized { return }
        finalized = true
        sqlite3_finalize(handle)
    }

    // MARK: - Binding
    //
    // Parameter indices are 1-based, which is SQLite's convention and is kept
    // rather than hidden: the call site reads in the same order as the SQL it
    // sits next to.

    /// SQLITE_TRANSIENT: tell SQLite to copy the bytes.
    ///
    /// The alternative, SQLITE_STATIC, promises the buffer outlives the
    /// statement -- which a Swift `String` bridged into a C string for the
    /// duration of one call does NOT. Getting this wrong reads freed memory,
    /// and the symptom is a row that is right today and garbage next week.
    private static let transient = unsafeBitCast(
        -1, to: sqlite3_destructor_type.self
    )

    func bind(_ index: Int32, text value: String) {
        sqlite3_bind_text(handle, index, value, -1, Self.transient)
    }

    func bind(_ index: Int32, optionalText value: String?) {
        if let value { bind(index, text: value) } else { sqlite3_bind_null(handle, index) }
    }

    /// THE MONEY BINDER. Int64 in, integer out, no other route.
    ///
    /// There is deliberately no Double overload and no generic numeric one. A
    /// STRICT *INTEGER* column would accept the Double 100.0 -- the conversion
    /// is lossless, so STRICT permits it -- which is why the money columns are
    /// declared `ANY` with a typeof CHECK instead. This signature is the second
    /// layer, and the one that fails at COMPILE time rather than on a device.
    /// If a future caller has a Double amount, it must say so out loud by
    /// converting, and every review of that line will ask why.
    func bind(_ index: Int32, minorUnits value: Int64) {
        sqlite3_bind_int64(handle, index, value)
    }

    func bind(_ index: Int32, optionalMinorUnits value: Int64?) {
        if let value { bind(index, minorUnits: value) } else { sqlite3_bind_null(handle, index) }
    }

    /// A non-money whole number: a sort order, a row count, a term in months.
    func bind(_ index: Int32, integer value: Int64) {
        sqlite3_bind_int64(handle, index, value)
    }

    func bind(_ index: Int32, integer value: Int) { bind(index, integer: Int64(value)) }

    func bind(_ index: Int32, optionalInteger value: Int?) {
        if let value { bind(index, integer: Int64(value)) } else { sqlite3_bind_null(handle, index) }
    }

    /// A boolean, as SQLite's 0/1. There is no BOOLEAN type in a STRICT table
    /// and inventing one as TEXT 'true'/'false' would make every query that
    /// forgot the quoting silently wrong.
    func bind(_ index: Int32, flag value: Bool) {
        sqlite3_bind_int64(handle, index, value ? 1 : 0)
    }

    /// A THREE-STATE flag: absent, false, true. NULL is absent.
    ///
    /// `Account.excludeFromNetWorth` is the one that needs this, and the reason
    /// is in Records.swift: a backup's content hash covers key PRESENCE, so a
    /// row that omitted the flag and a row that stated `false` are different
    /// files for the same book. Collapsing them here would make an exported
    /// row unable to come back the way it arrived.
    func bind(_ index: Int32, optionalFlag value: Bool?) {
        if let value { bind(index, flag: value) } else { sqlite3_bind_null(handle, index) }
    }

    /// A genuine REAL: an FX rate or a loan's interest percentage.
    ///
    /// NEITHER IS MONEY, and that is why they are allowed to be Doubles. A rate
    /// is not a decimal quantity (0.007758418188252167 is what the source
    /// published) and it never touches a stored amount -- it is an input to a
    /// display-time conversion whose output is rounded back to Int64 exactly
    /// once, in Money.convert. SQLite stores a REAL as an 8-byte IEEE-754
    /// double and hands back the identical bits, which is checked by a test
    /// rather than assumed.
    func bind(_ index: Int32, real value: Double) {
        sqlite3_bind_double(handle, index, value)
    }

    func bind(_ index: Int32, optionalReal value: Double?) {
        if let value { bind(index, real: value) } else { sqlite3_bind_null(handle, index) }
    }

    // MARK: - Stepping

    /// Advance. `true` when a row is available, `false` at the end.
    @discardableResult
    func step() throws -> Bool {
        try connection.checkUsable()
        switch sqlite3_step(handle) {
        case SQLITE_ROW: return true
        case SQLITE_DONE: return false
        default: throw connection.lastError(sql: sql)
        }
    }

    /// Run a statement that returns nothing.
    func run() throws {
        _ = try step()
        try reset()
    }

    func reset() throws {
        // sqlite3_reset returns the error the LAST step produced, which has
        // already been thrown by `step`. Clearing the bindings matters more:
        // a reused statement keeps its old parameters, so a missed bind on the
        // next row would silently write the previous row's value.
        sqlite3_reset(handle)
        sqlite3_clear_bindings(handle)
    }

    // MARK: - Reading
    //
    // EVERY accessor checks sqlite3_column_type before it converts. The C API
    // never refuses: column_int64 on the text '12.9' returns 12, on the real
    // 12.9 returns 12, and on NULL returns 0 -- three different ways to be
    // wrong, none of which sets an error code. A wrong balance that arrives
    // through a successful read is the worst failure this store could have, so
    // the type is asserted and a mismatch is thrown with the column named.

    private func columnName(_ index: Int32) -> String {
        sqlite3_column_name(handle, index).map { String(cString: $0) } ?? "column \(index)"
    }

    private func typeName(_ index: Int32) -> String {
        switch sqlite3_column_type(handle, index) {
        case SQLITE_INTEGER: return "integer"
        case SQLITE_FLOAT: return "real"
        case SQLITE_TEXT: return "text"
        case SQLITE_BLOB: return "blob"
        case SQLITE_NULL: return "null"
        default: return "unknown"
        }
    }

    private func mismatch(_ index: Int32, expected: String) -> StoreError {
        .columnTypeMismatch(
            statement: sql, column: columnName(index),
            expected: expected, found: typeName(index)
        )
    }

    func isNull(_ index: Int32) -> Bool {
        sqlite3_column_type(handle, index) == SQLITE_NULL
    }

    func text(_ index: Int32) throws -> String {
        guard sqlite3_column_type(handle, index) == SQLITE_TEXT,
              let raw = sqlite3_column_text(handle, index)
        else { throw mismatch(index, expected: "text") }
        return String(cString: raw)
    }

    func optionalText(_ index: Int32) throws -> String? {
        if isNull(index) { return nil }
        return try text(index)
    }

    /// THE MONEY ACCESSOR. Anything that is not an integer is a corrupt store,
    /// and it says so instead of rounding.
    func minorUnits(_ index: Int32) throws -> Int64 {
        guard sqlite3_column_type(handle, index) == SQLITE_INTEGER else {
            throw mismatch(index, expected: "integer (minor units)")
        }
        return sqlite3_column_int64(handle, index)
    }

    func optionalMinorUnits(_ index: Int32) throws -> Int64? {
        if isNull(index) { return nil }
        return try minorUnits(index)
    }

    func integer(_ index: Int32) throws -> Int64 {
        guard sqlite3_column_type(handle, index) == SQLITE_INTEGER else {
            throw mismatch(index, expected: "integer")
        }
        return sqlite3_column_int64(handle, index)
    }

    func int(_ index: Int32) throws -> Int {
        let value = try integer(index)
        guard let narrowed = Int(exactly: value) else {
            throw StoreError.corrupt("\(columnName(index)) is \(value), out of range for Int")
        }
        return narrowed
    }

    func optionalInt(_ index: Int32) throws -> Int? {
        if isNull(index) { return nil }
        return try int(index)
    }

    func flag(_ index: Int32) throws -> Bool {
        let value = try integer(index)
        guard value == 0 || value == 1 else {
            throw StoreError.corrupt("\(columnName(index)) is \(value), which is neither 0 nor 1")
        }
        return value == 1
    }

    func optionalFlag(_ index: Int32) throws -> Bool? {
        if isNull(index) { return nil }
        return try flag(index)
    }

    /// A REAL. Accepts an INTEGER too, and only here.
    ///
    /// A rate of exactly 2 may be stored as the integer 2 -- SQLite's REAL
    /// affinity keeps an integral value as an integer on disk as an internal
    /// optimisation, and a row inserted by another tool may simply have used
    /// one. Widening an integer to a Double is exact for every value SQLite can
    /// hold in this column, so this conversion loses nothing. It is spelled out
    /// because it is the ONE place in this file where a type other than the
    /// declared one is accepted, and it must never be copied to `minorUnits`.
    func real(_ index: Int32) throws -> Double {
        switch sqlite3_column_type(handle, index) {
        case SQLITE_FLOAT: return sqlite3_column_double(handle, index)
        case SQLITE_INTEGER: return Double(sqlite3_column_int64(handle, index))
        default: throw mismatch(index, expected: "real")
        }
    }

    func optionalReal(_ index: Int32) throws -> Double? {
        if isNull(index) { return nil }
        return try real(index)
    }
}
