// Backup & restore (SPEC §8.1.9).
//
// Semantics:
//  * exportBackup snapshots EVERY table (src/db/db.ts ALL_TABLES) plus
//    schemaVersion + exportedAt — read inside ONE 'r' transaction so the
//    snapshot is internally consistent;
//  * validateBackup fully validates shape/version BEFORE any write;
//  * restoreBackup is all-or-nothing: one Dexie rw-transaction that clears and
//    repopulates every table — a malformed file must change nothing (D21);
//  * restoring a backup with schemaVersion older than current applies the
//    necessary upgrades (see upgradeBackupData); newer than current → refuse
//    with a clear error;
//  * restoreBackup pins the DEVICE-LOCAL half of the settings row back to
//    this browser's own values (C8): a backup carries the settings row of the
//    device that wrote it, and a restore that took it verbatim would hand this
//    browser the other device's identity and sync bookkeeping;
//  * downloadBackup hands the JSON file to the user by the most observable
//    route the device offers (file picker > OS share sheet > <a download>) and
//    reports which of them happened — it never stamps settings.lastBackupAt
//    itself (D33). downloadBackupFile does the same for a file it is HANDED,
//    which is how the sync engine's conflict copy travels the same road;
//  * markBackupSaved is the only writer of settings.lastBackupAt: call it for
//    an observed save, or when the user confirms the file landed;
//  * the RECOVERY STORE (saveRecoverySnapshot and friends, bottom of the file)
//    keeps the last few books this app was about to destroy in a small
//    IndexedDB database of its own. It is the ONLY save here whose success can
//    be observed rather than hoped for, which is why sync's conflict
//    resolution is gated on it (C4);
//  * nudge: due when the user's OWN transactions exist (sample rows don't
//    count) and it is 7+ days since the last backup — or, with no backup ever,
//    7+ days since the install (settings.createdAt). SPEC §8.1.9 says "no
//    backup in 7+ days", not "no backup yet".
import Dexie, { type Table } from 'dexie';
import {
  ALL_TABLES,
  db,
  DEVICE_LOCAL_SETTING_KEYS,
  getSettings,
  SCHEMA_VERSION,
  updateSettings,
} from '../db/db';
import type { Settings } from '../db/types';
import { nowISO, todayISO, uid } from '../lib/util';

export interface BackupFile {
  app: 'MyMoney';
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export async function exportBackup(): Promise<BackupFile> {
  // One read transaction across every table: writes that land mid-export can
  // never produce a half-old, half-new snapshot.
  const tables = await db.transaction('r', [...ALL_TABLES], async () => {
    const out: Record<string, unknown[]> = {};
    for (const name of ALL_TABLES) out[name] = await db.table(name).toArray();
    return out;
  });
  return {
    app: 'MyMoney',
    schemaVersion: SCHEMA_VERSION,
    exportedAt: nowISO(),
    tables,
  };
}

/**
 * Total rows above which a backup is written COMPACT (E3).
 *
 * Pretty-printing costs ~45% of the file size — measured 26.5 MB vs 18.2 MB at
 * 50,000 transactions, ~53 MB vs ~36 MB at 100,000. That is a real burden when
 * the file has to travel off a phone, and nobody reads a 50,000-row JSON file
 * by eye anyway. Below the threshold the readability is free and occasionally
 * useful (a demo or a first week's data can be eyeballed in a text editor), so
 * small backups stay indented. ~2,000 rows is a few years of a light user or a
 * couple of months of a heavy one, and pretty-prints to well under 1 MB.
 *
 * Restore does not care either way: it is JSON.parse.
 */
export const PRETTY_PRINT_ROW_LIMIT = 2000;

/** Count every row in the snapshot, across all tables. */
function totalRows(file: BackupFile): number {
  let n = 0;
  for (const rows of Object.values(file.tables)) if (Array.isArray(rows)) n += rows.length;
  return n;
}

/**
 * Serialize a backup: indented while it is small enough for a human to read,
 * compact once it is big enough for the size to matter (PRETTY_PRINT_ROW_LIMIT).
 */
export function serializeBackup(file: BackupFile): string {
  return totalRows(file) > PRETTY_PRINT_ROW_LIMIT
    ? JSON.stringify(file)
    : JSON.stringify(file, null, 2);
}

export type BackupValidation = { ok: true; file: BackupFile } | { ok: false; error: string };

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/**
 * Validate a parsed backup without writing anything. Checks the file shape,
 * app marker, schemaVersion, presence of an array for every known table, and
 * basic per-row sanity (object with a string id; settings rows use id 'app').
 * Unknown extra table keys are ignored (forward/sideways compatibility).
 */
export function validateBackup(parsed: unknown): BackupValidation {
  const fail = (error: string): BackupValidation => ({ ok: false, error });

  if (!isPlainObject(parsed)) {
    return fail('Not a valid backup: expected a JSON object at the top level');
  }
  if (parsed.app !== 'MyMoney') {
    return fail('Not a MyMoney backup file: "app" field is missing or not "MyMoney"');
  }
  const version = parsed.schemaVersion;
  if (typeof version !== 'number' || !Number.isInteger(version) || version < 1) {
    return fail(
      `Invalid backup: "schemaVersion" must be a positive integer (got ${JSON.stringify(version)})`,
    );
  }
  if (version > SCHEMA_VERSION) {
    return fail(
      `This backup was created by a newer version of MyMoney (schema ${version}; ` +
        `this app supports up to ${SCHEMA_VERSION}). Update the app, then restore.`,
    );
  }
  if (typeof parsed.exportedAt !== 'string') {
    return fail('Invalid backup: "exportedAt" must be a timestamp string');
  }
  if (!isPlainObject(parsed.tables)) {
    return fail('Invalid backup: "tables" must be an object mapping table names to arrays');
  }
  const tables = parsed.tables;
  for (const name of ALL_TABLES) {
    const rows = tables[name];
    if (rows === undefined) return fail(`Invalid backup: table "${name}" is missing`);
    if (!Array.isArray(rows)) return fail(`Invalid backup: table "${name}" must be an array`);
    for (let i = 0; i < rows.length; i++) {
      const row: unknown = rows[i];
      if (!isPlainObject(row)) {
        return fail(`Invalid backup: ${name}[${i}] is not an object`);
      }
      if (typeof row.id !== 'string' || row.id === '') {
        return fail(`Invalid backup: ${name}[${i}] has no string "id"`);
      }
      if (name === 'settings' && row.id !== 'app') {
        return fail(`Invalid backup: settings[${i}] must have id "app" (got "${row.id}")`);
      }
    }
  }
  return { ok: true, file: parsed as unknown as BackupFile };
}

/**
 * Bring the rows of an older-schema backup up to the current schema.
 * SCHEMA_VERSION is 1 and validateBackup guarantees
 * 1 <= file.schemaVersion <= SCHEMA_VERSION, so there is nothing to transform
 * yet. When SCHEMA_VERSION grows, add per-version data transforms here
 * (v1→v2, v2→v3, …) applied in order. Restored settings rows are always
 * stamped with the schema they now conform to.
 */
function upgradeBackupData(file: BackupFile): Record<string, unknown[]> {
  const tables: Record<string, unknown[]> = {};
  for (const name of ALL_TABLES) tables[name] = file.tables[name] ?? [];
  tables.settings = tables.settings.map((row) => ({
    ...(row as Record<string, unknown>),
    schemaVersion: SCHEMA_VERSION,
  }));
  return tables;
}

/**
 * Take the BOOK from `incoming` and the DEVICE from `local` (C8).
 *
 * Every backup and every sync snapshot carries the whole settings row of the
 * device that wrote it — theme, install date, and (since sync) the device id,
 * name, OAuth client id and the bookkeeping that says which remote revision
 * this browser agreed with. Writing that row verbatim into a second browser
 * makes the two believe they are the same device: the conflict dialog then
 * labels BOTH sides "iMac" at the exact moment the user has to choose which
 * copy of the book to destroy, and the restored `syncLastPulledRevision`
 * describes a file this device never read. DEVICE_LOCAL_SETTING_KEYS (db.ts)
 * is the one list that says which half is which; both the sync apply path
 * (mergeSettingsRow) and this restore path pin exactly it, because a conflict
 * safety copy is restored through here.
 *
 * The book-level half — base currency, onboarded, saved CSV mappings, the FX
 * switch — is taken from the file, because that is what restoring a backup
 * MEANS.
 */
export function pinDeviceLocalSettings(local: Settings, incoming: unknown): Settings {
  const from = isPlainObject(incoming) ? (incoming as Partial<Settings>) : {};
  const merged = { ...local, ...from } as Settings & Record<string, unknown>;
  for (const key of DEVICE_LOCAL_SETTING_KEYS) {
    (merged as Record<string, unknown>)[key] = local[key];
  }
  merged.id = 'app';
  merged.schemaVersion = SCHEMA_VERSION;
  return merged;
}

/**
 * All-or-nothing restore: ONE rw transaction clears every table, then bulkAdds
 * every row from the file. Any failure (e.g. a duplicate primary key) aborts
 * the transaction and leaves the previous data completely untouched (D21).
 *
 * The settings row is the single exception to "the file, verbatim": it is read
 * from THIS device before the clear and merged through pinDeviceLocalSettings,
 * so a restore can never import another browser's identity. A file with no
 * settings row at all still leaves this device with its own one rather than
 * none — losing an identity is the same defect in the other direction, and a
 * device with no row cannot even say when it was installed.
 */
export async function restoreBackup(file: BackupFile): Promise<void> {
  // Defence in depth: never write from a file that would not validate,
  // even if the caller skipped validateBackup.
  const checked = validateBackup(file);
  if (!checked.ok) throw new Error(checked.error);
  const tables = upgradeBackupData(checked.file);
  await db.transaction('rw', [...ALL_TABLES], async () => {
    // BEFORE the clear, or there would be nothing left to pin from.
    const local = await getSettings();
    const incoming = tables.settings;
    // Mapped one-for-one rather than collapsed to a single row: two settings
    // rows in a file is corruption, and bulkAdd must still be the thing that
    // catches it (validateBackup has already pinned every id to 'app').
    tables.settings =
      incoming.length === 0
        ? [pinDeviceLocalSettings(local, undefined)]
        : incoming.map((row) => pinDeviceLocalSettings(local, row));
    for (const name of ALL_TABLES) await db.table(name).clear();
    for (const name of ALL_TABLES) {
      const rows = tables[name];
      // bulkAdd (not bulkPut): a duplicate id is corruption — abort, don't mask.
      if (rows.length > 0) await db.table(name).bulkAdd(rows as never[]);
    }
  });
}

/**
 * What actually happened to the file (D30):
 *  * 'saved' — the browser confirmed the bytes were written to a location the
 *    user chose. The only outcome we can honestly call a backup.
 *  * 'shared' — the OS share sheet ran to completion with the file attached
 *    (iOS/Android). Stronger than 'delivered': the user picked a destination
 *    and a cancel would have rejected. Still not proof that the destination
 *    KEPT the file (a share into a mail draft that is then discarded looks the
 *    same), so the caller still asks — but asks about a specific, real event.
 *  * 'delivered' — the file was handed to the browser's downloader, which
 *    reports nothing back: it may be on disk, or the user may have cancelled
 *    the "where to save?" dialog, or the download may have been blocked. The
 *    caller must ask the user before recording it.
 *  * 'cancelled' — the user dismissed the save/share dialog; nothing was written.
 */
export type BackupSaveResult = 'saved' | 'shared' | 'delivered' | 'cancelled';

interface SaveFilePickerWindow {
  showSaveFilePicker?: (options: {
    suggestedName?: string;
    types?: { description: string; accept: Record<string, string[]> }[];
  }) => Promise<{
    createWritable: () => Promise<{
      write: (data: string) => Promise<void>;
      close: () => Promise<void>;
    }>;
  }>;
}

const isAbort = (e: unknown): boolean =>
  typeof e === 'object' && e !== null && (e as { name?: unknown }).name === 'AbortError';

/**
 * File System Access API path (Chrome/Edge desktop): the write resolving is
 * proof the file exists, and a cancel is reported instead of being invisible.
 * Returns 'unsupported' when the API is absent or refused up front, so the
 * caller falls back to the <a download> path. A failing WRITE throws — a
 * half-written backup must surface as an error, not a shrug.
 */
async function saveViaFilePicker(
  json: string,
  fileName: string,
): Promise<BackupSaveResult | 'unsupported'> {
  // `globalThis`, not `window`: in a browser they are the same object, and
  // this way the ladder is usable from code that must stay importable without
  // one. The sync engine kept its own weaker copy of this function for exactly
  // that reason, and that copy is what silently destroyed books (C4).
  const picker = (globalThis as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') return 'unsupported';
  let handle;
  try {
    handle = await picker.call(globalThis, {
      suggestedName: fileName,
      types: [{ description: 'MyMoney backup', accept: { 'application/json': ['.json'] } }],
    });
  } catch (e) {
    if (isAbort(e)) return 'cancelled';
    return 'unsupported'; // blocked (e.g. permissions policy) — try the anchor
  }
  const writable = await handle.createWritable();
  await writable.write(json);
  await writable.close();
  return 'saved';
}

interface ShareNavigator {
  canShare?: (data: { files?: File[] }) => boolean;
  share?: (data: { files?: File[]; title?: string }) => Promise<void>;
  maxTouchPoints?: number;
}

/**
 * Is the OS share sheet the right save path on this device? (E4)
 *
 * On a phone or tablet an <a download> is the worst case in this whole file:
 * iOS gives no completion signal, no dialog and no obvious destination, so the
 * app can never honestly say a backup happened. `navigator.share({files})`
 * does give a signal — the user chooses "Save to Files"/iCloud Drive and a
 * cancel REJECTS with AbortError.
 *
 * Desktops are deliberately excluded (`maxTouchPoints === 0`): Chromium
 * desktop already has the strictly better showSaveFilePicker path, and on
 * macOS Safari a share sheet in place of the familiar download would be a
 * surprise, not an improvement.
 */
export function shareSheetAvailable(): boolean {
  if (typeof navigator === 'undefined' || typeof File === 'undefined') return false;
  const nav = navigator as unknown as ShareNavigator;
  if (typeof nav.share !== 'function' || typeof nav.canShare !== 'function') return false;
  return (nav.maxTouchPoints ?? 0) > 0;
}

/**
 * Web Share path (iOS/Android): hand the JSON over as a real File so the share
 * sheet offers "Save to Files"/Drive. Resolving means the sheet completed;
 * AbortError means the user backed out and nothing was written — a genuine
 * signal either way, which is more than the anchor can ever give. Any other
 * error (NotAllowedError from a lost user gesture, an unshareable type) falls
 * back to the anchor rather than failing the export.
 */
async function saveViaShareSheet(
  json: string,
  fileName: string,
): Promise<BackupSaveResult | 'unsupported'> {
  if (!shareSheetAvailable()) return 'unsupported';
  const nav = navigator as unknown as ShareNavigator;
  const file = new File([json], fileName, { type: 'application/json' });
  if (!nav.canShare!({ files: [file] })) return 'unsupported';
  try {
    await nav.share!({ files: [file], title: fileName });
  } catch (e) {
    if (isAbort(e)) return 'cancelled';
    return 'unsupported';
  }
  return 'shared';
}

/**
 * Browser-only: build the snapshot and hand it to the user. Deliberately does
 * NOT touch settings.lastBackupAt — neither an <a download> nor a share sheet
 * can tell us the file reached storage, and telling someone they have a backup
 * they do not have is the worst failure this app can have (SPEC §9). Callers
 * stamp via markBackupSaved() on 'saved', or after the user confirms a
 * 'shared'/'delivered' file really landed.
 */
export async function downloadBackup(): Promise<BackupSaveResult> {
  return downloadBackupFile(await exportBackup(), `mymoney-backup-${todayISO()}.json`);
}

/**
 * The same ladder for a file the caller already HAS — a conflict safety copy,
 * or one read back out of the recovery store. Exported because the sync engine
 * used to carry its own cut-down version of it, which skipped the share sheet
 * (i.e. the only real signal an iPhone can give) and treated a failed write as
 * a reason to fall through to the silent anchor rather than as a failure (C4).
 * One ladder, one set of rungs, one meaning for each result.
 */
export async function downloadBackupFile(
  file: BackupFile,
  fileName: string,
): Promise<BackupSaveResult> {
  return deliverJson(serializeBackup(file), fileName);
}

async function deliverJson(json: string, fileName: string): Promise<BackupSaveResult> {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    // Guarded so importing (and calling by mistake) in Node tests is safe.
    throw new Error('downloadBackup requires a browser environment');
  }
  // Best available signal first: an observed write (Chromium desktop), then the
  // share sheet (phones/tablets — a real completion/cancel signal), then the
  // anchor, which tells us nothing and must be confirmed by the user.
  const picked = await saveViaFilePicker(json, fileName);
  if (picked !== 'unsupported') return picked;

  const shared = await saveViaShareSheet(json, fileName);
  if (shared !== 'unsupported') return shared;

  const blob = new Blob([json], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    a.rel = 'noopener';
    document.body.appendChild(a);
    a.click();
    a.remove();
  } finally {
    // Delay revocation: some browsers (Safari) start the download async.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  return 'delivered';
}

/**
 * Record a backup that actually landed — either observed by the browser or
 * confirmed by the user. The single writer of settings.lastBackupAt, so the
 * 7-day nudge can never be reset by an unverified export (D30).
 */
export async function markBackupSaved(when: string = nowISO()): Promise<void> {
  await updateSettings({ lastBackupAt: when });
}

export interface BackupNudge {
  due: boolean;
  lastBackupAt: string | null;
  /** Every transaction in the database, sample rows included. */
  txCount: number;
  /** Transactions a backup would actually be protecting — sample rows excluded. */
  realTxCount: number;
}

const NUDGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/**
 * Transactions belonging to a 'sample' import batch (D19). Counted through the
 * importBatchId index, so the common case (no sample data) costs one tiny
 * importBatches scan and the loaded case never walks the transactions table.
 */
async function sampleTransactionCount(): Promise<number> {
  const sampleBatchIds = await db.importBatches
    .filter((b) => b.source === 'sample')
    .primaryKeys();
  if (sampleBatchIds.length === 0) return 0;
  return db.transactions.where('importBatchId').anyOf(sampleBatchIds as string[]).count();
}

/**
 * Due when there is real data to lose AND no backup in 7+ days (SPEC §8.1.9).
 *
 * Two things this deliberately does NOT do:
 *  * nag on day one. "No backup yet" is not the same as "no backup in 7 days":
 *    with lastBackupAt still null the clock runs from settings.createdAt, so a
 *    fresh install gets the same week of grace the spec gives everyone else.
 *    (Settings → Backup still says "Never backed up." the whole time — the
 *    state is visible, it is just not shouted from every screen.)
 *  * nag about demo money. If every transaction present belongs to the sample
 *    batch there is nothing of the user's to lose, and one tap deletes the lot.
 * Unparseable timestamps always count as stale: never claim a backup we cannot
 * prove.
 */
export async function backupNudgeState(): Promise<BackupNudge> {
  const txCount = await db.transactions.count();
  const realTxCount = txCount === 0 ? 0 : txCount - (await sampleTransactionCount());
  const { lastBackupAt, createdAt } = await getSettings();

  let stale: boolean;
  if (lastBackupAt === null) {
    const created = Date.parse(createdAt);
    stale = Number.isNaN(created) || Date.now() - created > NUDGE_AFTER_MS;
  } else {
    const t = Date.parse(lastBackupAt);
    stale = Number.isNaN(t) || Date.now() - t > NUDGE_AFTER_MS;
  }
  return { due: realTxCount > 0 && stale, lastBackupAt, txCount, realTxCount };
}

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;

// ===========================================================================
// The recovery store — the only save here whose success can be PROVED (C4)
// ===========================================================================
//
// WHY IT EXISTS. Resolving a sync conflict destroys one of two copies of the
// whole book, and the promise made to the user beforehand is that the losing
// copy has been written somewhere they can get it back from. That promise used
// to be kept by handing a file to the browser's downloader, which reports
// NOTHING: a blocked download, a dismissed "where do you want to save this?"
// prompt, or iOS opening the JSON in a preview tab instead of keeping it are
// all indistinguishable, from inside the page, from a file safely on disk. On
// every browser without showSaveFilePicker — i.e. every iPhone and iPad, the
// exact second device this feature exists for — the book was then cleared on
// the strength of that silence.
//
// So the save that GATES the destruction is now a write into IndexedDB on this
// device: one transaction we wait for, then a read-back that proves the bytes
// are there and are the bytes we meant. The file download still happens (the
// owner should have a copy outside the app, and the ladder above can often
// prove that one too) but it is no longer the only thing standing between a
// mis-click and a book that exists nowhere.
//
// WHY A SEPARATE DEXIE DATABASE, NOT A TABLE IN `db`:
//  * a recovery copy is a copy of the book, so it must never be part of the
//    book. As a table in the main database it would be one careless addition
//    to ALL_TABLES away from being exported inside every backup and uploaded
//    inside every sync snapshot (each file then carrying its predecessors) —
//    and, far worse, restoreBackup CLEARS every table in ALL_TABLES before it
//    writes, so the safety net would be destroyed by the very restore it
//    exists to feed. In its own database that mistake cannot be written;
//  * it needs no schema version bump of the user's real database. This store is
//    disposable by definition; the book is not.
// The cost, and it is a real one: Settings → "Erase all data" clears
// `db.tables` and would leave these copies behind. clearRecoveryStore() is
// exported for that button to call.

/**
 * How many copies to keep.
 *
 * Each one is a whole book — a few megabytes for the owner's 5,127 rows — and
 * they are kept only until the user is sure the resolution was the right one.
 * Three covers "I got the last conflict wrong" plus two before it, which is
 * more history than a conflict prompt that requires typing REPLACE is ever
 * likely to produce, while bounding the store at roughly three books.
 */
export const RECOVERY_KEEP = 3;

export type RecoveryReason = 'conflict-keep-local' | 'conflict-keep-remote';

/** A book this app was about to destroy, kept where it can prove it is kept. */
export interface RecoveryRecord {
  id: string;
  /**
   * Monotonic within the store. Ordering by timestamp is not enough: two
   * copies can be written inside the same millisecond, and then "delete the
   * oldest" has no defined meaning — which is exactly the operation that must
   * never pick the wrong one.
   */
  seq: number;
  savedAt: string;
  reason: RecoveryReason;
  /** One line of plain truth about what this copy IS, written by the caller. */
  label: string;
  /** The name the matching download was offered under. */
  fileName: string;
  /** What became of that download — never a reason to keep or drop this copy. */
  delivery: BackupSaveResult | 'not-offered';
  /** Rows per table, so a list can describe a copy without loading it. */
  counts: Record<string, number>;
  /** Size of the stored JSON, in JS string units. */
  bytes: number;
  schemaVersion: number;
}

interface RecoveryBody {
  id: string;
  json: string;
}

class RecoveryDB extends Dexie {
  records!: Table<RecoveryRecord, string>;
  bodies!: Table<RecoveryBody, string>;

  constructor() {
    super('mymoney-recovery');
    // Two stores rather than one row carrying its own JSON: listing three
    // copies must not deserialize three whole books to draw three lines of
    // text. They are written and deleted together, always.
    this.version(1).stores({ records: 'id, seq', bodies: 'id' });
  }
}

/** Exported so "erase all data" and the tests can reach it. */
export const recoveryDb = new RecoveryDB();

function tableRowCounts(file: BackupFile): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of ALL_TABLES) {
    const rows = file.tables[name];
    out[name] = Array.isArray(rows) ? rows.length : 0;
  }
  return out;
}

/** Body first: a metadata row with no body would list a copy nothing can restore. */
async function writeRecoveryRecord(
  record: RecoveryRecord,
  json: string,
): Promise<RecoveryRecord> {
  return recoveryDb.transaction('rw', recoveryDb.records, recoveryDb.bodies, async () => {
    const newest = await recoveryDb.records.orderBy('seq').last();
    const stored: RecoveryRecord = { ...record, seq: (newest?.seq ?? 0) + 1 };
    await recoveryDb.bodies.put({ id: stored.id, json });
    await recoveryDb.records.put(stored);
    return stored;
  });
}

/**
 * Drop the oldest copies until at most `keep` remain — never `protectedId`,
 * which is the one the caller has just written and is about to rely on.
 * Returns how many were freed.
 */
async function pruneRecoveryStore(keep: number, protectedId: string | null): Promise<number> {
  return recoveryDb.transaction('rw', recoveryDb.records, recoveryDb.bodies, async () => {
    const all = await recoveryDb.records.orderBy('seq').toArray(); // oldest first
    const excess = all.length - Math.max(0, keep);
    if (excess <= 0) return 0;
    const doomed = all.filter((r) => r.id !== protectedId).slice(0, excess);
    for (const r of doomed) {
      await recoveryDb.records.delete(r.id);
      await recoveryDb.bodies.delete(r.id);
    }
    return doomed.length;
  });
}

/**
 * Keep a copy of `file` on this device, and PROVE it is kept.
 *
 * Throws if it cannot — which is the entire contract. A caller that is about
 * to destroy the book must treat a throw as "abandon everything, nothing is
 * safe yet"; that is the one thing the anchor-download path it replaces could
 * never say (C4).
 *
 * Three things happen in order, and the order is load-bearing:
 *  1. the write, in one transaction over both stores;
 *  2. a READ-BACK, in a fresh transaction, comparing the stored JSON with the
 *     bytes we meant to store. A driver that accepted the write and kept
 *     nothing, a quota failure that surfaced as a silent no-op, a body written
 *     without its metadata row — all of them are indistinguishable from
 *     success until something reads the data back, and this function's whole
 *     reason to exist is that somebody does;
 *  3. only then, pruning. Never before: giving up a real copy to make room for
 *     a write that then fails would be paying for nothing. If the write DOES
 *     fail we prune once and try again, because "the store is full" must not
 *     be a permanent refusal to protect anything ever again.
 */
export async function saveRecoverySnapshot(
  file: BackupFile,
  meta: {
    reason: RecoveryReason;
    label: string;
    fileName: string;
    delivery?: BackupSaveResult;
  },
): Promise<RecoveryRecord> {
  const checked = validateBackup(file);
  if (!checked.ok) {
    throw new Error(`refusing to keep an unusable recovery copy — ${checked.error}`);
  }
  const json = serializeBackup(checked.file);
  const record: RecoveryRecord = {
    id: uid(),
    seq: 0, // assigned inside the write transaction
    savedAt: nowISO(),
    reason: meta.reason,
    label: meta.label,
    fileName: meta.fileName,
    delivery: meta.delivery ?? 'not-offered',
    counts: tableRowCounts(checked.file),
    bytes: json.length,
    schemaVersion: checked.file.schemaVersion,
  };

  let stored: RecoveryRecord;
  try {
    stored = await writeRecoveryRecord(record, json);
  } catch (e) {
    const freed = await pruneRecoveryStore(RECOVERY_KEEP - 1, record.id).catch(() => 0);
    if (freed === 0) throw e; // nothing to give up: the original failure stands
    stored = await writeRecoveryRecord(record, json);
  }

  const [row, body] = await Promise.all([
    recoveryDb.records.get(stored.id),
    recoveryDb.bodies.get(stored.id),
  ]);
  if (!row || !body || body.json !== json) {
    throw new Error(
      'the recovery copy could not be read back after saving it, so it cannot be relied on',
    );
  }
  // Pruning is housekeeping, not safety: the copy is already proved. A failure
  // here must not turn a successful save into a refusal.
  await pruneRecoveryStore(RECOVERY_KEEP, stored.id).catch(() => 0);
  return row;
}

/** Newest first — what a "Recover a replaced copy" list wants. */
export async function listRecoveryRecords(): Promise<RecoveryRecord[]> {
  return recoveryDb.records.orderBy('seq').reverse().toArray();
}

/** The stored book, parsed and fully validated — never a half-checked file. */
export async function readRecoveryBackup(id: string): Promise<BackupFile> {
  const body = await recoveryDb.bodies.get(id);
  if (!body) throw new Error('That recovery copy is no longer on this device.');
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.json);
  } catch {
    throw new Error('That recovery copy is unreadable — it is not valid JSON.');
  }
  const checked = validateBackup(parsed);
  if (!checked.ok) throw new Error(checked.error);
  return checked.file;
}

/**
 * Put a kept copy back. Goes through the normal restore, so it is all-or-
 * nothing and it pins this device's own settings (see pinDeviceLocalSettings):
 * recovering from a conflict must not also hand this browser the identity of
 * the device it was in conflict with (C8).
 */
export async function restoreRecoveryBackup(id: string): Promise<void> {
  await restoreBackup(await readRecoveryBackup(id));
}

/** Hand a kept copy to the user as a file, by the same ladder as any backup. */
export async function downloadRecoveryBackup(id: string): Promise<BackupSaveResult> {
  const [record, body] = await Promise.all([
    recoveryDb.records.get(id),
    recoveryDb.bodies.get(id),
  ]);
  if (!record || !body) throw new Error('That recovery copy is no longer on this device.');
  return deliverJson(body.json, record.fileName);
}

/** Forget one kept copy, on the user's say-so. Metadata and body together. */
export async function deleteRecoveryRecord(id: string): Promise<void> {
  await recoveryDb.transaction('rw', recoveryDb.records, recoveryDb.bodies, async () => {
    await recoveryDb.records.delete(id);
    await recoveryDb.bodies.delete(id);
  });
}

/**
 * Forget every kept copy. For "Erase all data", which clears the main database
 * and would otherwise leave copies of the erased book on the device.
 */
export async function clearRecoveryStore(): Promise<void> {
  await recoveryDb.transaction('rw', recoveryDb.records, recoveryDb.bodies, async () => {
    await recoveryDb.records.clear();
    await recoveryDb.bodies.clear();
  });
}

