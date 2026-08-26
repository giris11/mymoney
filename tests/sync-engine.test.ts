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
  DATA_TABLES,
  clearPendingLocalChange,
  db,
  defaultSettings,
  hasPendingLocalChange,
  flushLocalRevision,
  getSettings,
  SCHEMA_VERSION,
  updateSettings,
} from '../src/db/db';
import {
  applyRemote,
  bumpLocalRevision,
  DEVICE_LOCAL_SETTING_KEYS,
  ensureSyncIdentity,
  getSyncState,
  hasLocalChanges,
  localSnapshot,
  mergeSettingsRow,
  setConflictBackupSaver,
  snapshotCounts,
  syncNow,
  validateSnapshot,
} from '../src/sync/syncEngine';
import type { SyncOutcome, SyncSnapshot, SyncTransport } from '../src/sync/types';
import type { BackupFile } from '../src/backup/backup';
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

/** Build a snapshot as if some OTHER device wrote it. */
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
    tables: { ...emptyTables(), ...tables },
    ...over,
  };
}

// ------------------------------------------------------------ fake transport
//
// In-memory stand-in for Google Drive. No network is ever touched by these
// tests; `fetch` is never called, stubbed or otherwise.

class FakeDrive implements SyncTransport {
  file: SyncSnapshot | null = null;
  connected = true;
  reads = 0;
  metaReads = 0;
  writes = 0;
  failMetaWith: unknown = null;
  failReadWith: unknown = null;
  failWriteWith: unknown = null;

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
    return this.file ? clone(this.file) : null;
  }
  async writeRemote(snap: SyncSnapshot): Promise<void> {
    this.writes++;
    if (this.failWriteWith) throw this.failWriteWith;
    this.file = clone(snap);
  }
  async readRemoteMeta(): Promise<{ revision: number; savedAt: string; deviceName: string } | null> {
    this.metaReads++;
    if (this.failMetaWith) throw this.failMetaWith;
    if (!this.file) return null;
    const { revision, savedAt, deviceName } = this.file;
    return { revision, savedAt, deviceName };
  }
}

/**
 * A well-behaved second device: it always syncs cleanly (pull, edit, push), so
 * anything it puts in the remote descends from the current remote file.
 */
function deviceBPushes(drive: FakeDrive, edit: (tables: Record<string, unknown[]>) => void): void {
  const tables = drive.file ? clone(drive.file.tables) : emptyTables();
  edit(tables);
  drive.file = makeSnapshot((drive.file?.revision ?? 0) + 1, tables, {
    savedAt: new Date(Date.parse(T0) + drive.writes * 60_000).toISOString(),
  });
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
  clearPendingLocalChange();
  savedBackups = [];
  // Never write a real file in tests; also lets every test see WHAT was saved.
  setConflictBackupSaver(async (file, name) => {
    savedBackups.push({ file: clone(file), name });
  });
  await updateSettings({
    ...defaultSettings(),
    syncDeviceId: 'device-a',
    syncDeviceName: 'Laptop',
    syncEnabled: true, // the tracker is inert until sync is set up on a device
  });
  clearPendingLocalChange();
});

afterEach(() => {
  vi.unstubAllGlobals();
  setConflictBackupSaver(null);
  clearPendingLocalChange();
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

    const started = performance.now();
    await db.transactions.bulkAdd(rows);
    const elapsed = performance.now() - started;

    await flushLocalRevision();
    expect(await revisionOf()).toBe(before + 1); // ONE bump, not 5,127
    expect(await db.transactions.count()).toBe(5127);
    // Guard-rail, not a benchmark: a per-row settings write would be orders of
    // magnitude slower than this.
    expect(elapsed).toBeLessThan(5000);
  });

  it('writes to every data table bump it; settings writes never do', async () => {
    for (const name of DATA_TABLES) {
      const before = await revisionOf();
      await db.table(name).put({ id: `probe-${name}` } as never);
      await flushLocalRevision();
      expect(await revisionOf(), `${name} should bump`).toBe(before + 1);
    }
    const before = await revisionOf();
    await updateSettings({ theme: 'dark' });
    await updateSettings({ baseCurrency: 'USD' });
    await flushLocalRevision();
    expect(await revisionOf()).toBe(before); // or the tracker would loop forever
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
    clearPendingLocalChange();

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
      clearPendingLocalChange();
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
    const drive = new FakeDrive();
    drive.connected = false;
    await seedBook();
    expect(await syncNow(drive)).toEqual({ kind: 'not-connected' });
    expect(drive.metaReads + drive.reads + drive.writes).toBe(0);
  });

  it('offline ⇒ offline, and nothing changes on either side', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const drive = new FakeDrive();
    await seedBook();
    const before = await localDataTables();
    const settingsBefore = await getSettings();

    expect(await syncNow(drive)).toEqual({ kind: 'offline' });

    expect(drive.metaReads + drive.reads + drive.writes).toBe(0);
    expect(drive.file).toBeNull();
    expect(await localDataTables()).toEqual(before);
    expect(await getSettings()).toEqual(settingsBefore);
  });

  it('no remote file ⇒ pushes the local book as revision 1', async () => {
    const drive = new FakeDrive();
    await seedBook(4);

    const outcome = await syncNow(drive);

    expect(outcome).toEqual({ kind: 'pushed', revision: 1 });
    expect(drive.file?.revision).toBe(1);
    expect(drive.file?.deviceName).toBe('Laptop');
    expect(drive.file?.app).toBe('MyMoney');
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(1);
    expect(s.syncLastSyncedAt).not.toBeNull();
    expect(await hasLocalChanges()).toBe(false);
  });

  it('nothing moved on either side ⇒ up-to-date, no upload', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive); // seeds revision 1
    const writesAfterFirst = drive.writes;

    expect(await syncNow(drive)).toEqual({ kind: 'up-to-date' });
    expect(drive.writes).toBe(writesAfterFirst);
    expect(drive.reads).toBe(0); // never downloads the body when it need not
  });

  it('local changed, remote unchanged ⇒ pushes at remote + 1', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive);

    await db.transactions.add(txRow('tx-new', -999));
    await flushLocalRevision();

    const outcome = await syncNow(drive);
    expect(outcome).toEqual({ kind: 'pushed', revision: 2 });
    expect(drive.file?.revision).toBe(2);
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    expect(await hasLocalChanges()).toBe(false);
  });

  it('remote moved on, local unchanged ⇒ pulls and applies', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive); // revision 1, both sides agree

    deviceBPushes(drive, (t) => {
      (t.transactions as unknown[]).push(txRow('tx-from-imac', -4200));
    });

    const outcome = await syncNow(drive);
    expect(outcome.kind).toBe('pulled');
    if (outcome.kind !== 'pulled') throw new Error('unreachable');
    expect(outcome.revision).toBe(2);
    expect(outcome.counts.transactions).toBe(4);

    expect(await db.transactions.get('tx-from-imac')).toBeTruthy();
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    const s = await getSettings();
    expect(s.syncLastPulledRevision).toBe(2);
    expect(await hasLocalChanges()).toBe(false); // applying is not a local edit
  });

  it('a pulled snapshot never steals this device\'s identity or bookkeeping', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await updateSettings({ theme: 'dark', syncClientId: 'my-own-client-id', syncEnabled: true });
    await syncNow(drive);

    // Device B's settings row: different device, different preferences.
    deviceBPushes(drive, (t) => {
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

    expect((await syncNow(drive)).kind).toBe('pulled');

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
    const drive = new FakeDrive();
    // The remote holds the owner's real book.
    drive.file = makeSnapshot(7, {
      accounts: [clone(account)],
      categories: [clone(category)],
      transactions: [txRow('real-1'), txRow('real-2')],
    });
    // This device: never onboarded, but the startup seed already wrote rows.
    await db.categories.bulkAdd([{ ...clone(category), id: 'seeded-cat' }]);
    await flushLocalRevision();

    const outcome = await syncNow(drive);

    expect(outcome.kind).toBe('pulled');
    expect(await db.transactions.count()).toBe(2);
    expect(await db.categories.get('seeded-cat')).toBeUndefined();
  });

  it('a device holding data it has never pushed is dirty ⇒ conflict, not overwrite', async () => {
    const drive = new FakeDrive();
    await seedBook(2); // real data, never synced (lastPulledRevision stays 0)
    drive.file = makeSnapshot(1, { transactions: [txRow('remote-1')] });

    const outcome = await syncNow(drive);

    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.count()).toBe(2); // untouched
  });
});

// ===========================================================================
describe('conflict: refuse, describe, and only then act', () => {
  async function bothSidesMoved(): Promise<FakeDrive> {
    const drive = new FakeDrive();
    await seedBook(3);
    await syncNow(drive); // revision 1
    deviceBPushes(drive, (t) => {
      (t.transactions as unknown[]).push(txRow('tx-imac-1'), txRow('tx-imac-2'));
    });
    await db.transactions.add(txRow('tx-laptop-only', -777));
    await flushLocalRevision();
    return drive;
  }

  it('returns both sides described, and writes NOTHING', async () => {
    const drive = await bothSidesMoved();
    const localBefore = await localDataTables();
    const remoteBefore = clone(drive.file);
    const settingsBefore = await getSettings();

    const outcome = await syncNow(drive);

    expect(outcome.kind).toBe('conflict');
    if (outcome.kind !== 'conflict') throw new Error('unreachable');
    expect(outcome.local.deviceName).toBe('Laptop');
    expect(outcome.remote.deviceName).toBe('iMac');
    expect(outcome.remote.revision).toBe(2);
    expect(outcome.local.counts.transactions).toBe(4); // 3 seeded + 1 new
    expect(outcome.remote.counts.transactions).toBe(5); // 3 pushed + 2 theirs
    expect(outcome.remote.savedAt).toBe(drive.file?.savedAt);

    // Nothing at all changed: not the book, not the remote, not the bookkeeping.
    expect(await localDataTables()).toEqual(localBefore);
    expect(drive.file).toEqual(remoteBefore);
    expect(drive.writes).toBe(1); // just the original push
    expect(await getSettings()).toEqual(settingsBefore);
    expect(savedBackups).toHaveLength(0);
  });

  it('a remote that went BACKWARDS is a conflict too, never a silent rollback', async () => {
    const drive = new FakeDrive();
    await seedBook(3);
    await syncNow(drive); // revision 1
    await db.transactions.add(txRow('tx-4'));
    await flushLocalRevision();
    await syncNow(drive); // revision 2, local clean
    expect((await getSettings()).syncLastPulledRevision).toBe(2);

    // Someone restores an older file into Drive.
    drive.file = makeSnapshot(1, { transactions: [txRow('old-1')] });

    const outcome = await syncNow(drive);
    expect(outcome.kind).toBe('conflict');
    expect(await db.transactions.count()).toBe(4); // untouched
  });

  it('keep-local: backs up the losing REMOTE first, then pushes above both', async () => {
    const drive = await bothSidesMoved();
    expect((await syncNow(drive)).kind).toBe('conflict');

    const outcome = await syncNow(drive, { resolve: 'keep-local' });

    expect(outcome).toEqual({ kind: 'pushed', revision: 3 });
    // The safety file holds the side that lost, in normal backup format.
    expect(savedBackups).toHaveLength(1);
    expect(savedBackups[0]!.name).toMatch(/^mymoney-conflict-remote-rev2-\d{4}-\d{2}-\d{2}\.json$/);
    expect(savedBackups[0]!.file.app).toBe('MyMoney');
    const savedIds = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(savedIds).toContain('tx-imac-1');
    expect(savedIds).toContain('tx-imac-2');
    // …and only then was the remote replaced.
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    expect(await db.transactions.get('tx-laptop-only')).toBeTruthy();
  });

  it('keep-remote: backs up the losing LOCAL book first, then applies', async () => {
    const drive = await bothSidesMoved();
    expect((await syncNow(drive)).kind).toBe('conflict');

    const outcome = await syncNow(drive, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(savedBackups).toHaveLength(1);
    expect(savedBackups[0]!.name).toMatch(/^mymoney-conflict-local-rev1-/);
    const savedIds = (savedBackups[0]!.file.tables.transactions as { id: string }[]).map((t) => t.id);
    expect(savedIds).toContain('tx-laptop-only'); // the change that lost is safe
    // Local now IS the remote.
    expect(await db.transactions.get('tx-laptop-only')).toBeUndefined();
    expect(await db.transactions.get('tx-imac-1')).toBeTruthy();
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    expect(await hasLocalChanges()).toBe(false);
  });

  it('if the safety backup cannot be written, NOTHING is destroyed', async () => {
    const drive = await bothSidesMoved();
    const localBefore = await localDataTables();
    const remoteBefore = clone(drive.file);
    setConflictBackupSaver(async () => {
      throw new Error('Disk full');
    });

    const keepRemote = await syncNow(drive, { resolve: 'keep-remote' });
    expect(keepRemote.kind).toBe('error');
    if (keepRemote.kind !== 'error') throw new Error('unreachable');
    expect(keepRemote.message).toMatch(/Disk full/);
    expect(keepRemote.message).toMatch(/nothing was replaced/i);
    expect(await localDataTables()).toEqual(localBefore);

    const keepLocal = await syncNow(drive, { resolve: 'keep-local' });
    expect(keepLocal.kind).toBe('error');
    expect(drive.file).toEqual(remoteBefore);
    expect(await localDataTables()).toEqual(localBefore);
  });

  it('the built-in saver: a cancelled save aborts the resolution', async () => {
    const drive = await bothSidesMoved();
    const localBefore = await localDataTables();
    setConflictBackupSaver(null); // use the real default

    const abort = Object.assign(new Error('user cancelled'), { name: 'AbortError' });
    stubAnchorDownload();
    vi.stubGlobal('showSaveFilePicker', () => Promise.reject(abort));

    const outcome = await syncNow(drive, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/cancelled/i);
    expect(await localDataTables()).toEqual(localBefore);
  });

  it('the built-in saver: a completed save lets the resolution proceed', async () => {
    const drive = await bothSidesMoved();
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

    const outcome = await syncNow(drive, { resolve: 'keep-remote' });

    expect(outcome.kind).toBe('pulled');
    expect(suggested).toMatch(/^mymoney-conflict-local-rev1-/);
    const parsed = JSON.parse(written) as BackupFile;
    expect(parsed.app).toBe('MyMoney'); // a normal backup file, restorable as one
    expect((parsed.tables.transactions as { id: string }[]).some((t) => t.id === 'tx-laptop-only'))
      .toBe(true);
  });

  it('a per-call saver overrides the installed one', async () => {
    const drive = await bothSidesMoved();
    const seen: string[] = [];
    const outcome = await syncNow(drive, {
      resolve: 'keep-local',
      saveBackup: async (_file, name) => {
        seen.push(name);
      },
    });
    expect(outcome.kind).toBe('pushed');
    expect(seen).toEqual([expect.stringMatching(/^mymoney-conflict-remote-rev2-/)]);
    expect(savedBackups).toHaveLength(0); // the installed saver was bypassed
  });

  it('resolve is an answer, not a mode: it does nothing when there is no conflict', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive);
    expect(await syncNow(drive, { resolve: 'keep-remote' })).toEqual({ kind: 'up-to-date' });
    expect(savedBackups).toHaveLength(0);
  });
});

// ===========================================================================
describe('refusing bad remote data', () => {
  const localUntouched = async (before: Record<string, unknown[]>) => {
    expect(await localDataTables()).toEqual(before);
  };

  it('garbage in the sync file is refused without touching local data', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive);
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
      drive.file = bad as SyncSnapshot;
      // The meta head still claims a newer revision, so the engine tries.
      drive.metaReads = 0;
      const outcome = await syncNow({
        ...drive,
        isConnected: () => true,
        readRemoteMeta: async () => ({ revision: 2, savedAt: T0, deviceName: 'iMac' }),
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
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive);
    const before = await localDataTables();

    const future = makeSnapshot(2, { transactions: [txRow('future-1')] }, {
      schemaVersion: SCHEMA_VERSION + 1,
    });
    drive.file = future;

    const outcome = await syncNow(drive);
    expect(outcome.kind).toBe('error');
    if (outcome.kind === 'error') expect(outcome.message).toMatch(/newer version/i);
    await localUntouched(before);

    await expect(applyRemote(future)).rejects.toThrow(/newer version/i);
    await localUntouched(before);
  });

  it('a remote head with a nonsense revision is refused', async () => {
    const drive = new FakeDrive();
    await seedBook();
    drive.file = makeSnapshot(1, {});
    const bad = { ...drive, isConnected: () => true, readRemoteMeta: async () => ({ revision: -3, savedAt: T0, deviceName: 'x' }) } as unknown as SyncTransport;
    const outcome = await syncNow(bad);
    expect(outcome.kind).toBe('error');
  });

  it('transport failures surface as outcomes, never as thrown errors', async () => {
    const drive = new FakeDrive();
    await seedBook();
    drive.failMetaWith = new Error('Drive said no');
    let outcome = await syncNow(drive);
    expect(outcome).toEqual({
      kind: 'error',
      message: 'Could not read the sync file: Drive said no',
    });

    // A transport that reports its own typed reasons is understood.
    drive.failMetaWith = Object.assign(new Error("You're offline"), {
      name: 'SyncTransportError',
      kind: 'offline',
    });
    expect(await syncNow(drive)).toEqual({ kind: 'offline' });

    drive.failMetaWith = Object.assign(new Error('Not connected'), {
      name: 'SyncTransportError',
      kind: 'not-connected',
    });
    expect(await syncNow(drive)).toEqual({ kind: 'not-connected' });

    // A failed upload leaves the bookkeeping alone so the next try repeats it.
    drive.failMetaWith = null;
    drive.failWriteWith = new Error('upload failed');
    outcome = await syncNow(drive);
    expect(outcome.kind).toBe('error');
    expect((await getSettings()).syncLastPulledRevision).toBe(0);
    expect(await hasLocalChanges()).toBe(true);
  });

  it('a sync file that vanishes between head and body is an error, not a wipe', async () => {
    const drive = new FakeDrive();
    await seedBook();
    await syncNow(drive);
    const before = await localDataTables();
    deviceBPushes(drive, (t) => (t.transactions as unknown[]).push(txRow('theirs')));
    const vanishing = {
      ...drive,
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
    const drive = new FakeDrive();
    await seedBook(3);
    await syncNow(drive);
    const before = await localDataTables();

    drive.file = makeSnapshot(2, { transactions: [txRow('d'), txRow('d')] });
    const outcome = await syncNow(drive);

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
    const drive = new FakeDrive();
    await seedBook(2);

    const revisions: number[] = [];
    const record = (o: SyncOutcome) => {
      expect(o.kind === 'pushed' || o.kind === 'pulled' || o.kind === 'up-to-date').toBe(true);
      if (o.kind === 'pushed' || o.kind === 'pulled') revisions.push(o.revision);
    };

    record(await syncNow(drive)); // A pushes 1
    deviceBPushes(drive, (t) => (t.transactions as unknown[]).push(txRow('b-1')));
    record(await syncNow(drive)); // A pulls 2
    await db.transactions.add(txRow('a-1'));
    await flushLocalRevision();
    record(await syncNow(drive)); // A pushes 3
    deviceBPushes(drive, (t) => (t.transactions as unknown[]).push(txRow('b-2')));
    record(await syncNow(drive)); // A pulls 4
    await db.transactions.delete('tx-0');
    await flushLocalRevision();
    record(await syncNow(drive)); // A pushes 5
    record(await syncNow(drive)); // up-to-date

    expect(revisions).toEqual([1, 2, 3, 4, 5]);
    expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
    const ids = (await db.transactions.toArray()).map((t) => t.id).sort();
    expect(ids).toEqual(['a-1', 'b-1', 'b-2', 'tx-1']);
    expect(savedBackups).toHaveLength(0); // nothing ever lost a fight
  });

  it('reports a truthful state for the UI', async () => {
    const drive = new FakeDrive();
    await seedBook(2);
    let state = await getSyncState(drive);
    expect(state.connected).toBe(true);
    expect(state.lastSyncedAt).toBeNull();
    expect(state.hasLocalChanges).toBe(true);

    await syncNow(drive);
    state = await getSyncState(drive);
    expect(state.lastPulledRevision).toBe(1);
    expect(state.remoteRevision).toBe(1);
    expect(state.hasLocalChanges).toBe(false);
    expect(state.deviceId).toBe('device-a');

    await db.transactions.add(txRow('later'));
    await flushLocalRevision();
    expect((await getSyncState(drive)).hasLocalChanges).toBe(true);
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
    const drive = new FakeDrive();
    await seedBook(2); // real data, never pushed ⇒ genuinely dirty

    const everCreated = new Set<string>(['tx-0', 'tx-1']);
    const rescued = new Set<string>(); // ids written to a conflict safety file
    setConflictBackupSaver(async (file, name) => {
      savedBackups.push({ file: clone(file), name });
      for (const row of file.tables.transactions as { id: string }[]) rescued.add(row.id);
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
        deviceBPushes(drive, (t) => {
          (t.transactions as unknown[]).push(txRow(id, -(1 + counter)));
        });
        everCreated.add(id);
      } else {
        // ---- a sync
        const localBefore = await localDataTables();
        const remoteBefore = clone(drive.file);
        const dirtyBefore = await (async () => {
          await flushLocalRevision();
          return hasLocalChanges();
        })();
        const remoteRevBefore = drive.file?.revision ?? 0;
        const backupsAtStepStart = savedBackups.length;

        let outcome = await syncNow(drive);

        if (outcome.kind === 'conflict') {
          conflicts++;
          // A conflict must change absolutely nothing.
          expect(await localDataTables()).toEqual(localBefore);
          expect(drive.file).toEqual(remoteBefore);
          expect(outcome.local.counts.transactions).toBe(
            (localBefore.transactions as unknown[]).length,
          );
          expect(outcome.remote.counts.transactions).toBe(
            ((remoteBefore?.tables.transactions ?? []) as unknown[]).length,
          );
          // Now answer it, the way a user would.
          const resolve = rng() < 0.5 ? 'keep-local' : 'keep-remote';
          const backupsBefore = savedBackups.length;
          outcome = await syncNow(drive, { resolve });
          // Whatever happened, the loser was written out first.
          expect(savedBackups.length).toBe(backupsBefore + 1);
          expect(savedBackups.at(-1)!.name).toContain(
            resolve === 'keep-local' ? 'conflict-remote' : 'conflict-local',
          );
        }

        switch (outcome.kind) {
          case 'up-to-date':
            // THE INVARIANT: "nothing to do" must mean the two sides agree.
            expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
            expect(drive.file).toEqual(remoteBefore);
            break;
          case 'pushed':
            pushes++;
            expect(outcome.revision).toBeGreaterThan(remoteRevBefore);
            expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
            expect(await hasLocalChanges()).toBe(false);
            break;
          case 'pulled':
            pulls++;
            // A pull may only ever run over a device with nothing to lose —
            // unless the user explicitly chose to discard, in which case the
            // discarded side is in a safety file (asserted above).
            expect(snapshotDataTables(drive.file)).toEqual(await localDataTables());
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
        ((drive.file?.tables.transactions ?? []) as { id: string }[]).map((t) => t.id),
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
