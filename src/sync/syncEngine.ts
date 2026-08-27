// The sync engine (D42/D45; SPEC §8.3 "optional cloud backup sync").
//
// WHAT THIS IS FOR. The app has no server, so every browser holds its own
// IndexedDB. Open the site on a second device and it is empty. This module
// moves the WHOLE BOOK between devices through one file in the user's own
// Dropbox app folder: last-writer-wins at the file level, with the crucial
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
//  * whichever side loses a resolved conflict is kept BEFORE anything is
//    overwritten — twice. A normal backup file is handed to the user, and a
//    copy is written into this device's own recovery store and read back out
//    again; the destruction is gated on the second one, because a file
//    download cannot report that it landed and on an iPhone it routinely has
//    not (C4). If either save fails the resolution is abandoned and nothing is
//    touched. Both copies are ordinary backup files, restorable through the
//    normal Restore screen;
//  * a snapshot is fully validated before a single row is written, and one
//    from a NEWER schema is refused outright;
//  * applying is all-or-nothing — one Dexie rw transaction (restoreBackup),
//    so a failure halfway leaves the original book exactly as it was.
//
// HOW IT DECIDES: CAUSAL ANCESTRY, NOT VERSION NUMBERS. Every snapshot
// carries an immutable `snapshotId` and the `parentSnapshotId` it was built on
// top of, IN THE FILE BODY, so "is the file in the cloud the one my book grew
// out of?" is a question with an answer. It used to be answered with
// `revision`, which cannot answer it: two devices that both read revision N
// could both WRITE revision N (nothing made the second write fail), so the
// loser's push vanished while both sides recorded agreement — and the next
// pull deleted a month of the owner's transactions with no conflict and no
// safety file. A re-created file restarts numbering at 1, so equality did not
// even imply the same FILE. `revision` survives for display and ordering; it
// is no longer a safety input, and THERE IS NO LONGER A FALLBACK TABLE THAT
// TREATS IT AS ONE. Each snapshot also carries a bounded chain of the
// ancestors behind it, so a device several pushes behind can still be told
// apart from a device on a different lineage — otherwise "cannot prove
// descent" would mean a conflict every time the other device synced twice.
//
// WHAT WAS DELETED HERE, AND WHY IT IS SAFE TO DELETE (D45). Until this
// rewrite the engine also recorded and compared a whole STAMP —
// snapshotId AND revision AND savedAt AND deviceId — through
// `headStillOurs`/`proveHeadFromBody` and a pair of settings keys
// (syncLastPulledSavedAt / syncLastPulledDeviceId), with verdicts
// 'agrees' / 'diverged' / 'unproven'. Every line of that existed to
// compensate for ONE property of Google Drive: appProperties MERGE on
// files.update, so a writer that omitted `snapshotId` left OURS sitting on a
// file whose contents were now its own book (C18/C19). Identity lived in a
// mutable store BESIDE the bytes, so it could describe a file it had not come
// from, and the id alone could not be believed.
//
// On Dropbox identity lives INSIDE THE BODY, which is replaced wholesale on
// every write: no writer can inherit another writer's identity by leaving a
// field out, and the transport refuses to read or write a body that carries
// none at all. `snapshotId` therefore answers the question on its own, and the
// stamp apparatus was answering a question that can no longer be asked. Left
// in place it was not merely redundant but actively harmful — it was the door
// D2 came through, where a device recorded a whole stamp for a head it had
// never proved anything about. The separation is the fix; the stamp was the
// symptom.
//
// WHAT REPLACED IT IS NOT TRUST, IT IS A GATE. Nothing adopts or overwrites a
// book without the BODY bearing out the reason for doing so — see THE ADOPTION
// GATE below, and `PushParent`, which is the same idea on the write side: a
// push may name as its parent only a snapshot this device has actually seen
// the body of, never a field off a head read (D1).
//
// MONEY IS NEVER TOUCHED. A snapshot is `exportBackup()`'s tables verbatim:
// whole rows, integer minor units, moved and compared but never arithmetic'd.
//
// OFFLINE-FIRST. With no network the app behaves exactly as it does today:
// syncNow returns 'offline' and changes nothing on either side.

import {
  ALL_TABLES,
  DATA_TABLES,
  DEVICE_LOCAL_SETTING_KEYS,
  clearPendingLocalChange,
  db,
  flushLocalRevision,
  getSettings,
  localChangeMarkNow,
  markLocalChange,
  SCHEMA_VERSION,
  updateSettings,
  withoutLocalChangeTracking,
} from '../db/db';
import type { Settings } from '../db/types';
import {
  downloadBackupFile,
  exportBackup,
  pinDeviceLocalSettings,
  restoreBackup,
  saveRecoverySnapshot,
  validateBackup,
  type BackupFile,
  type BackupSaveResult,
  type RecoveryRecord,
} from '../backup/backup';
import { nowISO, todayISO, uid } from '../lib/util';
// SyncStamp is deliberately NOT imported any more. It is the Drive-era "whole
// stamp" (see the header): the transport still accepts one as an optional
// second argument to writeRemote, and the engine no longer builds one, because
// every field in it now derives from the same body as the identity beside it.
// A stamp built from a head read could only ever disagree with that head by
// disagreeing about the identity first, which the transport checks anyway.
import type {
  SyncOutcome,
  SyncRemoteMeta,
  SyncSnapshot,
  SyncState,
  SyncSummary,
  SyncTransport,
} from './types';

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
 * lastPulledRevision, the snapshot id it descends from, and the local-change
 * counters. Corrupt those and the next sync compares the wrong numbers, which
 * is precisely how a silent overwrite happens. So the merge keeps the
 * book-level preferences from the snapshot and pins these back to their local
 * values.
 *
 * The list itself lives beside `Settings`'s defaults in db.ts, paired with
 * BOOK_LEVEL_SETTING_KEYS: the two halves of that decision have to be made in
 * one place, because "travels" and "marks the device dirty" are the same
 * question asked from opposite ends (C3/C7). Re-exported here because this is
 * where callers of the sync engine expect to find it.
 */
export { DEVICE_LOCAL_SETTING_KEYS };

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
  if (!hasAgreedWithARemote(s.syncLastPulledSnapshotId, s.syncLastPulledRevision)) {
    return !(await isPristineBook(s));
  }
  return s.syncLocalRevision !== s.syncSyncedLocalRevision;
}

/**
 * Has this device ever agreed with a remote file? ONE definition, used by both
 * things that ask: which dirtiness regime applies (above), and whether "there
 * is no file" means "first sync" or "the file has been deleted" (C13).
 *
 * Two questions asking the same thing in two different ways is how this
 * subsystem generated defects for four rounds, so they now ask the same
 * function. The evidence is OR'd, never AND'd: an id OR a revision above zero
 * is history, because the safe reading of partial evidence is always "this
 * device has a past to protect".
 */
function hasAgreedWithARemote(snapshotId: string | null, revision: number): boolean {
  return snapshotId !== null || revision > 0;
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

// ===========================================================================
// The write that lands DURING a sync
// ===========================================================================
//
// A sync decides what to do once, at the top, and then spends seconds on the
// network: a head read, and — on a pull — a multi-megabyte download. The app
// stays fully interactive throughout (the quick-add button is mounted at the
// app shell, on every screen including Settings), so the owner can and does
// save a transaction inside that window.
//
// Applying the remote then destroys it: restoreBackup clears every table. The
// old code made that unrecoverable rather than merely wrong — it cleared the
// pending-change flag afterwards and recorded the counter as it stood AFTER
// the apply, so the device ended up reporting "no unsynced changes" over a row
// that existed nowhere at all (C2/C5/C6).
//
// The fix is not a lock (there is nowhere to put one that the user cannot
// route around) but a CHECK AT THE LAST POSSIBLE MOMENT: capture where this
// device stood when the decision was made, then re-read it inside the very
// transaction that is about to overwrite the book. Nothing can slip between
// the check and the write, because IndexedDB will not start another write to
// those tables while that transaction is open. If anything moved, the apply is
// abandoned with nothing touched: the change is still here, still unsent, and
// the next sync sees it and asks properly.

/** Where this device stood when `syncNow` chose what to do. */
export interface LocalStateAtDecision {
  /** syncLocalRevision as it was read. */
  localRevision: number;
  /** db.ts's count of noticed writes, including ones not yet flushed. */
  changeMark: number;
  /** syncLastPulledRevision, which selects which dirtiness regime applies. */
  pulledRevision: number;
  /** Was the device judged to have nothing unsent? */
  wasClean: boolean;
}

function captureLocalState(settings: Settings, dirty: boolean): LocalStateAtDecision {
  return {
    localRevision: settings.syncLocalRevision,
    changeMark: localChangeMarkNow(),
    pulledRevision: settings.syncLastPulledRevision,
    wasClean: !dirty,
  };
}

/** Thrown inside the apply transaction, which aborts it. Caught by applyPulled. */
class LocalWriteDuringSyncError extends Error {
  constructor() {
    super('a local change landed while this sync was running');
    this.name = 'LocalWriteDuringSyncError';
  }
}

/**
 * Has anything landed since the decision was taken? THREE questions, because
 * one of them can be answered "no" while the book has in fact moved:
 *
 *  1. the counter on disk — the only evidence that survives a reload, and the
 *     only one that sees a write made by a SECOND TAB of the app;
 *  2. the in-memory mark — a write coalesced within the last 250 ms has not
 *     reached the counter yet, and that is the commoner case by far, since the
 *     apply usually follows the write within one download;
 *  3. and, for a device that has never synced, whether the book is still
 *     pristine: there the counter is not consulted at all (hasLocalChanges
 *     judges such a device by its contents), and the flush is inert until sync
 *     is set up, so neither of the first two would move.
 *
 * Called INSIDE the apply transaction with the settings row read there.
 */
async function assertNothingLandedSince(
  guard: LocalStateAtDecision,
  now: Settings,
): Promise<void> {
  if (now.syncLocalRevision !== guard.localRevision) throw new LocalWriteDuringSyncError();
  if (localChangeMarkNow() !== guard.changeMark) throw new LocalWriteDuringSyncError();
  // Only when the decision rested on the book being pristine: after a
  // resolved conflict the device is knowingly dirty, and re-checking would
  // refuse the very apply the user just asked for.
  if (guard.pulledRevision === 0 && guard.wasClean && !(await isPristineBook(now))) {
    throw new LocalWriteDuringSyncError();
  }
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

/**
 * How many ancestors a snapshot carries (SyncSnapshot.ancestry).
 *
 * It bounds how far behind a CLEAN device can be and still be recognised as
 * behind rather than diverged. 24 is a fortnight of heavy two-device use at
 * ~1-2 pushes a day, costs under a kilobyte inside a multi-megabyte file, and
 * running past it is not a failure: the chain simply stops proving descent,
 * so the user is asked instead of being pulled over silently.
 */
export const SYNC_ANCESTRY_DEPTH = 24;

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
 * @param parentSnapshotId the remote head this book descends from — the id
 * `syncNow` had in hand when it decided to push, `null` for the first write of
 * a lineage. A FRESH snapshotId is minted on every call, never reused and
 * never derived from anything: two builds of the same book are two snapshots,
 * because they can land in Dropbox at different moments and only the file that
 * actually landed may be claimed as an ancestor.
 * @param olderAncestors what the PARENT descends from, newest first — this
 * device's own record of the chain, or the downloaded snapshot's when the user
 * has just chosen to overwrite it. Passed separately from the parent so the
 * two cannot disagree: the stored `ancestry` is built here, parent first.
 */
export async function localSnapshot(
  revision?: number,
  parentSnapshotId: string | null = null,
  olderAncestors: readonly string[] = [],
): Promise<IdentifiedSnapshot> {
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
    snapshotId: uid(),
    parentSnapshotId,
    ancestry:
      parentSnapshotId === null
        ? []
        : [parentSnapshotId, ...olderAncestors].slice(0, SYNC_ANCESTRY_DEPTH),
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

/**
 * A snapshot that has been through `validateSnapshot`, and therefore CARRIES AN
 * IDENTITY. Every function below that can change what this device's book is —
 * or what it claims to descend from — takes one of these rather than a bare
 * SyncSnapshot, so "we might not know what this is" stops being a state the
 * rest of the file has to keep handling.
 *
 * That used to be a state, and it was D3's door. Drive genuinely held files
 * written before ancestry existed, so reading tolerated a missing snapshotId;
 * a keep-remote resolution could then apply an identity-less body, leave this
 * device with `syncLastPulledSnapshotId: null`, drop it onto the revision-
 * number fallback, and let its next push mint an unprovable parent (D1 again,
 * by a second route). NO SUCH FILE CAN EXIST IN DROPBOX — no build of this app
 * has ever written there, and the transport refuses an identity-less body at
 * the door in both directions — so tolerating one here bought nothing and cost
 * that. Refused here too, because the engine must not depend on a particular
 * transport having remembered to refuse it first.
 */
export type IdentifiedSnapshot = SyncSnapshot & { snapshotId: string };

export type SnapshotValidation =
  | { ok: true; snap: IdentifiedSnapshot }
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
  // IDENTITY IS REQUIRED, and that is a change from the Drive build (see
  // IdentifiedSnapshot). It used to be optional because pre-ancestry files
  // really were sitting in owners' Drives; on Dropbox none can exist, and
  // tolerating one is what let a keep-remote resolution leave this device with
  // no id and no way to prove anything afterwards (D3).
  if (typeof parsed.snapshotId !== 'string' || parsed.snapshotId === '') {
    return fail('The sync file does not say which snapshot it is.');
  }
  if (
    parsed.parentSnapshotId !== undefined &&
    parsed.parentSnapshotId !== null &&
    (typeof parsed.parentSnapshotId !== 'string' || parsed.parentSnapshotId === '')
  ) {
    return fail('The sync file has an unusable parent snapshot id.');
  }
  if (parsed.ancestry !== undefined) {
    if (
      !Array.isArray(parsed.ancestry) ||
      parsed.ancestry.some((id) => typeof id !== 'string' || id === '')
    ) {
      return fail('The sync file has an unusable ancestry list.');
    }
  }
  const asBackup = {
    app: parsed.app,
    schemaVersion: parsed.schemaVersion,
    exportedAt: parsed.savedAt,
    tables: parsed.tables,
  };
  const checked = validateBackup(asBackup);
  if (!checked.ok) return fail(checked.error.replace(/\bbackup\b/gi, 'sync file'));
  return { ok: true, snap: parsed as unknown as IdentifiedSnapshot };
}

/**
 * Merge a snapshot's settings row into this device's, keeping every
 * device-local key (see DEVICE_LOCAL_SETTING_KEYS) on this side.
 */
export function mergeSettingsRow(local: Settings, remoteRow: unknown): Settings {
  const remote = isPlainObject(remoteRow) ? (remoteRow as Partial<Settings>) : {};
  // The pinning itself lives in backup.ts, because restoreBackup has to do
  // exactly the same thing and used not to (C8): a conflict safety copy is
  // restored through the Restore screen, and taking the other device's
  // identity and sync bookkeeping from it made both devices claim to be the
  // same machine. One implementation, one list, both paths.
  const merged = pinDeviceLocalSettings(local, remote) as Settings & Record<string, unknown>;
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
 *
 * @param guard where this device stood when the sync decided to apply. Given
 * one, the last thing this function does before destroying anything is check
 * that the device has not moved since — inside the SAME transaction, so no
 * write can slip between the check and the clear (see LocalStateAtDecision).
 * A change found there throws LocalWriteDuringSyncError, which aborts the
 * transaction: not one row is written, and the local change survives.
 *
 * The settings row is read inside that transaction too, not before it. It has
 * to be: mergeSettingsRow pins this device's counters back from what it reads,
 * so a copy taken seconds earlier would write a stale syncLocalRevision over a
 * bump that had landed in between — erasing the evidence of a local change by
 * a different route.
 */
export async function applyRemote(snap: SyncSnapshot, guard?: LocalStateAtDecision): Promise<void> {
  const checked = validateSnapshot(snap);
  if (!checked.ok) throw new Error(checked.error);

  await db.transaction('rw', [...ALL_TABLES], async () => {
    const local = await getSettings();
    if (guard) await assertNothingLandedSince(guard, local);
    const settingsRows = checked.snap.tables.settings;
    const merged = mergeSettingsRow(
      local,
      Array.isArray(settingsRows) ? settingsRows[0] : undefined,
    );
    const file: BackupFile = {
      ...snapshotToBackupFile(checked.snap),
      tables: { ...checked.snap.tables, settings: [merged] },
    };
    // restoreBackup opens the same scope in the same mode, so Dexie joins it
    // to this transaction rather than starting a second one — one commit, one
    // rollback, and the guard above is inside both.
    await withoutLocalChangeTracking(() => restoreBackup(file));
  });
}

// ===========================================================================
// The safety backup written before a resolved conflict destroys anything
// ===========================================================================

/**
 * Hands the losing side to the user as a FILE, and says what became of it.
 * `'cancelled'` is the one answer that must stop the resolution; the others
 * differ only in how much they prove, and none of them proves enough to
 * destroy a book on — which is why they are not what the destruction is gated
 * on any more (see saveLosingSide).
 */
export type ConflictBackupSaver = (
  file: BackupFile,
  fileName: string,
) => Promise<BackupSaveResult>;

/**
 * Default saver: backup.ts's ladder — file picker ▸ OS share sheet ▸ anchor
 * download — applied to a file we were handed rather than one it exported.
 *
 * This function used to be a cut-down copy of that ladder, and the cuts were
 * where C4 lived. It had no share-sheet rung, so on iOS (where the picker does
 * not exist) it went straight to the anchor; it caught a FAILING WRITE and
 * treated it as a reason to fall through to that same anchor; and the anchor
 * rung returned `undefined` whether the file was written, blocked, cancelled
 * or opened in a preview tab. backup.ts had already got all three right for
 * ordinary backups. Now there is one ladder, and one meaning per result.
 */
async function defaultConflictBackupSaver(
  file: BackupFile,
  fileName: string,
): Promise<BackupSaveResult> {
  return downloadBackupFile(file, fileName);
}

let conflictBackupSaver: ConflictBackupSaver = defaultConflictBackupSaver;

/** Install the app's real file-saving path (or a fake, in tests). */
export function setConflictBackupSaver(saver: ConflictBackupSaver | null): void {
  conflictBackupSaver = saver ?? defaultConflictBackupSaver;
}

/**
 * Put the losing side somewhere it can be got back from BEFORE anything is
 * overwritten — and prove it is there. Throws if it cannot, and the caller
 * must then abandon the resolution, because a resolution without this copy is
 * exactly the unrecoverable loss this feature is not allowed to cause.
 *
 * TWO SAVES, IN THIS ORDER, BOTH REQUIRED:
 *
 *  1. THE FILE, for the owner's own records, by the ladder above. It goes
 *     first because it is the only one that can ask the user a question: a
 *     cancelled save means "stop", and stopping before anything has been
 *     written is tidier than stopping after — it also stops every cancelled
 *     attempt from leaving an abandoned copy in the store.
 *  2. THE RECOVERY COPY, into this device's recovery store, written in its own
 *     transaction and then READ BACK. This is the gate, and it is last so that
 *     the save whose success is actually observable is the one immediately
 *     before the destruction. Invariant 3 used to rest on step 1 alone, which
 *     on every browser without showSaveFilePicker — every iPhone and iPad —
 *     could not report a blocked, cancelled or preview-tabbed download at all,
 *     so the book was cleared on the strength of an `a.click()` that returned
 *     undefined (C4).
 *
 * `opts.saveBackup` replaces step 1 only. A saver that returns without doing
 * anything IS the defect being fixed here, so nothing can inject its way past
 * step 2.
 */
async function saveLosingSide(
  file: BackupFile,
  side: 'local' | 'remote',
  revision: number,
  label: string,
  override?: ConflictBackupSaver,
): Promise<RecoveryRecord> {
  const fileName = `mymoney-conflict-${side}-rev${revision}-${todayISO()}.json`;
  const reported: BackupSaveResult | undefined = await (override ?? conflictBackupSaver)(
    file,
    fileName,
  );
  // A saver that says nothing is read as 'delivered' — handed over, unproven —
  // which is the same reading backup.ts gives its anchor rung, and the safe
  // one now that it decides nothing.
  const delivery: BackupSaveResult = reported ?? 'delivered';
  if (delivery === 'cancelled') throw new Error('the save was cancelled');
  return saveRecoverySnapshot(file, {
    // The side that LOSES names the choice that was made: the local book loses
    // when the user keeps the remote.
    reason: side === 'local' ? 'conflict-keep-remote' : 'conflict-keep-local',
    label,
    fileName,
    delivery,
  });
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
 * Turn a transport failure into an outcome. Duck-typed on purpose: the Dropbox
 * transport throws its own `SyncTransportError` with a `kind`, and this module
 * stays free of any import edge into the provider-specific code (and keeps
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
   * How to settle a situation the user has now SEEN and decided. Ignored when
   * there is nothing to settle — it is an answer to a question, never a mode.
   *
   * 'reseed-remote' answers the one question that is not a two-sided conflict:
   * the sync file this device was using is GONE. There is no remote
   * side to keep, so the only choices are "start a new file from this device"
   * and "do nothing", and neither may be taken on the user's behalf.
   */
  resolve?: 'keep-local' | 'keep-remote' | 'reseed-remote';
  /** Override the safety-backup writer for this call (tests, or a custom UI). */
  saveBackup?: ConflictBackupSaver;
  /**
   * The snapshotId this device's book descends from — the identity half of
   * "where this device stands", and the input the whole decision table is
   * built on.
   *
   *   `undefined` use what this device has persisted (the normal case — the
   *               app passes nothing and `ancestryOf` reads
   *               settings.syncLastPulledSnapshotId).
   *   `null`      the caller asserts that this device has never agreed with
   *               any remote file.
   *   a string    the id of the last remote snapshot this book descends from.
   *
   * Persisted as `Settings.syncLastPulledSnapshotId` (device-local, see
   * DEVICE_LOCAL_SETTING_KEYS), written back after every 'pushed' and
   * 'pulled' — and, since D45, after nothing else. 'up-to-date' used to write
   * it too, which is D2: a device that had proved nothing about the head
   * recorded a whole stamp for it off a head read. Now the only two things
   * that record an id are the two that have held the bytes.
   *
   * This option remains because the engine must stay testable without reaching
   * into the settings row, and because a caller driving two books in one
   * process (the tests do) needs to say which one it means.
   */
  lastPulledSnapshotId?: string | null;
}

/**
 * What the user is told when the file this device was syncing with is no
 * longer there. Both messages exist to stop ONE action: quietly starting a
 * second sync file at revision 1, which is how a device with 47 revisions of
 * history ends up reading a different book from every other device (C13/C16).
 */
const LOST_REMOTE_MESSAGE =
  'The sync file this device was using is no longer in your Dropbox. ' +
  'Nothing on this device was changed, and nothing was uploaded. ' +
  'Either restore it in Dropbox (check your deleted files) and sync again, or choose to ' +
  'start a new sync file from this device — this device will not start one on its own, ' +
  'because your other devices would then be syncing with a different file.';

const TRASHED_REMOTE_MESSAGE =
  'The sync file has been deleted from Dropbox. Nothing on this device was changed, and ' +
  'nothing was uploaded. Restore it from Dropbox’s deleted files and sync again, or empty ' +
  'them first if you meant to start over — while it is merely deleted this device will ' +
  'neither write over it nor start a second file beside it.';

/**
 * What the user is told when the head carries no identity at all.
 *
 * The transport refuses such a body at the door, so this is unreachable
 * through the real one — and it is here anyway, because the engine must not
 * rest a data-loss guarantee on a particular transport having remembered.
 * Without it, a never-synced device (`null`) meeting an identity-less head
 * (`null`) would compare the two, find them equal, and report 'up to date'
 * over a book it has never seen: the C18 wipe reconstructed out of two
 * absences. Comparing "I do not know" with "I do not know" must never come out
 * as agreement.
 */
const NO_IDENTITY_MESSAGE =
  'The sync file in Dropbox does not say which snapshot it is, so this device cannot tell ' +
  'whether its own book grew out of it. Nothing on this device was changed, and nothing ' +
  'was uploaded. It was not written by this app — replace it from a backup, or delete it ' +
  'and start a new sync file.';

// ===========================================================================
// WHAT THIS DEVICE DESCENDS FROM — and why it is a branded value (D1)
// ===========================================================================

/**
 * The brand. Its only purpose is to make one kind of mistake unrepresentable:
 * naming a snapshot id that came off a HEAD READ as the thing this device's
 * book descends from, or as the parent of a push.
 *
 * That mistake is D1. `resolveConflict`'s keep-local branch used to declare
 * `ctx.head.snapshotId` — an id read from the file's own claim about itself,
 * never checked against any body this device had seen — as the parent of the
 * snapshot it then uploaded, and wrote that id into `parentSnapshotId` AND
 * into `ancestry`. Every other device treats an ancestry entry as proof of
 * descent, so a third device that genuinely descended from that id would find
 * itself named in a chain it was not in, fast-forward, and be silently wiped.
 *
 * A comment saying "don't do that" is what the previous three rounds had. This
 * is a type: `meta.snapshotId` is a plain string, and a plain string cannot be
 * passed anywhere that wants a `Descent` or a `PushParent`.
 *
 * WHAT IT DOES NOT BUY, said plainly: the symbol is module-scoped, so a branch
 * inside this file could still forge one by naming it. What that costs is the
 * thing that matters — forging is a deliberate, visible act with this comment
 * attached, rather than the one-token slip (`meta.snapshotId` where
 * `pulledSnapshotId` belonged) that D1 actually was.
 */
const OUR_OWN_RECORD = Symbol('recorded by this device, never read off a head');

/**
 * Which snapshot this device's book descends from — the input the whole
 * decision table is built on. Produced ONLY by `ancestryOf`, from what this
 * device recorded after seeing a body (a push it wrote, or a pull it applied).
 */
interface Descent {
  readonly [OUR_OWN_RECORD]: true;
  /** `null` ⇒ this device has never agreed with any remote file. */
  readonly snapshotId: string | null;
}

/**
 * Two sources, in order: an explicit `opts.lastPulledSnapshotId` (tests, and
 * any caller that tracks ancestry itself), otherwise the persisted
 * `syncLastPulledSnapshotId`.
 *
 * THERE IS NO LONGER A THIRD. A device that had a pulled revision but no id
 * used to produce `undefined`, meaning "ancestry unknown", which sent the
 * decision to a revision-NUMBER fallback table. That table was the Drive
 * migration path — real devices had synced under a build that predated
 * ancestry, and treating their null as "descends from nothing" would have
 * greeted a perfectly in-step device with a conflict every time.
 *
 * It is gone, and it is gone rather than fixed because THE STATE IT SERVED
 * CANNOT ARISE HERE. No device has ever synced to Dropbox; the transport
 * refuses a body with no identity in both directions; and every path that
 * records an id records it together with the revision beside it. What the
 * table cost while it sat there: it hardcoded `descendsFrom: null` on its pull
 * even for a device holding an id (D4), and it told a clean device at a
 * matching revision number that it was up to date over a book it had never
 * seen (D2). A device that somehow does arrive with a revision and no id now
 * gets what "cannot prove" has always meant everywhere else in this file — it
 * is asked, not overruled.
 */
function ancestryOf(opts: SyncOptions, settings: Settings): Descent {
  const snapshotId =
    opts.lastPulledSnapshotId !== undefined
      ? opts.lastPulledSnapshotId
      : settings.syncLastPulledSnapshotId;
  return { [OUR_OWN_RECORD]: true, snapshotId };
}

/**
 * What we know sits BEHIND the snapshot this device descends from — this
 * device's own record, and only when the recorded chain really is that
 * snapshot's. Claiming a chain for some other snapshot would put ids into a
 * push's ancestry that are not its ancestors, and the whole mechanism rests on
 * that never happening.
 */
function chainBehind(descent: Descent, settings: Settings): readonly string[] {
  return descent.snapshotId !== null && settings.syncLastPulledSnapshotId === descent.snapshotId
    ? settings.syncAncestry
    : [];
}

// ===========================================================================
// WHERE A PUSH'S PARENT MAY COME FROM — the write-side half of the gate (D1)
// ===========================================================================
//
// `pushLocal` does not take a parent id. It takes one of these, and there are
// exactly three, each of which names a snapshot THIS DEVICE HAS SEEN THE BODY
// OF (or asserts that there is no file at all). A branch that wants to name
// something else has nothing to construct.
//
// The rule in one line: a parentSnapshotId is a claim every other device
// trusts, so it may only ever be an id we could ourselves testify about.

type PushParent =
  /**
   * There is no file. The ONLY value that permits a create — the transport
   * turns it into an `add`, which Dropbox refuses if a file has appeared in
   * the meantime, so a race to seed loses cleanly instead of creating a
   * second file beside the first.
   */
  | { kind: 'no-file' }
  /**
   * The snapshot this device's book descends from: written by our own push, or
   * downloaded and applied by our own pull. Branded, so it cannot be a head
   * field (see `Descent`).
   */
  | { kind: 'our-own-lineage'; snapshotId: string; older: readonly string[] }
  /**
   * A snapshot body this device is holding in memory right now — downloaded,
   * validated, described to the user, and written to a safety file before
   * anything was overwritten. This is what keep-local uses, and it is D1's
   * actual fix: the id it names is one we have read the contents of, not one
   * the file merely claimed about itself.
   */
  | { kind: 'a-body-we-hold'; snap: IdentifiedSnapshot };

const NO_FILE_YET: PushParent = { kind: 'no-file' };

/**
 * Push on top of what this device descends from. The id comes from the branded
 * `Descent` and from nowhere else, which is the point: it can only be what
 * this device recorded after seeing a body, never something read off a head.
 * (`settings` is only where the chain BEHIND that id is read from.)
 *
 * `null` when this device descends from nothing. Deliberately not silently
 * turned into `NO_FILE_YET`: "I have no lineage" and "there is no file" are
 * different facts, and quietly converting the first into the second is how a
 * device starts a second lineage beside a file that already exists (C13).
 */
function ourOwnLineage(descent: Descent, settings: Settings): PushParent | null {
  if (descent.snapshotId === null) return null;
  return {
    kind: 'our-own-lineage',
    snapshotId: descent.snapshotId,
    older: chainBehind(descent, settings),
  };
}

/** Push on top of a body we have downloaded and are holding. */
function aBodyWeHold(snap: IdentifiedSnapshot): PushParent {
  return { kind: 'a-body-we-hold', snap };
}

/** The id and chain a push should carry, for each kind of parent. */
function parentage(p: PushParent): { id: string | null; older: readonly string[] } {
  switch (p.kind) {
    case 'no-file':
      return { id: null, older: [] };
    case 'our-own-lineage':
      return { id: p.snapshotId, older: p.older };
    case 'a-body-we-hold':
      return { id: p.snap.snapshotId, older: p.snap.ancestry ?? [] };
  }
}


/**
 * One sync. Reads the remote head, works out how it is RELATED to the snapshot
 * this device descends from, and takes the single action that cannot lose
 * anything.
 *
 *   not connected                                 ⇒ 'not-connected'
 *   offline                                       ⇒ 'offline'
 *   no file, and this device never had one        ⇒ push as revision 1
 *   no file, but this device HAD one              ⇒ refuse and ask (C13)
 *   the file has been deleted in Dropbox          ⇒ refuse and ask (C13)
 *   the file carries no identity                  ⇒ refuse and ask
 *   remote IS what we descend from                ⇒ dirty ? push : 'up-to-date'
 *   remote is a child of what we descend from     ⇒ clean ? pull : 'conflict'
 *   remote names us further back in its chain     ⇒ clean ? pull : 'conflict'
 *   anything else                                 ⇒ 'conflict', nothing written
 *   anything landed here while we were reading    ⇒ refuse, keep the change
 *
 * The last line is not a special case but the same rule as the rest: the
 * decision is taken before two network round trips, so it is re-checked inside
 * the transaction that would act on it (see LocalStateAtDecision).
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
  // Every line below this one runs with the app still interactive, so this is
  // the moment the whole decision is made ABOUT. Nothing may be applied over
  // this device without first checking it still stands here.
  const guard = captureLocalState(settings, dirty);
  const pulledRevision = settings.syncLastPulledRevision;
  const descent = ancestryOf(opts, settings);
  const pulledSnapshotId = descent.snapshotId;

  let meta: Awaited<ReturnType<SyncTransport['readRemoteMeta']>>;
  try {
    meta = await transport.readRemoteMeta();
  } catch (e) {
    return outcomeFromError(e, 'Could not read the sync file');
  }

  // ---- there is no file at all -------------------------------------------
  //
  // Two completely different situations wear the same face, and the old code
  // treated both as "seed it": a device that has never synced (correct), and a
  // device whose file was deleted, trashed, or moved to another account
  // (catastrophic — it starts a SECOND lineage at revision 1, and from then on
  // two files called mymoney-sync.json hold two different books whose revision
  // numbers get compared as if they were one history). ANY evidence of a
  // history — an id we descend from, or simply a pulled revision above zero —
  // means this is the second case. Evidence is OR'd, never AND'd, so that a
  // later build introducing the persisted id (which will default to null on
  // devices that already have history) cannot make a device look brand new.
  if (meta === null) {
    lastKnownRemoteRevision = null;
    const everAgreed = hasAgreedWithARemote(pulledSnapshotId, pulledRevision);
    if (!everAgreed || opts.resolve === 'reseed-remote') {
      // "There is no file": the transport turns this into a create and Dropbox
      // refuses it if one has appeared in the meantime.
      return pushLocal(transport, 1, NO_FILE_YET);
    }
    return { kind: 'error', message: LOST_REMOTE_MESSAGE };
  }

  // ---- the file exists, but it is in the bin ------------------------------
  //
  // A trashed file is one click from being restored, so writing over it, or
  // creating a second one beside it, are both irreversible in a way the user
  // did not ask for. Refuse either way round — including 'reseed-remote',
  // because a new file created now would sit next to the restored one.
  if (meta.trashed) {
    lastKnownRemoteRevision = null;
    return { kind: 'error', message: TRASHED_REMOTE_MESSAGE };
  }

  const remoteRevision = meta.revision;
  if (!Number.isInteger(remoteRevision) || remoteRevision < 1) {
    return {
      kind: 'error',
      message: `The sync file reports an invalid revision (${JSON.stringify(remoteRevision)}). Nothing was changed.`,
    };
  }
  lastKnownRemoteRevision = remoteRevision;

  // The head must SAY WHICH SNAPSHOT IT IS. Everything below compares this
  // device's id against the head's, and comparing two absences would come out
  // as agreement — see NO_IDENTITY_MESSAGE. The transport refuses such a body
  // at the door; this is here so the guarantee does not depend on that.
  const headSnapshotId = meta.snapshotId;
  if (headSnapshotId === null) return { kind: 'error', message: NO_IDENTITY_MESSAGE };

  // `downloaded` is the snapshot a refused adoption already has in hand (see
  // the adoption gate): passing it on means the refusal costs no second
  // multi-megabyte download of the very file we just fetched.
  const conflict = (downloaded?: IdentifiedSnapshot) =>
    resolveConflict(transport, opts, guard, {
      remoteRevision,
      pulledRevision,
      localDeviceName: deviceName,
      downloaded: downloaded ?? null,
      // The one case that may turn out not to be a conflict after all: a CLEAN
      // device whose id the remote names further back in its chain. Anything
      // else — dirty, or no id of our own — is passed through as null, and
      // resolveConflict then does exactly what it always did.
      fastForwardFrom: !dirty ? pulledSnapshotId : null,
    });

  // ---- the decision, by ANCESTRY -----------------------------------------
  //
  // The only test there is now: not "is that number the number I remember" but
  // "is that file the one my book grew out of". There is no second table to
  // fall through to — see `ancestryOf`.

  // The head IS the snapshot we descend from.
  //
  // On Drive this was a CLAIM and not a fact: appProperties merged, so a
  // writer that sent no snapshotId of its own left ours sitting on top of ITS
  // book, and an id-only check reported 'up-to-date' over a stranger's data
  // and then destroyed it on the next push (C18). Answering it took a recorded
  // stamp, a verdict of agrees/diverged/unproven, and a download to settle the
  // unproven case.
  //
  // ALL OF THAT IS GONE, because the question changed shape. The head's
  // identity is derived from the file's own body (SyncRemoteMeta), which is
  // replaced wholesale by whoever writes it, so it cannot be a leftover of
  // ours. Equal ids mean the same bytes. There is nothing left to prove and
  // nothing to record: `up-to-date` writes NOTHING AT ALL, which is D2 closed
  // by deletion rather than by a fourth guard.
  if (headSnapshotId === pulledSnapshotId) {
    if (!dirty) return { kind: 'up-to-date', snapshotId: headSnapshotId };
    // The parent named here is OUR OWN RECORD of what we descend from, not
    // `headSnapshotId` — the two are equal on this branch, and it is the
    // PROVENANCE that matters (D1). The transport turns it into the rev of the
    // file it observed carrying that id, and Dropbox rejects the write if the
    // file has moved since.
    const parent = ourOwnLineage(descent, settings);
    // Unreachable: the head reported an id (checked above) and this branch is
    // only entered when ours is that same id, so it is not null. Handled
    // rather than asserted because the alternative — falling through to a
    // create — is the one mistake this whole file exists to prevent.
    if (parent === null) return { kind: 'error', message: NO_IDENTITY_MESSAGE };
    return pushLocal(transport, remoteRevision + 1, parent);
  }

  // The head CLAIMS to be a CHILD of the snapshot we descend from: someone
  // pushed once, on top of exactly what we have. Clean ⇒ a fast-forward — but
  // only once the BODY says so too, which is checked at the adoption gate.
  //
  // The proof is no longer about merged properties (C19); it is about TIME.
  // The head was read one round trip ago and the body arrives on the next, so
  // another device can write in between — and then the bytes being applied are
  // not the ones this decision was taken about. The gate catches exactly that,
  // and it costs nothing, because a pull downloads the body anyway.
  if (pulledSnapshotId !== null && meta.parentSnapshotId === pulledSnapshotId) {
    if (dirty) return conflict();
    return pullRemote(
      transport,
      guard,
      { kind: 'head-said-so', headSnapshotId, descendsFrom: pulledSnapshotId },
      conflict,
    );
  }

  // A device that has never agreed with ANY snapshot descends from nothing, so
  // there is no ancestry for the remote to violate — it is simply new here.
  // This is the feature's whole purpose (open the app on a second device and
  // get the book), and without this branch it would meet an established
  // lineage, fail both tests above and be told it had a conflict. `dirty` is
  // what protects it: a never-synced device counts as dirty unless its book is
  // PRISTINE (see hasLocalChanges), so a browser with anything of the user's
  // in it still gets asked. The revision guard is deliberate too — a device
  // that HAS synced but arrives with no id must not fall in here and be handed
  // a free pull.
  if (pulledSnapshotId === null && pulledRevision === 0) {
    if (dirty) return conflict();
    return pullRemote(
      transport,
      guard,
      {
        kind: 'nothing-of-ours-at-risk',
        because:
          'this device is PRISTINE — it descends from no snapshot and holds ' +
          'no book of its own (hasLocalChanges counts anything of the ' +
          "user's as dirty), so no proof about the file could protect " +
          'anything. Demanding one would greet a brand-new browser with a ' +
          'conflict dialog about a book it cannot lose, which is the one ' +
          'thing this branch exists to prevent.',
      },
      conflict,
    );
  }

  // Everything else is DIVERGENCE — until proved otherwise, and — this is the
  // whole point — it is a conflict even when this device is perfectly clean. A
  // clean device whose last agreed snapshot is nowhere in the remote's history
  // is holding rows that exist nowhere else: pulling would delete them with no
  // backup and no question asked, which is exactly the wipe this rewrite
  // exists to stop. It is also where a device that arrived with a revision and
  // no id lands, and being asked is the right answer for it too.
  //
  // "Until proved otherwise" is the one thing the head read cannot settle. A
  // device TWO OR MORE pushes behind also lands here — the head names only its
  // parent — and that is not divergence at all, it is the commonest thing two
  // devices do. So `conflict()` looks one step further before it asks: the
  // snapshot BODY carries a bounded chain of its ancestors
  // (SyncSnapshot.ancestry), and a clean device that finds its own id in that
  // chain fast-forwards instead. The check lives there, not here, because the
  // body has to be downloaded either way and downloading a multi-megabyte file
  // twice to answer one question would be absurd.
  return conflict();
}

/**
 * Write this device's book as the new head.
 *
 * @param parent WHERE the parentSnapshotId comes from — one of the three
 * sources in `PushParent`, never a bare id. Each of them names a snapshot this
 * device has actually seen the body of, or asserts that there is no file. That
 * is D1's fix and it is a type rather than a rule: the keep-local resolution
 * used to name the id the HEAD reported, which no device here had checked
 * against any body, and mint it into `parentSnapshotId` AND `ancestry` for
 * every other device to trust.
 *
 * The transport turns whatever id this resolves to into the Dropbox `rev` of a
 * file it has observed carrying it, and Dropbox enforces that rev atomically
 * with the bytes. If the head has moved since, the write is refused rather
 * than landing on top of a snapshot nobody here has seen.
 *
 * NOTE what is no longer passed: `expectHead`. On Drive the whole recorded
 * stamp had to travel with a write, because the identity in the head could be
 * a leftover of ours that a legacy writer's upload had merged back on top of
 * its own book (C18). Dropbox derives the head's identity from the same body
 * as everything else in the stamp, so a stamp could only ever disagree by
 * disagreeing about the identity first — which the transport checks anyway,
 * before Dropbox checks the rev. The parameter is still accepted there; this
 * engine has nothing honest to put in it.
 */
async function pushLocal(
  transport: SyncTransport,
  revision: number,
  parent: PushParent,
): Promise<SyncOutcome> {
  const { id: parentSnapshotId, older: olderAncestors } = parentage(parent);
  // Capture the change counter BEFORE reading the book. Anything written after
  // this point is not in the snapshot and leaves the device dirty, so the next
  // sync pushes again — a redundant push, never a lost change.
  const localRevisionAtSnapshot = (await getSettings()).syncLocalRevision;
  let snap: IdentifiedSnapshot;
  try {
    snap = await localSnapshot(revision, parentSnapshotId, olderAncestors);
  } catch (e) {
    return { kind: 'error', message: `Could not read this device's data: ${messageOf(e)}` };
  }
  try {
    await transport.writeRemote(snap);
  } catch (e) {
    // Settings are untouched, so the next attempt makes exactly this decision
    // again — and, crucially, this device does NOT record that it agrees with
    // a remote it may not have written. A refused precondition arrives here
    // like any other failure, which is the whole point: the alternative is
    // "pushed" over data we never saw.
    return outcomeFromError(e, 'Could not upload to Dropbox');
  }
  lastKnownRemoteRevision = revision;
  await updateSettings({
    syncLastPulledRevision: revision,
    // The id of the file that is in Dropbox NOW. We wrote this body, so it is
    // an id whose contents this device can testify about — which is exactly
    // what makes it legitimate for the NEXT push to name as its parent.
    syncLastPulledSnapshotId: snap.snapshotId,
    // The chain we just wrote is the one our next push must hand on.
    syncAncestry: snap.ancestry ?? [],
    syncSyncedLocalRevision: localRevisionAtSnapshot,
    syncLastSyncedAt: nowISO(),
  });
  return { kind: 'pushed', revision, snapshotId: snap.snapshotId };
}

/** Fetch + validate the remote snapshot, or an outcome explaining why not. */
async function fetchRemote(
  transport: SyncTransport,
): Promise<{ ok: true; snap: IdentifiedSnapshot } | { ok: false; outcome: SyncOutcome }> {
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

// ===========================================================================
// THE ADOPTION GATE — the body, and nothing but the body (C18/C19)
// ===========================================================================
//
// WHY THIS IS ONE GATE AND NOT A CHECK PER BRANCH. C18 was a branch that
// believed `snapshotId` off the head read. It was fixed by hardening that
// branch — and the branch immediately after it, believing `parentSnapshotId`
// off the same head read, kept the identical wipe alive (C19): a CLEAN device
// one push behind had its whole book replaced by a legacy device's, with no
// conflict, no prompt and no safety file. The defect was never in either
// branch. It was in letting a branch decide this at all. So there is one
// place where a downloaded snapshot becomes this device's book, it demands a
// proof, and only `proveAdoption` can mint one: a new branch cannot forget the
// check, because it has nothing to pass.
//
// THE GATE SURVIVES THE MOVE TO DROPBOX, AND IT SHOULD. What it was defending
// against on Drive is gone — appProperties merged, so the head's identity
// could be a leftover of ours sitting on somebody else's book, and no field of
// a head read could testify about the bytes beside it. Identity now travels in
// the body and cannot be inherited, so that particular lie is unavailable.
//
// But the gate was never really about appProperties. It is about the fact that
// A HEAD READ AND A BODY DOWNLOAD ARE TWO DIFFERENT MOMENTS. The engine
// decides what to do from a head, then spends a multi-megabyte download
// getting the bytes, and another device can write in between; the bytes that
// arrive are then not the ones the decision was about. Cheap, exact, and
// checkable only against the body — which every path that reaches here has
// already fetched, because it cannot apply what it has not downloaded.
//
// It is also what caught C19, and keeping a guard that has caught a real wipe
// is cheaper than re-deriving the argument for removing it.

/**
 * WHY a downloaded snapshot is allowed to become this device's book. Every
 * adoption names one, at the point where the decision was actually taken.
 */
type AdoptionWarrant =
  /**
   * The head read is what justified the download. The body must BE the
   * snapshot the head said it was — otherwise the file moved between the two
   * requests — and must NAME the id this device descends from in its own
   * chain. Both halves are read off the body; the head's claim is only the
   * thing being checked.
   *
   * `descendsFrom` is NOT NULLABLE, and that is D4 closed by construction.
   * The revision-number fallback used to pull with `descendsFrom: null` — "do
   * not check descent" — on a device that was holding an id perfectly capable
   * of being checked. With no null to pass, no branch can ask for a pull that
   * skips the descent check while claiming a lineage; a device that descends
   * from nothing has to say so with the warrant below, in writing.
   */
  | { kind: 'head-said-so'; headSnapshotId: string; descendsFrom: string }
  /**
   * The body's OWN chain justifies it: it names the snapshot this device
   * descends from, so applying it takes nothing away from a clean device. The
   * head is deliberately NOT compared here — this warrant is used inside
   * `resolveConflict`, reached precisely because the head could not be
   * trusted, and descent proved from the body is the stronger fact anyway.
   */
  | { kind: 'body-names-us'; descendsFrom: string }
  /**
   * Nothing this device holds can be lost by adopting, so there is nothing for
   * a proof to protect — and demanding one would only turn the two cases below
   * into conflict dialogs about books their owners cannot lose. `because` is
   * required so that a third such case has to argue for itself in writing.
   */
  | { kind: 'nothing-of-ours-at-risk'; because: string };

/**
 * Proof that the BODY bears out the warrant. `applyPulled` demands one and
 * `proveAdoption` is the only thing that makes one, which is what makes the
 * rule structural rather than remembered.
 */
const BODY_BORE_IT_OUT = Symbol('the snapshot body was checked against the warrant');
interface AdoptionProof {
  readonly [BODY_BORE_IT_OUT]: true;
}
const PROVED: AdoptionProof = { [BODY_BORE_IT_OUT]: true };

type Adoption = { ok: true; proof: AdoptionProof } | { ok: false; why: string };

/**
 * The single check. `why` is written to be readable in a test failure.
 *
 * The overload says out loud what the union would hide: a warrant that rests
 * on nothing being at risk CANNOT fail, so its caller has no refusal to
 * handle — while every warrant that makes a claim about the body does.
 */
function proveAdoption(
  snap: IdentifiedSnapshot,
  warrant: { kind: 'nothing-of-ours-at-risk'; because: string },
): { ok: true; proof: AdoptionProof };
function proveAdoption(snap: IdentifiedSnapshot, warrant: AdoptionWarrant): Adoption;
function proveAdoption(snap: IdentifiedSnapshot, warrant: AdoptionWarrant): Adoption {
  if (warrant.kind === 'nothing-of-ours-at-risk') return { ok: true, proof: PROVED };

  if (warrant.kind === 'head-said-so') {
    // The head said which snapshot this is. The bytes that arrived have to say
    // the same thing, or the file moved between the head read and the
    // download and this decision is about a file that no longer exists.
    if (snap.snapshotId !== warrant.headSnapshotId) {
      return {
        ok: false,
        why:
          `the file that was downloaded is not the one the head named ` +
          `(the head said ${warrant.headSnapshotId}, the file says ${snap.snapshotId})`,
      };
    }
  }

  // …and the body has to NAME US. Only the body can: snapshot ids are random
  // uid()s, so a writer that never saw ours cannot name one, which is why a
  // chain can only ever GRANT descent and never deny it.
  const from = warrant.descendsFrom;
  const names = (snap.parentSnapshotId ?? null) === from || (snap.ancestry ?? []).includes(from);
  if (!names) {
    return {
      ok: false,
      why: `the file's contents do not descend from ${from}, the snapshot this device's book grew out of`,
    };
  }
  return { ok: true, proof: PROVED };
}

/**
 * Download the remote and adopt it — or, if the body does not bear out the
 * warrant, hand it to `refuse` (which is always `conflict()`, so the owner is
 * asked instead of overruled). The downloaded snapshot goes with it, because
 * the conflict path needs the same bytes and this device's real book is ~3 MB.
 */
async function pullRemote(
  transport: SyncTransport,
  guard: LocalStateAtDecision,
  warrant: AdoptionWarrant,
  refuse: (downloaded: IdentifiedSnapshot) => Promise<SyncOutcome>,
): Promise<SyncOutcome> {
  const got = await fetchRemote(transport);
  if (!got.ok) return got.outcome;
  const proved = proveAdoption(got.snap, warrant);
  // NOTHING is recorded on the way out. In particular this device keeps the id
  // it descends from: overwriting `syncLastPulledSnapshotId` here would leave
  // it claiming descent from a file it has just refused to adopt.
  if (!proved.ok) return refuse(got.snap);
  return applyPulled(got.snap, guard, proved.proof);
}

/**
 * What the user is told when they typed something while the sync was running.
 * The one thing it must never read as is "done": the change is still here, it
 * is still unsent, and one more sync deals with it properly.
 */
const LOCAL_WRITE_DURING_SYNC_MESSAGE =
  'This device changed while the sync was running, so nothing was replaced. ' +
  'Your change is still here and still unsent — sync again to send it, or to be ' +
  'shown both sides if the other device has changed too.';

/**
 * Replace this device's book with `snap`.
 *
 * `_proof` is never read, and that is the point: it can only have come from
 * `proveAdoption`, so the type system — not a reviewer's memory — is what
 * stops a future branch from applying a snapshot it never checked. See THE
 * ADOPTION GATE above for why the check has to be against the body.
 */
async function applyPulled(
  snap: IdentifiedSnapshot,
  guard: LocalStateAtDecision,
  _proof: AdoptionProof,
): Promise<SyncOutcome> {
  try {
    await applyRemote(snap, guard);
  } catch (e) {
    // restoreBackup is one transaction: a failure here means nothing was
    // written at all. A change that landed during the download arrives here
    // the same way, by aborting that transaction — deliberately, so that the
    // "nothing was written" guarantee covers both.
    if ((e as { name?: string } | null)?.name === 'LocalWriteDuringSyncError') {
      return { kind: 'error', message: LOCAL_WRITE_DURING_SYNC_MESSAGE };
    }
    return {
      kind: 'error',
      message: `Could not apply the synced data: ${messageOf(e)} Nothing on this device was changed.`,
    };
  }
  // The book now IS the remote revision. Drop the pending flag — but only the
  // one we captured before the network calls: a flag raised since belongs to a
  // write this sync has never seen, and dropping it would be the erasure that
  // made C2/C5/C6 unrecoverable. (The apply's own writes never raise one; they
  // run under withoutLocalChangeTracking.)
  clearPendingLocalChange(guard.changeMark);
  lastKnownRemoteRevision = snap.revision;
  await updateSettings({
    syncLastPulledRevision: snap.revision,
    // We have just read this body and written it into every table, so it is an
    // id this device can testify about — which is what makes it legitimate for
    // the next push to name as its parent (see PushParent).
    syncLastPulledSnapshotId: snap.snapshotId,
    // Everything that snapshot descends from is now behind us too.
    syncAncestry: (snap.ancestry ?? []).slice(0, SYNC_ANCESTRY_DEPTH),
    // The counter as it stood when the decision was made, NOT as it stands
    // now: reading it now would consume a bump made during the sync and mark
    // the device clean over a change that is not in the snapshot. The guard
    // has just proved the two are the same number, so this is also the honest
    // one; if that ever stops being true, the device stays dirty and pushes.
    syncSyncedLocalRevision: guard.localRevision,
    syncLastSyncedAt: nowISO(),
  });
  return {
    kind: 'pulled',
    revision: snap.revision,
    counts: snapshotCounts(snap.tables),
    // This book now descends from exactly that snapshot.
    snapshotId: snap.snapshotId,
  };
}

async function resolveConflict(
  transport: SyncTransport,
  opts: SyncOptions,
  guard: LocalStateAtDecision,
  ctx: {
    remoteRevision: number;
    pulledRevision: number;
    localDeviceName: string;
    /**
     * The id this device holds, if a fast-forward is still possible — non-null
     * only for a device with nothing unsent.
     *
     * The head is deliberately NOT passed in any more. A resolution that
     * overwrites the remote must name a parent it has SEEN THE BODY OF, and
     * the body is downloaded right here; there is nothing a head field could
     * add except the opportunity to name it by mistake (D1).
     */
    fastForwardFrom: string | null;
    /**
     * The snapshot the caller has ALREADY downloaded, when it got here by
     * refusing to adopt one (see the adoption gate). Same file, same sync,
     * seconds old — and re-fetching it would cost the owner a second ~3 MB
     * download to answer a question these bytes already answer.
     */
    downloaded: IdentifiedSnapshot | null;
  },
): Promise<SyncOutcome> {
  let remoteSnap: IdentifiedSnapshot;
  if (ctx.downloaded !== null) {
    remoteSnap = ctx.downloaded;
  } else {
    const got = await fetchRemote(transport);
    if (!got.ok) return got.outcome;
    remoteSnap = got.snap;
  }

  // 'reseed-remote' answers a DIFFERENT question — "the file is gone, start a
  // new one" — and there is a file here. Treated as no answer at all, because
  // the alternative is falling through to the keep-local branch below and
  // overwriting a remote the user was never shown.
  const unanswered = !opts.resolve || opts.resolve === 'reseed-remote';

  // NOT A CONFLICT AFTER ALL. The head named a parent we have never heard of,
  // but the snapshot itself names US further back: this device is simply two
  // or more pushes behind, which is what happens every time the other device
  // syncs twice before this one does. The chain can only ever GRANT descent —
  // snapshot ids are random, so a writer that never saw ours cannot name it —
  // and `fastForwardFrom` is non-null only for a device with nothing unsent,
  // so applying takes nothing away. It is checked HERE, after the download,
  // because the chain lives in the body: asking before would mean fetching the
  // same multi-megabyte file twice.
  if (unanswered && ctx.fastForwardFrom !== null) {
    const proved = proveAdoption(remoteSnap, {
      kind: 'body-names-us',
      descendsFrom: ctx.fastForwardFrom,
    });
    if (proved.ok) return applyPulled(remoteSnap, guard, proved.proof);
  }

  if (unanswered) {
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
    //
    // The guard is taken HERE, not at the top of the sync, and it is the
    // export that decides where: everything in the book at this instant is
    // about to be written to a file the user can restore, so a change made
    // earlier in this sync is discarded knowingly and recoverably — which is
    // what "keep the remote" means. What must not happen is a change made
    // AFTER this line being destroyed, and there is a lot of "after": the
    // save dialog can sit open for minutes. `wasClean: false` because the
    // device is dirty on purpose here; re-checking for a pristine book would
    // refuse the very apply the user just asked for.
    const discardGuard = captureLocalState(await getSettings(), true);
    let losing: BackupFile;
    try {
      losing = await exportBackup();
    } catch (e) {
      return { kind: 'error', message: `Could not read this device's data: ${messageOf(e)}` };
    }
    try {
      await saveLosingSide(
        losing,
        'local',
        ctx.pulledRevision,
        `This device's copy of the book, replaced by revision ${ctx.remoteRevision} from Dropbox.`,
        opts.saveBackup,
      );
    } catch (e) {
      return {
        kind: 'error',
        message:
          `Could not save a backup of this device's data (${messageOf(e)}), ` +
          'so nothing was replaced. Export a backup first, then try again.',
      };
    }
    // The owner was shown both sides and chose this one, and the book about to
    // be replaced has just been written to a file he can restore. There is
    // nothing left for a proof to protect, and demanding one would make
    // "keep the copy in Dropbox" impossible to carry out in exactly the state
    // it exists to settle — two books that do not descend from each other.
    const proved = proveAdoption(remoteSnap, {
      kind: 'nothing-of-ours-at-risk',
      because:
        'the owner was shown both sides and chose the remote, and the losing ' +
        'local book has just been written to a safety file',
    });
    return applyPulled(remoteSnap, discardGuard, proved.proof);
  }

  // keep-local: the REMOTE snapshot loses and is about to be overwritten.
  // Dropbox keeps its own file revisions, but "probably recoverable from
  // someone else's service" is not the standard here.
  try {
    await saveLosingSide(
      snapshotToBackupFile(remoteSnap),
      'remote',
      remoteSnap.revision,
      `Revision ${remoteSnap.revision} from Dropbox (written by ${remoteSnap.deviceName}), ` +
        "replaced by this device's copy.",
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
  // Push above BOTH sides so the number never goes backwards for anyone, and
  // name as the parent THE BODY WE ARE HOLDING — the snapshot we downloaded,
  // described to the owner, and wrote to a safety file before touching
  // anything. This is the longest window in the whole feature (a 3 MB download
  // plus a save dialog that can sit open for minutes), so it is also the one
  // most likely to have a third write land inside it; the transport then
  // refuses this push rather than flattening something nobody has seen.
  //
  // ===== D1, AND WHY THIS ONE LINE IS THE WHOLE DEFECT ====================
  //
  // This used to name `ctx.head.snapshotId` — the id THE FILE REPORTED ABOUT
  // ITSELF at the top of the sync, which no device here had ever checked
  // against any body. On Drive that id could be a leftover of our own write
  // that appProperties had merged back on top of somebody else's book, and
  // naming it here minted it into `parentSnapshotId` AND into `ancestry`,
  // where every other device treats an ancestry entry as PROOF OF DESCENT. A
  // third device that genuinely descended from that id would find itself named
  // in a chain it was not in, fast-forward, and be silently wiped — a
  // conflict RESOLUTION destroying an uninvolved device's rows.
  //
  // The fix is not "compare more fields". It is that a parent may only ever be
  // an id this device has seen the body of, which is what `aBodyWeHold` says
  // and what `PushParent` makes the only thing sayable. The chain handed on is
  // that body's own ancestry, from the same bytes, so the two cannot disagree.
  return pushLocal(
    transport,
    Math.max(ctx.remoteRevision, ctx.pulledRevision) + 1,
    aBodyWeHold(remoteSnap),
  );
}

/** Table names a snapshot is expected to carry — re-exported for the UI. */
export { ALL_TABLES, DATA_TABLES };
