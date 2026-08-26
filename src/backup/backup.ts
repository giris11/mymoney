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
//  * downloadBackup hands the JSON file to the user by the most observable
//    route the device offers (file picker > OS share sheet > <a download>) and
//    reports which of them happened — it never stamps settings.lastBackupAt
//    itself (D33);
//  * markBackupSaved is the only writer of settings.lastBackupAt: call it for
//    an observed save, or when the user confirms the file landed;
//  * nudge: due when the user's OWN transactions exist (sample rows don't
//    count) and it is 7+ days since the last backup — or, with no backup ever,
//    7+ days since the install (settings.createdAt). SPEC §8.1.9 says "no
//    backup in 7+ days", not "no backup yet".
import { ALL_TABLES, db, getSettings, SCHEMA_VERSION, updateSettings } from '../db/db';
import { nowISO, todayISO } from '../lib/util';

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
 * All-or-nothing restore: ONE rw transaction clears every table, then bulkAdds
 * every row from the file. Any failure (e.g. a duplicate primary key) aborts
 * the transaction and leaves the previous data completely untouched (D21).
 */
export async function restoreBackup(file: BackupFile): Promise<void> {
  // Defence in depth: never write from a file that would not validate,
  // even if the caller skipped validateBackup.
  const checked = validateBackup(file);
  if (!checked.ok) throw new Error(checked.error);
  const tables = upgradeBackupData(checked.file);
  await db.transaction('rw', [...ALL_TABLES], async () => {
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
  if (typeof window === 'undefined') return 'unsupported';
  const picker = (window as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker !== 'function') return 'unsupported';
  let handle;
  try {
    handle = await picker.call(window, {
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
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    // Guarded so importing (and calling by mistake) in Node tests is safe.
    throw new Error('downloadBackup requires a browser environment');
  }
  const json = serializeBackup(await exportBackup());
  const fileName = `mymoney-backup-${todayISO()}.json`;

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
