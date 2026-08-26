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
 * everything a local edit can touch. `settings` is deliberately absent: it is
 * part-book, part-device (see Settings in ./types), and writing to it must
 * never count as a local data change or the revision tracker below would bump
 * itself forever.
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
 */
export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  return db.transaction('rw', db.settings, async () => {
    const next = { ...(await getSettings()), ...patch };
    await db.settings.put(next);
    return next;
  });
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
 * Forget a coalesced-but-unwritten change. Only correct where the local book
 * has just been REPLACED wholesale (applyRemote) and the pending flag refers
 * to data that no longer exists.
 */
export function clearPendingLocalChange(): void {
  pendingLocalChange = false;
  clearFlushTimer();
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
 * Module-global on purpose (Dexie gives no per-caller write context). The app
 * is single-user and blocks its UI during an apply, so the only writes in the
 * window are the apply's own; a concurrent write here would in any case be
 * overwritten by the apply it is racing.
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
