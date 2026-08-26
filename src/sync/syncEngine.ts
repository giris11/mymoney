// The sync engine (D42; SPEC §8.3 "optional Google Drive backup sync").
//
// WHAT THIS IS FOR. The app has no server, so every browser holds its own
// IndexedDB. Open the site on a second device and it is empty. This module
// moves the WHOLE BOOK between devices through one file in the user's own
// Google Drive: last-writer-wins at the file level, with the crucial
// exception that when both sides have moved it refuses to pick a winner.
//
// THE GOVERNING RULE — WHEN IN DOUBT, REFUSE AND ASK. This is the first
// feature in the app that can destroy real data (SPEC §2.6: "data loss is
// unacceptable"), so every path here is written to that rule:
//
//  * nothing is merged, ever. A snapshot is applied whole or not at all;
//  * a conflict is never resolved automatically — `syncNow` returns both
//    sides described in row counts, device names and timestamps, writes
//    NOTHING, and only acts when called again with an explicit opts.resolve;
//  * whichever side loses a resolved conflict is written to a local backup
//    file FIRST, in the normal backup format, restorable through the normal
//    Restore screen. If that safety file cannot be written, the resolution is
//    abandoned and nothing is touched;
//  * a snapshot is fully validated before a single row is written, and one
//    from a NEWER schema is refused outright;
//  * applying is all-or-nothing — one Dexie rw transaction (restoreBackup),
//    so a failure halfway leaves the original book exactly as it was.
//
// MONEY IS NEVER TOUCHED. A snapshot is `exportBackup()`'s tables verbatim:
// whole rows, integer minor units, moved and compared but never arithmetic'd.
//
// OFFLINE-FIRST. With no network the app behaves exactly as it does today:
// syncNow returns 'offline' and changes nothing on either side.

import {
  ALL_TABLES,
  DATA_TABLES,
  clearPendingLocalChange,
  db,
  flushLocalRevision,
  getSettings,
  markLocalChange,
  SCHEMA_VERSION,
  updateSettings,
  withoutLocalChangeTracking,
} from '../db/db';
import type { Settings } from '../db/types';
import {
  exportBackup,
  restoreBackup,
  serializeBackup,
  validateBackup,
  type BackupFile,
} from '../backup/backup';
import { nowISO, todayISO, uid } from '../lib/util';
import type { SyncOutcome, SyncSnapshot, SyncState, SyncSummary, SyncTransport } from './types';

export type { SyncOutcome, SyncSnapshot, SyncState, SyncSummary, SyncTransport } from './types';

// ===========================================================================
// Device identity
// ===========================================================================

/**
 * Settings keys that belong to THIS DEVICE and must survive a pull unchanged.
 *
 * A snapshot carries the writing device's whole settings row. Applying it
 * naively would hand this device the other one's identity (so both would claim
 * to be "iMac"), its OAuth client id, and — far worse — its sync bookkeeping:
 * lastPulledRevision and the local-change counters. Corrupt those and the next
 * sync compares the wrong numbers, which is precisely how a silent overwrite
 * happens. So the merge keeps the book-level preferences from the snapshot and
 * pins these back to their local values.
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
  'syncLocalRevision',
  'syncSyncedLocalRevision',
] as const satisfies readonly (keyof Settings)[];

function guessDeviceName(): string {
  const ua =
    typeof navigator === 'undefined' ? '' : ((navigator as { userAgent?: string }).userAgent ?? '');
  if (/iPhone/i.test(ua)) return 'iPhone';
  if (/iPad/i.test(ua)) return 'iPad';
  if (/Android/i.test(ua)) return 'Android phone';
  if (/Macintosh|Mac OS X/i.test(ua)) return 'Mac';
  if (/Windows/i.test(ua)) return 'Windows PC';
  if (/Linux/i.test(ua)) return 'Linux PC';
  return 'This device';
}

/**
 * The stable id and display name for this browser profile, minted on first use
 * and persisted. Writing settings does not count as a local data change, so
 * this never makes a clean device look dirty.
 */
export async function ensureSyncIdentity(): Promise<{ deviceId: string; deviceName: string }> {
  const s = await getSettings();
  const deviceId = s.syncDeviceId || uid();
  const deviceName = s.syncDeviceName || guessDeviceName();
  if (deviceId !== s.syncDeviceId || deviceName !== s.syncDeviceName) {
    await updateSettings({ syncDeviceId: deviceId, syncDeviceName: deviceName });
  }
  return { deviceId, deviceName };
}

// ===========================================================================
// State
// ===========================================================================

/** Last remote revision seen in THIS session (no network call to report it). */
let lastKnownRemoteRevision: number | null = null;

/**
 * Is this device holding changes the remote has not seen?
 *
 * TWO REGIMES, because a counter cannot describe a device that has never
 * synced:
 *
 *  * NEVER AGREED WITH A REMOTE FILE (lastPulledRevision === 0). Nothing this
 *    device holds has ever been anywhere else, so ANY real book is unsynced —
 *    no counter required, and no way for a device that imported 5,127 rows
 *    before switching sync on to look clean and get overwritten.
 *    The exception is a PRISTINE book: a brand-new browser seeds the default
 *    category tree and may fetch FX rates before the user has done anything at
 *    all, and treating that as "changes" would turn the very first sync of a
 *    new device — the entire point of this feature — into a conflict between
 *    "42 seeded categories" and "the owner's real 5,127 transactions". No
 *    accounts, no transactions, no budgets, no imports and onboarding
 *    unfinished ⇒ nothing of the user's to lose ⇒ it pulls cleanly. A book
 *    with even one account is a real book and gets the conflict it deserves.
 *  * ONCE SYNCED, the counter is exact: it moved since the last push/pull, or
 *    it did not.
 */
export async function hasLocalChanges(settings?: Settings): Promise<boolean> {
  const s = settings ?? (await getSettings());
  if (s.syncLastPulledRevision === 0) return !(await isPristineBook(s));
  return s.syncLocalRevision !== s.syncSyncedLocalRevision;
}

async function isPristineBook(s: Settings): Promise<boolean> {
  if (s.onboarded) return false;
  const [accounts, transactions, budgets, imports] = await Promise.all([
    db.accounts.count(),
    db.transactions.count(),
    db.budgets.count(),
    db.importBatches.count(),
  ]);
  // fxRates are deliberately not consulted: the auto-rate module writes them
  // by itself (D34), so they say nothing about what the user has done.
  return accounts === 0 && transactions === 0 && budgets === 0 && imports === 0;
}

/** Everything the Settings UI needs, without touching the network. */
export async function getSyncState(transport?: SyncTransport): Promise<SyncState> {
  const s = await getSettings();
  return {
    enabled: s.syncEnabled,
    connected: transport?.isConnected() ?? false,
    lastSyncedAt: s.syncLastSyncedAt,
    lastPulledRevision: s.syncLastPulledRevision,
    localRevision: s.syncLocalRevision,
    remoteRevision: lastKnownRemoteRevision,
    deviceId: s.syncDeviceId,
    hasLocalChanges: await hasLocalChanges(s),
  };
}

/**
 * Mark this device as changed, immediately and durably.
 *
 * The tracker in db.ts already does this for every write to a data table; this
 * is the manual door for a caller that changed something Dexie cannot see, and
 * it coalesces with any bump already pending rather than double-counting.
 */
export async function bumpLocalRevision(): Promise<void> {
  markLocalChange();
  await flushLocalRevision();
}

// ===========================================================================
// Snapshots
// ===========================================================================

const isPlainObject = (x: unknown): x is Record<string, unknown> =>
  typeof x === 'object' && x !== null && !Array.isArray(x);

/** Row counts per table — the honest, cheap way to describe a snapshot. */
export function snapshotCounts(tables: Record<string, unknown[]>): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of ALL_TABLES) out[name] = Array.isArray(tables[name]) ? tables[name].length : 0;
  return out;
}

async function localCounts(): Promise<Record<string, number>> {
  return db.transaction('r', [...ALL_TABLES], async () => {
    const out: Record<string, number> = {};
    for (const name of ALL_TABLES) out[name] = await db.table(name).count();
    return out;
  });
}

/**
 * The local book as a snapshot, read through `exportBackup()` — one 'r'
 * transaction across every table, so a write landing mid-read can never
 * produce a half-old, half-new file. Reusing the backup module is deliberate:
 * a snapshot and a backup must stay the same thing forever, or a restore of a
 * conflict-safety file would not work.
 *
 * @param revision what the snapshot claims to be. Defaults to the last remote
 * revision this device agreed with; `syncNow` passes the revision it is about
 * to write.
 */
export async function localSnapshot(revision?: number): Promise<SyncSnapshot> {
  const { deviceId, deviceName } = await ensureSyncIdentity();
  const s = await getSettings();
  const file = await exportBackup();
  return {
    app: 'MyMoney',
    schemaVersion: file.schemaVersion,
    revision: revision ?? s.syncLastPulledRevision,
    deviceId,
    deviceName,
    savedAt: file.exportedAt,
    tables: file.tables,
  };
}

/** A snapshot in backup clothing — same tables, same rows, nothing converted. */
export function snapshotToBackupFile(snap: SyncSnapshot): BackupFile {
  return {
    app: 'MyMoney',
    schemaVersion: snap.schemaVersion,
    exportedAt: snap.savedAt,
    tables: snap.tables,
  };
}

export type SnapshotValidation =
  | { ok: true; snap: SyncSnapshot }
  | { ok: false; error: string };

/**
 * Full validation before anything is written: the sync envelope first, then
 * `validateBackup()` for the file body — which is where the per-table, per-row
 * checks and the "newer schema than this build" refusal already live. One
 * validator for both features means a file that restores also syncs.
 */
export function validateSnapshot(parsed: unknown): SnapshotValidation {
  const fail = (error: string): SnapshotValidation => ({ ok: false, error });
  if (!isPlainObject(parsed)) return fail('The sync file is not a JSON object.');
  if (parsed.app !== 'MyMoney') return fail('That file is not a MyMoney sync file.');
  const rev = parsed.revision;
  if (typeof rev !== 'number' || !Number.isInteger(rev) || rev < 1) {
    return fail(`The sync file has an invalid revision (${JSON.stringify(rev)}).`);
  }
  if (typeof parsed.deviceId !== 'string' || typeof parsed.deviceName !== 'string') {
    return fail('The sync file does not say which device wrote it.');
  }
  if (typeof parsed.savedAt !== 'string') {
    return fail('The sync file has no valid "savedAt" timestamp.');
  }
  const asBackup = {
    app: parsed.app,
    schemaVersion: parsed.schemaVersion,
    exportedAt: parsed.savedAt,
    tables: parsed.tables,
  };
  const checked = validateBackup(asBackup);
  if (!checked.ok) return fail(checked.error.replace(/\bbackup\b/gi, 'sync file'));
  return { ok: true, snap: parsed as unknown as SyncSnapshot };
}

/**
 * Merge a snapshot's settings row into this device's, keeping every
 * device-local key (see DEVICE_LOCAL_SETTING_KEYS) on this side.
 */
export function mergeSettingsRow(local: Settings, remoteRow: unknown): Settings {
  const remote = isPlainObject(remoteRow) ? (remoteRow as Partial<Settings>) : {};
  const merged = { ...local, ...remote } as Settings & Record<string, unknown>;
  for (const key of DEVICE_LOCAL_SETTING_KEYS) {
    (merged as Record<string, unknown>)[key] = local[key];
  }
  merged.id = 'app';
  merged.schemaVersion = SCHEMA_VERSION;
  // Onboarding is a one-way door: a device that has been through it, or a book
  // that has been through it anywhere, is onboarded.
  merged.onboarded = Boolean(local.onboarded || remote.onboarded);
  // Saved CSV mappings are a dictionary of UI conveniences, not money: take
  // both sides, this device wins a clash. The only merge in this file, and it
  // cannot change a single amount.
  merged.savedMappings = { ...(remote.savedMappings ?? {}), ...(local.savedMappings ?? {}) };
  return merged;
}

/**
 * Replace the entire local book with `snap`. All-or-nothing, via the backup
 * module's restore path (one rw transaction: clear every table, then bulkAdd
 * every row — a duplicate id or any other failure aborts and leaves the
 * original data untouched, D21).
 *
 * Validation happens before the transaction opens, so a corrupt or
 * newer-schema snapshot cannot write a single row. Change tracking is
 * suppressed for the duration: these writes are the result of a sync, not
 * local edits, and counting them would make the device look dirty the instant
 * after it pulled.
 */
export async function applyRemote(snap: SyncSnapshot): Promise<void> {
  const checked = validateSnapshot(snap);
  if (!checked.ok) throw new Error(checked.error);

  const local = await getSettings();
  const settingsRows = checked.snap.tables.settings;
  const merged = mergeSettingsRow(local, Array.isArray(settingsRows) ? settingsRows[0] : undefined);
  const file: BackupFile = {
    ...snapshotToBackupFile(checked.snap),
    tables: { ...checked.snap.tables, settings: [merged] },
  };
  await withoutLocalChangeTracking(() => restoreBackup(file));
}

// ===========================================================================
// The safety backup written before a resolved conflict destroys anything
// ===========================================================================

export type ConflictBackupSaver = (file: BackupFile, fileName: string) => Promise<void>;

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

/**
 * Default saver for the losing side of a conflict.
 *
 * It tries the File System Access API first, because that is the ONLY path
 * that both proves the bytes landed and reports a cancellation — and a
 * cancellation here must abort the whole resolution rather than shrug and
 * overwrite. It then falls back to an anchor download, which tells us nothing
 * but at least produces the file.
 *
 * The first rung deliberately mirrors backup.ts's `saveViaFilePicker`. That
 * duplication should not survive: backup.ts owns the full ladder (picker ▸ OS
 * share sheet ▸ anchor) and only lacks a way to save a file it was HANDED
 * rather than one it exported. The right fix is a `downloadBackupFile(file,
 * name)` export there, wired in here via `setConflictBackupSaver` — see the
 * handover notes. Until then this is the safety net, not the plan.
 */
async function defaultConflictBackupSaver(file: BackupFile, fileName: string): Promise<void> {
  if (typeof document === 'undefined' || typeof Blob === 'undefined') {
    throw new Error('no way to write a safety backup in this environment');
  }
  const json = serializeBackup(file);
  // globalThis, not a bare `window`: this file must stay importable (and
  // testable) outside a browser.
  const picker = (globalThis as unknown as SaveFilePickerWindow).showSaveFilePicker;
  if (typeof picker === 'function') {
    try {
      const handle = await picker.call(globalThis, {
        suggestedName: fileName,
        types: [{ description: 'MyMoney backup', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(json);
      await writable.close();
      return;
    } catch (e) {
      // A cancelled save must NOT be treated as a saved one — let it throw so
      // the resolution is abandoned with everything still intact.
      if ((e as { name?: string } | null)?.name === 'AbortError') {
        throw new Error('the save was cancelled');
      }
      // Anything else (blocked by policy, unsupported): fall through.
    }
  }
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
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

let conflictBackupSaver: ConflictBackupSaver = defaultConflictBackupSaver;

/** Install the app's real file-saving path (or a fake, in tests). */
export function setConflictBackupSaver(saver: ConflictBackupSaver | null): void {
  conflictBackupSaver = saver ?? defaultConflictBackupSaver;
}

/**
 * Write the losing side to a local file BEFORE anything is overwritten.
 * Throws if it cannot — the caller must then abandon the resolution, because a
 * resolution without this file is exactly the unrecoverable loss this feature
 * is not allowed to cause.
 */
async function saveLosingSide(
  file: BackupFile,
  side: 'local' | 'remote',
  revision: number,
  override?: ConflictBackupSaver,
): Promise<void> {
  const name = `mymoney-conflict-${side}-rev${revision}-${todayISO()}.json`;
  await (override ?? conflictBackupSaver)(file, name);
}

// ===========================================================================
// syncNow — the decision table
// ===========================================================================

interface TransportErrorish {
  name?: string;
  kind?: string;
}

const messageOf = (e: unknown): string =>
  e instanceof Error ? e.message : typeof e === 'string' ? e : 'unknown error';

/**
 * Turn a transport failure into an outcome. Duck-typed on purpose: the Drive
 * transport throws its own `SyncTransportError` with a `kind`, and this module
 * stays free of any import edge into the Google-specific code (and keeps
 * working with any other transport, including the test fake).
 */
function outcomeFromError(e: unknown, context: string): SyncOutcome {
  const kind = (e as TransportErrorish | null)?.name === 'SyncTransportError'
    ? (e as TransportErrorish).kind
    : undefined;
  if (kind === 'offline') return { kind: 'offline' };
  if (kind === 'not-connected') return { kind: 'not-connected' };
  return { kind: 'error', message: `${context}: ${messageOf(e)}` };
}

/** Only an explicit `false` means offline; an absent navigator means "assume yes". */
function isOffline(): boolean {
  const nav = (globalThis as { navigator?: { onLine?: boolean } }).navigator;
  return nav?.onLine === false;
}

export interface SyncOptions {
  /**
   * How to settle a conflict the user has now SEEN and decided. Ignored when
   * there is no conflict — it is an answer to a question, never a mode.
   */
  resolve?: 'keep-local' | 'keep-remote';
  /** Override the safety-backup writer for this call (tests, or a custom UI). */
  saveBackup?: ConflictBackupSaver;
}

/**
 * One sync. Reads the remote head, compares it with what this device last
 * agreed to, and takes the single action that cannot lose anything.
 *
 *   not connected                              ⇒ 'not-connected'
 *   offline                                    ⇒ 'offline'
 *   no remote file                             ⇒ push as revision 1
 *   remote unchanged, local unchanged          ⇒ 'up-to-date'
 *   remote unchanged, local changed            ⇒ push at remote + 1
 *   remote moved on, local unchanged           ⇒ pull and apply
 *   BOTH moved (or the remote went backwards)  ⇒ 'conflict', nothing written
 *
 * Only a second call carrying opts.resolve acts on a conflict, and only after
 * the losing side has been written to a local file.
 */
export async function syncNow(
  transport: SyncTransport,
  opts: SyncOptions = {},
): Promise<SyncOutcome> {
  if (!transport.isConnected()) return { kind: 'not-connected' };
  if (isOffline()) return { kind: 'offline' };

  // Land any coalesced local-change bump first: a change made a moment ago
  // must not be mistaken for a clean device.
  try {
    await flushLocalRevision();
  } catch (e) {
    return { kind: 'error', message: `Could not record this device's state: ${messageOf(e)}` };
  }

  const { deviceName } = await ensureSyncIdentity();
  const settings = await getSettings();
  const dirty = await hasLocalChanges(settings);
  const pulledRevision = settings.syncLastPulledRevision;

  let meta: Awaited<ReturnType<SyncTransport['readRemoteMeta']>>;
  try {
    meta = await transport.readRemoteMeta();
  } catch (e) {
    return outcomeFromError(e, 'Could not read the sync file');
  }

  // ---- no remote file yet: this device seeds it -------------------------
  if (meta === null) {
    lastKnownRemoteRevision = null;
    return pushLocal(transport, 1);
  }

  const remoteRevision = meta.revision;
  if (!Number.isInteger(remoteRevision) || remoteRevision < 1) {
    return {
      kind: 'error',
      message: `The sync file reports an invalid revision (${JSON.stringify(remoteRevision)}). Nothing was changed.`,
    };
  }
  lastKnownRemoteRevision = remoteRevision;

  // ---- the remote is where we left it -----------------------------------
  if (remoteRevision === pulledRevision) {
    if (!dirty) return { kind: 'up-to-date' };
    return pushLocal(transport, remoteRevision + 1);
  }

  // ---- the remote moved on and we have nothing to lose -------------------
  if (!dirty && remoteRevision > pulledRevision) return pullRemote(transport);

  // ---- everything else needs a person ------------------------------------
  //
  // Either both sides moved, or the remote went BACKWARDS (someone restored an
  // older file into Drive, or a device re-seeded it). A backwards remote with a
  // clean local looks harmless, but applying it would roll this device back to
  // data it has already moved past — the same silent loss, so it asks too.
  return resolveConflict(transport, opts, {
    remoteRevision,
    pulledRevision,
    localDeviceName: deviceName,
  });
}

async function pushLocal(transport: SyncTransport, revision: number): Promise<SyncOutcome> {
  // Capture the change counter BEFORE reading the book. Anything written after
  // this point is not in the snapshot and leaves the device dirty, so the next
  // sync pushes again — a redundant push, never a lost change.
  const localRevisionAtSnapshot = (await getSettings()).syncLocalRevision;
  let snap: SyncSnapshot;
  try {
    snap = await localSnapshot(revision);
  } catch (e) {
    return { kind: 'error', message: `Could not read this device's data: ${messageOf(e)}` };
  }
  try {
    await transport.writeRemote(snap);
  } catch (e) {
    // Settings are untouched, so the next attempt makes exactly this decision
    // again.
    return outcomeFromError(e, 'Could not upload to Google Drive');
  }
  lastKnownRemoteRevision = revision;
  await updateSettings({
    syncLastPulledRevision: revision,
    syncSyncedLocalRevision: localRevisionAtSnapshot,
    syncLastSyncedAt: nowISO(),
  });
  return { kind: 'pushed', revision };
}

/** Fetch + validate the remote snapshot, or an outcome explaining why not. */
async function fetchRemote(
  transport: SyncTransport,
): Promise<{ ok: true; snap: SyncSnapshot } | { ok: false; outcome: SyncOutcome }> {
  let raw: SyncSnapshot | null;
  try {
    raw = await transport.readRemote();
  } catch (e) {
    return { ok: false, outcome: outcomeFromError(e, 'Could not download the sync file') };
  }
  if (raw === null) {
    return {
      ok: false,
      outcome: {
        kind: 'error',
        message:
          'The sync file disappeared while syncing. Nothing was changed — try again in a moment.',
      },
    };
  }
  const checked = validateSnapshot(raw);
  if (!checked.ok) {
    return {
      ok: false,
      outcome: {
        kind: 'error',
        message: `${checked.error} Nothing on this device was changed.`,
      },
    };
  }
  return { ok: true, snap: checked.snap };
}

async function pullRemote(transport: SyncTransport): Promise<SyncOutcome> {
  const got = await fetchRemote(transport);
  if (!got.ok) return got.outcome;
  return applyPulled(got.snap);
}

async function applyPulled(snap: SyncSnapshot): Promise<SyncOutcome> {
  try {
    await applyRemote(snap);
  } catch (e) {
    // restoreBackup is one transaction: a failure here means nothing was
    // written at all.
    return {
      kind: 'error',
      message: `Could not apply the synced data: ${messageOf(e)} Nothing on this device was changed.`,
    };
  }
  // The book now IS the remote revision: drop any pending flag raised during
  // the apply and record agreement.
  clearPendingLocalChange();
  const after = await getSettings();
  lastKnownRemoteRevision = snap.revision;
  await updateSettings({
    syncLastPulledRevision: snap.revision,
    syncSyncedLocalRevision: after.syncLocalRevision,
    syncLastSyncedAt: nowISO(),
  });
  return { kind: 'pulled', revision: snap.revision, counts: snapshotCounts(snap.tables) };
}

async function resolveConflict(
  transport: SyncTransport,
  opts: SyncOptions,
  ctx: { remoteRevision: number; pulledRevision: number; localDeviceName: string },
): Promise<SyncOutcome> {
  const got = await fetchRemote(transport);
  if (!got.ok) return got.outcome;
  const remoteSnap = got.snap;

  if (!opts.resolve) {
    // Describe both sides truthfully and stop. NOTHING is written — not the
    // book, not the remote file, not even the sync bookkeeping.
    const local: SyncSummary = {
      revision: ctx.pulledRevision,
      deviceName: ctx.localDeviceName,
      savedAt: nowISO(), // local data is current by definition
      counts: await localCounts(),
    };
    const remote: SyncSummary = {
      revision: remoteSnap.revision,
      deviceName: remoteSnap.deviceName,
      savedAt: remoteSnap.savedAt,
      counts: snapshotCounts(remoteSnap.tables),
    };
    return { kind: 'conflict', local, remote };
  }


  if (opts.resolve === 'keep-remote') {
    // The LOCAL book loses. Write it out before it is replaced.
    let losing: BackupFile;
    try {
      losing = await exportBackup();
    } catch (e) {
      return { kind: 'error', message: `Could not read this device's data: ${messageOf(e)}` };
    }
    try {
      await saveLosingSide(losing, 'local', ctx.pulledRevision, opts.saveBackup);
    } catch (e) {
      return {
        kind: 'error',
        message:
          `Could not save a backup of this device's data (${messageOf(e)}), ` +
          'so nothing was replaced. Export a backup first, then try again.',
      };
    }
    return applyPulled(remoteSnap);
  }

  // keep-local: the REMOTE snapshot loses and is about to be overwritten.
  // Drive keeps its own file revisions, but "probably recoverable from someone
  // else's service" is not the standard here.
  try {
    await saveLosingSide(
      snapshotToBackupFile(remoteSnap),
      'remote',
      remoteSnap.revision,
      opts.saveBackup,
    );
  } catch (e) {
    return {
      kind: 'error',
      message:
        `Could not save a backup of the synced data (${messageOf(e)}), ` +
        'so nothing was uploaded. Try again, or download a backup first.',
    };
  }
  // Push above BOTH sides so the number never goes backwards for anyone.
  return pushLocal(transport, Math.max(ctx.remoteRevision, ctx.pulledRevision) + 1);
}

/** Table names a snapshot is expected to carry — re-exported for the UI. */
export { ALL_TABLES, DATA_TABLES };
