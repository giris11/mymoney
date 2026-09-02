// The one settings field this app can change, and the reason it has to be
// changeable at all.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHY THIS EXISTS. The base currency is asked for once, on the first screen
// anybody sees, before they have entered a single account -- and until this
// file there was no way to change the answer afterwards. A first-run choice
// that cannot be undone is a trap: the person who taps GBP because it is at the
// top of the list, and who actually keeps their money in LKR, would have had to
// delete the app and start again. The web app has never had that problem
// (src/ui/settings/AppearanceSection.tsx changes it from Settings), so this is
// a gap in the port rather than a new feature.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHAT CHANGING IT DOES, AND -- MUCH MORE IMPORTANTLY -- WHAT IT DOES NOT
//
// It changes ONE STRING: the currency the TOTALS are reported in. It does not
// touch a single stored amount. Every account keeps its own currency and its
// own integer minor units; every transaction keeps the currency it was entered
// in. `Balances.netWorth` converts each currency ONCE, through the fx rates the
// book holds, and says out loud which currencies it could not convert.
//
// That distinction is the whole safety argument, and it is why this is nothing
// like `saveAccount`'s currency field. Re-labelling an ACCOUNT would silently
// re-denominate every amount inside it -- "all my euros became pounds" -- so
// that is refused once history exists. Re-labelling the BASE re-denominates
// nothing: it changes which direction the arithmetic runs, and the arithmetic
// is redone from the rates each time a total is drawn. Nothing is lost, so
// nothing needs protecting, and the change is reversible by making it again.
//
// THE ONE THING THE OWNER MUST BE TOLD is that a base with no rate for a
// currency they hold produces an INCOMPLETE total -- and they are, by the
// screen that draws it: `NetWorth.missingRateCurrencies` is already printed in
// orange under the headline. This function neither invents a rate nor hides an
// account; it lets the existing honesty machinery report the consequence.
//
// IT COUNTS AS A LOCAL EDIT. The settings row travels in a backup file, so on
// an imported book this is one more thing this copy has that the web app does
// not -- exactly like renaming an account. On a book created here it counts
// nothing, for the reason LedgerStore+LocalEdits.swift gives.
import Foundation

extension LedgerStore {

    /// Change the currency every total is reported in.
    ///
    /// Returns the settings row as it now stands. Throws `EditError.badCurrency`
    /// for a code that is not three letters, and `EditError.noBook` on a device
    /// that holds no book. Nothing is written in either case.
    @discardableResult
    public func setBaseCurrency(_ code: String) throws -> Settings {
        let currency = Names.clean(code).uppercased()
        guard Validate.isCurrencyCode(currency) else { throw EditError.badCurrency(code) }

        return try connection.transaction {
            guard let existing = try readSettings() else { throw EditError.noBook }
            // Asking for the currency it already has is not an error and is
            // also not an edit: counting it would inflate the number the banner
            // shows for a tap that changed nothing.
            guard existing.baseCurrency != currency else { return existing }

            // EVERY OTHER FIELD IS CARRIED, INCLUDING `raw`. That is what keeps
            // the device-local `sync*` keys this package does not model on the
            // row -- `BackupWriter.settingsRow` re-merges them from `raw` on
            // the way out, so a book whose base currency was changed here still
            // exports the keys the browser wrote, and only the one value moves.
            let updated = Settings(
                id: existing.id,
                schemaVersion: existing.schemaVersion,
                baseCurrency: currency,
                theme: existing.theme,
                lastBackupAt: existing.lastBackupAt,
                onboarded: existing.onboarded,
                lastUsedAccountId: existing.lastUsedAccountId,
                savedMappings: existing.savedMappings,
                createdAt: existing.createdAt,
                autoFxEnabled: existing.autoFxEnabled,
                lastFxSyncAt: existing.lastFxSyncAt,
                lastFxSyncSource: existing.lastFxSyncSource,
                raw: existing.raw
            )
            try replaceSettings(updated)
            try recordLocalEdit(at: environment.now())

            // The row is re-read rather than returned from memory, so what
            // comes back is what a later reader will see -- `raw` included,
            // which is now the JSON just written rather than the JSON that was
            // there before. A caller comparing the two would otherwise find a
            // `raw` still claiming the old currency.
            guard let stored = try readSettings() else { throw EditError.noBook }
            return stored
        }
    }

    /// Write the settings row over whatever is there.
    ///
    /// AN UPSERT, NOT A DELETE AND AN INSERT. There is exactly one settings row
    /// and it is the row that says what currency this book's totals are in; a
    /// window in which it does not exist -- however short, however wrapped in a
    /// transaction -- is a window in which a reader would find a book with no
    /// base currency. `ON CONFLICT` never removes it.
    ///
    /// `row_json` is rebuilt by `BackupWriter.settingsRow`, the same function
    /// `writeSettings` uses, so there is still one path from record to stored
    /// bytes.
    private func replaceSettings(_ settings: Settings) throws {
        let statement = try connection.prepare(
            """
            INSERT INTO settings (
                id, schema_version, base_currency, theme, last_backup_at, onboarded,
                last_used_account_id, created_at, auto_fx_enabled, last_fx_sync_at,
                last_fx_sync_source, row_json
            ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)
            ON CONFLICT(id) DO UPDATE SET
                schema_version = ?2, base_currency = ?3, theme = ?4, last_backup_at = ?5,
                onboarded = ?6, last_used_account_id = ?7, created_at = ?8,
                auto_fx_enabled = ?9, last_fx_sync_at = ?10, last_fx_sync_source = ?11,
                row_json = ?12
            """
        )
        defer { statement.finalize() }
        statement.bind(1, text: settings.id)
        statement.bind(2, integer: settings.schemaVersion)
        statement.bind(3, text: settings.baseCurrency)
        statement.bind(4, text: settings.theme.rawValue)
        statement.bind(5, optionalText: settings.lastBackupAt)
        statement.bind(6, flag: settings.onboarded)
        statement.bind(7, optionalText: settings.lastUsedAccountId)
        statement.bind(8, text: settings.createdAt)
        statement.bind(9, flag: settings.autoFxEnabled)
        statement.bind(10, optionalText: settings.lastFxSyncAt)
        statement.bind(11, optionalText: settings.lastFxSyncSource)
        statement.bind(
            12, text: CanonicalJSON.text(BackupWriter.settingsRow(settings), indent: 0)
        )
        try statement.run()
    }

    /// The base currency this book's totals are reported in, or nil on a device
    /// with no book.
    public func baseCurrency() throws -> String? {
        try readSettings()?.baseCurrency
    }
}
