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
//  * downloadBackup hands the JSON file to the user and reports whether the
//    save was OBSERVED, merely delivered, or cancelled — it never stamps
//    settings.lastBackupAt itself (D30);
//  * markBackupSaved is the only writer of settings.lastBackupAt: call it for
//    an observed save, or when the user confirms the file landed;
//  * nudge: due when transactions exist and lastBackupAt is null or >7 days
//    ago (SPEC §8.1.9).
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

/** Pretty JSON (2-space indent) — humans may inspect their backups. */
export function serializeBackup(file: BackupFile): string {
  return JSON.stringify(file, null, 2);
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
 *  * 'delivered' — the file was handed to the browser's downloader, which
 *    reports nothing back: it may be on disk, or the user may have cancelled
 *    the "where to save?" dialog, or the download may have been blocked. The
 *    caller must ask the user before recording it.
 *  * 'cancelled' — the user dismissed the save dialog; nothing was written.
 */
export type BackupSaveResult = 'saved' | 'delivered' | 'cancelled';

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

/**
 * Browser-only: build the snapshot and hand it to the user. Deliberately does
 * NOT touch settings.lastBackupAt — a browser cannot tell us that an
 * <a download> reached the disk, and telling someone they have a backup they
 * do not have is the worst failure this app can have (SPEC §9). Callers stamp
 * via markBackupSaved() on 'saved', or after the user confirms a 'delivered'
 * file arrived.
 */
export async function downloadBackup(): Promise<BackupSaveResult> {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    // Guarded so importing (and calling by mistake) in Node tests is safe.
    throw new Error('downloadBackup requires a browser environment');
  }
  const json = serializeBackup(await exportBackup());
  const fileName = `mymoney-backup-${todayISO()}.json`;

  const picked = await saveViaFilePicker(json, fileName);
  if (picked !== 'unsupported') return picked;

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
  txCount: number;
}

const NUDGE_AFTER_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

/** Due when transactions exist AND (never backed up OR last backup >7 days old). */
export async function backupNudgeState(): Promise<BackupNudge> {
  const txCount = await db.transactions.count();
  const { lastBackupAt } = await getSettings();
  let stale = true;
  if (lastBackupAt !== null) {
    const t = Date.parse(lastBackupAt);
    // An unparseable timestamp counts as stale — never claim a recent backup we can't prove.
    stale = Number.isNaN(t) || Date.now() - t > NUDGE_AFTER_MS;
  }
  return { due: txCount > 0 && stale, lastBackupAt, txCount };
}

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;
