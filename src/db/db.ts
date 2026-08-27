// Dexie database. Every future schema change MUST ship as a new
// this.version(n) block with an upgrade function (SPEC §9 migrations),
// and SCHEMA_VERSION must be bumped to match.
import Dexie, { type Table } from 'dexie';
import type {
  Account,
  AccountGroup,
  Budget,
  Category,
  FxRate,
  ImportBatch,
  Payee,
  Settings,
  Tag,
  Transaction,
} from './types';

export const SCHEMA_VERSION = 1;

export class MyMoneyDB extends Dexie {
  accounts!: Table<Account, string>;
  accountGroups!: Table<AccountGroup, string>;
  transactions!: Table<Transaction, string>;
  categories!: Table<Category, string>;
  payees!: Table<Payee, string>;
  tags!: Table<Tag, string>;
  budgets!: Table<Budget, string>;
  fxRates!: Table<FxRate, string>;
  importBatches!: Table<ImportBatch, string>;
  settings!: Table<Settings, string>;

  constructor() {
    super('mymoney');
    this.version(SCHEMA_VERSION).stores({
      accounts: 'id, groupId, archived',
      accountGroups: 'id, sortOrder',
      transactions:
        'id, accountId, date, categoryId, payeeId, transferGroupId, importBatchId, dedupeHash, status, [accountId+date], *tagIds',
      categories: 'id, parentId, kind',
      payees: 'id, nameLower',
      tags: 'id, nameLower',
      budgets: 'id, archived',
      fxRates: 'id, base, quote',
      importBatches: 'id, importedAt',
      settings: 'id',
    });
  }
}

export const db = new MyMoneyDB();

/**
 * The tables that hold the user's BOOK — everything a sync moves and
 * everything a local edit can touch. `settings` is deliberately absent from
 * the TRACKER's view of the world: it is part-book, part-device (see Settings
 * in ./types), and the tracker records itself into that very row, so watching
 * it here would bump the counter forever. The book-level half of the row is
 * still a change worth pushing — `updateSettings` marks those itself, see
 * BOOK_LEVEL_SETTING_KEYS below.
 */
export const DATA_TABLES = [
  'accounts',
  'accountGroups',
  'transactions',
  'categories',
  'payees',
  'tags',
  'budgets',
  'fxRates',
  'importBatches',
] as const;
export type DataTableName = (typeof DATA_TABLES)[number];

/** Table names in a stable order — used by backup export/restore. */
export const ALL_TABLES = [...DATA_TABLES, 'settings'] as const;
export type TableName = (typeof ALL_TABLES)[number];

// ===========================================================================
// The settings row is half book, half device — and the split is load-bearing
// ===========================================================================
//
// `settings` is one row containing two completely different kinds of value,
// and sync has to treat them as opposites:
//
//  * DEVICE-LOCAL keys describe THIS browser: its theme, its identity, its
//    sync bookkeeping. They never travel — a pulled snapshot carries the other
//    device's row, and taking its `syncLocalRevision` (or its device id) would
//    make the next sync compare the wrong numbers, which is exactly how a
//    silent overwrite happens. They must also never mark the device dirty, or
//    recording a sync would itself be an unsynced change and the tracker would
//    chase its own tail forever.
//  * BOOK-LEVEL keys describe the USER'S BOOK: the currency every total is
//    denominated in, whether the app may fetch rates, the saved CSV mappings.
//    They DO travel inside a snapshot — so a change to one is a change to the
//    book, and must mark the device dirty exactly like adding a transaction.
//
// Getting the second half wrong is C3/C7: `settings` is excluded from
// DATA_TABLES above, so the dbcore tracker never sees it, so changing the
// base currency left the device "clean". It was never pushed, and the next
// pull — taken silently, because a clean device has nothing to lose — put the
// old currency back. Every total in the app was then denominated in a currency
// the user had explicitly changed away from, with no conflict, no prompt and
// no safety file. `updateSettings` below closes that by bumping the counter
// itself for book-level keys; the tracker still ignores the table, because a
// bump IS a settings write and tracking it would loop.
//
// ONE LIST EACH, AND EVERY KEY IN EXACTLY ONE. The type assertion below turns
// "somebody added a Settings field and classified it nowhere" into a compile
// error, and a test in tests/sync-engine.test.ts walks defaultSettings() to
// say the same thing at runtime. A silently unclassified key would default to
// travelling (mergeSettingsRow pins only the device-local list) while never
// marking the device dirty — i.e. straight back to the C3/C7 defect.

/**
 * Settings keys that belong to THIS DEVICE: never sent, never taken from a
 * snapshot, never a reason to push.
 */
export const DEVICE_LOCAL_SETTING_KEYS = [
  'theme', // a phone may want dark while the iMac is light
  'lastBackupAt', // backup files are per-device
  'createdAt', // when THIS browser first ran the app
  'lastUsedAccountId', // a quick-add convenience, not a fact about the book
  'syncEnabled',
  'syncDeviceId',
  'syncDeviceName',
  'syncClientId',
  'syncLastSyncedAt',
  'syncLastPulledRevision',
  'syncLastPulledSnapshotId',
  'syncAncestry',
  'syncLocalRevision',
  'syncSyncedLocalRevision',
] as const satisfies readonly (keyof Settings)[];

/**
 * Settings keys that belong to THE BOOK: they travel in a snapshot, so
 * changing one leaves this device holding something the remote has not seen.
 *
 * `id` and `schemaVersion` are here because they are part of the row that
 * travels, not because a user can change them: `updateSettings` cannot patch
 * `id` at all, and both are stamped to constants by mergeSettingsRow /
 * restoreBackup. They can therefore never trigger a bump in practice — they
 * are listed so that the exhaustiveness check below is a real check.
 */
export const BOOK_LEVEL_SETTING_KEYS = [
  'id',
  'schemaVersion',
  'baseCurrency', // every total and every report is denominated in it
  'onboarded', // a fact about the book, not about the browser
  'savedMappings', // CSV column mappings, keyed by file signature
  'autoFxEnabled', // the switch that makes the app a zero-request island
  'lastFxSyncAt',
  'lastFxSyncSource',
] as const satisfies readonly (keyof Settings)[];

export type DeviceLocalSettingKey = (typeof DEVICE_LOCAL_SETTING_KEYS)[number];
export type BookLevelSettingKey = (typeof BOOK_LEVEL_SETTING_KEYS)[number];

/**
 * Compile-time proof that the two lists cover `Settings` EXACTLY: nothing
 * missing, nothing in both. `AssertNever` fails to accept anything else, and
 * the error message names the offending key ("Type '"baseCurrency"' does not
 * satisfy the constraint 'never'").
 */
type AssertNever<T extends never> = T;
type _EverySettingIsClassified = AssertNever<
  Exclude<keyof Settings, DeviceLocalSettingKey | BookLevelSettingKey>
>;
type _NoSettingIsBoth = AssertNever<Extract<DeviceLocalSettingKey, BookLevelSettingKey>>;

export function defaultSettings(): Settings {
  return {
    id: 'app',
    schemaVersion: SCHEMA_VERSION,
    baseCurrency: 'GBP',
    theme: 'system',
    lastBackupAt: null,
    onboarded: false,
    lastUsedAccountId: null,
    savedMappings: {},
    createdAt: new Date().toISOString(),
    // On by default because live rates were explicitly asked for (D34); one
    // switch in Settings turns the app back into a zero-request island.
    autoFxEnabled: true,
    lastFxSyncAt: null,
    lastFxSyncSource: null,
    // Drive sync (D42). Off, unconnected and unidentified until the user asks
    // for it; syncDeviceId stays '' until something mints one, because this
    // function is called on EVERY getSettings() and must return the same value
    // every time (a uid() here would invent a new device on each read).
    syncEnabled: false,
    syncDeviceId: '',
    syncDeviceName: '',
    syncClientId: null,
    syncLastSyncedAt: null,
    syncLastPulledRevision: 0,
    // Null, never '' — "this device descends from nothing" has to be
    // distinguishable from an id, and an empty string compares equal to
    // another empty string, which would read as two devices agreeing.
    syncLastPulledSnapshotId: null,
    syncAncestry: [],
    syncLocalRevision: 0,
    syncSyncedLocalRevision: 0,
  };
}

/**
 * Settings row, normalised over the current defaults. Spreading the stored row
 * over defaultSettings() means a row written by an older build gains any newly
 * added field with its default instead of surfacing `undefined` — so adding a
 * setting never needs a schema migration, and restoring an older backup keeps
 * working (SPEC §9).
 */
export async function getSettings(): Promise<Settings> {
  const stored = await db.settings.get('app');
  return stored ? { ...defaultSettings(), ...stored } : defaultSettings();
}

/**
 * Patch the settings row.
 *
 * The read and the write are ONE transaction. They have to be: this is a
 * read-modify-write of a whole row, and since sync's change tracker (below)
 * also writes to that row from a timer, a read here followed by a put there
 * would quietly drop whichever change lost the race. A dropped
 * `syncLocalRevision` bump is not a cosmetic loss — it makes a device with
 * unsynced edits look clean, which is how a pull silently overwrites them.
 * (Nesting is safe: every caller that already holds an rw transaction has
 * `settings` in its scope, or its existing `settings.put` would throw today.)
 *
 * A patch that changes a BOOK-LEVEL key marks the device as locally changed,
 * because that value travels in a snapshot: without this, changing the base
 * currency left the device clean, never pushed it, and let the next pull put
 * the old currency back with no conflict and no safety file (C3/C7). The mark
 * is raised AFTER the transaction commits, so a patch that aborts does not
 * claim a change that never happened — and it goes through the same coalescing
 * flag as every other write, so a burst of settings writes still costs one
 * revision bump.
 *
 * The bump lives here rather than in the dbcore middleware below on purpose:
 * the middleware skips `settings` entirely because writing the counter is
 * itself a settings write, and tracking that would loop forever. Writers that
 * bypass this function (restoreBackup's bulkAdd, the tracker's own flush)
 * therefore never bump — which is right for both: a restore rewrites every
 * data table too, and the flush IS the bump.
 */
export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  let changedTheBook = false;
  const next = await db.transaction('rw', db.settings, async () => {
    const prev = await getSettings();
    const merged = { ...prev, ...patch };
    changedTheBook = changesBookLevelSetting(prev, merged);
    await db.settings.put(merged);
    return merged;
  });
  if (changedTheBook) markLocalChange();
  return next;
}

/**
 * Did this patch change something that travels?
 *
 * Compared by VALUE, not by "was the key present in the patch": several
 * screens re-save the whole row, and a device that reported a change every
 * time a component re-rendered would push constantly and, worse, teach the
 * user that "unsynced changes" means nothing.
 *
 * The one object-valued key (savedMappings) cannot use Object.is — every read
 * from IndexedDB is a fresh structured clone, so an unchanged row would
 * compare unequal to itself. It is a small dictionary of CSV column indices,
 * so JSON is both cheap and exact. Anything JSON cannot represent (there is
 * nothing today) would compare unequal and cost a redundant push, which is the
 * safe direction: over-reporting a change costs a push, under-reporting one
 * costs the change.
 */
function changesBookLevelSetting(prev: Settings, next: Settings): boolean {
  for (const key of BOOK_LEVEL_SETTING_KEYS) {
    const a: unknown = prev[key];
    const b: unknown = next[key];
    if (Object.is(a, b)) continue;
    if (typeof a === 'object' && a !== null && typeof b === 'object' && b !== null) {
      if (JSON.stringify(a) === JSON.stringify(b)) continue;
    }
    return true;
  }
  return false;
}

// ===========================================================================
// Local-change tracking for sync (D42)
// ===========================================================================
//
// Sync has to answer one question before it can do anything safely: "does THIS
// device hold changes the remote has not seen?" Answering it by diffing the
// whole book against a remote snapshot would mean downloading 5,000+ rows on
// every check, so instead every write to a DATA table bumps a counter, and
// `syncLocalRevision !== syncSyncedLocalRevision` means dirty.
//
// Three properties this has to have, in order of importance:
//
//  1. NEVER MISS A WRITE. A missed write makes the device look clean, and a
//     clean device gets a pull applied over the top of it — the exact data
//     loss this feature must not cause. Hence a dbcore middleware, which sits
//     under every path into IndexedDB (add/put/delete/bulk*/collection
//     modify+delete, from domain code, the importer, restore, anywhere), not
//     table hooks bolted onto the tables we happened to think of.
//  2. COST NOTHING ON A BULK IMPORT. The middleware intercepts OPERATIONS,
//     not rows: one `bulkAdd` of 5,127 transactions is a single `mutate` call,
//     so the tracker runs once, sets a boolean, and gets out of the way.
//     Measured on the owner's real import size (5,127 rows) the added cost is
//     in the noise — see the header of tests/sync-engine.test.ts.
//  3. WRITE TO THE DB RARELY, AND NARROWLY. The counter lives in `settings`,
//     and a settings write per row would turn one import into 5,127 extra
//     transactions. So the flag is coalesced in memory and flushed once,
//     shortly after the writes stop (or immediately, when sync asks for it) —
//     and the flush touches ONE FIELD inside its own rw transaction, so it can
//     never lose a concurrent change to the theme or the base currency.
//
// `settings` itself is excluded from tracking — bumping the counter is a
// settings write, and tracking that would loop forever.
//
// TWO THINGS THE FLUSH DELIBERATELY DOES NOT DO:
//
//  * it never CREATES the settings row. A device that has not written one has
//    not been onboarded; materialising a row full of defaults from a
//    background timer would be a surprise to every other part of the app (and
//    to every test that expects to `settings.add` its own).
//  * it does nothing at all until sync is set up on this device
//    (`syncEnabled`, or a revision already agreed with a remote file). Before
//    that the counter is not consulted by anything: `hasLocalChanges()` treats
//    a device that has never synced as unsynced-by-definition, which is both
//    stricter and cheaper than any counter could be. So an app — or a test
//    suite — that never turns sync on pays nothing and sees no writes.

/** How long to wait for writes to stop before writing the bump to disk. */
const LOCAL_REVISION_FLUSH_MS = 250;

const DATA_TABLE_SET: ReadonlySet<string> = new Set(DATA_TABLES);

let pendingLocalChange = false;
let flushTimer: ReturnType<typeof setTimeout> | null = null;
let flushQueue: Promise<unknown> = Promise.resolve();
let suppressDepth = 0;

/**
 * Monotonic count of writes this device has NOTICED, flushed or not.
 *
 * Not a second revision counter: it never goes to disk and it is not compared
 * with anything remote. It exists so that a caller can say "clear the pending
 * flag I saw, and only that one". `clearPendingLocalChange()` used to be
 * unconditional, and the pull path called it after replacing the whole book —
 * which threw away the flag for a transaction the user had typed DURING the
 * download, leaving no evidence anywhere that the row had ever existed
 * (C2/C5/C6). Comparing marks makes that impossible to write by accident.
 */
let localChangeMark = 0;

function clearFlushTimer(): void {
  if (flushTimer !== null) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
}

/**
 * Note that the book changed. Cheap by design: a boolean and, at most, one
 * timer. Called by the middleware below; also exported so a caller that
 * bypasses Dexie (there is none today) can stay honest.
 */
export function markLocalChange(): void {
  if (suppressDepth > 0) return;
  localChangeMark++;
  pendingLocalChange = true;
  if (flushTimer !== null) return;
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushLocalRevision().catch(() => {
      /* retried by the next flush — pendingLocalChange is restored on failure */
    });
  }, LOCAL_REVISION_FLUSH_MS);
  // Node/vitest: a pending tracker timer must not keep the process alive.
  (flushTimer as unknown as { unref?: () => void }).unref?.();
}

/**
 * Is the counter worth maintaining on this device yet? True once sync is
 * switched on, or once this device has agreed a revision with a remote file.
 * Deliberately the same condition `hasLocalChanges()` uses to decide whether
 * to trust the counter at all, so the two can never drift apart.
 */
function trackingApplies(row: Settings | undefined): boolean {
  if (!row) return false;
  return row.syncEnabled === true || (row.syncLastPulledRevision ?? 0) > 0;
}

async function writeRevisionBump(): Promise<void> {
  if (!pendingLocalChange) return;
  pendingLocalChange = false;
  try {
    // ignoreTransaction: the flush can fire from a timer while a long rw
    // transaction is still open, and joining that transaction would either
    // throw (settings out of scope) or tie the bump to a write that may yet
    // abort. The bump is its own tiny transaction, always — and it reads and
    // writes inside that one transaction, so a concurrent updateSettings()
    // cannot be clobbered by a stale copy of the row.
    await Dexie.ignoreTransaction(() =>
      db.transaction('rw', db.settings, async () => {
        const row = await db.settings.get('app');
        if (!trackingApplies(row)) return; // no row, or sync not set up here
        await db.settings.update('app', {
          syncLocalRevision: (row!.syncLocalRevision ?? 0) + 1,
        });
      }),
    );
  } catch (e) {
    // Could not record it ⇒ we do not know that it is recorded. Put the flag
    // back so the next flush tries again: over-reporting a change costs a
    // redundant push, under-reporting one costs the change itself.
    pendingLocalChange = true;
    throw e;
  }
}

/**
 * Write any coalesced bump out NOW and resolve when it has landed. Sync calls
 * this before it reads the counters, so a change made a millisecond ago is
 * never mistaken for a clean device. Serialised through a queue so two callers
 * cannot read-modify-write the settings row over each other.
 */
export function flushLocalRevision(): Promise<void> {
  clearFlushTimer();
  const next = flushQueue.then(writeRevisionBump);
  flushQueue = next.catch(() => {});
  return next;
}

/**
 * Where this device's noticed-writes counter stands right now. Capture it
 * before a long operation, hand it back to `clearPendingLocalChange` after.
 */
export function localChangeMarkNow(): number {
  return localChangeMark;
}

/**
 * Forget a coalesced-but-unwritten change — but ONLY the one described by
 * `mark`. Correct in exactly one place: the local book has just been REPLACED
 * wholesale (applyRemote) and the pending flag refers to data that no longer
 * exists.
 *
 * `mark` is required, and is checked rather than trusted. If any write has
 * been noticed since it was taken, the flag belongs to data the caller has
 * never seen — a row typed while a sync was downloading — and clearing it
 * would erase the only evidence that the row existed. In that case nothing is
 * cleared and `false` is returned: over-reporting a change costs a redundant
 * push, under-reporting one costs the change itself.
 */
export function clearPendingLocalChange(mark: number): boolean {
  if (mark !== localChangeMark) return false;
  pendingLocalChange = false;
  clearFlushTimer();
  return true;
}

/** Test/diagnostic view of the un-flushed flag. */
export function hasPendingLocalChange(): boolean {
  return pendingLocalChange;
}

/**
 * Run `fn` with change tracking off — for writes that are the RESULT of a sync
 * (applying a remote snapshot), which must not then look like local edits and
 * cause a phantom conflict on the next run.
 *
 * Module-global on purpose (Dexie gives no per-caller write context). What
 * makes that safe is NOT that the app blocks its UI — it does not, and
 * believing it did is how a transaction typed during a sync was destroyed and
 * its pending flag dropped (C2/C5/C6). It is that the only caller wraps this
 * around ONE rw transaction spanning every table: while that transaction is
 * open, IndexedDB cannot start another write to those tables, so there is no
 * concurrent write to mis-suppress. Anything typed during the seconds BEFORE
 * the apply is a different problem, and one this flag cannot solve — the
 * caller checks for it inside the same transaction and abandons the apply.
 */
export async function withoutLocalChangeTracking<T>(fn: () => Promise<T>): Promise<T> {
  suppressDepth++;
  try {
    return await fn();
  } finally {
    suppressDepth--;
  }
}

db.use({
  stack: 'dbcore',
  name: 'syncLocalChangeTracker',
  create(down) {
    return {
      ...down,
      table(name: string) {
        const table = down.table(name);
        if (!DATA_TABLE_SET.has(name)) return table;
        return {
          ...table,
          mutate: (req) =>
            table.mutate(req).then((res) => {
              // After the operation, not before: a request that fails outright
              // never happened. (A write that succeeds inside a transaction
              // that later aborts still marks — over-marking is the safe
              // direction, and it costs one redundant push at most.)
              markLocalChange();
              return res;
            }),
        };
      },
    };
  },
});
