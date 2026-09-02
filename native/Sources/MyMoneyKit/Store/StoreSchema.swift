// The tables, the tombstones, and the migration chain.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY EVERY MONEY COLUMN IS `ANY`, WHICH IS THE OPPOSITE OF UNTYPED
//
// Read that twice before changing it. In a STRICT table `ANY` is the STRONGEST
// declaration available for holding an integer, not the weakest -- and getting
// there needs the three measurements below, all taken against the libsqlite3 on
// this machine (3.51.0) rather than remembered.
//
// SQLite does not have column types. It has column AFFINITY, which is a
// PREFERENCE applied to whatever you hand it, and the gap between those two
// words is where money becomes a float.
//
//   1. A PLAIN `INTEGER` COLUMN WITH A typeof CHECK. Catches a fractional
//      float, because affinity converts only when the conversion is lossless
//      and so leaves 100.5 a REAL for the CHECK to see. Misses a numeric
//      STRING entirely -- affinity has already made it an integer by the time
//      the CHECK looks.
//
//          CREATE TABLE t (m INTEGER CHECK (typeof(m) = 'integer'));
//          INSERT INTO t VALUES (100.5);   -- refused by the CHECK
//          INSERT INTO t VALUES ('100');   -- ACCEPTED, stored as 100
//
//   2. A `STRICT` TABLE WITH AN `INTEGER` COLUMN. Much better, and still not
//      enough. STRICT refuses a value it cannot convert LOSSLESSLY -- and a
//      float with no fractional part, and a string of digits, both convert
//      losslessly:
//
//          CREATE TABLE t (m INTEGER) STRICT;
//          INSERT INTO t VALUES (100.5);   -- refused: cannot store REAL value
//          INSERT INTO t VALUES ('100.5'); -- refused: cannot store REAL value
//          INSERT INTO t VALUES ('abc');   -- refused: cannot store TEXT value
//          INSERT INTO t VALUES (100.0);   -- ACCEPTED, stored as 100
//          INSERT INTO t VALUES ('100');   -- ACCEPTED, stored as 100
//          INSERT INTO t VALUES ('100.0'); -- ACCEPTED, stored as 100
//
//      Nothing is LOST in those three, which is exactly why they are dangerous:
//      an amount that arrived as a Double is a Double in somebody's arithmetic
//      upstream, and the store is the last place that could have said so.
//
//   3. A `STRICT` TABLE WITH AN `ANY` COLUMN AND A typeof CHECK. `ANY` is the
//      one column type that applies NO affinity conversion -- the value is
//      stored exactly as given -- which finally lets the CHECK see what was
//      actually passed:
//
//          CREATE TABLE t (m ANY NOT NULL CHECK (typeof(m) = 'integer')) STRICT;
//          INSERT INTO t VALUES (100);                 -- ok
//          INSERT INTO t VALUES (9223372036854775807); -- ok, Int64 to the edge
//          INSERT INTO t VALUES (100.0);               -- REFUSED
//          INSERT INTO t VALUES (100.5);               -- REFUSED
//          INSERT INTO t VALUES ('100');               -- REFUSED
//
// Every hole shut, in the schema, where a future query or another tool that has
// never read a line of this package still cannot get past it. The values stored
// are ordinary integers, so indexes, comparisons and `sum()` behave exactly as
// they would in an INTEGER column; only the door is different.
//
// The tables are STRICT anyway -- every one of them -- because the columns that
// are NOT money still benefit from a type that means something, and because
// `ANY` only behaves as described above inside a STRICT table.
//
// `bind(_:minorUnits:)` in SQLite.swift keeps its Int64-only signature as a
// second layer, and the two are kept because they fail differently: the CHECK
// is a runtime refusal on a device somewhere, the missing Double overload is a
// compile error here. StoreTypeAffinityTests executes every line above, so a
// SQLite that ever stops behaving this way turns the suite red instead of
// quietly turning the design off.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY EVERY DELETABLE ROW HAS `deleted_at`, AND WHY YOU MUST NOT "CLEAN THEM UP"
//
// This is not a preference and it is not tidiness. It was bought with a real
// CloudKit experiment in the native project's Phase 1, and the finding was:
//
//     A CloudKit DELETE carries NO change tag. It gets NO conflict protection.
//     Two devices, one of them offline, and the delete wins over an edit it has
//     never seen -- with NO error, NO log line and NO way to tell afterwards.
//     The row is simply gone.
//
// A row that is SAVED with a tombstone is an ordinary record change: it carries
// a change tag, it is conflict-protected like any other save, and a device that
// edited it while offline gets a real conflict it can resolve instead of a
// silent loss. So deletion in this app is a SAVE, always.
//
// Sync is NOT part of this phase and there is no CloudKit code here. The
// tombstones are here anyway because retrofitting them over a hard-delete
// schema is a migration across every table, every query and every historical
// row -- and the rows deleted before the retrofit are unrecoverable by then.
//
// THE TEMPTATION TO REMOVE THEM WILL BE STRONG. It will look like dead weight
// in a table nobody queries for deleted rows, and there is no visible feature
// that needs it. Do not. The cost of keeping a tombstone is a row; the cost of
// not having one is somebody's transaction, discovered months later, with no
// error anywhere to explain it.
//
// The queries exclude tombstones BY CONSTRUCTION rather than by convention:
// every read in LedgerStore goes through a `live_*` VIEW whose definition
// carries the `WHERE deleted_at IS NULL`. Forgetting the clause is not
// possible, because the clause is not at the call site.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT IS *NOT* TOMBSTONED, AND WHY
//
//   * `transaction_splits`, `transaction_tags`, `budget_categories` -- these
//     are parts of their parent, not rows an owner deletes. Removing a split is
//     an EDIT of its transaction, and the transaction is what carries the
//     tombstone. They cascade with the parent row's physical removal, which
//     only ever happens on a whole-book restore.
//   * `settings` -- there is one row, id "app", and it is not deletable.
//   * `schema_migrations`, `store_meta` -- the store's own bookkeeping.
import Foundation

/// One versioned step. `name` is written into `schema_migrations` so an
/// upgraded store can say what was applied to it and when.
struct StoreMigration {
    let version: Int
    let name: String
    let statements: [String]
}

public enum StoreSchema {
    /// The store schema version this build writes and reads.
    ///
    /// SEPARATE FROM `Schema.version`, which is the BACKUP FILE's version and
    /// belongs to the web app. Conflating them would mean the store could never
    /// gain an index without claiming every backup file had changed format.
    public static let version = 3

    /// The ledger tables that carry a tombstone, in the order a restore writes
    /// them (parents before children, so a store with foreign keys switched on
    /// never sees a dangling reference mid-import).
    public static let tombstonedTables: [String] = [
        "account_groups",
        "accounts",
        "categories",
        "payees",
        "tags",
        "import_batches",
        "budgets",
        "fx_rates",
        "transactions",
    ]

    /// The child tables: parts of a parent row rather than rows an owner can
    /// delete, which is why none of them carries a tombstone.
    public static let childTables: [String] = [
        "transaction_splits", "transaction_tags", "budget_categories",
    ]

    /// Every table this schema defines, bookkeeping included.
    public static let allTables: [String] =
        tombstonedTables + childTables + ["settings", "schema_migrations", "store_meta"]

    /// The SQL table a BACKUP FILE's table name corresponds to.
    ///
    /// The two vocabularies are deliberately different: the file speaks
    /// camelCase because a browser wrote it, and the schema speaks snake_case
    /// because SQL does. Mapping them in ONE place means a caller comparing a
    /// manifest's row counts to the store's cannot get the correspondence
    /// subtly wrong.
    public static func table(forBackupTable name: String) -> String {
        switch name {
        case "accountGroups": return "account_groups"
        case "fxRates": return "fx_rates"
        case "importBatches": return "import_batches"
        default: return name
        }
    }

    /// Every column that holds MONEY, as `(table, column)`.
    ///
    /// The single list the type-affinity defences are driven from: the audit in
    /// `LedgerStore.auditMoneyColumns()` walks it, and a test asserts each one
    /// is declared `ANY` with a `typeof = 'integer'` CHECK in a STRICT table --
    /// which, counter-intuitively, is the strictest an integer column can be
    /// (see the header). A money column added without being added here would be
    /// a column nothing checks, so the test also asserts that no OTHER column's
    /// name ends in `_minor`.
    public static let moneyColumns: [(table: String, column: String)] = [
        ("accounts", "opening_balance_minor"),
        ("accounts", "loan_principal_minor"),
        ("transactions", "amount_minor"),
        ("transaction_splits", "amount_minor"),
        ("budgets", "amount_minor"),
    ]

    /// The two columns that legitimately hold a Double, named here so that
    /// "why is this one REAL?" has an answer in the schema rather than in
    /// somebody's memory. NEITHER IS MONEY:
    ///
    ///   * `fx_rates.rate` -- 1 unit of base = rate units of quote. A rate is
    ///     genuinely not a decimal quantity; it is an input to a conversion
    ///     whose output is rounded to Int64 exactly once, in Money.convert.
    ///   * `accounts.loan_rate_pct` -- an interest percentage, likewise.
    public static let realColumns: [(table: String, column: String)] = [
        ("accounts", "loan_rate_pct"),
        ("fx_rates", "rate"),
    ]

    // MARK: - Migration 1: the ledger

    static let migration1 = StoreMigration(
        version: 1,
        name: "ledger tables, tombstones, integer money",
        statements: [
            """
            CREATE TABLE account_groups (
                id          TEXT    NOT NULL PRIMARY KEY,
                name        TEXT    NOT NULL,
                sort_order  INTEGER NOT NULL,
                deleted_at  TEXT
            ) STRICT
            """,
            """
            CREATE TABLE accounts (
                id                     TEXT    NOT NULL PRIMARY KEY,
                name                   TEXT    NOT NULL,
                type                   TEXT    NOT NULL
                                       CHECK (type IN ('current', 'savings', 'credit_card',
                                                       'cash', 'loan', 'investment')),
                currency               TEXT    NOT NULL,
                -- MONEY. Integer minor units, in the account's own currency,
                -- never converted and never a float. `ANY` + typeof is the
                -- strict form -- see the header.
                opening_balance_minor  ANY     NOT NULL
                                       CHECK (typeof(opening_balance_minor) = 'integer'),
                colour                 TEXT    NOT NULL,
                -- `groupId: string | null` in the file: always written, null
                -- when there is none. NULL here means the same thing.
                group_id               TEXT,
                sort_order             INTEGER NOT NULL,
                archived               INTEGER NOT NULL CHECK (archived IN (0, 1)),
                -- THREE STATES, on purpose: NULL = the key is absent from the
                -- row, 0 = the row says false, 1 = the row says true. A
                -- backup's content hash covers key PRESENCE, so absent and
                -- false are different files for the same book (Records.swift
                -- explains at length). The money rules ask `== true` and so
                -- never see the difference.
                exclude_from_net_worth INTEGER
                                       CHECK (exclude_from_net_worth IS NULL
                                              OR exclude_from_net_worth IN (0, 1)),
                -- MONEY.
                loan_principal_minor   ANY
                                       CHECK (loan_principal_minor IS NULL
                                              OR typeof(loan_principal_minor) = 'integer'),
                -- NOT money: an interest percentage. See `realColumns`.
                loan_rate_pct          REAL,
                loan_term_months       INTEGER,
                deleted_at             TEXT
            ) STRICT
            """,
            """
            CREATE TABLE categories (
                id         TEXT    NOT NULL PRIMARY KEY,
                name       TEXT    NOT NULL,
                parent_id  TEXT,
                kind       TEXT    NOT NULL CHECK (kind IN ('income', 'expense')),
                icon       TEXT,
                colour     TEXT,
                archived   INTEGER NOT NULL CHECK (archived IN (0, 1)),
                sort_order INTEGER NOT NULL,
                deleted_at TEXT
            ) STRICT
            """,
            """
            CREATE TABLE payees (
                id                  TEXT NOT NULL PRIMARY KEY,
                name                TEXT NOT NULL,
                name_lower          TEXT NOT NULL,
                default_category_id TEXT,
                deleted_at          TEXT
            ) STRICT
            """,
            """
            CREATE TABLE tags (
                id         TEXT NOT NULL PRIMARY KEY,
                name       TEXT NOT NULL,
                name_lower TEXT NOT NULL,
                deleted_at TEXT
            ) STRICT
            """,
            """
            CREATE TABLE import_batches (
                id                       TEXT    NOT NULL PRIMARY KEY,
                source                   TEXT    NOT NULL
                                         CHECK (source IN ('moneywiz', 'csv', 'sample')),
                file_name                TEXT    NOT NULL,
                row_count                INTEGER NOT NULL,
                imported_at              TEXT    NOT NULL,
                -- The five REQUIRED provenance lists and the two OPTIONAL
                -- ones, each as a canonical JSON array of ids.
                --
                -- WHY JSON AND NOT A JOIN TABLE. These are opaque id lists with
                -- exactly one job -- undoing an import as a unit -- and nothing
                -- ever joins to them. A join table would also have to carry a
                -- separate presence flag for the two optional lists, because
                -- "absent" and "[]" are different claims in the file format and
                -- both occur in real backups (D19: only the sample-data batch
                -- writes them). A nullable TEXT column says that in one place.
                created_account_ids      TEXT    NOT NULL,
                created_category_ids     TEXT    NOT NULL,
                created_payee_ids        TEXT    NOT NULL,
                created_tag_ids          TEXT    NOT NULL,
                created_group_ids        TEXT    NOT NULL,
                created_budget_ids       TEXT,
                created_fx_rate_ids      TEXT,
                deleted_at               TEXT
            ) STRICT
            """,
            """
            CREATE TABLE budgets (
                id           TEXT    NOT NULL PRIMARY KEY,
                name         TEXT    NOT NULL,
                -- MONEY, and in BASE currency (D22), not in any account's.
                amount_minor ANY     NOT NULL CHECK (typeof(amount_minor) = 'integer'),
                period       TEXT    NOT NULL CHECK (period IN ('weekly', 'monthly', 'yearly')),
                start_date   TEXT    NOT NULL,
                rollover     INTEGER NOT NULL CHECK (rollover IN (0, 1)),
                archived     INTEGER NOT NULL CHECK (archived IN (0, 1)),
                deleted_at   TEXT
            ) STRICT
            """,
            """
            -- A budget's category list, kept ordered. Order is DATA: the array
            -- is written into the backup in this sequence, and a different
            -- sequence is a different file with a different content hash.
            CREATE TABLE budget_categories (
                budget_id   TEXT    NOT NULL REFERENCES budgets(id) ON DELETE CASCADE,
                position    INTEGER NOT NULL,
                category_id TEXT    NOT NULL,
                PRIMARY KEY (budget_id, position)
            ) STRICT
            """,
            """
            CREATE TABLE fx_rates (
                id         TEXT NOT NULL PRIMARY KEY,
                base       TEXT NOT NULL,
                quote      TEXT NOT NULL,
                -- NOT money. See `realColumns`.
                rate       REAL NOT NULL,
                as_of      TEXT NOT NULL,
                source     TEXT NOT NULL CHECK (source IN ('manual', 'auto')),
                deleted_at TEXT
            ) STRICT
            """,
            """
            CREATE TABLE transactions (
                id                TEXT    NOT NULL PRIMARY KEY,
                account_id        TEXT    NOT NULL,
                -- "YYYY-MM-DD", a calendar date and deliberately not an
                -- instant. Records.swift explains why: a Date has a timezone,
                -- and a transaction that moves between budget periods when the
                -- phone crosses a border is a real bug in real finance apps.
                date              TEXT    NOT NULL,
                -- MONEY. Signed: expenses negative, income positive.
                amount_minor      ANY     NOT NULL CHECK (typeof(amount_minor) = 'integer'),
                currency          TEXT    NOT NULL,
                payee_id          TEXT,
                category_id       TEXT,
                notes             TEXT    NOT NULL,
                status            TEXT    NOT NULL CHECK (status IN ('cleared', 'pending')),
                transfer_group_id TEXT,
                import_batch_id   TEXT,
                dedupe_hash       TEXT    NOT NULL,
                created_at        TEXT    NOT NULL,
                updated_at        TEXT    NOT NULL,
                deleted_at        TEXT
            ) STRICT
            """,
            """
            CREATE TABLE transaction_splits (
                transaction_id TEXT    NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                position       INTEGER NOT NULL,
                category_id    TEXT,
                -- MONEY. Signed, same convention as the parent, and the splits
                -- of one transaction must sum EXACTLY to it (SPEC 6).
                amount_minor   ANY     NOT NULL CHECK (typeof(amount_minor) = 'integer'),
                notes          TEXT,
                PRIMARY KEY (transaction_id, position)
            ) STRICT
            """,
            """
            CREATE TABLE transaction_tags (
                transaction_id TEXT    NOT NULL REFERENCES transactions(id) ON DELETE CASCADE,
                position       INTEGER NOT NULL,
                tag_id         TEXT    NOT NULL,
                PRIMARY KEY (transaction_id, position)
            ) STRICT
            """,
            """
            -- The single settings row, id "app". No tombstone: it is not
            -- deletable.
            --
            -- `row_json` IS THE AUTHORITY and the typed columns are an index
            -- over it, not a second copy of the truth. The reason is the format
            -- rather than laziness: half this row is DEVICE-LOCAL (the `sync*`
            -- keys, per src/db/db.ts's DEVICE_LOCAL_SETTING_KEYS) and this
            -- package deliberately models none of it -- but a backup's content
            -- hash covers the WHOLE row, so dropping the keys we do not
            -- understand would mean an export of an unchanged book could never
            -- match the browser's hash. Reconstruction reads `row_json` and
            -- runs it through the very decoder a backup file goes through, so
            -- there is exactly one path from bytes to record. The typed columns
            -- exist so SQL can ask "what currency is this book in" without
            -- parsing JSON, and a test pins that they agree.
            CREATE TABLE settings (
                id                  TEXT    NOT NULL PRIMARY KEY,
                schema_version      INTEGER NOT NULL,
                base_currency       TEXT    NOT NULL,
                theme               TEXT    NOT NULL
                                    CHECK (theme IN ('system', 'light', 'dark')),
                last_backup_at      TEXT,
                onboarded           INTEGER NOT NULL CHECK (onboarded IN (0, 1)),
                last_used_account_id TEXT,
                created_at          TEXT    NOT NULL,
                auto_fx_enabled     INTEGER NOT NULL CHECK (auto_fx_enabled IN (0, 1)),
                last_fx_sync_at     TEXT,
                last_fx_sync_source TEXT,
                row_json            TEXT    NOT NULL
            ) STRICT
            """,
        ] + liveViewStatements
    )

    /// The `live_*` views: every tombstoned table with its tombstones removed.
    ///
    /// This is what makes "queries exclude deleted rows by default" a fact
    /// about the schema rather than a habit. A reader that selects from
    /// `live_transactions` cannot forget the clause, because the clause is not
    /// at the call site. A reader that genuinely wants tombstones names the
    /// base table, which is visible in review.
    ///
    /// A migration that adds a column to a base table must DROP and recreate
    /// the matching view -- `SELECT *` is expanded and frozen when the view is
    /// created, so a new column would otherwise be invisible to every read.
    static var liveViewStatements: [String] {
        tombstonedTables.map { table in
            "CREATE VIEW live_\(table) AS SELECT * FROM \(table) WHERE deleted_at IS NULL"
        }
    }

    // MARK: - Migration 2: provenance and the indexes real data needs

    static let migration2 = StoreMigration(
        version: 2,
        name: "store_meta provenance, query indexes",
        statements: [
            """
            -- HOW THE BOOK ARRIVED, so that exporting it can reproduce the file
            -- it came from rather than a file that merely means the same thing.
            --
            -- This is the capability migration 1 did not have, and the reason
            -- it is a migration rather than a retrofit into 1: the need only
            -- became visible once the round-trip property was written down. Two
            -- of the four facts below CHANGE THE CONTENT HASH and cannot be
            -- derived from the rows --
            --
            --   * the file's schemaVersion, which is stamped into the document;
            --   * the manifest version, which SELECTS THE NET-WORTH ARITHMETIC
            --     (v1 rounds per account, v2 per currency -- one penny apart on
            --     a book with two counted accounts in a currency). Re-exporting
            --     a v1 file under this build's v2 rule produces a different
            --     total, which looks exactly like corruption.
            --
            -- Keys are namespaced (`source.*`) so a later phase can add its own
            -- without collision. Values are TEXT because this table's job is to
            -- remember, not to compute.
            CREATE TABLE store_meta (
                key   TEXT NOT NULL PRIMARY KEY,
                value TEXT NOT NULL
            ) STRICT
            """,
            // The indexes the app's real queries need once a book has thousands
            // of rows. All the transaction ones are PARTIAL -- `WHERE deleted_at
            // IS NULL` -- which both matches how every read filters and keeps
            // tombstones out of the index entirely.
            "CREATE INDEX idx_transactions_account_date ON transactions(account_id, date) WHERE deleted_at IS NULL",
            "CREATE INDEX idx_transactions_date ON transactions(date) WHERE deleted_at IS NULL",
            // Import dedupe (SPEC 7.3) looks a candidate row up by this hash
            // once per imported line; without the index that is a full scan per
            // line, which is quadratic on the size of the file being imported.
            "CREATE INDEX idx_transactions_dedupe ON transactions(dedupe_hash) WHERE deleted_at IS NULL",
            "CREATE INDEX idx_transactions_category ON transactions(category_id) WHERE deleted_at IS NULL",
            // Undoing an import as a unit.
            "CREATE INDEX idx_transactions_batch ON transactions(import_batch_id) WHERE deleted_at IS NULL",
            "CREATE INDEX idx_transaction_splits_category ON transaction_splits(category_id)",
            "CREATE INDEX idx_transaction_tags_tag ON transaction_tags(tag_id)",
            "CREATE INDEX idx_accounts_group ON accounts(group_id) WHERE deleted_at IS NULL",
            "CREATE INDEX idx_categories_parent ON categories(parent_id) WHERE deleted_at IS NULL",
            "CREATE INDEX idx_payees_name_lower ON payees(name_lower) WHERE deleted_at IS NULL",
        ]
    )

    // MARK: - Migration 3: the register's own order

    static let migration3 = StoreMigration(
        version: 3,
        name: "register order indexes",
        statements: [
            // THE REGISTER'S ORDER, INDEXED.
            //
            // The register reads NEWEST FIRST, `date DESC, created_at DESC, id
            // DESC` (Register.orderClause), and it reads a PAGE AT A TIME from
            // a cursor -- `WHERE (date, created_at, id) < (?, ?, ?)`. Migration
            // 2's `idx_transactions_account_date` covers the account and the
            // date and stops there, which leaves SQLite to sort every group of
            // same-date rows and, worse, leaves the row-value comparison above
            // without a full key to seek on.
            //
            // These two carry the WHOLE sort key, so a page is one seek plus a
            // scan of exactly the rows it returns, whether it is the first page
            // or the fortieth. Partial (`WHERE deleted_at IS NULL`) like every
            // other transaction index here: tombstones are not register rows,
            // and keeping them out of the index keeps it the size of the book.
            //
            // DESC is spelled out rather than left to SQLite's ability to walk
            // an ascending index backwards, because that ability stops at the
            // first mixed-direction ORDER BY and this file should not depend on
            // a query planner's mood.
            """
            CREATE INDEX idx_transactions_register
                ON transactions(date DESC, created_at DESC, id DESC)
                WHERE deleted_at IS NULL
            """,
            """
            CREATE INDEX idx_transactions_account_register
                ON transactions(account_id, date DESC, created_at DESC, id DESC)
                WHERE deleted_at IS NULL
            """,
            // The other leg of a transfer is looked up by this id, once per
            // page. Without an index that is a full scan of the transactions
            // table per page, which is precisely the "smooth over 5,127 rows"
            // promise broken by the smallest column on the row.
            """
            CREATE INDEX idx_transactions_transfer_group
                ON transactions(transfer_group_id)
                WHERE deleted_at IS NULL AND transfer_group_id IS NOT NULL
            """,
        ]
    )

    /// The chain, in order. Each entry runs exactly once, inside one
    /// transaction with the row that records it, so a migration that fails
    /// halfway leaves a store at the version it was at before.
    ///
    /// THE SHAPE THE NEXT ONE WILL TAKE, written down because the constraints
    /// are not obvious and are enforced by SQLite rather than by review:
    ///
    ///   * `ALTER TABLE ... ADD COLUMN` works on a STRICT table.
    ///   * A `NOT NULL` column added by ALTER must have a non-null CONSTANT
    ///     default ("Cannot add a NOT NULL column with default value NULL").
    ///     A column whose value has to be computed per row is added nullable,
    ///     back-filled with an UPDATE in the same migration, and only then
    ///     tightened -- which in SQLite means rebuilding the table.
    ///   * Adding a column to a table with a `live_*` view means DROPping and
    ///     recreating that view in the same migration; `SELECT *` was expanded
    ///     when the view was created and will not see the new column.
    static let all: [StoreMigration] = [migration1, migration2, migration3]
}
