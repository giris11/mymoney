// The SEAM between the two halves of Drive sync (D42; SPEC §8.3, §2.6).
//
// tests/sync-engine.test.ts fakes SyncTransport at the interface, so the real
// transport never runs. tests/sync-transport.test.ts fakes `fetch` and never
// imports the engine, so the real syncNow never runs. Both files are green,
// and between them is a seam that nothing crosses — which is exactly where the
// fatal defect lived. The engine decides what its book DESCENDS FROM and
// declares that parent on the way out; the transport refuses the write unless
// the file it is replacing is still that snapshot. Those are two different
// modules answering the same question — "has the head moved?" — and until this
// file nothing checked that they answer it the same way.
//
// So here the REAL syncNow() drives the REAL createDriveTransport(). Only two
// things are faked, and both sit outside our code:
//
//  * `fetch` — a stand-in for the Drive v3 REST API, written to the behaviours
//    the fixes actually depend on rather than to a convenient simplification:
//      - files.update MERGES appProperties, so a key left out of an upload
//        keeps its previous value (this is why parentSnapshotId is written as
//        '' and never omitted, and why a legacy writer's PATCH leaves someone
//        else's snapshotId sitting on a file whose contents have changed);
//      - files.list cannot see a file in the bin, while files.get on a known
//        id returns it with `trashed: true` — the difference between "there is
//        no file" and "the file is one click from being restored";
//      - an upload is ONE multipart/related request carrying metadata and
//        content together;
//      - failures come back shaped the way Drive shapes them: 401 for a token
//        that has expired mid-session, 403 whose `error.errors[].reason` is
//        the only thing that tells a FULL DRIVE apart from rate limiting, and
//        429/5xx for "busy, come back later".
//  * the OAuth token provider — no Google, no popup, no network.
//
// Everything else is the shipping code: the decision table, Dexie (through
// fake-indexeddb), exportBackup/restoreBackup, the multipart writer, the
// precondition, the post-write read-back and the settings bookkeeping.
//
// A SECOND DEVICE IS A REAL DEVICE HERE. There is one IndexedDB in this
// process, so `atDevice()` parks one browser profile's rows and loads the
// other's — settings row included, which is where a device's identity, its
// ancestry bookkeeping and its change counters live. Both devices then run the
// same real engine against the same fake Drive, which is the only way to say
// "and the other device agrees" and mean it.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TABLES,
  DATA_TABLES,
  db,
  defaultSettings,
  flushLocalRevision,
  getSettings,
  SCHEMA_VERSION,
  updateSettings,
  withoutLocalChangeTracking,
} from '../src/db/db';
import { recoveryDb } from '../src/backup/backup';
import { hasLocalChanges, setConflictBackupSaver, syncNow } from '../src/sync/syncEngine';
import { createDriveTransport, SYNC_FILE_NAME } from '../src/sync/transport';
import type { TokenProvider } from '../src/sync/googleAuth';
import type { SyncSnapshot, SyncTransport } from '../src/sync/types';
import type { Account, Category, Transaction } from '../src/db/types';

const clone = <T>(x: T): T => structuredClone(x);
const T0 = '2026-08-01T10:00:00.000Z';

// ===========================================================================
// A fake Drive v3, at the HTTP layer
// ===========================================================================

interface DriveFile {
  id: string;
  name: string;
  /** In Drive's bin: it still exists, and files.list will not show it. */
  trashed: boolean;
  /** Drive's per-file key/value store. MERGED on update, never replaced. */
  appProperties: Record<string, string>;
  content: string;
  modifiedTime: string;
}

interface DriveCall {
  method: string;
  url: string;
  token: string;
  upload: boolean;
}

/** The body Drive actually sends when it says no. */
function driveError(code: number, message: string, reason?: string): unknown {
  return {
    error: {
      code,
      message,
      errors: reason ? [{ domain: 'usageLimits', reason, message }] : [],
      status: code === 403 ? 'PERMISSION_DENIED' : undefined,
    },
  };
}

/** The appProperties MyMoney writes beside a snapshot (see transport.ts). */
function propsFor(snap: SyncSnapshot): Record<string, string> {
  return {
    app: 'MyMoney',
    revision: String(snap.revision),
    savedAt: snap.savedAt,
    deviceId: snap.deviceId,
    deviceName: snap.deviceName,
    schemaVersion: String(snap.schemaVersion),
    snapshotId: snap.snapshotId ?? '',
    parentSnapshotId: snap.parentSnapshotId ?? '',
  };
}

class FakeDrive {
  readonly files = new Map<string, DriveFile>();
  readonly calls: DriveCall[] = [];
  private nextId = 1;
  /** A token the fake has decided is past its hour. */
  private expiredToken: string | null = null;
  /** The next upload fails with this Drive error instead of landing. */
  private uploadRefusal: { status: number; reason?: string; message: string } | null = null;
  /** Runs while a media download is in flight. */
  private downloadHook: (() => void | Promise<void>) | null = null;
  /** Runs once an upload has COMMITTED — the window before the read-back. */
  private uploadedHook: (() => void) | null = null;
  /** Runs just before the Nth head read from now (see beforeHeadRead). */
  private headReadHook: { countdown: number; fn: () => void } | null = null;

  // ---- what a test looks at -------------------------------------------

  /** The one live sync file. Anything else is a bug in the test or the code. */
  only(): DriveFile {
    const live = [...this.files.values()].filter((f) => !f.trashed);
    if (live.length !== 1) throw new Error(`expected one live sync file, found ${live.length}`);
    return live[0]!;
  }
  head(): SyncSnapshot {
    return JSON.parse(this.only().content) as SyncSnapshot;
  }
  props(): Record<string, string> {
    return this.only().appProperties;
  }
  mark(): number {
    return this.calls.length;
  }
  callsSince(mark: number): DriveCall[] {
    return this.calls.slice(mark);
  }
  uploadsSince(mark: number): DriveCall[] {
    return this.callsSince(mark).filter((c) => c.upload);
  }

  // ---- what a test does to it ------------------------------------------

  /**
   * Another client updates the sync file: content replaced, appProperties
   * MERGED, exactly as files.update behaves. This is how a writer that does
   * not honour our precondition — an older build, a hand-edited file, another
   * tool — lands a snapshot the transport would have refused.
   */
  strangerUpdates(snap: SyncSnapshot, props = propsFor(snap)): void {
    const f = this.only();
    f.content = JSON.stringify(snap);
    f.appProperties = { ...f.appProperties, ...props };
    f.modifiedTime = snap.savedAt;
  }
  /** Put a captured copy of the file back exactly as it was. */
  restoreFile(copy: DriveFile): void {
    this.files.set(copy.id, clone(copy));
  }
  trash(id: string): void {
    this.files.get(id)!.trashed = true;
  }
  /** Gone for good — the bin emptied, or the file deleted from another account. */
  remove(id: string): void {
    this.files.delete(id);
  }
  expire(token: string): void {
    this.expiredToken = token;
  }
  refuseNextUpload(status: number, reason: string | undefined, message: string): void {
    this.uploadRefusal = { status, reason, message };
  }
  duringNextDownload(fn: () => void | Promise<void>): void {
    this.downloadHook = fn;
  }
  afterNextUpload(fn: () => void): void {
    this.uploadedHook = fn;
  }
  /**
   * Run `fn` immediately before the Nth head read from now. One sync reads the
   * head twice — once for the engine's decision, once for the transport's
   * precondition — and `beforeHeadRead(2, …)` is the only way to open the
   * window between them, which is the window the precondition exists for.
   */
  beforeHeadRead(n: number, fn: () => void): void {
    this.headReadHook = { countdown: n, fn };
  }

  // ---- the API ---------------------------------------------------------

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const u = new URL(url);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const upload = u.pathname.startsWith('/upload/drive/v3/files');
    this.calls.push({ method, url, token, upload });

    const text = (status: number, body: string) =>
      ({ status, ok: status >= 200 && status < 300, text: async () => body }) as unknown as Response;
    const json = (status: number, body: unknown) => text(status, JSON.stringify(body));

    if (token === '' || token === this.expiredToken) {
      // What Drive says to a token that has run out its hour. The transport is
      // expected to drop it, get another and try once more, without ever
      // telling the owner anything went wrong.
      return json(401, driveError(401, 'Invalid Credentials', 'authError'));
    }

    const id = decodeURIComponent(/\/files\/([^/?]+)/.exec(u.pathname)?.[1] ?? '');
    const isHeadRead = !upload && method === 'GET' && u.searchParams.get('alt') !== 'media';
    if (isHeadRead && this.headReadHook) {
      this.headReadHook.countdown -= 1;
      if (this.headReadHook.countdown === 0) {
        const { fn } = this.headReadHook;
        this.headReadHook = null;
        fn();
      }
    }

    // files.list — CANNOT SEE A TRASHED FILE. Drive excludes them by default,
    // and the transport's query says `trashed = false` besides.
    if (!upload && method === 'GET' && u.searchParams.get('q')) {
      const wanted = /name = '([^']+)'/.exec(u.searchParams.get('q') ?? '')?.[1];
      const matches = [...this.files.values()]
        .filter((f) => f.name === wanted && !f.trashed)
        .sort((a, b) => b.modifiedTime.localeCompare(a.modifiedTime));
      return json(200, {
        files: matches.map((f) => ({
          id: f.id,
          name: f.name,
          modifiedTime: f.modifiedTime,
          appProperties: f.appProperties,
        })),
      });
    }

    if (!upload && method === 'GET' && id) {
      const f = this.files.get(id);
      if (!f) return json(404, driveError(404, 'File not found: ' + id, 'notFound'));
      if (u.searchParams.get('alt') === 'media') {
        const body = f.content;
        // Between the headers and the body: the multi-megabyte download during
        // which the app stays fully interactive.
        const hook = this.downloadHook;
        this.downloadHook = null;
        if (hook) await hook();
        return text(200, body);
      }
      // A KNOWN ID STILL RESOLVES WHEN IT IS IN THE BIN, flagged. Answering
      // "no such file" here is what let a device start a second lineage beside
      // a file that was one click from being restored.
      return json(200, { id: f.id, trashed: f.trashed, appProperties: f.appProperties });
    }

    if (upload && (method === 'POST' || method === 'PATCH')) {
      if (this.uploadRefusal) {
        const { status, reason, message } = this.uploadRefusal;
        this.uploadRefusal = null;
        return json(status, driveError(status, message, reason));
      }
      const { metadata, content } = parseMultipart(
        String(init.body),
        headers['content-type'] ?? '',
      );
      const props = (metadata.appProperties ?? {}) as Record<string, string>;
      if (method === 'POST') {
        const created = `file-${this.nextId++}`;
        this.files.set(created, {
          id: created,
          name: String(metadata.name),
          trashed: false,
          appProperties: { ...props },
          content,
          modifiedTime: new Date().toISOString(),
        });
        this.commit(created);
        return json(200, { id: created });
      }
      const f = this.files.get(id);
      if (!f) return json(404, driveError(404, 'File not found: ' + id, 'notFound'));
      f.content = content;
      // THE MERGE. A key the uploader left out keeps its previous value, which
      // is why the app writes parentSnapshotId as '' rather than omitting it —
      // and why a writer that sends no snapshotId at all leaves the previous
      // one sitting on top of a file whose contents have changed.
      f.appProperties = { ...f.appProperties, ...props };
      f.modifiedTime = new Date().toISOString();
      this.commit(f.id);
      return json(200, { id: f.id });
    }

    throw new Error(`fake Drive got an unexpected request: ${method} ${url}`);
  };

  /** Our bytes are in. Anything armed here runs before the read-back sees them. */
  private commit(_id: string): void {
    const hook = this.uploadedHook;
    this.uploadedHook = null;
    hook?.();
  }
}

/** Split a multipart/related upload back into its two parts. */
function parseMultipart(
  body: string,
  contentType: string,
): { metadata: Record<string, unknown>; content: string } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`not a multipart body: ${contentType}`);
  const parts = body
    .split(`--${boundary}`)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '--');
  const payloads = parts.map((p) => p.slice(p.indexOf('\r\n\r\n') + 4).trim());
  return {
    metadata: JSON.parse(payloads[0] ?? '{}') as Record<string, unknown>,
    content: payloads[1] ?? '',
  };
}

// ===========================================================================
// Two devices, one process
// ===========================================================================

type Rows = Record<string, unknown[]>;

interface Device {
  /** Travels inside every snapshot this device writes. */
  name: string;
  id: string;
  transport: SyncTransport;
  /** This device's IndexedDB, while some other device is at the keyboard. */
  parked: Rows;
}

/** A browser profile that has never done anything. */
function freshProfile(name: string, id: string): Rows {
  const rows: Rows = {};
  for (const t of ALL_TABLES) rows[t] = [];
  rows.settings = [
    {
      ...defaultSettings(),
      createdAt: T0,
      syncDeviceId: id,
      syncDeviceName: name,
      // The change tracker is inert until sync is set up on a device.
      syncEnabled: true,
    },
  ];
  return rows;
}

function createDevice(name: string, id: string): Device {
  // Each browser profile has its own localStorage, so each device has its own
  // pointer to the Drive file — and one of them going stale is a case the real
  // transport has to handle rather than a detail to fake away.
  let cachedFileId: string | null = null;
  return {
    name,
    id,
    parked: freshProfile(name, id),
    transport: createDriveTransport({
      auth: fakeAuth,
      fileIdStore: {
        get: () => cachedFileId,
        set: (v: string | null) => {
          cachedFileId = v;
        },
      },
    }),
  };
}

let atKeyboard: Device | null = null;

/**
 * Put `device` at the keyboard: park whoever was there and load this one's
 * rows, settings included. Tracking is off for the swap — carrying a book
 * between browser profiles is not the owner typing, and counting it would make
 * every device look dirty the moment it was switched to.
 */
async function atDevice(device: Device): Promise<void> {
  if (atKeyboard === device) return;
  if (atKeyboard) {
    // Land any coalesced bump on the settings row it belongs to, first.
    await flushLocalRevision();
    const rows: Rows = {};
    for (const t of ALL_TABLES) rows[t] = await db.table(t).toArray();
    atKeyboard.parked = rows;
  }
  const loading = device.parked;
  await withoutLocalChangeTracking(() =>
    db.transaction('rw', [...ALL_TABLES], async () => {
      for (const t of ALL_TABLES) {
        await db.table(t).clear();
        const rows = loading[t] ?? [];
        if (rows.length > 0) await db.table(t).bulkAdd(rows);
      }
    }),
  );
  atKeyboard = device;
}

// ===========================================================================
// A book
// ===========================================================================

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

/** A real book on whichever device is at the keyboard — i.e. NOT pristine. */
async function seedBook(txIds: string[]): Promise<void> {
  await db.accounts.add(clone(account));
  await db.categories.add(clone(category));
  for (const id of txIds) await db.transactions.add(txRow(id));
  await updateSettings({ onboarded: true });
  await flushLocalRevision();
}

/** One transaction typed by the owner. */
async function type(id: string, amountMinor = -1234): Promise<void> {
  await db.transactions.add(txRow(id, amountMinor));
  await flushLocalRevision();
}

async function txIds(): Promise<string[]> {
  return (await db.transactions.toArray()).map((t) => t.id).sort();
}

async function dataRows(): Promise<Rows> {
  const out: Rows = {};
  for (const t of DATA_TABLES) {
    out[t] = ((await db.table(t).toArray()) as { id: string }[]).sort((a, b) =>
      a.id.localeCompare(b.id),
    );
  }
  return out;
}

/**
 * A snapshot written by a device that is not in this test — a whole book, with
 * its own identity. By default it descends from nothing, which is what makes
 * it a STRANGER: no device here can find its own id anywhere in its history.
 */
let strangerCount = 0;
function strangerSnapshot(
  revision: number,
  txs: string[],
  over: Partial<SyncSnapshot> = {},
): SyncSnapshot {
  const tables: Rows = {};
  for (const t of ALL_TABLES) tables[t] = [];
  tables.accounts = [clone(account)];
  tables.categories = [clone(category)];
  tables.transactions = txs.map((id) => txRow(id));
  return {
    app: 'MyMoney',
    schemaVersion: SCHEMA_VERSION,
    revision,
    deviceId: 'device-imac',
    deviceName: 'iMac',
    savedAt: `2026-08-2${revision % 10}T09:00:00.000Z`,
    snapshotId: `stranger-${++strangerCount}`,
    parentSnapshotId: null,
    ancestry: [],
    tables,
    ...over,
  };
}

// ===========================================================================
// Harness
// ===========================================================================

let drive: FakeDrive;
let laptop: Device;
let imac: Device;
let tokens: string[];

/**
 * A token provider that never touches Google. `invalidate()` mints the next
 * token, which is what makes an expired-token retry observable: the fake Drive
 * refuses the old string and accepts the new one.
 */
const fakeAuth: TokenProvider = {
  isConnected: () => true,
  hasValidToken: () => true,
  isLinked: () => true,
  getToken: async () => tokens[tokens.length - 1]!,
  connect: async () => {},
  disconnect: async () => {},
  invalidate: () => {
    tokens.push(`token-${tokens.length + 1}`);
  },
};

beforeEach(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  // The recovery store is a SEPARATE database, so clearing the book does not
  // touch it. A resolved conflict writes into it for real here (only the file
  // half of the save is overridden), and one test's copies must not be part of
  // the next one's starting conditions.
  await Promise.all([recoveryDb.records.clear(), recoveryDb.bodies.clear()]);
  tokens = ['token-1'];
  strangerCount = 0;
  drive = new FakeDrive();
  vi.stubGlobal('fetch', drive.fetch);
  laptop = createDevice('Laptop', 'device-laptop');
  imac = createDevice('iMac', 'device-imac');
  atKeyboard = null;
  await atDevice(laptop);
  // Nothing here resolves a conflict, so nothing should ever ask to write a
  // safety file. Recording it (rather than letting the real ladder run) means
  // a test that unexpectedly does can say so instead of touching the disk.
  setConflictBackupSaver(async () => {
    throw new Error('no test in this file should be saving a conflict backup');
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  setConflictBackupSaver(null);
});

/** The laptop's first push: the lineage every other test starts from. */
async function seedLineage(txs = ['tx-laptop-1']): Promise<SyncSnapshot> {
  await atDevice(laptop);
  await seedBook(txs);
  const outcome = await syncNow(laptop.transport);
  expect(outcome.kind).toBe('pushed');
  return drive.head();
}

// ===========================================================================
describe('a lineage begins', () => {
  it('seeds an empty Drive, and a second device pulls the same book', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1', 'tx-2']);

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({ kind: 'pushed', revision: 1 });
    const head = drive.head();
    expect(drive.files.size).toBe(1);
    expect(drive.only().name).toBe(SYNC_FILE_NAME);
    // The cheap head read is these few hundred bytes, so what a lineage is
    // made of has to be legible in them.
    expect(drive.props()).toMatchObject({
      app: 'MyMoney',
      revision: '1',
      deviceName: 'Laptop',
      schemaVersion: String(SCHEMA_VERSION),
      snapshotId: head.snapshotId!,
      // '' rather than an absent key, because files.update MERGES: an omitted
      // parentSnapshotId would keep the previous write's parent for ever.
      parentSnapshotId: '',
    });
    expect(head.parentSnapshotId).toBeNull();
    expect(head.ancestry).toEqual([]);
    // Money crosses the wire unrounded and unre-interpreted (SPEC §6).
    const uploaded = head.tables.accounts as Account[];
    expect(uploaded[0]!.openingBalanceMinor).toBe(150_000);

    // The laptop now knows which snapshot its book descends from — that id,
    // not the number 1, is what the next sync reasons about.
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(head.snapshotId);

    // A second device, straight out of the box: a pristine book, its own
    // identity, no idea the file exists.
    await atDevice(imac);
    const pulled = await syncNow(imac.transport);

    expect(pulled).toMatchObject({ kind: 'pulled', revision: 1 });
    expect(await txIds()).toEqual(['tx-1', 'tx-2']);
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(head.snapshotId);
    expect(s.syncDeviceId).toBe('device-imac'); // it kept its own identity
    expect(s.syncDeviceName).toBe('iMac');

    // AND AGREES: a second sync finds nothing to do and uploads nothing.
    const mark = drive.mark();
    expect(await syncNow(imac.transport)).toEqual({
      kind: 'up-to-date',
      snapshotId: head.snapshotId,
    });
    expect(drive.uploadsSince(mark)).toEqual([]);

    // The two devices hold the same book, row for row.
    const onImac = await dataRows();
    await atDevice(laptop);
    expect(await dataRows()).toEqual(onImac);
  });
});

// ===========================================================================
describe('two devices taking turns', () => {
  it('advances the chain by exactly one link per push, in one file', async () => {
    const first = await seedLineage(['tx-1']);
    const fileId = drive.only().id;

    // The iMac pulls, adds something, pushes.
    await atDevice(imac);
    expect((await syncNow(imac.transport)).kind).toBe('pulled');
    await type('tx-imac');
    expect(await syncNow(imac.transport)).toMatchObject({ kind: 'pushed', revision: 2 });

    const second = drive.head();
    expect(second.parentSnapshotId).toBe(first.snapshotId);
    expect(second.ancestry).toEqual([first.snapshotId]);
    expect(drive.props()).toMatchObject({ revision: '2', parentSnapshotId: first.snapshotId! });

    // The laptop pulls it and pushes on top.
    await atDevice(laptop);
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pulled', revision: 2 });
    expect(await txIds()).toEqual(['tx-1', 'tx-imac']);
    await type('tx-laptop-2');
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 3 });

    const third = drive.head();
    expect(third.parentSnapshotId).toBe(second.snapshotId);
    // Newest first, and it carries the whole chain — that is what lets a
    // device two pushes behind prove it is behind rather than diverged.
    expect(third.ancestry).toEqual([second.snapshotId, first.snapshotId]);
    expect(drive.props().parentSnapshotId).toBe(second.snapshotId);

    // The iMac fast-forwards, and both books are identical again.
    await atDevice(imac);
    expect(await syncNow(imac.transport)).toMatchObject({ kind: 'pulled', revision: 3 });
    expect(await txIds()).toEqual(['tx-1', 'tx-imac', 'tx-laptop-2']);
    const onImac = await dataRows();
    await atDevice(laptop);
    expect(await dataRows()).toEqual(onImac);

    // ONE file the whole way through: three revisions of one lineage, never a
    // second mymoney-sync.json created beside it.
    expect(drive.files.size).toBe(1);
    expect(drive.only().id).toBe(fileId);
  });
});

// ===========================================================================
describe('the seam: the engine and the transport agree about "the head moved"', () => {
  it('does not mistake a stranger at the same revision number for its own snapshot', async () => {
    const ours = await seedLineage(['tx-laptop-1', 'tx-laptop-2']);
    expect(ours.revision).toBe(1);

    // Another device that has never seen ours writes its OWN revision 1: same
    // number, different book, unrelated lineage. It gets there through a
    // client that does not honour the precondition — a hand-edited file, some
    // other tool — because ours would have refused it.
    //
    // THIS IS C1. Under the revision model the numbers matched, so a clean
    // device reported 'up-to-date' and the next pull silently replaced the
    // owner's book with a stranger's.
    drive.strangerUpdates(strangerSnapshot(1, ['tx-imac-1', 'tx-imac-2', 'tx-imac-3']));
    const mark = drive.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).not.toBe('up-to-date');
    expect(outcome.kind).toBe('conflict');
    // Both sides described truthfully, and nothing written in either
    // direction: not the book, not the file, not the bookkeeping.
    expect(outcome).toMatchObject({
      local: { deviceName: 'Laptop', counts: { transactions: 2 } },
      remote: { deviceName: 'iMac', revision: 1, counts: { transactions: 3 } },
    });
    expect(await txIds()).toEqual(['tx-laptop-1', 'tx-laptop-2']);
    expect(drive.uploadsSince(mark)).toEqual([]);
    expect(drive.head().snapshotId).toBe('stranger-1');
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
  });

  it('refuses the push the engine authorised when the head moved under it', async () => {
    const ours = await seedLineage(['tx-1']);
    const untouched = clone(drive.only());
    await type('tx-2'); // ⇒ dirty, so this sync will decide to push

    // The stranger lands in the ONE window that matters: after the engine has
    // read the head and decided to descend from `ours`, before the transport
    // re-reads it to check that this is still true. Its revision is BELOW the
    // one we are about to write, so the transport's revision guard cannot be
    // what saves us — only the identity check can.
    drive.beforeHeadRead(2, () => {
      drive.strangerUpdates(strangerSnapshot(1, ['tx-imac-1']));
    });
    const mark = drive.mark();

    const outcome = await syncNow(laptop.transport);

    // The engine declared a parent; the transport found the head was no longer
    // that snapshot and refused. Nothing was uploaded at all.
    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(
      /Another device saved to Google Drive while this one was preparing its upload/,
    );
    expect((outcome as { message: string }).message).not.toMatch(/already at version/);
    expect(drive.uploadsSince(mark)).toEqual([]);
    expect(drive.head().snapshotId).toBe('stranger-1');

    // The refusal cost nothing: the change is still here, still unsent, and
    // this device still descends from the snapshot it did before.
    expect(await txIds()).toEqual(['tx-1', 'tx-2']);
    expect(await hasLocalChanges()).toBe(true);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(ours.snapshotId);

    // And the engine now asks, rather than pushing over a book nobody here
    // has seen. The two halves reached the same verdict from opposite ends.
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');

    // The proof that "the head moved" is the whole of what was wrong: put the
    // head back and the identical push goes through, naming the same parent.
    drive.files.clear();
    drive.restoreFile(untouched);
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 2 });
    expect(drive.props().parentSnapshotId).toBe(ours.snapshotId);
    expect(drive.head().parentSnapshotId).toBe(ours.snapshotId);
  });

  it('does not record agreement when its write is overwritten before the read-back', async () => {
    const ours = await seedLineage(['tx-1']);
    await type('tx-2');

    // Our bytes land — Drive really did accept them — and another device's
    // push lands on top a moment later, before we read our own write back. A
    // 200 from the upload says nothing about what the file holds now.
    drive.afterNextUpload(() => {
      drive.strangerUpdates(strangerSnapshot(9, ['tx-imac-1']));
    });

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).not.toBe('pushed');
    expect((outcome as { message: string }).message).toMatch(
      /no longer holds this device's data/,
    );
    expect((outcome as { message: string }).message).toMatch(/NOT been recorded as backed up/);

    // THE POINT: no false agreement. This device still descends from what it
    // did before, still counts itself dirty, and will push again.
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
    expect(await hasLocalChanges()).toBe(true);
    expect(await txIds()).toEqual(['tx-1', 'tx-2']);
    // What is in Drive is the write that came second, and the next sync says
    // so rather than reporting everything is fine.
    expect(drive.head().snapshotId).toBe('stranger-1');
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');
  });
});

// ===========================================================================
describe('a sync file that is in the bin, or gone', () => {
  it('refuses a trashed file, and will not start a second one beside it', async () => {
    const ours = await seedLineage(['tx-1']);
    const fileId = drive.only().id;
    drive.trash(fileId);
    const mark = drive.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    // The message has to be the one about the BIN, not the one about a file
    // that is gone: they lead to different actions, and only one of them ends
    // with the owner clicking Restore.
    expect((outcome as { message: string }).message).toMatch(/is in Google Drive's bin/);
    expect((outcome as { message: string }).message).not.toMatch(/no longer in your Google Drive/);
    // Nothing uploaded, nothing created: the file in the bin is one click from
    // being restored, and a second lineage started beside it is not.
    expect(drive.uploadsSince(mark)).toEqual([]);
    expect(drive.files.size).toBe(1);
    expect((JSON.parse(drive.files.get(fileId)!.content) as SyncSnapshot).snapshotId).toBe(
      ours.snapshotId,
    );

    // Even asked outright to start a new file: a trashed file is not a missing
    // file, so 'reseed-remote' is not an answer to this question.
    const forced = await syncNow(laptop.transport, { resolve: 'reseed-remote' });
    expect(forced.kind).toBe('error');
    expect((forced as { message: string }).message).toMatch(/is in Google Drive's bin/);
    expect(drive.files.size).toBe(1);
    expect(drive.uploadsSince(mark)).toEqual([]);
  });

  it('stops when the file is gone, and starts a new lineage only when told to', async () => {
    const ours = await seedLineage(['tx-1']);
    drive.remove(drive.only().id);
    const mark = drive.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/no longer in your Google Drive/);
    // A device with 47 revisions of history quietly starting again at 1 is how
    // two files called mymoney-sync.json end up holding two different books.
    expect(drive.files.size).toBe(0);
    expect(drive.uploadsSince(mark)).toEqual([]);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(ours.snapshotId);

    // The owner decides. Only then does a new lineage begin — and it IS a new
    // one: a fresh identity, descending from nothing, numbered from 1.
    const reseeded = await syncNow(laptop.transport, { resolve: 'reseed-remote' });

    expect(reseeded).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(drive.files.size).toBe(1);
    const head = drive.head();
    expect(head.snapshotId).not.toBe(ours.snapshotId);
    expect(head.parentSnapshotId).toBeNull();
    expect(head.ancestry).toEqual([]);
    expect(drive.props()).toMatchObject({ revision: '1', parentSnapshotId: '' });
    expect(await txIds()).toEqual(['tx-1']);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(head.snapshotId);
  });
});

// ===========================================================================
describe('what Drive says when it refuses', () => {
  it('reports a full Drive as permanent, and being busy as temporary', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1']);

    // Drive overloads 403: only error.errors[].reason tells "your Drive is
    // full" apart from "you asked too often".
    drive.refuseNextUpload(
      403,
      'storageQuotaExceeded',
      "The user's Drive storage quota has been exceeded.",
    );
    const full = await syncNow(laptop.transport);

    expect(full.kind).toBe('error');
    const fullMessage = (full as { message: string }).message;
    expect(fullMessage).toMatch(/Drive is full/);
    expect(fullMessage).toMatch(/Free up space/);
    // The defect this replaced: telling the owner to "try again shortly" for
    // ever, while every push failed and the off-site copy stopped advancing.
    expect(fullMessage).not.toMatch(/try again shortly/);
    // Nothing was created, and the device knows it still holds the only copy.
    expect(drive.files.size).toBe(0);
    expect((await getSettings()).syncLastPulledRevision).toBe(0);
    expect(await hasLocalChanges()).toBe(true);

    // The same shape of failure that IS temporary reads as temporary.
    drive.refuseNextUpload(429, 'rateLimitExceeded', 'Rate Limit Exceeded');
    const limited = await syncNow(laptop.transport);
    expect((limited as { message: string }).message).toMatch(/try again shortly/);
    expect((limited as { message: string }).message).not.toMatch(/Drive is full/);

    drive.refuseNextUpload(503, undefined, 'Backend Error');
    const busy = await syncNow(laptop.transport);
    expect((busy as { message: string }).message).toMatch(/busy right now \(HTTP 503\)/);

    // And when Drive stops saying no, the very same push goes through — the
    // refusals were about Drive, never about this snapshot.
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(drive.files.size).toBe(1);
  });

  it('renews a token that expired mid-session without bothering the owner', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1']);
    // Tokens last about an hour, so an expiry mid-session is normal traffic,
    // not an error to show anyone.
    drive.expire('token-1');

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(drive.calls.some((c) => c.token === 'token-1')).toBe(true);
    expect(drive.calls.some((c) => c.token === 'token-2')).toBe(true);
    expect(drive.head().tables.transactions).toHaveLength(1);
  });
});

// ===========================================================================
describe('a conflict the owner has settled', () => {
  it('keeps this device and lands ON TOP of the snapshot it was shown', async () => {
    const ours = await seedLineage(['tx-1']);

    // A stranger's book is the head: unrelated lineage, same revision number.
    drive.strangerUpdates(strangerSnapshot(1, ['tx-imac-1', 'tx-imac-2']));
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');

    // The owner has now SEEN both sides and chosen this device. The remote is
    // written to a safety file first — a resolution without that copy is the
    // unrecoverable loss this feature is not allowed to cause.
    const saved: string[] = [];
    const resolved = await syncNow(laptop.transport, {
      resolve: 'keep-local',
      saveBackup: async (_file, fileName) => {
        saved.push(fileName);
        return 'saved';
      },
    });

    expect(saved).toHaveLength(1);
    expect(saved[0]).toMatch(/^mymoney-conflict-remote-rev1-/);
    // Above BOTH sides, so the number never goes backwards for anyone.
    expect(resolved).toMatchObject({ kind: 'pushed', revision: 2 });

    // THE SEAM: the engine declared the snapshot the user chose to discard as
    // this push's parent, and the transport let the write land only because
    // that snapshot was still the head. The chain records the overwrite
    // honestly rather than pretending the stranger never existed.
    const head = drive.head();
    expect(head.parentSnapshotId).toBe('stranger-1');
    expect(drive.props()).toMatchObject({ revision: '2', parentSnapshotId: 'stranger-1' });
    expect((head.tables.transactions as Transaction[]).map((t) => t.id)).toEqual(['tx-1']);
    expect(drive.files.size).toBe(1);
    expect(head.snapshotId).not.toBe(ours.snapshotId);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(head.snapshotId);
    // And the device is back in step: nothing left to send.
    expect(await syncNow(laptop.transport)).toEqual({
      kind: 'up-to-date',
      snapshotId: head.snapshotId,
    });
  });

  it('refuses that same resolution when a THIRD write lands during the save', async () => {
    const ours = await seedLineage(['tx-1']);
    drive.strangerUpdates(strangerSnapshot(1, ['tx-imac-1']));
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');

    // This is the longest window in the whole feature: a multi-megabyte
    // download plus a save dialog that can sit open for minutes. A third
    // device writing inside it must not be flattened by a decision the owner
    // took about a different snapshot. Head reads in this call: the engine's,
    // the download's, then the transport's precondition — so the third is the
    // window, and the interloper's revision is BELOW the one being written so
    // that only the identity check can be what refuses.
    drive.beforeHeadRead(3, () => {
      drive.strangerUpdates(strangerSnapshot(1, ['tx-third-1']));
    });
    const mark = drive.mark();
    const saved: string[] = [];

    const outcome = await syncNow(laptop.transport, {
      resolve: 'keep-local',
      saveBackup: async (_file, fileName) => {
        saved.push(fileName);
        return 'saved';
      },
    });

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(
      /Another device saved to Google Drive while this one was preparing its upload/,
    );
    expect((outcome as { message: string }).message).not.toMatch(/already at version/);
    // Nothing uploaded, the third device's book untouched, and this device
    // exactly where it was — the resolution simply did not happen.
    expect(drive.uploadsSince(mark)).toEqual([]);
    expect(drive.head().snapshotId).toBe('stranger-2');
    expect(drive.files.size).toBe(1);
    expect(await txIds()).toEqual(['tx-1']);
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
    // The safety copy of the side that was about to lose was still written
    // before anything was attempted, and the next sync asks again.
    expect(saved).toHaveLength(1);
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');
  });
});

// ===========================================================================
describe('the owner types while the sync is running', () => {
  it('abandons the pull rather than destroying the row that just landed', async () => {
    const first = await seedLineage(['tx-1']);

    // The other device pushes, so this one is exactly one pull behind and
    // perfectly clean — the case that applies a remote over the whole book.
    await atDevice(imac);
    expect((await syncNow(imac.transport)).kind).toBe('pulled');
    await type('tx-imac');
    expect(await syncNow(imac.transport)).toMatchObject({ kind: 'pushed', revision: 2 });

    await atDevice(laptop);
    expect(await hasLocalChanges()).toBe(false);
    const mark = drive.mark();

    // The app stays fully interactive during the download (the quick-add
    // button is mounted on every screen), so the owner saves a transaction
    // inside it. restoreBackup clears every table; without the re-check inside
    // that transaction this row would exist nowhere at all.
    drive.duringNextDownload(async () => {
      await type('tx-typed-mid-sync');
    });

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(
      /This device changed while the sync was running, so nothing was replaced/,
    );
    // NOT ONE ROW written: the pull was abandoned whole, the typed row is
    // still here, and the remote's rows have not arrived.
    expect(await txIds()).toEqual(['tx-1', 'tx-typed-mid-sync']);
    expect(drive.uploadsSince(mark)).toEqual([]);
    // And no false agreement recorded in either direction.
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(first.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
    expect(await hasLocalChanges()).toBe(true);

    // The change survived to be offered properly: both sides have moved, so
    // the next sync asks instead of picking a winner.
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');
  });
});
