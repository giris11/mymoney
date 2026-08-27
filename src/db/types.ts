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

  // ----------------------------------------------------- Cloud sync (D42/D45)
  //
  // SPEC §8.3's "optional cloud backup sync" — Dropbox since D45. Every field
  // below is supplied by defaultSettings(), so a settings row written by an
  // older build — or restored from an older backup — gains them through the
  // normalisation in getSettings() and needs no Dexie migration (none of them
  // is indexed; the settings store is declared `'id'`). SCHEMA_VERSION is
  // unchanged.
  //
  // WHAT IS DELIBERATELY NOT HERE, AND MUST NEVER BE ADDED (D45).
  //
  //  * THE DROPBOX `rev`. It is the transport's compare-and-swap token: opaque,
  //    issued by Dropbox, meaningful only inside the request that carries it.
  //    Storing it here would give it a second life as remembered state, which
  //    is precisely the overload — one value acting as both "the token I write
  //    with" and "the evidence I reason from" — that produced C18/C19 and cost
  //    this subsystem four review rounds. Causal identity lives in
  //    syncLastPulledSnapshotId; the rev lives in the transport's own
  //    localStorage observation cache and nowhere else.
  //  * THE DROPBOX REFRESH TOKEN, for a harder reason: `exportBackup()` copies
  //    this whole row into every backup file the user saves or shares. A
  //    credential here would be a credential in every copy of every backup. It
  //    lives in localStorage, owned by src/sync/dropboxAuth.ts.
  //
  // The rule both cases follow: this row is for what the BOOK and the DEVICE
  // are, never for what the transport is currently holding.
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
   * AN OPTIONAL OVERRIDE FOR THE DROPBOX APP KEY — blank/null means "use the
   * one built into this build", which is the normal case.
   *
   * IT USED TO BE MANDATORY, and the change is worth recording. Google gave us
   * no usable public client, so the Drive build shipped no credential at all
   * and the user had to create an OAuth client and paste its id in before sync
   * would work. Dropbox's app key is designed to live in client-side code (the
   * secret it comes with is never used and cannot be held by a browser app),
   * so the app carries its own and this field exists only for an owner who
   * wants to point the app at a Dropbox app of their own.
   *
   * Still called `syncClientId` because that is the OAuth parameter's real
   * name and because the Sync screen reads it under that name; renaming it is
   * a UI change, not a data one. Not a secret — but device-local, because it
   * is useless to a device that has not been set up anyway.
   */
  syncClientId: string | null;
  /** ISO timestamp of the last successful push or pull. */
  syncLastSyncedAt: string | null;
  /**
   * Revision number of the remote snapshot this device's data descends from.
   *
   * FOR DISPLAY AND ORDERING, and — since D45 — for nothing else. There is no
   * longer a decision path that compares it to the remote's number: the engine
   * asks about identity, or it asks the user. It is still written, because a
   * push has to number itself above what is there and the Sync screen prints
   * it, and it still counts as evidence that this device has a history worth
   * protecting when the remote file has vanished (C13).
   */
  syncLastPulledRevision: number;
  /**
   * IDENTITY of the remote snapshot this device's data descends from — the
   * answer to "is the file in the cloud the one my book grew out of?", which
   * the revision NUMBER above cannot give (two devices can write the same
   * number over different books, and a re-created file starts counting at 1
   * again; see SyncSnapshot.snapshotId). `null` means this device has never
   * agreed with any remote file.
   *
   * IT IS ALSO A CLAIM THIS DEVICE CAN TESTIFY TO. Only two things write it:
   * a push (we authored those bytes) and a pull (we downloaded and applied
   * them). Both have held the body. That is what makes it legitimate for the
   * next push to name it as `parentSnapshotId` — an assertion every other
   * device treats as proof of descent — and it is why 'up-to-date' no longer
   * writes it: a head read is not a body, and recording an id off one was D2.
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
   * `null` alongside a syncLastPulledRevision above zero is not a state any
   * build can now produce — the two are written together, and no device has
   * ever synced to Dropbox. It used to be the Drive migration state and it had
   * a revision-number fallback table to itself; that table is deleted (D45),
   * and a device that somehow arrives in that state is asked rather than
   * guessed at, which is what "cannot prove" means everywhere else here.
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
   * RETIRED (D45), and typed so that nothing can put a value back.
   *
   * WHAT THEY WERE. Together with syncLastPulledSnapshotId and
   * syncLastPulledRevision they made one STAMP, and the WHOLE stamp — never
   * the id on its own — was what the engine compared the remote head against.
   * That was not belt-and-braces; it was load-bearing, because Google Drive
   * MERGES appProperties on files.update. A key the writer omitted KEPT ITS
   * PREVIOUS VALUE, so a device on a build from before ancestry existed wrote
   * no snapshotId at all and left OURS sitting on a file whose contents were
   * now ITS book. An identity check read "still mine" over a stranger's book,
   * reported up-to-date, and let the next push destroy that device's rows with
   * no conflict and no safety file (C18). `savedAt` and `deviceId` are fields
   * every writer actively writes, and only an actively-written field can
   * testify that somebody wrote.
   *
   * WHY THEY ARE GONE. On Dropbox identity lives inside the file BODY, which
   * is replaced wholesale on every write, so no writer can inherit another's
   * identity by omitting a field and `snapshotId` answers the question on its
   * own. Keeping the stamp was not neutral: it was the door D2 came through —
   * `upToDate()` recorded a whole stamp, straight off a head read, for a
   * device that had proved nothing about that head. The separation is the fix
   * and the stamp was the symptom, so the symptom is deleted rather than
   * guarded.
   *
   * WHY THEY ARE STILL DECLARED. The Sync screen still reads both names, and
   * that screen belongs to another workstream. `?: undefined` keeps it
   * compiling while making the fields incapable of holding anything: a future
   * branch cannot quietly start recording a stamp again, because there is no
   * value it could assign. defaultSettings() no longer supplies them, so a
   * settings row simply stops having the keys. Delete both lines — and their
   * entry in RETIRED_SETTING_KEYS — when the screen stops naming them.
   */
  syncLastPulledSavedAt?: undefined;
  /** RETIRED (D45) — see syncLastPulledSavedAt. */
  syncLastPulledDeviceId?: undefined;
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
