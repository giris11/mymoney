// The schema constants a backup file is read against.
//
// Mirrors src/db/db.ts. The table NAMES and their ORDER are part of the file
// format -- the manifest's rowCounts is keyed by them and the exporter writes
// them in this sequence -- so this list is not a convenience, it is a contract.
public enum Schema {
    /// SCHEMA_VERSION in src/db/db.ts. A file claiming a HIGHER version is
    /// refused rather than read (see BackupValidation): a newer build may have
    /// changed what a row means, and reading it with old assumptions is how a
    /// restore produces plausible wrong numbers instead of an error.
    public static let version = 1

    /// The tables that hold the owner's BOOK.
    public static let dataTables: [String] = [
        "accounts",
        "accountGroups",
        "transactions",
        "categories",
        "payees",
        "tags",
        "budgets",
        "fxRates",
        "importBatches",
    ]

    /// Every table, in the stable order backup export and restore use.
    public static let allTables: [String] = dataTables + ["settings"]
}
