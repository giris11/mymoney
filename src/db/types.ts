// All persisted record shapes (Dexie tables). SPEC §5.
// Monetary amounts are ALWAYS integers in the currency's minor units (SPEC §6).

export type AccountType = 'current' | 'savings' | 'credit_card' | 'cash' | 'loan' | 'investment';
export type TxStatus = 'cleared' | 'pending';
export type CategoryKind = 'income' | 'expense';
export type BudgetPeriod = 'weekly' | 'monthly' | 'yearly';
export type ThemeChoice = 'system' | 'light' | 'dark';

export interface Account {
  id: string;
  name: string;
  type: AccountType;
  currency: string; // ISO code, e.g. 'GBP'
  openingBalanceMinor: number;
  colour: string; // hex
  groupId: string | null;
  sortOrder: number;
  archived: boolean;
  /**
   * Show the account, but leave it OUT of net-worth totals.
   *
   * What it does and does not do: it changes what a TOTAL counts, and nothing
   * else. The account keeps its own balance, every transaction is untouched,
   * and no amount anywhere is re-computed. Category-based reports (spending,
   * income, cash flow, payee, tag) group by CATEGORY, not by account, and are
   * deliberately unaffected — a gift card you spend is still spending.
   * The account stays VISIBLE with its balance shown: "not counted" is not
   * "hidden", and the user must never be unable to find their money.
   * It composes with `archived` (archived OR excluded ⇒ not counted); the two
   * are independent — archiving retires an account, excluding only re-scopes
   * the headline figure.
   *
   * THE FLAG LIVES ON THE ACCOUNT, and this is the single source of truth.
   * A group-level control is a BULK ACTION that writes this field on every
   * account currently in that group (setGroupExcluded in domain/accounts.ts) —
   * it is a snapshot, not a rule, so an account moved into the group later is
   * unaffected. A second, group-level flag was considered and REJECTED: with
   * two independent flags, un-excluding one account inside an excluded group
   * has no obvious correct answer (does the account win, or the group?), and a
   * finance app must never leave the user guessing which of two switches is
   * deciding their net worth.
   *
   * OPTIONAL ON PURPOSE — undefined means false. Every account row written by
   * an earlier build, and every account row inside an older backup file, lacks
   * this key entirely; treating undefined as false makes those rows already
   * correct, so no Dexie migration and no SCHEMA_VERSION bump is needed. That
   * holds only because the field is NOT INDEXED: the accounts store is
   * declared `'id, groupId, archived'` in src/db/db.ts, and IndexedDB only
   * cares about a schema change when the set of indexes changes. Backups keep
   * round-tripping too, since they store whole rows (src/backup/backup.ts).
   * If this ever needs an index, that IS a migration — bump the version.
   */
  excludeFromNetWorth?: boolean;
  // Loan fields (Phase 2 amortisation view)
  loanPrincipalMinor?: number;
  loanRatePct?: number;
  loanTermMonths?: number;
}

export interface AccountGroup {
  id: string;
  name: string;
  sortOrder: number;
}

export interface Split {
  categoryId: string | null;
  amountMinor: number; // signed, same convention as parent
  notes?: string;
}

export interface Transaction {
  id: string;
  accountId: string;
  date: string; // 'YYYY-MM-DD' (calendar date, timezone-proof)
  amountMinor: number; // signed: expenses negative, income positive
  currency: string; // == account currency
  payeeId: string | null;
  categoryId: string | null; // null for transfers and uncategorised
  tagIds: string[];
  notes: string;
  status: TxStatus;
  splits: Split[]; // non-empty ⇒ must sum exactly to amountMinor
  transferGroupId: string | null; // two legs share one id
  importBatchId: string | null;
  dedupeHash: string; // normalised accountId|date|amount|payee-or-desc (D10)
  createdAt: string; // ISO timestamp
  updatedAt: string;
}

export interface Category {
  id: string;
  name: string;
  parentId: string | null;
  kind: CategoryKind;
  icon?: string;
  colour?: string;
  archived: boolean;
  sortOrder: number;
}

export interface Payee {
  id: string;
  name: string;
  nameLower: string; // for case-insensitive lookup/index
  defaultCategoryId: string | null; // learned (SPEC §7.4)
}

export interface Tag {
  id: string;
  name: string;
  nameLower: string;
}

export interface Budget {
  id: string;
  name: string;
  categoryIds: string[]; // descendants included when computing spend (D16)
  amountMinor: number; // in base currency (D22)
  period: BudgetPeriod;
  startDate: string; // 'YYYY-MM-DD' anchor for period windows
  rollover: boolean; // Phase 2; stored now for forward-compat
  archived: boolean;
}

// {base, quote, rate}: 1 unit of `base` = `rate` units of `quote` (D11).
export interface FxRate {
  id: string; // `${base}:${quote}`
  base: string;
  quote: string;
  rate: number;
  asOf: string; // ISO timestamp
  source: 'manual' | 'auto';
}

export interface ImportBatch {
  id: string;
  source: 'moneywiz' | 'csv' | 'sample';
  fileName: string;
  rowCount: number;
  importedAt: string;
  // recorded so undo can also remove entities the import created (D18)
  createdAccountIds: string[];
  createdCategoryIds: string[];
  createdPayeeIds: string[];
  createdTagIds: string[];
  createdGroupIds: string[];
  // only the sample-data batch creates these (D19)
  createdBudgetIds?: string[];
  createdFxRateIds?: string[];
}

// Saved generic-CSV column mapping, persisted per file signature (SPEC §7.2)
export interface ColumnMapping {
  // column indices into the CSV row; -1 = not present
  date: number;
  amount: number; // used when debit/credit are -1
  debit: number; // money out (stored negative)
  credit: number; // money in (stored positive)
  payee: number;
  description: number;
  category: number;
  account: number;
  currency: number;
  tags: number;
  notes: number;
  dateFormat: 'auto' | 'DMY' | 'MDY' | 'YMD';
  decimal: 'auto' | 'dot' | 'comma';
  negate: boolean; // flip the sign of single-column amounts
  headerRow: boolean;
}

export interface Settings {
  id: 'app';
  schemaVersion: number;
  baseCurrency: string;
  theme: ThemeChoice;
  lastBackupAt: string | null;
  onboarded: boolean;
  lastUsedAccountId: string | null;
  savedMappings: Record<string, ColumnMapping>; // key = file signature
  createdAt: string;
  /**
   * Live FX rates (D34). SPEC §8.2 lists auto rates as Phase 2; pulled forward
   * at Girish's request. When enabled the app makes ONE outbound request to a
   * free, no-key rates source — the single network call SPEC §2.3 permits.
   * Manual rates are never overwritten by it.
   */
  autoFxEnabled: boolean;
  lastFxSyncAt: string | null;
  /** Human-readable name of the source that last supplied rates. */
  lastFxSyncSource: string | null;

  // ------------------------------------------------------- Drive sync (D42)
  //
  // SPEC §8.3's "optional Google Drive backup sync". Every field below is
  // supplied by defaultSettings(), so a settings row written by an older build
  // — or restored from an older backup — gains them through the normalisation
  // in getSettings() and needs no Dexie migration (none of them is indexed;
  // the settings store is declared `'id'`). SCHEMA_VERSION is unchanged.
  //
  // Which of these travel between devices and which stay put is decided ONCE,
  // in DEVICE_LOCAL_SETTING_KEYS (src/db/db.ts): everything named `sync*` here
  // is device-local, because a pulled snapshot carries the OTHER device's
  // settings row and must never be allowed to steal this device's identity,
  // its OAuth client id, or its sync bookkeeping. Every OTHER key in this
  // interface is book-level and is listed in BOOK_LEVEL_SETTING_KEYS beside
  // it; a key in neither list is a compile error, because a setting nobody
  // classified is a setting sync will silently get wrong (C3/C7).

  /** Master switch for AUTOMATIC syncing. A manual "Sync now" ignores it. */
  syncEnabled: boolean;
  /**
   * Stable id for THIS browser profile, minted lazily on first use
   * (`''` until then — defaultSettings() must stay a pure value, so it cannot
   * mint one itself or every getSettings() call would invent a new device).
   */
  syncDeviceId: string;
  /** What the user calls this device in conflict dialogs. `''` ⇒ guess it. */
  syncDeviceName: string;
  /**
   * The user's OWN Google OAuth client id. A browser app cannot keep a client
   * secret, and we ship no credential of ours, so this is pasted in by the
   * user (docs/DRIVE-SETUP.md). Not a secret — but device-local, because it is
   * useless to a device that has not been set up anyway.
   */
  syncClientId: string | null;
  /** ISO timestamp of the last successful push or pull. */
  syncLastSyncedAt: string | null;
  /** Revision number of the remote snapshot this device's data descends from. */
  syncLastPulledRevision: number;
  /**
   * IDENTITY of the remote snapshot this device's data descends from — the
   * answer to "is the file in Drive the one my book grew out of?", which the
   * revision NUMBER above cannot give (two devices can write the same number
   * over different books, and a re-created file starts counting at 1 again;
   * see SyncSnapshot.snapshotId). `null` means this device has never agreed
   * with any remote file.
   *
   * Device-local, and emphatically so: it describes what THIS device last
   * saw. A snapshot carries the writing device's settings row, so letting it
   * travel would hand this device someone else's ancestry — after which the
   * engine would compare our book against a file we have never seen and call
   * it agreement. Listed in DEVICE_LOCAL_SETTING_KEYS with the rest.
   *
   * Like every field in this block it is supplied by defaultSettings() and is
   * NOT indexed (the settings store is declared `'id'`, and this value is
   * never queried by — only read with the row), so adding it needs no Dexie
   * version block and SCHEMA_VERSION is unchanged: an older row gains it as
   * `null` through the normalisation in getSettings().
   *
   * `null` on a device that has already synced (syncLastPulledRevision > 0)
   * therefore means "written by a build from before ancestry", not "never
   * synced" — the engine tells the two apart and falls back to the revision
   * table for that device until its next push or pull records an id.
   */
  syncLastPulledSnapshotId: string | null;
  /**
   * The ids OLDER than syncLastPulledSnapshotId in the same lineage, newest
   * first and not including it, bounded to the most recent few. Together the
   * two make the chain this device's book sits on.
   *
   * It is carried so that a push can hand the chain on: a snapshot names the
   * ancestors it descends from (SyncSnapshot.ancestry), and the pushing device
   * is the only one that knows them — the cheap head read exposes a file's
   * parent, never its grandparent. Without it, a device two pushes behind
   * cannot be told apart from a device on a different lineage, and the
   * commonest thing two devices do (one syncs twice, then the other) becomes a
   * conflict.
   *
   * Device-local, like the id it extends, and for the same reason: it
   * describes what THIS device has seen. Not indexed, supplied by
   * defaultSettings(), so no Dexie migration — an older row gains it as `[]`.
   * An empty array is always safe: it proves nothing, so the worst it can do
   * is make the engine ask a question it could have answered itself.
   */
  syncAncestry: string[];
  /**
   * Monotonic counter of local CHANGE BATCHES. Bumped once per write
   * operation on a data table by the tracker in db.ts (coalesced — a
   * 5,127-row import bumps it once, not 5,127 times).
   */
  syncLocalRevision: number;
  /**
   * The value syncLocalRevision had at the last successful push/pull.
   * `syncLocalRevision !== syncSyncedLocalRevision` is the ONE definition of
   * "this device has unsynced changes".
   *
   * Deliberately not "reset syncLocalRevision to 0 on sync": a write that
   * lands DURING a push would be erased by that reset, the device would look
   * clean while differing from the remote, and the next pull would overwrite
   * the change without anybody being asked. Comparing against a captured
   * value makes that window visible instead — the worst case is a redundant
   * push, never a silent loss.
   */
  syncSyncedLocalRevision: number;
}
