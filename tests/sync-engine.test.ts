// Sync engine tests (D42; SPEC §8.3, §2.6 "data loss is unacceptable").
//
// This is the first feature in the app that can destroy real data, so the
// tests are written as a safety case rather than a coverage exercise. Every
// branch of the decision table is here, and so is every way the engine is
// supposed to REFUSE: a conflict that writes nothing, a corrupt remote, a
// remote from a newer build, a failure halfway through an apply, an offline
// attempt, a safety backup that could not be written. The last test in the
// file is the one that matters most — a seeded, randomised sequence of local
// edits, remote edits and syncs asserting that the two sides never silently
// diverge and that no transaction ever vanishes without a copy of it existing
// somewhere.
//
// COST OF THE CHANGE TRACKER, measured on the owner's real import size (5,127
// transactions; fake-indexeddb, Node v24.19, 15 runs):
//
//   revision bumps for one 5,127-row import   1        (not 5,127)
//   markLocalChange(), per OPERATION          0.0025 ms  (median)
//   flushLocalRevision(), per burst           0.18 ms    (median)
//   import untracked / tracked+flushed        321 / 319 ms (min of 15)
//
// The middleware intercepts operations, not rows — a bulkAdd of 5,127 rows is
// one `mutate` call — so the whole tracker costs one boolean and one settings
// write per import: ~0.18 ms against a ~330 ms import, which is below the
// run-to-run noise (the tracked minimum came out marginally FASTER). The "1"
// on the first line is asserted below by 'a 5,127-row bulk import bumps the
// revision exactly once'; a per-row implementation would have written 5,127
// settings rows instead.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TABLES,
  BOOK_LEVEL_SETTING_KEYS,
  DATA_TABLES,
  DEVICE_LOCAL_SETTING_KEYS,
  RETIRED_SETTING_KEYS,
  clearPendingLocalChange,
  withoutLocalChangeTracking,
  db,
  defaultSettings,
  hasPendingLocalChange,
  flushLocalRevision,
  getSettings,
  localChangeMarkNow,
  SCHEMA_VERSION,
  updateSettings,
} from '../src/db/db';
import {
  applyRemote,
  bumpLocalRevision,
  ensureSyncIdentity,
  getSyncState,
  hasLocalChanges,
  localSnapshot,
  mergeSettingsRow,
  setConflictBackupSaver,
  snapshotCounts,
  SYNC_ANCESTRY_DEPTH,
  syncNow,
  validateSnapshot,
} from '../src/sync/syncEngine';
import type { SyncOutcome, SyncRemoteMeta, SyncSnapshot, SyncTransport } from '../src/sync/types';
import {
  clearRecoveryStore,
  listRecoveryRecords,
  readRecoveryBackup,
  recoveryDb,
  restoreRecoveryBackup,
  RECOVERY_KEEP,
  type BackupFile,
  type BackupSaveResult,
} from '../src/backup/backup';
import type { Account, Category, Settings, Transaction } from '../src/db/types';

// ---------------------------------------------------------------- utilities

const T0 = '2026-08-01T10:00:00.000Z';
const clone = <T>(x: T): T => structuredClone(x);
const sortById = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

function emptyTables(): Record<string, unknown[]> {
  const out: Record<string, unknown[]> = {};
  for (const name of ALL_TABLES) out[name] = [];
  return out;
}

const account: Account = {
  id: 'acc1',
  name: 'Current',
  type: 'current',
  currency: 'GBP',
  openingBalanceMinor: 150_000,
  colour: '#3b82f6',
  groupId: null,
  sortOrder: 0,
  archived: false,
};

const category: Category = {
  id: 'cat1',
  name: 'Groceries',
  parentId: null,
  kind: 'expense',
  archived: false,
  sortOrder: 0,
};

function txRow(id: string, amountMinor = -1234): Transaction {
  return {
    id,
    accountId: 'acc1',
    date: '2026-07-15',
    amountMinor,
    currency: 'GBP',
    payeeId: null,
    categoryId: 'cat1',
    tagIds: [],
    notes: '',
    status: 'cleared',
    splits: [],
    transferGroupId: null,
    importBatchId: null,
    dedupeHash: `hash-${id}`,
    createdAt: T0,
    updatedAt: T0,
  };
}

/** A book with real accounts + transactions, i.e. NOT a pristine device. */
async function seedBook(txCount = 3): Promise<void> {
  await db.accounts.add(clone(account));
  await db.categories.add(clone(category));
  for (let i = 0; i < txCount; i++) await db.transactions.add(txRow(`tx-${i}`, -(100 + i)));
  await updateSettings({ onboarded: true });
  await flushLocalRevision();
}

/** Pretend the current book is exactly what the remote holds at `revision`. */
async function markSyncedAt(revision: number): Promise<void> {
  await flushLocalRevision();
  const s = await getSettings();
  await updateSettings({
    syncSyncedLocalRevision: s.syncLocalRevision,
    syncLastPulledRevision: revision,
    syncLastSyncedAt: T0,
  });
}

async function localDataTables(): Promise<Record<string, unknown[]>> {
  const out: Record<string, unknown[]> = {};
  for (const name of DATA_TABLES) {
    out[name] = sortById((await db.table(name).toArray()) as { id: string }[]);
  }
  return out;
}

function snapshotDataTables(snap: SyncSnapshot | null): Record<string, unknown[]> | null {
  if (!snap) return null;
  const out: Record<string, unknown[]> = {};
  for (const name of DATA_TABLES) {
    out[name] = sortById((snap.tables[name] ?? []) as { id: string }[]);
  }
  return out;
}

/** Fresh, readable snapshot ids — a failing assertion names the write. */
let snapshotIdCounter = 0;
const nextSnapshotId = () => `snap-${++snapshotIdCounter}`;

/**
 * Build a snapshot as if some OTHER device wrote it. It gets its own identity
 * every time (never reused), and by default descends from nothing — pass
 * `parentSnapshotId` (and, for a lineage more than one deep, `ancestry`) to
 * place it in one.
 */
function makeSnapshot(
  revision: number,
  tables: Record<string, unknown[]>,
  over: Partial<SyncSnapshot> = {},
): SyncSnapshot {
  return {
    app: 'MyMoney',
    schemaVersion: SCHEMA_VERSION,
    revision,
    deviceId: 'device-b',
    deviceName: 'iMac',
    savedAt: '2026-08-20T09:00:00.000Z',
    snapshotId: nextSnapshotId(),
    parentSnapshotId: null,
    ancestry: [],
    tables: { ...emptyTables(), ...tables },
    ...over,
  };
}

/**
 * The chain a snapshot written on top of `head` should carry — bounded exactly
 * as a real device bounds it (localSnapshot slices to SYNC_ANCESTRY_DEPTH), so
 * the tests cannot accidentally rely on an unbounded chain the app would never
 * write.
 */
function chainOver(head: SyncSnapshot | null): string[] {
  if (!head?.snapshotId) return [];
  return [head.snapshotId, ...(head.ancestry ?? [])].slice(0, SYNC_ANCESTRY_DEPTH);
}

// ------------------------------------------------------------ fake transport
//
// In-memory stand-in for the Dropbox app folder. No network is ever touched by
// these tests; `fetch` is never called, stubbed or otherwise.
//
// IT MODELS THE REAL TRANSPORT'S REFUSALS, not just its storage. In particular
// it refuses a body with no snapshotId in both directions, exactly as
// src/sync/transport.ts's vetSnapshot() does — a fake that accepted one would
// let a test "prove" a branch the real transport can never reach.

/** A transport failure shaped like the real one (duck-typed on name + kind). */
function transportError(message: string): Error & { kind: string } {
  return Object.assign(new Error(message), { name: 'SyncTransportError', kind: 'remote' });
}

/**
 * The real transport refuses an identity-less body at the door, in BOTH
 * directions (src/sync/transport.ts). No build of this app has ever written to
 * Dropbox and the pre-ancestry build cannot reach it, so such a file can only
 * come from a hand edit or a foreign tool — and tolerating one would let a
 * device fall past every ancestry branch onto a comparison of two absences.
 */
function requireIdentity(snap: SyncSnapshot, subject: string): void {
  if (typeof snap.snapshotId !== 'string' || snap.snapshotId === '') {
    throw transportError(`${subject} carries no snapshot identity.`);
  }
}

class FakeCloud implements SyncTransport {
  file: SyncSnapshot | null = null;
  /** Deleted in Dropbox: it exists, is restorable, and must not be written over. */
  trashed = false;
  connected = true;
  reads = 0;
  metaReads = 0;
  writes = 0;
  failMetaWith: unknown = null;
  failReadWith: unknown = null;
  failWriteWith: unknown = null;
  /** Runs the instant readRemoteMeta() has answered — i.e. INSIDE syncNow's
   *  window, between the head read and the upload. */
  afterNextMetaRead: (() => void) | null = null;
  /** Runs after our bytes have landed and before the read-back sees them. */
  duringNextWrite: (() => void) | null = null;
  /**
   * Runs while readRemote() is still in flight — the multi-megabyte download
   * during which the app stays fully interactive (the quick-add button is
   * mounted at the app shell, so the user need not even leave the Sync
   * screen). Awaited, so a test can make a real Dexie write there.
   */
  duringNextRead: (() => void | Promise<void>) | null = null;

  isConnected(): boolean {
    return this.connected;
  }
  async connect(): Promise<void> {
    this.connected = true;
  }
  async disconnect(): Promise<void> {
    this.connected = false;
  }
  async readRemote(): Promise<SyncSnapshot | null> {
    this.reads++;
    if (this.failReadWith) throw this.failReadWith;
    const hook = this.duringNextRead;
    this.duringNextRead = null;
    if (hook) await hook();
    if (this.file) requireIdentity(this.file, 'The sync file in Dropbox');
    return this.file ? clone(this.file) : null;
  }
  /**
   * Models the REAL transport's contract, not a memory cell: the write only
   * lands if the head is still the parent this snapshot was built on, and it
   * is only reported as successful if our snapshot is what is there afterwards
   * (src/sync/transport.ts, rule 1a). A fake that accepted anything is exactly
   * why the collision this file now tests for went unnoticed.
   */
  async writeRemote(snap: SyncSnapshot): Promise<void> {
    this.writes++;
    if (this.failWriteWith) throw this.failWriteWith;
    requireIdentity(snap, 'This snapshot');
    if (this.trashed) throw transportError('The sync file has been deleted from Dropbox.');
    const headId = this.file?.snapshotId ?? null;
    const parent = snap.parentSnapshotId ?? null;
    if (headId !== parent) {
      throw transportError('Another device saved to Dropbox while this one was uploading.');
    }
    this.file = clone(snap);
    const hook = this.duringNextWrite;
    this.duringNextWrite = null;
    hook?.();
    if (this.file?.snapshotId !== snap.snapshotId) {
      throw transportError('The sync file no longer holds this device’s data.');
    }
  }
  async readRemoteMeta(): Promise<SyncRemoteMeta | null> {
    this.metaReads++;
    if (this.failMetaWith) throw this.failMetaWith;
    if (!this.file) return null;
    const { revision, savedAt, deviceName, snapshotId, parentSnapshotId } = this.file;
    const meta: SyncRemoteMeta = {
      revision,
      savedAt,
      deviceName,
      snapshotId: snapshotId ?? null,
      parentSnapshotId: parentSnapshotId ?? null,
      ...(this.trashed ? { trashed: true } : {}),
    };
    const hook = this.afterNextMetaRead;
    this.afterNextMetaRead = null;
    hook?.();
    return meta;
  }
}

/**
 * A remote with NO COMPARE-AND-SWAP — Google Drive, in one class. It accepts
 * any write at all, so what a snapshot claims about its own ancestry rests on
 * the engine and nothing else. Used to check that a safety property is the
 * engine's own rather than a side effect of Dropbox refusing the write.
 */
class NoPreconditionCloud extends FakeCloud {
  async writeRemote(snap: SyncSnapshot): Promise<void> {
    this.writes++;
    requireIdentity(snap, 'This snapshot');
    this.file = clone(snap);
  }
}

/**
 * A well-behaved second device: it always syncs cleanly (pull, edit, push), so
 * anything it puts in the remote descends from the current remote file.
 */
function deviceBPushes(cloud: FakeCloud, edit: (tables: Record<string, unknown[]>) => void): void {
  const tables = cloud.file ? clone(cloud.file.tables) : emptyTables();
  edit(tables);
  cloud.file = makeSnapshot((cloud.file?.revision ?? 0) + 1, tables, {
    savedAt: new Date(Date.parse(T0) + cloud.writes * 60_000).toISOString(),
    parentSnapshotId: cloud.file?.snapshotId ?? null,
    ancestry: chainOver(cloud.file),
  });
}

/**
 * A device pushing off a STALE head — the write that the revision model could
 * not see and that this whole rewrite exists to catch.
 *
 * It bypasses writeRemote deliberately: the real transport now refuses this,
 * so the only way it can happen in the wild is a writer that does not honour
 * the precondition (a build from before this fix, a hand-edited file, another
 * tool). The engine must still notice that what is in the remote is not what it
 * descends from — never report "up to date", never pull over local changes.
 *
 * `stale` is the snapshot it thinks it is replacing; the new book keeps every
 * row already in the remote so that nothing is destroyed by the collision
 * itself, and only the ANCESTRY is broken.
 */
function staleWriterPushes(
  cloud: FakeCloud,
  stale: SyncSnapshot,
  edit: (tables: Record<string, unknown[]>) => void,
): void {
  const tables = clone(cloud.file ? cloud.file.tables : stale.tables);
  edit(tables);
  cloud.file = makeSnapshot((cloud.file?.revision ?? 0) + 1, tables, {
    deviceId: 'device-c',
    deviceName: 'Old iPad',
    savedAt: new Date(Date.parse(T0) + (cloud.writes + 1) * 60_000).toISOString(),
    // Its chain is the STALE one it was working from — honestly written, and
    // therefore naming nothing that came after the head it never saw.
    parentSnapshotId: stale.snapshotId ?? null,
    ancestry: chainOver(stale),
  });
}

/**
 * Reset the tracker between tests. `clearPendingLocalChange` takes the mark it
 * is allowed to clear — that is the whole point of it (a pull may only ever
 * drop the flag it captured before its network calls, never one raised by a
 * write that landed since) — so a harness that genuinely means "whatever is
 * pending right now" has to say so.
 */
function resetPendingLocalChange(): void {
  clearPendingLocalChange(localChangeMarkNow());
}

/**
 * A working <a download> path, so a test that cancels the file picker cannot
 * pass merely because the fallback exploded: with this in place the fallback
 * SUCCEEDS, and only a deliberate refusal to treat a cancellation as a save
 * can stop the resolution.
 */
let anchorDownloads: string[] = [];
function stubAnchorDownload(): void {
  anchorDownloads = [];
  vi.stubGlobal('document', {
    createElement: () => ({ click: () => anchorDownloads.push('clicked'), remove: () => {} }),
    body: { appendChild: () => {} },
  });
  vi.stubGlobal('URL', {
    createObjectURL: () => 'blob:fake',
    revokeObjectURL: () => {},
  });
}

// ------------------------------------------------------------------- harness

let savedBackups: { file: BackupFile; name: string }[] = [];

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  // The recovery store is a database of its own (see backup.ts), so clearing
  // db.tables does not touch it — and a conflict copy left behind by the
  // previous test would make the next one's assertions meaningless.
  await clearRecoveryStore();
  resetPendingLocalChange();
  savedBackups = [];
  snapshotIdCounter = 0;
  // Never write a real file in tests; also lets every test see WHAT was saved.
  // 'saved' is what a file picker that wrote the bytes reports — the FILE half
  // of the safety copy succeeding. The recovery-store half is never stubbed:
  // it is the half the destruction is gated on (C4).
  setConflictBackupSaver(async (file, name) => {
    savedBackups.push({ file: clone(file), name });
    return 'saved';
  });
  await updateSettings({
    ...defaultSettings(),
    syncDeviceId: 'device-a',
    syncDeviceName: 'Laptop',
    syncEnabled: true, // the tracker is inert until sync is set up on a device
  });
  resetPendingLocalChange();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setConflictBackupSaver(null);
  resetPendingLocalChange();
});

// ===========================================================================
describe('settings gain sync fields without a migration', () => {
  it('defaults are present and inert', async () => {
    // The factory defaults, not the harness's (which turns sync on).
    const s = defaultSettings();
    expect(s.syncEnabled).toBe(false);
    expect(s.syncDeviceId).toBe(''); // minted lazily — never per getSettings()
    expect(defaultSettings().syncDeviceId).toBe(s.syncDeviceId);
    expect(s.syncClientId).toBeNull();
    expect(s.syncLastSyncedAt).toBeNull();
    expect(s.syncLastPulledRevision).toBe(0);
    expect(s.syncLocalRevision).toBe(0);
    expect(s.syncSyncedLocalRevision).toBe(0);
  });

  it('a settings row written by an older build normalises to the defaults', async () => {
    // Exactly what a pre-sync build (or an older backup) stored: no sync keys.
    const old = {
      id: 'app',
      schemaVersion: SCHEMA_VERSION,
      baseCurrency: 'GBP',
      theme: 'dark',
      lastBackupAt: null,
      onboarded: true,
      lastUsedAccountId: null,
      savedMappings: {},
      createdAt: T0,
    };
    await db.settings.put(old as unknown as Settings);
    const s = await getSettings();
    expect(s.theme).toBe('dark'); // stored values survive
    expect(s.syncEnabled).toBe(false); // new ones are filled in
    expect(s.syncDeviceId).toBe('');
    expect(s.syncLocalRevision).toBe(0);
  });

  it('device identity is minted once and then stable', async () => {
    await updateSettings({ syncDeviceId: '', syncDeviceName: '' });
    const first = await ensureSyncIdentity();
    expect(first.deviceId).not.toBe('');
    expect(first.deviceName).not.toBe('');
    const second = await ensureSyncIdentity();
    expect(second).toEqual(first);
    // Two getSettings() calls must never invent two devices.
    expect((await getSettings()).syncDeviceId).toBe(first.deviceId);
  });
});

// ===========================================================================
describe('local change tracking', () => {
  const revisionOf = async () => (await getSettings()).syncLocalRevision;

  it('a 5,127-row bulk import bumps the revision exactly once', async () => {
    const rows = Array.from({ length: 5127 }, (_, i) => txRow(`bulk-${i}`, -(100 + i)));
    const before = await revisionOf();

    // COUNT THE WORK, NOT THE CLOCK.
    //
    // This used to time the import and assert `elapsed < 5000`, as a stand-in
    // for "a per-row settings write would be orders of magnitude slower". That
    // was a bad instrument in both directions: it fails on a machine whose
    // cores are busy with the other 38 test files (which is how it was found —
    // it is a statement about the scheduler, not about this code), and it
    // PASSES on a machine fast enough to do the wrong thing in five seconds.
    // Rejected alternative: keep the timing and just raise the bound — that
    // only moves the false red further away, and the further away it moves the
    // less the assertion means.
    //
    // The counters below state the property directly. The middleware
    // intercepts OPERATIONS, not rows, so a 5,127-row bulkAdd is ONE `mutate`:
    // the tracker runs once, and the coalesced flag reaches disk in ONE
    // settings write. A per-row implementation scores 5,127 on both, on any
    // machine, at any speed.
    let settingsWrites = 0;
    const countSettingsWrite = () => {
      settingsWrites++;
    };
    // Dexie table hooks, not a spy on `db.settings.update`: they fire for
    // every write path into the row (put/update/bulkPut), so an implementation
    // that reached the settings table by another route would still be counted.
    db.settings.hook('creating', countSettingsWrite);
    db.settings.hook('updating', countSettingsWrite);
    const markBefore = localChangeMarkNow();
    try {
      await db.transactions.bulkAdd(rows);
      // One operation noticed for 5,127 rows.
      expect(localChangeMarkNow() - markBefore).toBe(1);
      // …and the import itself touched `settings` not at all. (Deterministic,
      // not a race: the flush is a 250 ms macrotask armed after the mutate
      // resolves, so it cannot have run by the time this line does.)
      expect(settingsWrites).toBe(0);
      await flushLocalRevision();
      // The whole import costs exactly one settings write, on the flush.
      expect(settingsWrites).toBe(1);
    } finally {
      db.settings.hook('creating').unsubscribe(countSettingsWrite);
      db.settings.hook('updating').unsubscribe(countSettingsWrite);
    }

    expect(await revisionOf()).toBe(before + 1); // ONE bump, not 5,127
    expect(await db.transactions.count()).toBe(5127);
  });

  it('writes to every data table bump it; DEVICE-LOCAL settings writes never do', async () => {
    for (const name of DATA_TABLES) {
      const before = await revisionOf();
      await db.table(name).put({ id: `probe-${name}` } as never);
      await flushLocalRevision();
      expect(await revisionOf(), `${name} should bump`).toBe(before + 1);
    }
    // A device-local key describes this browser, never the book. It must not
    // bump — recording a sync is itself a settings write, and a tracker that
    // counted those would chase its own tail forever.
    const before = await revisionOf();
    await updateSettings({ theme: 'dark' });
    await updateSettings({ lastUsedAccountId: 'acc-1' });
    await updateSettings({ syncLastSyncedAt: T0, syncLastPulledRevision: 4 });
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before);
  });

  /**
   * C3/C7. baseCurrency, autoFxEnabled and lastFxSync* TRAVEL inside a
   * snapshot, so a device that changes one is holding something the remote has
   * not seen — however the tracker's table-level view of the world looks.
   * Before this, changing the base currency left the counter still, the device
   * still "clean", and the next pull put the old currency back.
   */
  it('BOOK-LEVEL settings writes bump it, once per change and only on a change', async () => {
    for (const patch of [
      { baseCurrency: 'USD' },
      { autoFxEnabled: false },
      { lastFxSyncAt: T0 },
      { lastFxSyncSource: 'exchangerate.host' },
      { onboarded: true },
      { savedMappings: { sig: {} as never } },
    ]) {
      const before = await revisionOf();
      await updateSettings(patch);
      await flushLocalRevision();
      expect(await revisionOf(), `${JSON.stringify(patch)} should bump`).toBe(before + 1);

      // Writing the SAME value again is not a change. Several screens re-save
      // the whole row on every render; each one must not cost a push.
      await updateSettings(patch);
      await flushLocalRevision();
      expect(await revisionOf(), `${JSON.stringify(patch)} again`).toBe(before + 1);
    }

    // …and a burst still coalesces into one bump, like any other write.
    const before = await revisionOf();
    await updateSettings({ baseCurrency: 'EUR' });
    await updateSettings({ baseCurrency: 'JPY' });
    await updateSettings({ baseCurrency: 'CHF' });
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before + 1);
  });

  /**
   * The rot-proofing. A Settings field classified in NEITHER list would travel
   * (mergeSettingsRow pins only the device-local list) while never marking the
   * device dirty — which is precisely C3/C7, rebuilt by hand. The compile-time
   * check in db.ts says the same thing; this one says it at runtime, over the
   * keys that actually exist in a row, so it also catches a field added to
   * Settings and forgotten in defaultSettings().
   */
  it('every Settings key is classified as either device-local or book-level', () => {
    const keys = Object.keys(defaultSettings()).sort();
    const device = new Set<string>(DEVICE_LOCAL_SETTING_KEYS);
    const book = new Set<string>(BOOK_LEVEL_SETTING_KEYS);
    const retired = new Set<string>(RETIRED_SETTING_KEYS);

    for (const key of keys) {
      const inDevice = device.has(key);
      const inBook = book.has(key);
      expect(inDevice || inBook, `Settings.${key} is in neither list`).toBe(true);
      expect(inDevice && inBook, `Settings.${key} is in both lists`).toBe(false);
      expect(retired.has(key), `Settings.${key} is retired but still defaulted`).toBe(false);
    }
    // …and neither list names a field that no longer exists — except the
    // retired ones, which are named on purpose so that a snapshot's settings
    // row cannot smuggle a value into a key nothing validates any more.
    const live = [...device, ...book].filter((k) => !retired.has(k));
    expect(live.filter((k) => !keys.includes(k))).toEqual([]);
    expect(live.length).toBe(keys.length);
  });

  it('a retired settings key holds nothing, travels nowhere, and is not defaulted', async () => {
    // RETIRED_SETTING_KEYS is the third list, and the one that could quietly
    // become a place to park an unclassified field. Two properties keep it
    // honest, and the compile-time half (only a `?: undefined` field may be
    // listed) is checked by tsc, not here.
    expect(RETIRED_SETTING_KEYS.length).toBeGreaterThan(0);
    for (const key of RETIRED_SETTING_KEYS) {
      // Nothing supplies a default, so a fresh row simply lacks the key…
      expect(key in defaultSettings()).toBe(false);
      // …and it is pinned device-local, so a pulled snapshot's settings row
      // cannot introduce one either (C3/C7, on a dead field).
      expect(DEVICE_LOCAL_SETTING_KEYS as readonly string[]).toContain(key);
    }
    await seedBook();
    const stored = await getSettings();
    for (const key of RETIRED_SETTING_KEYS) expect(key in stored).toBe(false);
  });

  it('updates and deletes count as changes too', async () => {
    await db.transactions.add(txRow('tx-1'));
    await flushLocalRevision();
    let before = await revisionOf();

    await db.transactions.update('tx-1', { notes: 'edited' });
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before + 1);

    before = await revisionOf();
    await db.transactions.delete('tx-1');
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before + 1);

    before = await revisionOf();
    await db.transactions.clear();
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before + 1);
  });

  it('a coalesced burst of writes bumps once', async () => {
    const before = await revisionOf();
    await db.transactions.add(txRow('a'));
    await db.transactions.add(txRow('b'));
    await db.transactions.add(txRow('c'));
    expect(hasPendingLocalChange()).toBe(true); // still in memory, not on disk
    await flushLocalRevision();
    expect(hasPendingLocalChange()).toBe(false);
    expect(await revisionOf()).toBe(before + 1);
  });

  /**
   * The API that makes C2/C5/C6 hard to reintroduce. A pull captures the mark
   * before it goes to the network and hands that value back afterwards; if a
   * write has been noticed in between, the flag it would clear belongs to data
   * the pull has never seen, so the clear is refused.
   */
  it('clearPendingLocalChange refuses a mark it was not given', async () => {
    const mark = localChangeMarkNow();
    await db.transactions.add(txRow('typed-later'));
    expect(hasPendingLocalChange()).toBe(true);

    expect(clearPendingLocalChange(mark)).toBe(false);
    expect(hasPendingLocalChange()).toBe(true); // the evidence survives

    expect(clearPendingLocalChange(localChangeMarkNow())).toBe(true);
    expect(hasPendingLocalChange()).toBe(false);
  });

  it('bumpLocalRevision() is the manual door and coalesces with a pending bump', async () => {
    const before = await revisionOf();
    await bumpLocalRevision();
    expect(await revisionOf()).toBe(before + 1);
    await db.transactions.add(txRow('x'));
    await bumpLocalRevision(); // coalesces with the write above
    expect(await revisionOf()).toBe(before + 2);
  });

  it('a device that has never synced is judged by its book, not by the counter', async () => {
    // A brand-new browser that has only seeded its category tree.
    await db.categories.bulkAdd([clone(category)]);
    await flushLocalRevision();
    expect(await hasLocalChanges()).toBe(false); // nothing of the USER'S exists

    // The moment a real book exists it is unsynced — however the counter looks.
    await db.accounts.add(clone(account));
    await flushLocalRevision();
    await updateSettings({ syncSyncedLocalRevision: (await getSettings()).syncLocalRevision });
    expect(await hasLocalChanges()).toBe(true);
  });

  it('once synced, dirtiness is exactly counter-vs-marker', async () => {
    await seedBook(2);
    await markSyncedAt(3);
    expect(await hasLocalChanges()).toBe(false);
    await db.transactions.add(txRow('after'));
    await flushLocalRevision();
    expect(await hasLocalChanges()).toBe(true);
  });

  it('never creates a settings row, and stays inert until sync is set up', async () => {
    await db.settings.clear();
    resetPendingLocalChange();

    await db.transactions.bulkAdd([txRow('t1'), txRow('t2')]);
    await flushLocalRevision();
    // A background counter must not conjure a settings row out of nothing:
    // other code (and other suites) legitimately `settings.add` their own.
    expect(await db.settings.get('app')).toBeUndefined();
    await expect(db.settings.add({ ...defaultSettings(), syncEnabled: false })).resolves.toBe('app');

    // Sync off ⇒ still no writes at all.
    const before = await db.settings.get('app');
    await db.transactions.add(txRow('t3'));
    await flushLocalRevision();
    expect(await db.settings.get('app')).toEqual(before);

    // Switch it on and the counter starts moving.
    await updateSettings({ syncEnabled: true });
    await db.transactions.add(txRow('t4'));
    await flushLocalRevision();
    expect((await getSettings()).syncLocalRevision).toBe(before!.syncLocalRevision + 1);
  });

  it('a bump and a concurrent settings edit cannot swallow each other', async () => {
    // Both directions of the race. A lost bump is the dangerous one: it makes
    // a device with unsynced edits look clean, and clean devices get pulled
    // over. A lost theme is merely rude.
    for (const bumpFirst of [true, false]) {
      await db.settings.clear();
      resetPendingLocalChange();
      await updateSettings({ ...defaultSettings(), syncEnabled: true, theme: 'system' });

      await db.transactions.add(txRow(`race-${String(bumpFirst)}`));
      const bump = flushLocalRevision();
      const edit = updateSettings({ theme: 'dark', baseCurrency: 'JPY' });
      await Promise.all(bumpFirst ? [bump, edit] : [edit, bump]);

      const s = await getSettings();
      expect(s.theme, 'the settings edit survived').toBe('dark');
      expect(s.baseCurrency).toBe('JPY');
      expect(s.syncLocalRevision, 'the change bump survived').toBe(1);
    }
  });
});

// ===========================================================================
describe('syncNow decision table', () => {
  it('not connected ⇒ not-connected, and nothing is read or written', async () => {
    const cloud = new FakeCloud();
    cloud.connected = false;
    await seedBook();
    expect(await syncNow(cloud)).toEqual({ kind: 'not-connected' });
    expect(cloud.metaReads + cloud.reads + cloud.writes).toBe(0);
  });

  it('offline ⇒ offline, and nothing changes on either side', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const cloud = new FakeCloud();
    await seedBook();
    const before = await localDataTables();
    const settingsBefore = await getSettings();

    expect(await syncNow(cloud)).toEqual({ kind: 'offline' });

    expect(cloud.metaReads + cloud.reads + cloud.writes).toBe(0);
    expect(cloud.file).toBeNull();
    expect(await localDataTables()).toEqual(before);
    expect(await getSettings()).toEqual(settingsBefore);
  });

  it('no remote file ⇒ pushes the local book as revision 1', async () => {
    const cloud = new FakeCloud();
    await seedBook(4);

    const outcome = await syncNow(cloud);

    // The outcome names the snapshot this device now descends from, which is
    // what a caller persists as syncLastPulledSnapshotId.
    expect(outcome).toEqual({ kind: 'pushed', revision: 1, snapshotId: cloud.file?.snapshotId });
    expect(cloud.file?.revision).toBe(1);
    expect(cloud.file?.parentSnapshotId).toBeNull(); // the first of a lineage
    expect(cloud.file?.deviceName).toBe('Laptop');
    expect(cloud.file?.app).toBe('MyMoney');
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(1);
    expect(s.syncLastSyncedAt).not.toBeNull();
    expect(await hasLocalChanges()).toBe(false);
  });

  it('nothing moved on either side ⇒ up-to-date, no upload', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud); // seeds revision 1
    const writesAfterFirst = cloud.writes;

    expect(await syncNow(cloud)).toEqual({
      kind: 'up-to-date',
      snapshotId: cloud.file?.snapshotId,
    });
    expect(cloud.writes).toBe(writesAfterFirst);
    expect(cloud.reads).toBe(0); // never downloads the body when it need not
  });

  it('local changed, remote unchanged ⇒ pushes at remote + 1', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud);

    await db.transactions.add(txRow('tx-new', -999));
    await flushLocalRevision();

    const outcome = await syncNow(cloud);
    expect(outcome).toEqual({ kind: 'pushed', revision: 2, snapshotId: cloud.file?.snapshotId });
    expect(cloud.file?.revision).toBe(2);
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    expect(await hasLocalChanges()).toBe(false);
  });

  it('remote moved on, local unchanged ⇒ pulls and applies', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud); // revision 1, both sides agree

    deviceBPushes(cloud, (t) => {
      (t.transactions as unknown[]).push(txRow('tx-from-imac', -4200));
    });

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('pulled');
    if (outcome.kind !== 'pulled') throw new Error('unreachable');
    expect(outcome.revision).toBe(2);
    expect(outcome.counts.transactions).toBe(4);

    expect(await db.transactions.get('tx-from-imac')).toBeTruthy();
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(2);
    expect(await hasLocalChanges()).toBe(false); // applying is not a local edit
  });

  it('a pulled snapshot never steals this device\'s identity or bookkeeping', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await updateSettings({ theme: 'dark', syncClientId: 'my-own-client-id', syncEnabled: true });
    await syncNow(cloud);

    // Device B's settings row: different device, different preferences.
    deviceBPushes(cloud, (t) => {
      t.settings = [
        {
          ...defaultSettings(),
          theme: 'light',
          baseCurrency: 'EUR',
          syncDeviceId: 'device-b',
          syncDeviceName: 'iMac',
          syncClientId: 'their-client-id',
          syncEnabled: false,
          syncLastPulledRevision: 99,
          syncLocalRevision: 77,
          syncSyncedLocalRevision: 77,
        },
      ];
    });

    expect((await syncNow(cloud)).kind).toBe('pulled');

    const s = await getSettings();
    expect(s.baseCurrency).toBe('EUR'); // book-level preference travels
    expect(s.theme).toBe('dark'); // device preference does not
    expect(s.syncDeviceId).toBe('device-a');
    expect(s.syncDeviceName).toBe('Laptop');
    expect(s.syncClientId).toBe('my-own-client-id');
    expect(s.syncEnabled).toBe(true);
    expect(s.syncLastPulledRevision).toBe(2); // ours, not their 99
    expect(s.syncLocalRevision).not.toBe(77);
  });

  it('a fresh browser with only seeded categories pulls the real book cleanly', async () => {
    const cloud = new FakeCloud();
    // The remote holds the owner's real book.
    cloud.file = makeSnapshot(7, {
      accounts: [clone(account)],
      categories: [clone(category)],
      transactions: [txRow('real-1'), txRow('real-2')],
    });
    // This device: never onboarded, but the startup seed already wrote rows.
    await db.categories.bulkAdd([{ ...clone(category), id: 'seeded-cat' }]);
    await flushLocalRevision();

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('pulled');
    expect(await db.transactions.count()).toBe(2);
    expect(await db.categories.get('seeded-cat')).toBeUndefined();
  });

  /**
   * C3/C7. baseCurrency, autoFxEnabled and lastFxSync* travel inside a
   * snapshot but used to leave the counter still, so the device stayed
   * "clean": the change was never uploaded, and the next pull — silent,
   * because a clean device is assumed to have nothing to lose — put the old
   * value back. Every total in the app was then denominated in a currency the
   * user had explicitly changed away from.
   */
  it('a book-level setting is unsynced work: it pushes, and it is never silently reverted', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1, both sides agree
    expect(await hasLocalChanges()).toBe(false);

    // Exactly what AppearanceSection and RatesSection write.
    await updateSettings({ baseCurrency: 'EUR' });
    await updateSettings({ autoFxEnabled: false });
    await flushLocalRevision();
    expect(await hasLocalChanges()).toBe(true);

    const pushed = await syncNow(cloud);
    expect(pushed).toMatchObject({ kind: 'pushed', revision: 2 });
    const remoteSettings = cloud.file!.tables.settings[0] as Settings;
    expect(remoteSettings.baseCurrency).toBe('EUR'); // it actually left the device
    expect(remoteSettings.autoFxEnabled).toBe(false);

    // The other half: with a change of this kind outstanding and the remote
    // moved on, the user is ASKED rather than quietly overruled.
    deviceBPushes(cloud, (t) => {
      t.settings = [{ ...defaultSettings(), baseCurrency: 'GBP' }];
    });
    await updateSettings({ baseCurrency: 'CHF' });
    await flushLocalRevision();

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    expect((await getSettings()).baseCurrency).toBe('CHF'); // still theirs to keep
    expect(savedBackups).toHaveLength(0);
  });

  it('a device holding data it has never pushed is dirty ⇒ conflict, not overwrite', async () => {
    const cloud = new FakeCloud();
    await seedBook(2); // real data, never synced (lastPulledRevision stays 0)
    cloud.file = makeSnapshot(1, { transactions: [txRow('remote-1')] });

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.count()).toBe(2); // untouched
  });
});

// ===========================================================================
// Identity and ancestry — the wipe this rewrite exists to stop.
//
// Every test here fails against the previous engine, which decided by
// comparing revision NUMBERS. The numbers are still there, and are still
// printed; they are simply no longer trusted to answer "is the remote file
// the one my book grew out of?".
// ===========================================================================

describe('a write that lost the race is refused, not recorded', () => {
  /**
   * THE COLLISION. Both devices agree with revision 1. This device is dirty
   * and starts a sync; between its head read and its upload — in production a
   * ~3 MB export plus a ~3 MB upload, i.e. seconds to minutes on a phone — the
   * other device pushes revision 2. The old code PATCHed unconditionally, so
   * this device's book landed *as revision 2 as well*, erasing the other
   * device's push while both sides recorded agreement at 2. Nothing was ever
   * reported: the next sync said 'up-to-date' over two different books, and
   * the pull after that deleted the rows for good.
   */
  it("a push built on a head that has since moved is refused, and the other device's rows survive", async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1 — the common ancestor
    const ancestor = clone(cloud.file)!;

    // This device edits...
    await db.transactions.add(txRow('a-new', -111));
    await flushLocalRevision();
    // ...and the other device lands its own revision 2 inside our window.
    cloud.afterNextMetaRead = () => {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-new', -222)));
    };

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    // The remote still holds the OTHER device's push, untouched.
    const remoteIds = (cloud.file!.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(remoteIds).toContain('b-new');
    expect(remoteIds).not.toContain('a-new');
    expect(cloud.file!.parentSnapshotId).toBe(ancestor.snapshotId);
    // And this device did NOT record agreement with a file it did not write.
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(1);
    expect(await hasLocalChanges()).toBe(true);
    // Nothing of ours was lost either — it is still here, still unsent.
    expect(await db.transactions.get('a-new')).toBeTruthy();
  });

  it('the refused push then surfaces as a conflict, with both sides described', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud);
    await db.transactions.add(txRow('a-new', -111));
    await flushLocalRevision();
    cloud.afterNextMetaRead = () => {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-new', -222)));
    };
    expect((await syncNow(cloud)).kind).toBe('error');

    // Second attempt: the head has moved and we are dirty ⇒ a real conflict,
    // described honestly, with nothing written on either side.
    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.remote.deviceName).toBe('iMac');
    expect(outcome.remote.revision).toBe(2);
    expect(savedBackups).toHaveLength(0);
  });

  /**
   * The other half of rule 1a: the remote accepted our bytes, and something landed
   * on top before we could confirm. The upload "succeeded" — recording that
   * would be the same lie, one step later.
   */
  it('a clobber that lands after the upload is caught by the read-back', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1
    const ancestor = clone(cloud.file)!;
    await db.transactions.add(txRow('a-new', -111));
    await flushLocalRevision();

    // Our write lands, and is immediately overwritten by a device that was
    // working from the same ancestor.
    cloud.duringNextWrite = () => {
      staleWriterPushes(cloud, ancestor, (t) =>
        (t.transactions as unknown[]).push(txRow('c-new', -333)),
      );
    };

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(/not been recorded as backed up|no longer holds/i);
    // The device is still dirty and still at revision 1: it will push again.
    expect(await hasLocalChanges()).toBe(true);
    expect((await getSettings()).syncLastPulledRevision).toBe(1);
  });

  it('a well-behaved sequence still pushes: the precondition is not a blanket refusal', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    expect((await syncNow(cloud)).kind).toBe('pushed');
    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    expect(await syncNow(cloud)).toMatchObject({ kind: 'pushed', revision: 2 });
    expect(cloud.file?.parentSnapshotId).not.toBeNull();
  });
});

describe('deciding by ancestry rather than by revision number', () => {
  /** Sync, threading the snapshot id the way a device with the persisted
   *  field will. Returns the id to carry into the next call. */
  async function syncTracking(
    cloud: FakeCloud,
    lastPulledSnapshotId: string | null,
    opts: { resolve?: 'keep-local' | 'keep-remote' | 'reseed-remote' } = {},
  ): Promise<{ outcome: SyncOutcome; snapshotId: string | null }> {
    const outcome = await syncNow(cloud, { ...opts, lastPulledSnapshotId });
    const carried =
      outcome.kind === 'pushed' || outcome.kind === 'pulled' || outcome.kind === 'up-to-date'
        ? (outcome.snapshotId ?? null)
        : lastPulledSnapshotId;
    return { outcome, snapshotId: carried };
  }

  it('the remote IS what we descend from: clean ⇒ up-to-date, dirty ⇒ push', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    const seeded = await syncTracking(cloud, null);
    expect(seeded.outcome.kind).toBe('pushed');
    expect(seeded.snapshotId).toBe(cloud.file?.snapshotId);

    const clean = await syncTracking(cloud, seeded.snapshotId);
    expect(clean.outcome.kind).toBe('up-to-date');
    expect(clean.snapshotId).toBe(seeded.snapshotId);

    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    const pushed = await syncTracking(cloud, clean.snapshotId);
    expect(pushed.outcome).toMatchObject({ kind: 'pushed', revision: 2 });
    // The new head names the snapshot it grew out of.
    expect(cloud.file?.parentSnapshotId).toBe(seeded.snapshotId);
    expect(pushed.snapshotId).toBe(cloud.file?.snapshotId);
  });

  it('the remote is a CHILD of what we descend from: clean ⇒ fast-forward pull', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    const seeded = await syncTracking(cloud, null);
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));

    const pulled = await syncTracking(cloud, seeded.snapshotId);
    expect(pulled.outcome.kind).toBe('pulled');
    expect(await db.transactions.get('b-1')).toBeTruthy();
    expect(pulled.snapshotId).toBe(cloud.file?.snapshotId);
  });

  it('the remote is a CHILD but we have moved too ⇒ conflict, nothing written', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    const seeded = await syncTracking(cloud, null);
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    const remoteBefore = clone(cloud.file);

    const { outcome } = await syncTracking(cloud, seeded.snapshotId);
    expect(outcome.kind).toBe('conflict');
    expect(cloud.file).toEqual(remoteBefore);
    expect(await db.transactions.get('a-1')).toBeTruthy();
  });

  /**
   * THE C1 WIPE, at the moment it used to happen. This device is CLEAN and the
   * remote's revision is higher than the one it agreed with, which under the
   * old table meant "fast-forward, nothing to lose" — a pull that replaced the
   * whole book. But the remote does not descend from our snapshot: our rows
   * exist nowhere else, and applying it would delete them with no conflict and
   * no safety file. Clean is not the same as safe.
   */
  it('a remote that does NOT descend from ours is a conflict even when this device is clean', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    const seeded = await syncTracking(cloud, null); // our snapshot, revision 1
    await db.transactions.add(txRow('a-only', -4242));
    await flushLocalRevision();
    const pushed = await syncTracking(cloud, seeded.snapshotId); // revision 2, clean
    expect(pushed.outcome.kind).toBe('pushed');
    expect(await hasLocalChanges()).toBe(false);

    // A writer that never saw revision 2 replaces the file at revision 3.
    staleWriterPushes(cloud, cloud.file!, (t) => (t.transactions as unknown[]).push(txRow('c-1')));
    cloud.file = makeSnapshot(3, cloud.file!.tables, { parentSnapshotId: 'some-other-lineage' });

    const localBefore = await localDataTables();
    const { outcome } = await syncTracking(cloud, pushed.snapshotId);

    expect(outcome.kind).toBe('conflict');
    // Nothing was applied: the rows only this device has are still here.
    expect(await localDataTables()).toEqual(localBefore);
    expect(await db.transactions.get('a-only')).toBeTruthy();
    expect(savedBackups).toHaveLength(0);
  });

  /**
   * C16: the file was deleted and re-created, so its revision counter started
   * again at 1 — the same number this device last agreed with, over a
   * completely different book. "Already up to date" was a lie, and if the
   * device had been dirty it would have flattened the new file instead.
   */
  it('a re-created file that happens to share our revision number is a conflict, not "up to date"', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    const seeded = await syncTracking(cloud, null); // revision 1
    expect(await hasLocalChanges()).toBe(false);

    // Someone deleted mymoney-sync.json and another device seeded a new one:
    // same name, same number, unrelated history.
    cloud.file = makeSnapshot(1, { transactions: [txRow('imac-month-1'), txRow('imac-month-2')] });

    const { outcome } = await syncTracking(cloud, seeded.snapshotId);
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.remote.counts.transactions).toBe(2);
    expect(outcome.local.counts.transactions).toBe(2);
    expect(await db.transactions.get('tx-0')).toBeTruthy(); // untouched
  });

  // The feature's whole purpose: open the app on a second device and get the
  // book. That device descends from nothing, so it matches neither ancestry
  // rule, and a rule-by-rule reading would hand it a conflict on its very
  // first sync. What keeps it safe is dirtiness, not ancestry.
  it('a brand-new device pulls an established lineage cleanly', async () => {
    const cloud = new FakeCloud();
    // A remote several pushes into its life — its head names a parent that
    // this device has never heard of.
    const older = makeSnapshot(3, { transactions: [txRow('real-1')] });
    cloud.file = makeSnapshot(4, { transactions: [txRow('real-1'), txRow('real-2')] }, {
      parentSnapshotId: older.snapshotId,
    });

    const { outcome, snapshotId } = await syncTracking(cloud, null);
    expect(outcome.kind).toBe('pulled');
    expect(await db.transactions.count()).toBe(2);
    expect(snapshotId).toBe(cloud.file?.snapshotId);
  });

  it('…but a brand-new device holding real data of its own is still asked first', async () => {
    const cloud = new FakeCloud();
    await seedBook(2); // never synced, real rows ⇒ dirty
    const older = makeSnapshot(3, { transactions: [txRow('real-1')] });
    cloud.file = makeSnapshot(4, { transactions: [txRow('real-1')] }, {
      parentSnapshotId: older.snapshotId,
    });

    const { outcome } = await syncTracking(cloud, null);
    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.get('tx-0')).toBeTruthy();
  });

  it('carries the id forward on every outcome that changes what we descend from', async () => {
    const cloud = new FakeCloud();
    await seedBook(1);
    const pushed = await syncNow(cloud, { lastPulledSnapshotId: null });
    expect(pushed).toMatchObject({ kind: 'pushed', snapshotId: cloud.file?.snapshotId });

    const seededId = cloud.file?.snapshotId ?? null;
    const uptodate = await syncNow(cloud, { lastPulledSnapshotId: seededId });
    expect(uptodate).toEqual({ kind: 'up-to-date', snapshotId: seededId });

    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    const pulled = await syncNow(cloud, { lastPulledSnapshotId: seededId });
    expect(pulled).toMatchObject({ kind: 'pulled', snapshotId: cloud.file?.snapshotId });
  });
});

// ===========================================================================
describe('the snapshot this device descends from is persisted', () => {
  const heldId = async () => (await getSettings()).syncLastPulledSnapshotId;

  it('is recorded by every push and pull, and never taken from a snapshot', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);

    await syncNow(cloud); // push
    expect(await heldId()).toBe(cloud.file?.snapshotId);

    await syncNow(cloud); // up-to-date changes nothing
    expect(await heldId()).toBe(cloud.file?.snapshotId);

    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    expect((await syncNow(cloud)).kind).toBe('pulled');
    expect(await heldId()).toBe(cloud.file?.snapshotId);

    // A snapshot carries the WRITING device's settings row, including the id
    // IT descends from. Taking that would leave this device comparing its book
    // against a file it has never seen and calling it agreement.
    deviceBPushes(cloud, (t) => {
      t.settings = [
        { ...defaultSettings(), syncDeviceId: 'device-b', syncLastPulledSnapshotId: 'their-id' },
      ];
    });
    expect((await syncNow(cloud)).kind).toBe('pulled');
    expect(await heldId()).toBe(cloud.file?.snapshotId);
    expect(await heldId()).not.toBe('their-id');
  });

  /**
   * THE COMMONEST THING TWO DEVICES DO, and the reason a snapshot carries a
   * chain rather than just its parent: the iMac syncs twice (or five times)
   * before the phone syncs at all. The head then names a parent this device
   * has never heard of, and from the head alone "two pushes behind" and "a
   * different lineage" look identical — so without the chain this device would
   * be handed a conflict, every time, on a book that is perfectly in step.
   */
  it('a clean device several pushes behind fast-forwards instead of being asked', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1 — the ancestor we hold

    for (const id of ['b-1', 'b-2', 'b-3', 'b-4']) {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow(id)));
    }
    expect(await hasLocalChanges()).toBe(false);

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('pulled');
    if (outcome.kind !== 'pulled') throw new Error('unreachable');
    expect(outcome.revision).toBe(5);
    expect(await db.transactions.count()).toBe(6);
    expect(savedBackups).toHaveLength(0); // nothing lost a fight
    expect(cloud.reads).toBe(1); // and the body was downloaded exactly once
    expect(await heldId()).toBe(cloud.file?.snapshotId);
    // The chain came with it, so the NEXT push hands it on.
    expect((await getSettings()).syncAncestry).toEqual(cloud.file?.ancestry);
  });

  it('…but a remote that never saw us is still a conflict, however far ahead it is', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1
    const ours = clone(cloud.file)!;
    await db.transactions.add(txRow('a-only', -4242));
    await flushLocalRevision();
    await syncNow(cloud); // revision 2 — rows that exist only here and in the remote
    expect(await hasLocalChanges()).toBe(false);

    // A writer working from revision 1 replaces the file and pushes on twice
    // more. Its chain is long, and our snapshot is nowhere in it.
    staleWriterPushes(cloud, ours, (t) => (t.transactions as unknown[]).push(txRow('c-1')));
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('c-2')));
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('c-3')));

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.get('a-only')).toBeTruthy(); // still only here
    expect(savedBackups).toHaveLength(0);
  });

  it('the chain is bounded, and running off the end asks rather than guesses', async () => {
    const cloud = new FakeCloud();
    await seedBook(1);
    await syncNow(cloud); // revision 1 — the id that will fall off the end

    for (let i = 0; i <= SYNC_ANCESTRY_DEPTH; i++) {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow(`b-${i}`)));
    }
    expect(cloud.file?.ancestry).toHaveLength(SYNC_ANCESTRY_DEPTH);
    expect(cloud.file?.ancestry).not.toContain(await heldId());

    // Safe, not silent: this device cannot prove it is merely behind, so it
    // says so instead of applying a book it cannot vouch for.
    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.get('tx-0')).toBeTruthy();
  });

  /**
   * A REVISION WITH NO ID: what the deleted fallback table used to be for, and
   * what happens to it now (D45, closing D2 and D4).
   *
   * The Drive build really did have devices in this state — they had synced
   * many times under a build that predated ancestry — so the engine kept a
   * second decision table that compared revision NUMBERS, adopted the head's
   * id on the way past, and pulled with the descent check switched off. Both
   * of those were defects (D2, D4) and the state cannot arise on Dropbox: no
   * device has ever synced there, and every path that records an id records
   * the revision with it.
   *
   * The table is deleted rather than repaired, so the state now gets what
   * "cannot prove" means everywhere else in this file — the user is asked.
   * These two tests exist because deleting a fallback is exactly the kind of
   * change that quietly turns a refusal into a silent adoption.
   */
  it('a device with a revision but no id is ASKED, never handed a free pull (D4)', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // revision 1
    await updateSettings({ syncLastPulledSnapshotId: null }); // the state under test
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));

    const outcome = await syncNow(cloud);

    // It is CLEAN and the remote is genuinely ahead, so the old table pulled.
    // With no id there is nothing to check the remote's chain against, and a
    // pull that skips the check is a pull that can delete rows existing
    // nowhere else. It asks instead, and writes nothing on either side.
    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.get('b-1')).toBeUndefined();
    expect(await heldId()).toBeNull();
    expect(await db.transactions.count()).toBe(2);
  });

  it('…and is never told "up to date" over a head it cannot prove it descends from (D2)', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud);
    await updateSettings({ syncLastPulledSnapshotId: null });
    const writesBefore = cloud.writes;

    const outcome = await syncNow(cloud);

    // D2 verbatim: the old table read "same revision number" as agreement and
    // then recorded the head's whole stamp for a device that had proved
    // nothing about it. Nothing is adopted and nothing is written.
    expect(outcome.kind).toBe('conflict');
    expect(await heldId()).toBeNull();
    expect(cloud.writes).toBe(writesBefore);
  });

  it('a device with history and no id still refuses to re-seed a deleted file', async () => {
    // Evidence of history is OR'd, so a null id cannot make a device with 47
    // revisions look brand new (C13).
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud);
    await updateSettings({ syncLastPulledSnapshotId: null });
    cloud.file = null;

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/no longer in your Dropbox/i);
    expect(cloud.file).toBeNull();
  });
});

describe('a sync file that has gone missing is never quietly replaced', () => {
  /**
   * C13/C16. A device with history reads "no file" and used to seed a brand
   * new one at revision 1 — a second lineage, whose numbers every device then
   * compared against the first's as though they were one history. The file is
   * usually not even gone: Dropbox hides deleted files by default, and the screen's
   * own reset instructions send the user through it.
   */
  it('the file is gone but this device had one ⇒ refuses, and writes nothing', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1
    await db.transactions.add(txRow('after-1'));
    await flushLocalRevision();
    await syncNow(cloud); // revision 2
    expect((await getSettings()).syncLastPulledRevision).toBe(2);

    cloud.file = null; // deleted, and not recoverable
    const settingsBefore = await getSettings();
    const localBefore = await localDataTables();

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(/no longer in your Dropbox/i);
    expect(cloud.file).toBeNull(); // NOT re-seeded at revision 1
    expect(await getSettings()).toEqual(settingsBefore);
    expect(await localDataTables()).toEqual(localBefore);
  });

  it('the same device seeds normally when it genuinely has no history', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    expect(await syncNow(cloud)).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(cloud.file?.parentSnapshotId).toBeNull();
  });

  it('re-seeding happens only when the user explicitly asks for it', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud);
    cloud.file = null;
    expect((await syncNow(cloud)).kind).toBe('error');

    const outcome = await syncNow(cloud, { resolve: 'reseed-remote' });
    expect(outcome).toMatchObject({ kind: 'pushed', revision: 1 });
    // `as` rather than an annotation: the local `cloud.file = null` above
    // narrows the property to `null`, which would make the assertions vacuous.
    const reseeded = cloud.file as SyncSnapshot | null;
    expect(reseeded).not.toBeNull();
    expect(reseeded?.parentSnapshotId ?? null).toBeNull();
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
  });

  it('a file deleted in Dropbox is neither written over nor duplicated', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1
    const remoteBefore = clone(cloud.file);
    await db.transactions.add(txRow('later-1'));
    await flushLocalRevision();

    cloud.trashed = true; // the user deleted it in Dropbox

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(/deleted files/i);
    expect(cloud.file).toEqual(remoteBefore); // untouched, still restorable
    expect(cloud.writes).toBe(1); // only the original push
    // Even an explicit re-seed is refused while it sits there: a new file
    // would end up beside the restored one.
    expect((await syncNow(cloud, { resolve: 'reseed-remote' })).kind).toBe('error');
    expect(cloud.file).toEqual(remoteBefore);
  });

  it('a device that never synced is not blocked by a trashed file it has never seen', async () => {
    // It still refuses — the file EXISTS — but it says so rather than starting
    // a second one beside it.
    const cloud = new FakeCloud();
    cloud.file = makeSnapshot(9, { transactions: [txRow('remote-1')] });
    cloud.trashed = true;
    await seedBook(2);

    expect((await syncNow(cloud)).kind).toBe('error');
    expect(cloud.writes).toBe(0);
  });
});

// ===========================================================================
// C2/C5/C6 — a write that lands DURING a sync
//
// `dirty` is decided at the top of syncNow and the app is not blocked, so the
// owner can save a transaction while the head read and the ~3 MB download are
// in flight. Every test here fails against the previous engine, which applied
// the snapshot over the top of that row, cleared the coalesced flag that was
// the only evidence of it, and then recorded the counter as it stood AFTER the
// apply — leaving the device reporting "no unsynced changes" over data that
// existed nowhere at all.
//
// The rule these tests pin down: a write during a sync ends as "your change
// survived, sync again", never as a silent loss.
// ===========================================================================

describe('a write that lands during a sync is never applied over', () => {
  /** Set the remote one clean push ahead of us, so a pull is what happens next. */
  async function cleanDeviceOnePullBehind(): Promise<FakeCloud> {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1 — both sides agree
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-from-imac', -4242)));
    expect(await hasLocalChanges()).toBe(false);
    return cloud;
  }

  const REFUSED = /still here and still unsent/i;

  it('the bump reached disk during the download ⇒ refuses, and keeps the row', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    const remoteBefore = clone(cloud.file);
    cloud.duringNextRead = async () => {
      await db.transactions.add(txRow('typed-during-download', -999));
      await flushLocalRevision(); // the 250 ms timer fired before the apply
    };

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind !== 'error') throw new Error('unreachable');
    expect(outcome.message).toMatch(REFUSED);
    // The row is still here…
    expect(await db.transactions.get('typed-during-download')).toBeTruthy();
    // …nothing of the remote's was applied…
    expect(await db.transactions.get('tx-from-imac')).toBeUndefined();
    expect(cloud.file).toEqual(remoteBefore);
    expect(savedBackups).toHaveLength(0);
    // …the bookkeeping still says revision 1, so the next sync decides afresh…
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(1);
    // …and the device knows it is holding something unsent.
    expect(await hasLocalChanges()).toBe(true);
  });

  it('and the next sync then handles it properly: conflict, resolve, nothing lost', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    cloud.duringNextRead = async () => {
      await db.transactions.add(txRow('typed-during-download', -999));
      await flushLocalRevision();
    };
    expect((await syncNow(cloud)).kind).toBe('error');

    // Both sides really have moved now, and this time the engine says so.
    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.local.counts.transactions).toBe(4);
    expect(outcome.remote.counts.transactions).toBe(4);

    // Answering it keeps both books: the loser is written to a safety file.
    expect((await syncNow(cloud, { resolve: 'keep-local' })).kind).toBe('pushed');
    expect(await db.transactions.get('typed-during-download')).toBeTruthy();
    expect(savedBackups).toHaveLength(1);
    const rescued = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(rescued).toContain('tx-from-imac');
  });

  /**
   * The commoner half, and the one that used to be worst: the 250 ms
   * coalescing timer has NOT fired, so the ONLY evidence of the write is a
   * boolean in memory — which the old code explicitly threw away with an
   * unconditional clearPendingLocalChange().
   */
  it('the bump is still only in memory ⇒ refuses, and does NOT drop the flag', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    cloud.duringNextRead = async () => {
      await db.transactions.add(txRow('typed-during-download', -999));
      // deliberately no flush: still coalescing
      expect(hasPendingLocalChange()).toBe(true);
    };

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(REFUSED);
    expect(await db.transactions.get('typed-during-download')).toBeTruthy();
    // THE FLAG SURVIVED — this is the assertion the old engine could not pass.
    expect(hasPendingLocalChange()).toBe(true);
    await flushLocalRevision();
    expect(await hasLocalChanges()).toBe(true);
  });

  it('an EDIT to an existing row is protected too, not just an insert', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    cloud.duringNextRead = async () => {
      await db.transactions.update('tx-0', { amountMinor: -777_00, notes: 'corrected' });
      await flushLocalRevision();
    };

    expect((await syncNow(cloud)).kind).toBe('error');

    const row = await db.transactions.get('tx-0');
    expect(row?.amountMinor).toBe(-777_00);
    expect(row?.notes).toBe('corrected');
  });

  /**
   * Each of the three checks in assertNothingLandedSince is load-bearing, and
   * these two tests reach the ones the tracker cannot see. A write made in a
   * SECOND TAB of the app raises no flag and moves no counter in THIS tab —
   * `withoutLocalChangeTracking` is how that looks from here.
   */
  it('a bump that only exists on disk (another tab flushed it) still stops the apply', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    cloud.duringNextRead = async () => {
      await withoutLocalChangeTracking(async () => {
        await db.transactions.add(txRow('typed-in-another-tab', -55));
      });
      // …and that tab's flush lands the counter, which is all this tab can see.
      const s = await getSettings();
      await db.settings.update('app', { syncLocalRevision: s.syncLocalRevision + 1 });
    };

    expect((await syncNow(cloud)).kind).toBe('error');
    expect(await db.transactions.get('typed-in-another-tab')).toBeTruthy();
    expect(await db.transactions.get('tx-from-imac')).toBeUndefined();
  });

  it('a never-synced device is judged by its book, and that is re-checked too', async () => {
    // No counter is consulted at all in this regime (hasLocalChanges asks
    // whether the book is pristine), so neither of the other two checks can
    // fire — only the pristine re-check inside the transaction can.
    const cloud = new FakeCloud();
    cloud.file = makeSnapshot(4, {
      accounts: [clone(account)],
      transactions: [txRow('real-1'), txRow('real-2')],
    });
    expect(await hasLocalChanges()).toBe(false); // pristine browser

    cloud.duringNextRead = async () => {
      await withoutLocalChangeTracking(async () => {
        await db.accounts.add({ ...clone(account), id: 'acc-typed-during-sync' });
      });
    };

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(REFUSED);
    expect(await db.accounts.get('acc-typed-during-sync')).toBeTruthy();
    expect(await db.transactions.count()).toBe(0); // the remote was NOT applied
    expect((await getSettings()).syncLastPulledRevision).toBe(0);
  });

  /**
   * The other long window: the user has chosen "keep the copy in Dropbox", the
   * losing local book has been written to a safety file, and the save dialog
   * is sitting open. A row typed NOW is in neither the safety file nor the
   * remote, so applying would destroy it outright.
   */
  it('keep-remote refuses if something is typed after the safety backup was taken', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud);
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-1')));
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    expect((await syncNow(cloud)).kind).toBe('conflict');

    const outcome = await syncNow(cloud, {
      resolve: 'keep-remote',
      saveBackup: async (file, name) => {
        savedBackups.push({ file: clone(file), name });
        // The user adds a transaction while the save dialog is open.
        await db.transactions.add(txRow('typed-in-the-dialog', -12));
        await flushLocalRevision();
        return 'saved';
      },
    });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(REFUSED);
    expect(savedBackups).toHaveLength(1); // the backup WAS written
    expect(await db.transactions.get('typed-in-the-dialog')).toBeTruthy();
    expect(await db.transactions.get('tx-laptop-only')).toBeTruthy(); // nothing applied
    expect(await db.transactions.get('tx-imac-1')).toBeUndefined();
  });

  it('but a change made BEFORE the safety backup is discarded as the user asked', async () => {
    // The control for the test above: keep-remote still works, and everything
    // it discards is in the file it just wrote.
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud);
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-1')));
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(await db.transactions.get('tx-laptop-only')).toBeUndefined();
    const rescued = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(rescued).toContain('tx-laptop-only');
    expect(await hasLocalChanges()).toBe(false);
  });

  it('an undisturbed pull still pulls — the check is not a blanket refusal', async () => {
    const cloud = await cleanDeviceOnePullBehind();
    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('pulled');
    expect(await db.transactions.get('tx-from-imac')).toBeTruthy();
    expect(await hasLocalChanges()).toBe(false);
  });
});

// ===========================================================================
describe('conflict: refuse, describe, and only then act', () => {
  async function bothSidesMoved(): Promise<FakeCloud> {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1
    deviceBPushes(cloud, (t) => {
      (t.transactions as unknown[]).push(txRow('tx-imac-1'), txRow('tx-imac-2'));
    });
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    return cloud;
  }

  it('returns both sides described, and writes NOTHING', async () => {
    const cloud = await bothSidesMoved();
    const localBefore = await localDataTables();
    const remoteBefore = clone(cloud.file);
    const settingsBefore = await getSettings();

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.local.deviceName).toBe('Laptop');
    expect(outcome.remote.deviceName).toBe('iMac');
    expect(outcome.remote.revision).toBe(2);
    expect(outcome.local.counts.transactions).toBe(4); // 3 seeded + 1 new
    expect(outcome.remote.counts.transactions).toBe(5); // 3 pushed + 2 theirs
    expect(outcome.remote.savedAt).toBe(cloud.file?.savedAt);

    // Nothing at all changed: not the book, not the remote, not the bookkeeping.
    expect(await localDataTables()).toEqual(localBefore);
    expect(cloud.file).toEqual(remoteBefore);
    expect(cloud.writes).toBe(1); // just the original push
    expect(await getSettings()).toEqual(settingsBefore);
    expect(savedBackups).toHaveLength(0);
  });

  it('a remote that went BACKWARDS is a conflict too, never a silent rollback', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1
    await db.transactions.add(txRow('tx-4'));
    await flushLocalRevision();
    await syncNow(cloud); // revision 2, local clean
    expect((await getSettings()).syncLastPulledRevision).toBe(2);

    // Someone restores an older file into the remote.
    cloud.file = makeSnapshot(1, { transactions: [txRow('old-1')] });

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.count()).toBe(4); // untouched
  });

  it('keep-local: backs up the losing REMOTE first, then pushes above both', async () => {
    const cloud = await bothSidesMoved();
    expect((await syncNow(cloud)).kind).toBe('conflict');

    const outcome = await syncNow(cloud, { resolve: 'keep-local' });

    expect(outcome).toEqual({ kind: 'pushed', revision: 3, snapshotId: cloud.file?.snapshotId });
    // The safety file holds the side that lost, in normal backup format.
    expect(savedBackups).toHaveLength(1);
    expect(savedBackups[0]!.name).toMatch(/^mymoney-conflict-remote-rev2-\d{4}-\d{2}-\d{2}\.json$/);
    expect(savedBackups[0]!.file.app).toBe('MyMoney');
    const savedIds = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(savedIds).toContain('tx-imac-1');
    expect(savedIds).toContain('tx-imac-2');
    // …and only then was the remote replaced.
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    expect(await db.transactions.get('tx-laptop-only')).toBeTruthy();
  });

  it('keep-remote: backs up the losing LOCAL book first, then applies', async () => {
    const cloud = await bothSidesMoved();
    expect((await syncNow(cloud)).kind).toBe('conflict');

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(savedBackups).toHaveLength(1);
    expect(savedBackups[0]!.name).toMatch(/^mymoney-conflict-local-rev1-/);
    const savedIds = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(savedIds).toContain('tx-laptop-only'); // the change that lost is safe
    // Local now IS the remote.
    expect(await db.transactions.get('tx-laptop-only')).toBeUndefined();
    expect(await db.transactions.get('tx-imac-1')).toBeTruthy();
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    expect(await hasLocalChanges()).toBe(false);
  });

  it('if the safety backup cannot be written, NOTHING is destroyed', async () => {
    const cloud = await bothSidesMoved();
    const localBefore = await localDataTables();
    const remoteBefore = clone(cloud.file);
    setConflictBackupSaver(async () => {
      throw new Error('Disk full');
    });

    const keepRemote = await syncNow(cloud, { resolve: 'keep-remote' });
    expect(keepRemote.kind).toBe('error');
    if (keepRemote.kind !== 'error') throw new Error('unreachable');
    expect(keepRemote.message).toMatch(/Disk full/);
    expect(keepRemote.message).toMatch(/nothing was replaced/i);
    expect(await localDataTables()).toEqual(localBefore);

    const keepLocal = await syncNow(cloud, { resolve: 'keep-local' });
    expect(keepLocal.kind).toBe('error');
    expect(cloud.file).toEqual(remoteBefore);
    expect(await localDataTables()).toEqual(localBefore);
  });

  it('the built-in saver: a cancelled save aborts the resolution', async () => {
    const cloud = await bothSidesMoved();
    const localBefore = await localDataTables();
    setConflictBackupSaver(null); // use the real default

    const abort = Object.assign(new Error('user cancelled'), { name: 'AbortError' });
    stubAnchorDownload();
    vi.stubGlobal('showSaveFilePicker', () => Promise.reject(abort));

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/cancelled/i);
    expect(await localDataTables()).toEqual(localBefore);
  });

  it('the built-in saver: a completed save lets the resolution proceed', async () => {
    const cloud = await bothSidesMoved();
    setConflictBackupSaver(null);

    let written = '';
    let suggested = '';
    vi.stubGlobal('showSaveFilePicker', (opts: { suggestedName: string }) => {
      suggested = opts.suggestedName;
      return Promise.resolve({
        createWritable: async () => ({
          write: async (data: string) => {
            written = data;
          },
          close: async () => {},
        }),
      });
    });
    stubAnchorDownload();

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(suggested).toMatch(/^mymoney-conflict-local-rev1-/);
    const parsed = JSON.parse(written) as BackupFile;
    expect(parsed.app).toBe('MyMoney'); // a normal backup file, restorable as one
    expect((parsed.tables.transactions as { id: string }[]).some((t) => t.id === 'tx-laptop-only'))
      .toBe(true);
  });

  it('a per-call saver overrides the installed one', async () => {
    const cloud = await bothSidesMoved();
    const seen: string[] = [];
    const outcome = await syncNow(cloud, {
      resolve: 'keep-local',
      saveBackup: async (_file, name) => {
        seen.push(name);
        return 'saved';
      },
    });
    expect(outcome.kind).toBe('pushed');
    expect(seen).toEqual([expect.stringMatching(/^mymoney-conflict-remote-rev2-/)]);
    expect(savedBackups).toHaveLength(0); // the installed saver was bypassed
  });

  it('resolve is an answer, not a mode: it does nothing when there is no conflict', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud);
    expect(await syncNow(cloud, { resolve: 'keep-remote' })).toEqual({
      kind: 'up-to-date',
      snapshotId: cloud.file?.snapshotId,
    });
    expect(savedBackups).toHaveLength(0);
  });
});

// ===========================================================================
// C4 — what the destruction is actually gated on
// ===========================================================================
//
// Invariant 3 says the losing copy is kept somewhere restorable BEFORE
// anything is destroyed, and that a failure to keep it abandons the
// resolution. It used to be kept by an <a download>, whose success cannot be
// observed: `a.click()` returns undefined whether the file was written,
// blocked, cancelled, or opened in a preview tab — which is what iOS does with
// a JSON file, on the exact second device this feature exists for. The book
// was then cleared on the strength of that silence.
//
// Now the gate is a write into this device's recovery store, read back after
// it commits. The file is still offered — it is what the owner keeps outside
// the app — but it no longer decides anything on its own.

describe('the losing side is kept where the app can PROVE it is kept', () => {
  /** Both sides have moved: a resolution must now destroy one of them. */
  async function conflicted(): Promise<FakeCloud> {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1 — both sides agree
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-1')));
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    expect((await syncNow(cloud)).kind).toBe('conflict');
    return cloud;
  }

  const idsIn = (file: BackupFile): string[] =>
    (file.tables.transactions as { id: string }[]).map((t) => t.id);

  /** A phone: no file picker, but a share sheet that reports what happened. */
  function stubShareSheet(mode: 'ok' | 'cancelled'): { shared: string[] } {
    const shared: string[] = [];
    vi.stubGlobal('navigator', {
      maxTouchPoints: 5,
      canShare: (d: { files?: unknown[] }) => Array.isArray(d.files) && d.files.length > 0,
      share: async (d: { files?: File[] }) => {
        if (mode === 'cancelled') {
          throw Object.assign(new Error('Share canceled'), { name: 'AbortError' });
        }
        for (const f of d.files ?? []) shared.push(await f.text());
      },
    });
    return { shared };
  }

  it('iPhone/Safari: the silent download is no longer what a book is destroyed on', async () => {
    const cloud = await conflicted();
    setConflictBackupSaver(null); // the real ladder
    stubAnchorDownload(); // no picker, no share sheet ⇒ the rung that says nothing

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(anchorDownloads).toHaveLength(1); // the file was still offered…

    // …and THIS is what made it safe to proceed: a copy on this device that
    // was written, committed, and then read back out again.
    const listed = await listRecoveryRecords();
    expect(listed).toHaveLength(1);
    expect(listed[0]!.reason).toBe('conflict-keep-remote');
    expect(listed[0]!.delivery).toBe('delivered'); // handed over, never proven
    expect(idsIn(await readRecoveryBackup(listed[0]!.id))).toContain('tx-laptop-only');

    // The book really was replaced — this is not a test of a refusal.
    expect(await db.transactions.get('tx-laptop-only')).toBeUndefined();
    expect(await db.transactions.get('tx-imac-1')).toBeTruthy();
  });

  it('a file picker whose WRITE fails does not fall through to a silent download', async () => {
    // Chromium, disk full. The old saver caught this inside its try and used
    // the anchor instead, so the resolution proceeded on a file that was never
    // written. backup.ts always kept write/close outside its try for exactly
    // this reason; there is now only one ladder, so this cannot drift again.
    const cloud = await conflicted();
    const localBefore = await localDataTables();
    const remoteBefore = clone(cloud.file);
    setConflictBackupSaver(null);
    stubAnchorDownload();
    vi.stubGlobal('showSaveFilePicker', () =>
      Promise.resolve({
        createWritable: async () => ({
          write: () =>
            Promise.reject(
              Object.assign(new Error('QuotaExceededError'), { name: 'QuotaExceededError' }),
            ),
          close: async () => {},
        }),
      }),
    );

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/nothing was replaced/i);
    expect(anchorDownloads).toEqual([]); // no silent second attempt
    expect(await localDataTables()).toEqual(localBefore);
    expect(cloud.file).toEqual(remoteBefore);
    expect(await listRecoveryRecords()).toEqual([]);
  });

  it('on a phone the share sheet is used, not the rung that reports nothing', async () => {
    const cloud = await conflicted();
    setConflictBackupSaver(null);
    stubAnchorDownload();
    const { shared } = stubShareSheet('ok');

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(anchorDownloads).toEqual([]); // the share sheet took it
    expect(shared).toHaveLength(1);
    expect(idsIn(JSON.parse(shared[0]!) as BackupFile)).toContain('tx-laptop-only');
    expect((await listRecoveryRecords())[0]!.delivery).toBe('shared');
  });

  it('a cancelled save still stops the resolution', async () => {
    // A cancel is the user saying stop, and it is the one answer the file save
    // can give that means something. It stops BEFORE the recovery copy is
    // written, so a cancelled attempt leaves nothing behind either.
    const cloud = await conflicted();
    const localBefore = await localDataTables();
    setConflictBackupSaver(null);
    stubAnchorDownload();
    stubShareSheet('cancelled');

    const outcome = await syncNow(cloud, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/cancelled/i);
    expect(await localDataTables()).toEqual(localBefore);
    expect(await listRecoveryRecords()).toEqual([]);
  });

  it('if the copy cannot be KEPT on this device, nothing is destroyed', async () => {
    // The gate itself, in both directions. The file saver succeeds throughout,
    // which is the point: a saved file is not enough on its own any more.
    const cloud = await conflicted();
    const localBefore = await localDataTables();
    const remoteBefore = clone(cloud.file);
    vi.spyOn(recoveryDb.bodies, 'put').mockRejectedValue(new Error('QuotaExceededError'));

    const keepRemote = await syncNow(cloud, { resolve: 'keep-remote' });
    expect(keepRemote.kind).toBe('error');
    if (keepRemote.kind === 'error') {
      expect(keepRemote.message).toMatch(/Quota/);
      expect(keepRemote.message).toMatch(/nothing was replaced/i);
    }
    expect(await localDataTables()).toEqual(localBefore);

    const keepLocal = await syncNow(cloud, { resolve: 'keep-local' });
    expect(keepLocal.kind).toBe('error');
    expect(cloud.file).toEqual(remoteBefore);
    expect(await localDataTables()).toEqual(localBefore);

    expect(savedBackups).toHaveLength(2); // the FILE was saved both times
    expect(await listRecoveryRecords()).toEqual([]);
  });

  it('a saver that reports nothing decides nothing', async () => {
    // The exact shape of the defect: a save function that returns whether or
    // not a byte reached disk. It is still allowed to say nothing — it just no
    // longer authorises anything.
    const cloud = await conflicted();

    const outcome = await syncNow(cloud, {
      resolve: 'keep-remote',
      saveBackup: async () => undefined as unknown as BackupSaveResult,
    });

    expect(outcome.kind).toBe('pulled');
    const [record] = await listRecoveryRecords();
    expect(record!.delivery).toBe('delivered'); // read as unproven, never as saved
    expect(idsIn(await readRecoveryBackup(record!.id))).toContain('tx-laptop-only');
  });

  it('keep-local keeps the copy that was in Dropbox', async () => {
    const cloud = await conflicted();

    const outcome = await syncNow(cloud, { resolve: 'keep-local' });

    expect(outcome.kind).toBe('pushed');
    const [record] = await listRecoveryRecords();
    expect(record!.reason).toBe('conflict-keep-local');
    expect(record!.label).toMatch(/Dropbox/);
    expect(record!.fileName).toMatch(/^mymoney-conflict-remote-rev2-/);
    expect(idsIn(await readRecoveryBackup(record!.id))).toContain('tx-imac-1');
  });

  it('the kept copy brings the book back — and not the other device with it', async () => {
    const cloud = await conflicted();
    const bookBefore = await localDataTables();

    expect((await syncNow(cloud, { resolve: 'keep-remote' })).kind).toBe('pulled');
    const afterPull = await getSettings();
    expect(await db.transactions.get('tx-laptop-only')).toBeUndefined();

    // The user changes their mind and restores the copy that was kept for
    // them. It is a normal backup file and goes through the normal restore.
    const [record] = await listRecoveryRecords();
    await restoreRecoveryBackup(record!.id);

    expect(await localDataTables()).toEqual(bookBefore);
    // C8: the copy carries the settings row as it was BEFORE the pull, and
    // none of its device-local half may come back with it — including the sync
    // bookkeeping, which now describes revision 2. Restoring a book is not
    // rewinding this device's memory of what it has agreed with.
    const after = await getSettings();
    expect(after.syncDeviceId).toBe('device-a');
    expect(after.syncDeviceName).toBe('Laptop');
    expect(after.syncLastPulledRevision).toBe(afterPull.syncLastPulledRevision);
    expect(after.syncLastPulledSnapshotId).toBe(afterPull.syncLastPulledSnapshotId);

    // …so the next sync is a clean push of the restored book, not a conflict
    // and not a silent re-pull: the device is dirty, and it descends from the
    // head it actually read.
    const next = await syncNow(cloud);
    expect(next.kind).toBe('pushed');
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
  });

  it('repeated conflicts cannot fill the device up', async () => {
    const cloud = await conflicted();
    for (let i = 0; i < RECOVERY_KEEP + 2; i++) {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow(`tx-imac-${i + 2}`)));
      await db.transactions.add(txRow(`tx-laptop-${i}`, -100 - i));
      await flushLocalRevision();
      expect((await syncNow(cloud, { resolve: 'keep-remote' })).kind).toBe('pulled');
    }
    const listed = await listRecoveryRecords();
    expect(listed).toHaveLength(RECOVERY_KEEP);
    // The newest is the one from the LAST resolution — the pruning never eats
    // the copy that was just made.
    expect(idsIn(await readRecoveryBackup(listed[0]!.id))).toContain(
      `tx-laptop-${RECOVERY_KEEP + 1}`,
    );
  });
});

// ===========================================================================
describe('refusing bad remote data', () => {
  const localUntouched = async (before: Record<string, unknown[]>) => {
    expect(await localDataTables()).toEqual(before);
  };

  it('garbage in the sync file is refused without touching local data', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud);
    const before = await localDataTables();

    const garbage: unknown[] = [
      null,
      'not a snapshot',
      { app: 'SomethingElse', revision: 2, tables: {} },
      { ...makeSnapshot(2, {}), tables: { accounts: 'nope' } },
      { ...makeSnapshot(2, {}), revision: 0 },
      { ...makeSnapshot(2, {}), savedAt: 12345 },
      { ...makeSnapshot(2, {}), tables: { ...emptyTables(), transactions: [{ noId: true }] } },
      { ...makeSnapshot(2, {}), deviceName: undefined },
    ];

    for (const bad of garbage) {
      cloud.file = bad as SyncSnapshot;
      // The meta head still claims a newer revision, so the engine tries.
      cloud.metaReads = 0;
      const outcome = await syncNow({
        ...cloud,
        isConnected: () => true,
        readRemoteMeta: async () => ({
          revision: 2,
          savedAt: T0,
          deviceName: 'iMac',
          snapshotId: null,
          parentSnapshotId: null,
        }),
        readRemote: async () => clone(bad) as SyncSnapshot,
        writeRemote: async () => {
          throw new Error('must not write');
        },
        connect: async () => {},
        disconnect: async () => {},
      });
      expect(outcome.kind, `garbage: ${JSON.stringify(bad)?.slice(0, 60)}`).toBe('error');
      if (outcome.kind === 'error') expect(outcome.message).toMatch(/nothing/i);
      await localUntouched(before);
    }
  });

  it('a snapshot from a NEWER build is refused, by syncNow and by applyRemote', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud);
    const before = await localDataTables();

    const future = makeSnapshot(2, { transactions: [txRow('future-1')] }, {
      schemaVersion: SCHEMA_VERSION + 1,
    });
    cloud.file = future;

    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/newer version/i);
    await localUntouched(before);

    await expect(applyRemote(future)).rejects.toThrow(/newer version/i);
    await localUntouched(before);
  });

  it('a remote head with a nonsense revision is refused', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    cloud.file = makeSnapshot(1, {});
    const bad = { ...cloud, isConnected: () => true, readRemoteMeta: async () => ({ revision: -3, savedAt: T0, deviceName: 'x' }) } as unknown as SyncTransport;
    const outcome = await syncNow(bad);
    expect(outcome.kind).toBe('error');
  });

  it('transport failures surface as outcomes, never as thrown errors', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    cloud.failMetaWith = new Error('Dropbox said no');
    let outcome = await syncNow(cloud);
    expect(outcome).toEqual({
      kind: 'error',
      message: 'Could not read the sync file: Dropbox said no',
    });

    // A transport that reports its own typed reasons is understood.
    cloud.failMetaWith = Object.assign(new Error("You're offline"), {
      name: 'SyncTransportError',
      kind: 'offline',
    });
    expect(await syncNow(cloud)).toEqual({ kind: 'offline' });

    cloud.failMetaWith = Object.assign(new Error('Not connected'), {
      name: 'SyncTransportError',
      kind: 'not-connected',
    });
    expect(await syncNow(cloud)).toEqual({ kind: 'not-connected' });

    // A failed upload leaves the bookkeeping alone so the next try repeats it.
    cloud.failMetaWith = null;
    cloud.failWriteWith = new Error('upload failed');
    outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('error');
    expect((await getSettings()).syncLastPulledRevision).toBe(0);
    expect(await hasLocalChanges()).toBe(true);
  });

  it('a sync file that vanishes between head and body is an error, not a wipe', async () => {
    const cloud = new FakeCloud();
    await seedBook();
    await syncNow(cloud);
    const before = await localDataTables();
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('theirs')));
    const vanishing = {
      ...cloud,
      isConnected: () => true,
      readRemoteMeta: async () => ({ revision: 2, savedAt: T0, deviceName: 'iMac' }),
      readRemote: async () => null,
      connect: async () => {},
      disconnect: async () => {},
      writeRemote: async () => {},
    } as unknown as SyncTransport;

    const outcome = await syncNow(vanishing);
    expect(outcome.kind).toBe('error');
    await localUntouched(before);
  });
});

// ===========================================================================
describe('applyRemote', () => {
  it('is all-or-nothing: a failure part-way leaves the original book intact', async () => {
    await seedBook(3);
    const before = await localDataTables();
    const settingsBefore = await getSettings();

    // Valid shape, fatal content: the same primary key twice. Only bulkAdd can
    // catch this, i.e. after the tables have already been cleared.
    const rows = [txRow('dup-1'), txRow('dup-2'), txRow('dup-1')];
    const snap = makeSnapshot(5, { transactions: rows, accounts: [clone(account)] });
    expect(validateSnapshot(snap).ok).toBe(true);

    await expect(applyRemote(snap)).rejects.toThrow();

    expect(await localDataTables()).toEqual(before);
    expect(await getSettings()).toEqual(settingsBefore);
  });

  it('a failed apply inside syncNow reports an error and changes nothing', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud);
    const before = await localDataTables();

    // A legitimate child of what we pushed — so the engine agrees to pull it —
    // whose rows are fatal: the same primary key twice.
    deviceBPushes(cloud, (t) => {
      t.transactions = [txRow('d'), txRow('d')];
    });
    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/nothing on this device/i);
    expect(await localDataTables()).toEqual(before);
    expect((await getSettings()).syncLastPulledRevision).toBe(1);
  });

  it('applying does not mark the device as locally changed', async () => {
    await seedBook(2);
    await markSyncedAt(4);
    const revisionBefore = (await getSettings()).syncLocalRevision;

    await applyRemote(makeSnapshot(5, { transactions: [txRow('r1'), txRow('r2'), txRow('r3')] }));

    expect(await db.transactions.count()).toBe(3);
    expect((await getSettings()).syncLocalRevision).toBe(revisionBefore);
    expect(await hasLocalChanges()).toBe(false);
  });

  it('mergeSettingsRow keeps every device-local key on this side', () => {
    const local = { ...defaultSettings(), theme: 'dark' as const, syncDeviceId: 'me', createdAt: T0 };
    const remote = {
      ...defaultSettings(),
      theme: 'light' as const,
      baseCurrency: 'USD',
      syncDeviceId: 'them',
      createdAt: '2020-01-01T00:00:00.000Z',
      savedMappings: { theirSig: {} as never },
    };
    const merged = mergeSettingsRow(local, remote);
    for (const key of DEVICE_LOCAL_SETTING_KEYS) {
      expect(merged[key], `${key} must stay local`).toEqual(local[key]);
    }
    expect(merged.baseCurrency).toBe('USD');
    expect(merged.savedMappings).toHaveProperty('theirSig');
    expect(merged.id).toBe('app');
    expect(merged.schemaVersion).toBe(SCHEMA_VERSION);
  });

  it('onboarding is a one-way door across devices', () => {
    const local = { ...defaultSettings(), onboarded: false };
    const remote = { ...defaultSettings(), onboarded: true };
    expect(mergeSettingsRow(local, remote).onboarded).toBe(true);
    expect(mergeSettingsRow({ ...local, onboarded: true }, { ...remote, onboarded: false }).onboarded).toBe(true);
  });
});

// ===========================================================================
describe('localSnapshot', () => {
  it('carries every table and stamps this device', async () => {
    await seedBook(2);
    const snap = await localSnapshot(9);
    expect(snap.app).toBe('MyMoney');
    expect(snap.revision).toBe(9);
    expect(snap.deviceId).toBe('device-a');
    expect(snap.deviceName).toBe('Laptop');
    expect(Object.keys(snap.tables).sort()).toEqual([...ALL_TABLES].sort());
    expect(validateSnapshot(snap).ok).toBe(true);
    expect(snapshotCounts(snap.tables).transactions).toBe(2);
  });

  it('moves amounts verbatim — integer minor units, never re-computed', async () => {
    await db.accounts.add(clone(account));
    const odd = [-1, 1, -999_999_999, 2_147_483_647, 0, -70];
    await db.transactions.bulkAdd(odd.map((amount, i) => txRow(`m-${i}`, amount)));

    const snap = await localSnapshot(1);
    const roundTripped = JSON.parse(JSON.stringify(snap)) as SyncSnapshot;
    await applyRemote(roundTripped);

    const after = (await db.transactions.toArray()).sort((a, b) => a.id.localeCompare(b.id));
    expect(after.map((t) => t.amountMinor)).toEqual(odd);
    for (const t of after) expect(Number.isInteger(t.amountMinor)).toBe(true);
  });

  it('defaults its revision to the last one this device agreed with', async () => {
    await seedBook(1);
    await markSyncedAt(6);
    expect((await localSnapshot()).revision).toBe(6);
  });
});

// ===========================================================================
describe('two devices alternating cleanly', () => {
  it('never conflicts, and every revision is exactly one more than the last', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);

    const revisions: number[] = [];
    const record = (o: SyncOutcome) => {
      expect(o.kind === 'pushed' || o.kind === 'pulled' || o.kind === 'up-to-date').toBe(true);
      if (o.kind === 'pushed' || o.kind === 'pulled') revisions.push(o.revision);
    };

    record(await syncNow(cloud)); // A pushes 1
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    record(await syncNow(cloud)); // A pulls 2
    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    record(await syncNow(cloud)); // A pushes 3
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-2')));
    record(await syncNow(cloud)); // A pulls 4
    await db.transactions.delete('tx-0');
    await flushLocalRevision();
    record(await syncNow(cloud)); // A pushes 5
    record(await syncNow(cloud)); // up-to-date

    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
    const ids = (await db.transactions.toArray()).map((t) => t.id).sort();
    expect(ids).toEqual(['a-1', 'b-1', 'b-2', 'tx-1']);
    expect(savedBackups).toHaveLength(0); // nothing ever lost a fight
  });

  it('reports a truthful state for the UI', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    let state = await getSyncState(cloud);
    expect(state.connected).toBe(true);
    expect(state.lastSyncedAt).toBeNull();
    expect(state.hasLocalChanges).toBe(true);

    await syncNow(cloud);
    state = await getSyncState(cloud);
    expect(state.lastPulledRevision).toBe(1);
    expect(state.remoteRevision).toBe(1);
    expect(state.hasLocalChanges).toBe(false);
    expect(state.deviceId).toBe('device-a');

    await db.transactions.add(txRow('later'));
    await flushLocalRevision();
    expect((await getSyncState(cloud)).hasLocalChanges).toBe(true);
  });
});

// ===========================================================================
// The one that matters most.
// ===========================================================================

/** Deterministic PRNG (mulberry32) — a failing seed is always reproducible. */
function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

describe('property: the two sides never silently diverge', () => {
  it('holds over a randomised sequence of edits, remote writes and syncs', async () => {
    const rng = mulberry32(20260827);
    const cloud = new FakeCloud();
    await seedBook(2); // real data, never pushed ⇒ genuinely dirty

    const everCreated = new Set<string>(['tx-0', 'tx-1']);
    const rescued = new Set<string>(); // ids written to a conflict safety file
    setConflictBackupSaver(async (file, name) => {
      savedBackups.push({ file: clone(file), name });
      for (const row of file.tables.transactions as { id: string }[]) rescued.add(row.id);
      return 'saved';
    });

    let counter = 0;
    let conflicts = 0;
    let pushes = 0;
    let pulls = 0;

    for (let step = 0; step < 120; step++) {
      const roll = rng();

      if (roll < 0.3) {
        // ---- a local edit
        const id = `a-${counter++}`;
        await db.transactions.add(txRow(id, -(1 + counter)));
        everCreated.add(id);
        if (rng() < 0.5) await flushLocalRevision(); // sometimes still coalescing
      } else if (roll < 0.5) {
        // ---- the other device, which always syncs cleanly, pushes
        const id = `b-${counter++}`;
        deviceBPushes(cloud, (t) => {
          (t.transactions as unknown[]).push(txRow(id, -(1 + counter)));
        });
        everCreated.add(id);
      } else {
        // ---- a sync
        const localBefore = await localDataTables();
        const remoteBefore = clone(cloud.file);
        const dirtyBefore = await (async () => {
          await flushLocalRevision();
          return hasLocalChanges();
        })();
        const remoteRevBefore = cloud.file?.revision ?? 0;
        const backupsAtStepStart = savedBackups.length;

        let outcome = await syncNow(cloud);

        if (outcome.kind === 'conflict') {
          conflicts++;
          // A conflict must change absolutely nothing.
          expect(await localDataTables()).toEqual(localBefore);
          expect(cloud.file).toEqual(remoteBefore);
          expect(outcome.local.counts.transactions).toBe(
            (localBefore.transactions as unknown[]).length,
          );
          expect(outcome.remote.counts.transactions).toBe(
            ((remoteBefore?.tables.transactions ?? []) as unknown[]).length,
          );
          // Now answer it, the way a user would.
          const resolve = rng() < 0.5 ? 'keep-local' : 'keep-remote';
          const backupsBefore = savedBackups.length;
          outcome = await syncNow(cloud, { resolve });
          // Whatever happened, the loser was written out first.
          expect(savedBackups.length).toBe(backupsBefore + 1);
          expect(savedBackups.at(-1)!.name).toContain(
            resolve === 'keep-local' ? 'conflict-remote' : 'conflict-local',
          );
        }

        switch (outcome.kind) {
          case 'up-to-date':
            // THE INVARIANT: "nothing to do" must mean the two sides agree.
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            expect(cloud.file).toEqual(remoteBefore);
            break;
          case 'pushed':
            pushes++;
            expect(outcome.revision).toBeGreaterThan(remoteRevBefore);
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            expect(await hasLocalChanges()).toBe(false);
            break;
          case 'pulled':
            pulls++;
            // A pull may only ever run over a device with nothing to lose —
            // unless the user explicitly chose to discard, in which case the
            // discarded side is in a safety file (asserted above).
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            expect(await hasLocalChanges()).toBe(false);
            break;
          default:
            throw new Error(`unexpected outcome ${outcome.kind}`);
        }

        // A pull that was NOT the answer to a conflict may only ever run over a
        // device with nothing to lose. (After a resolution the user has
        // explicitly chosen to discard, and the discarded side is in a file.)
        if (outcome.kind === 'pulled' && savedBackups.length === backupsAtStepStart) {
          expect(dirtyBefore, `silent pull over unsynced local changes at step ${step}`).toBe(false);
        }
      }

      // ---- after EVERY step: no transaction has ever simply vanished.
      const localIds = new Set((await db.transactions.toArray()).map((t) => t.id));
      const remoteIds = new Set(
        ((cloud.file?.tables.transactions ?? []) as { id: string }[]).map((t) => t.id),
      );
      for (const id of everCreated) {
        const safe = localIds.has(id) || remoteIds.has(id) || rescued.has(id);
        expect(safe, `transaction ${id} vanished at step ${step}`).toBe(true);
      }
    }

    // The run has to have actually exercised the interesting paths.
    expect(conflicts).toBeGreaterThan(0);
    expect(pushes).toBeGreaterThan(0);
    expect(pulls).toBeGreaterThan(0);
  }, 60_000);
});

// ===========================================================================
// The same property, run against a remote that a rule-breaking writer keeps
// interfering with — the case the first property test structurally cannot
// reach, because its only other device always writes off the CURRENT file.
// ===========================================================================

describe('property: ancestry holds even when someone writes off a stale head', () => {
  it('never fast-forwards over a remote that does not descend from this device', async () => {
    const rng = mulberry32(20260828);
    const cloud = new FakeCloud();
    await seedBook(2);

    const everCreated = new Set<string>(['tx-0', 'tx-1']);
    const rescued = new Set<string>();
    setConflictBackupSaver(async (file, name) => {
      savedBackups.push({ file: clone(file), name });
      for (const row of file.tables.transactions as { id: string }[]) rescued.add(row.id);
      return 'saved';
    });

    // What a device with the persisted field will hold; threaded by hand until
    // it exists (see SyncOptions.lastPulledSnapshotId).
    let pulledSnapshotId: string | null = null;
    /** Snapshots that HAVE been the head — the stale writer picks from these. */
    const history: SyncSnapshot[] = [];
    let counter = 0;
    let conflicts = 0;
    let pulls = 0;
    let staleWrites = 0;

    const remember = () => {
      if (cloud.file) history.push(clone(cloud.file));
    };

    for (let step = 0; step < 120; step++) {
      const roll = rng();

      if (roll < 0.25) {
        const id = `a-${counter++}`;
        await db.transactions.add(txRow(id, -(1 + counter)));
        everCreated.add(id);
        if (rng() < 0.5) await flushLocalRevision();
      } else if (roll < 0.45) {
        const id = `b-${counter++}`;
        deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow(id, -(1 + counter))));
        everCreated.add(id);
        remember();
      } else if (roll < 0.55 && history.length > 0) {
        // A writer that did not honour the precondition: same file, new
        // contents, ancestry pointing at something that is no longer the head.
        // It destroys nothing (it keeps every row already there); it only
        // breaks the chain, which is exactly what must not go unnoticed.
        const stale = history[Math.floor(rng() * history.length)]!;
        const id = `c-${counter++}`;
        staleWriterPushes(cloud, stale, (t) =>
          (t.transactions as unknown[]).push(txRow(id, -(1 + counter))),
        );
        everCreated.add(id);
        staleWrites++;
        remember();
      } else {
        const localBefore = await localDataTables();
        const remoteBefore = clone(cloud.file);
        const heldBefore = pulledSnapshotId;
        const dirtyBefore = await (async () => {
          await flushLocalRevision();
          return hasLocalChanges();
        })();
        const backupsAtStepStart = savedBackups.length;

        let outcome = await syncNow(cloud, { lastPulledSnapshotId: pulledSnapshotId });

        if (outcome.kind === 'conflict') {
          conflicts++;
          expect(await localDataTables()).toEqual(localBefore);
          expect(cloud.file).toEqual(remoteBefore);
          const resolve = rng() < 0.5 ? 'keep-local' : 'keep-remote';
          outcome = await syncNow(cloud, { resolve, lastPulledSnapshotId: pulledSnapshotId });
          expect(savedBackups.length).toBeGreaterThan(backupsAtStepStart);
        }

        switch (outcome.kind) {
          case 'up-to-date':
            // "Nothing to do" must mean the two sides really are the same
            // book — the claim that used to be made on the strength of a
            // matching revision number over completely different data.
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            expect(cloud.file?.snapshotId).toBe(pulledSnapshotId);
            break;
          case 'pushed':
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            expect(await hasLocalChanges()).toBe(false);
            break;
          case 'pulled':
            pulls++;
            expect(snapshotDataTables(cloud.file)).toEqual(await localDataTables());
            // A pull nobody was asked about is only ever a TRUE fast-forward:
            // this device had nothing unsent, and what it applied grew
            // directly out of what it already had.
            if (savedBackups.length === backupsAtStepStart) {
              expect(dirtyBefore, `silent pull over unsynced changes at step ${step}`).toBe(false);
              const descendsFromUs =
                heldBefore !== null &&
                ((remoteBefore?.parentSnapshotId ?? null) === heldBefore ||
                  (remoteBefore?.ancestry ?? []).includes(heldBefore));
              expect(
                heldBefore === null || descendsFromUs,
                `silent pull from a remote that does not descend from us at step ${step}`,
              ).toBe(true);
            }
            break;
          case 'error':
            // Only ever a refusal that changed nothing.
            expect(await localDataTables()).toEqual(localBefore);
            expect(cloud.file).toEqual(remoteBefore);
            break;
          default:
            throw new Error(`unexpected outcome ${outcome.kind}`);
        }

        if (outcome.kind === 'pushed' || outcome.kind === 'pulled' || outcome.kind === 'up-to-date') {
          pulledSnapshotId = outcome.snapshotId ?? null;
        }
        remember();
      }

      const localIds = new Set((await db.transactions.toArray()).map((t) => t.id));
      const remoteIds = new Set(
        ((cloud.file?.tables.transactions ?? []) as { id: string }[]).map((t) => t.id),
      );
      for (const id of everCreated) {
        const safe = localIds.has(id) || remoteIds.has(id) || rescued.has(id);
        expect(safe, `transaction ${id} vanished at step ${step}`).toBe(true);
      }
    }

    expect(staleWrites).toBeGreaterThan(0);
    expect(conflicts).toBeGreaterThan(0);
    expect(pulls).toBeGreaterThan(0);
  }, 60_000);
});

// ===========================================================================
describe('an answer to one question is not an answer to another', () => {
  // 'reseed-remote' means "the file is gone, start a new one". Arriving at a
  // real two-sided conflict it must count as NO answer: falling through to the
  // keep-local branch would overwrite a remote the user was never shown, and
  // without the safety copy that branch is built around.
  it('reseed-remote does not resolve a conflict', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // revision 1
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    const remoteBefore = clone(cloud.file);

    const outcome = await syncNow(cloud, { resolve: 'reseed-remote' });

    expect(outcome.kind).toBe('conflict');
    expect(cloud.file).toEqual(remoteBefore);
    expect(savedBackups).toHaveLength(0);
  });
});

// ===========================================================================
// D1–D4 — the four defects the Drive design left open, closed by the
// separation rather than by four more guards (D45)
// ===========================================================================
//
// src/sync/held.ts is the record of why sync was stopped: three rounds of
// review, each fix opening the next hole, all of it downstream of TWO FIELDS
// EACH DOING TWO JOBS. On Dropbox the two jobs separate — `rev` is the
// transport's compare-and-swap token, `snapshotId`/`parentSnapshotId`/
// `ancestry` are causal identity inside the body — and these four tests pin
// the consequences.
//
// Each one was written to FAIL against the previous engine. The exact failures
// are recorded in the commit message for this change.
describe('D1–D4, closed', () => {
  /**
   * D1. keep-local used to declare `ctx.head.snapshotId` — the id the FILE
   * REPORTED ABOUT ITSELF at the top of the sync — as the parent of the
   * snapshot it then uploaded, and `localSnapshot` mints that same id into
   * `ancestry`. Every other device reads an ancestry entry as proof of
   * descent, so the resolution published a lineage claim about a snapshot
   * nobody here had looked inside.
   *
   * The head read and the body download are two different moments. This test
   * puts a third device's write in between them, which is the ordinary way
   * they come apart, and asserts that what the push names is the body it
   * actually replaced — the one it described and wrote to a safety file.
   */
  it('D1: keep-local names the body it replaced, never the id the head claimed', async () => {
    const cloud = new FakeCloud();
    await seedBook(3);
    await syncNow(cloud); // S1, ours
    const s1 = cloud.file!.snapshotId!;
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-1')));
    const s2 = cloud.file!.snapshotId!;
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    expect((await syncNow(cloud)).kind).toBe('conflict');

    // A THIRD write lands between the head read and the download, so the head
    // says S2 and the bytes that arrive are S3.
    cloud.afterNextMetaRead = () => {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-2')));
    };

    const outcome = await syncNow(cloud, { resolve: 'keep-local' });
    const s3 = (cloud.file!.ancestry ?? [])[0];

    expect(outcome.kind).toBe('pushed');
    // The parent is the snapshot whose CONTENTS this device read, and the
    // chain behind it is that body's own chain — one lineage, from one set of
    // bytes. The old code named S2 here and produced the chain [S2, S2, S1],
    // in which the snapshot it actually destroyed does not appear at all.
    expect(cloud.file!.parentSnapshotId).toBe(s3);
    expect(cloud.file!.ancestry).toEqual([s3, s2, s1]);
    expect(cloud.file!.ancestry).not.toContain(undefined);

    // …and the safety copy holds THAT body — the rows that were destroyed, not
    // the rows the head claimed were there.
    const [record] = await listRecoveryRecords();
    expect(record!.reason).toBe('conflict-keep-local');
    const kept = (await readRecoveryBackup(record!.id)).tables.transactions as { id: string }[];
    expect(kept.map((t) => t.id)).toContain('tx-imac-2');
  });

  /**
   * …AND THE ENGINE DOES NOT LEAN ON THE TRANSPORT TO CATCH IT.
   *
   * Dropbox's compare-and-swap refuses a write whose parent is no longer the
   * head, so the test above ends in a refusal rather than a lie landing in the
   * file — the defect is caught, just not by the code that committed it. That
   * is not the standard here: the Drive transport had no such precondition,
   * the next one might not either, and a lineage claim is something this
   * engine publishes about ITSELF.
   *
   * So the same scenario, against a remote that accepts whatever it is given.
   * What the pushed snapshot claims is then the engine's word alone.
   */
  it('D1: …and does not lean on the transport to catch it', async () => {
    const cloud = new NoPreconditionCloud();
    await seedBook(3);
    await syncNow(cloud);
    const s1 = cloud.file!.snapshotId!;
    deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-1')));
    const s2 = cloud.file!.snapshotId!;
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    expect((await syncNow(cloud)).kind).toBe('conflict');

    let s3 = '';
    cloud.afterNextMetaRead = () => {
      deviceBPushes(cloud, (t) => (t.transactions as unknown[]).push(txRow('tx-imac-2')));
      s3 = cloud.file!.snapshotId!;
    };

    expect((await syncNow(cloud, { resolve: 'keep-local' })).kind).toBe('pushed');

    // The chain published to every other device names the snapshot this
    // resolution actually replaced. Naming the head's claim instead produced
    // [S2, S2, S1]: the destroyed snapshot missing, an id duplicated, and a
    // descent claim about bytes nobody here had read.
    expect(cloud.file!.parentSnapshotId).toBe(s3);
    expect(cloud.file!.ancestry).toEqual([s3, s2, s1]);
  });

  /**
   * D2. `upToDate()` used to write a whole stamp — id, revision, savedAt,
   * deviceId — straight off `readRemoteMeta`, for a device that had proved
   * nothing about that head. It was reachable through the revision-number
   * fallback: a clean device whose recorded NUMBER matched was told it agreed,
   * and then recorded which file it supposedly agreed with.
   *
   * Both halves are gone. There is no fallback, so a device that cannot name
   * what it descends from is asked; and agreeing writes nothing at all, so
   * there is no id to adopt off a head read in the first place.
   */
  it('D2: agreeing with the head adopts nothing and writes nothing', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud);
    const before = await getSettings();

    expect((await syncNow(cloud)).kind).toBe('up-to-date');
    expect(await getSettings()).toEqual(before);

    // And the door it came through is shut: a device with a matching revision
    // number but no id of its own is asked, never told it agrees.
    await updateSettings({ syncLastPulledSnapshotId: null });
    const outcome = await syncNow(cloud);
    expect(outcome.kind).toBe('conflict');
    expect((await getSettings()).syncLastPulledSnapshotId).toBeNull();
  });

  /**
   * D3. A keep-remote resolution could apply a body with no identity, leaving
   * this device with `syncLastPulledSnapshotId: null` and a revision above
   * zero — the fallback's home ground — from where its next push minted the
   * same unprovable claim as D1.
   *
   * Identity is now required at three separate points, and this test names all
   * three, because the guarantee must not rest on any one of them: the
   * transport refuses such a body at the door, `validateSnapshot` refuses it
   * before a row is written, and the decision table refuses to compare a head
   * that has no identity against a device that has none either.
   */
  const namelessSnapshot = () =>
    makeSnapshot(2, { transactions: [txRow('remote-1')] }, { snapshotId: undefined });

  it('D3: a body with no identity fails validation', async () => {
    const checked = validateSnapshot(namelessSnapshot());
    expect(checked.ok).toBe(false);
    if (!checked.ok) expect(checked.error).toMatch(/does not say which snapshot it is/i);
  });

  it('D3: …so it can never be applied over the book', async () => {
    await seedBook(2);
    const before = await localDataTables();
    await expect(applyRemote(namelessSnapshot())).rejects.toThrow(/which snapshot it is/i);
    expect(await localDataTables()).toEqual(before);
    // The state D3 produced — a book applied, and no id to prove anything
    // about it afterwards — is now unreachable.
    expect((await getSettings()).syncLastPulledSnapshotId).toBeNull();
  });

  it('D3: …and a head with no identity is never compared against a device that has none', async () => {
    // Two absences are equal, and equality reads as agreement. The real
    // transport refuses such a head at the door; this stands in for one that
    // forgot, because the guarantee must not rest on that.
    //
    // The device is CLEAN and has a history — the state in which "the head is
    // the snapshot I descend from" is answered by comparing one null with
    // another, and answered 'up to date' over a book it has never seen.
    await seedBook(2);
    await syncNow(new FakeCloud());
    await updateSettings({ syncLastPulledSnapshotId: null });
    const before = await localDataTables();
    const nameless = namelessSnapshot();
    const namelessHead: SyncTransport = {
      isConnected: () => true,
      connect: async () => {},
      disconnect: async () => {},
      readRemote: async () => clone(nameless),
      writeRemote: async () => {
        throw new Error('nothing may be written against a head with no identity');
      },
      readRemoteMeta: async () => ({
        revision: 2,
        savedAt: nameless.savedAt,
        deviceName: nameless.deviceName,
        snapshotId: null,
        parentSnapshotId: null,
      }),
    };

    const outcome = await syncNow(namelessHead);

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') {
      expect(outcome.message).toMatch(/does not say which snapshot it is/i);
    }
    expect(await localDataTables()).toEqual(before);
  });

  /**
   * D4. The fallback's pull passed `descendsFrom: null` — "do not check
   * descent" — even for a device holding an id perfectly capable of being
   * checked, so a clean device could be pulled onto a book that named nothing
   * of its lineage.
   *
   * `AdoptionWarrant`'s `descendsFrom` is no longer nullable, so no branch can
   * ask for a pull with the check switched off. A device that genuinely
   * descends from nothing has to say so with the other warrant, in writing.
   */
  it('D4: a clean device is never pulled onto a book that does not name its lineage', async () => {
    const cloud = new FakeCloud();
    await seedBook(2);
    await syncNow(cloud); // ours, revision 1
    const ours = cloud.file!.snapshotId!;

    // A file from somewhere else entirely, ahead of us on the numbers and
    // naming no part of our lineage. Numbers are what the fallback compared.
    cloud.file = makeSnapshot(5, { transactions: [txRow('stranger-1')] });

    const outcome = await syncNow(cloud);

    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.get('stranger-1')).toBeUndefined();
    expect(await db.transactions.count()).toBe(2);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(ours);
    expect(cloud.writes).toBe(1); // only the original push
  });
});
