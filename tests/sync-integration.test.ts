// The SEAM between the two halves of Dropbox sync (D42/D44/D45; SPEC §8.3, §2.6).
//
// tests/sync-engine.test.ts fakes SyncTransport at the interface, so the real
// transport never runs. tests/sync-transport.test.ts fakes `fetch` and never
// imports the engine, so the real syncNow never runs. Both files are green,
// and between them is a seam that nothing crosses — which is exactly where the
// fatal defect lived. The engine decides what its book DESCENDS FROM and
// declares that parent on the way out; the transport refuses the write unless
// the file it is replacing is still the one that decision was made against.
// Those are two different modules answering the same question — "has the head
// moved?" — and until this file nothing checked that they answer it the same
// way.
//
// So here the REAL syncNow() drives the REAL createDropboxTransport(). Only two
// things are faked, and both sit outside our code:
//
//  * `fetch` — a stand-in for the Dropbox HTTP API, written to the behaviours
//    the design actually rests on rather than to a convenient simplification:
//      - files/upload with `mode: update(<rev>)` is a TRUE COMPARE-AND-SWAP:
//        the precondition and the bytes are ONE request, so a rev that has
//        moved means the bytes are refused rather than landing on top of
//        someone else's book. There is no window to lose;
//      - the `"update"` STRING shorthand is rejected with the same 400 Dropbox
//        gives, because the shorthand is legal only for Void union members and
//        a transport that sent it would silently lose its precondition;
//      - a rev is OPAQUE, unguessable from the last one, and changes on every
//        write — content and rev move together and cannot be separated;
//      - `content_hash` is verified, so a body that did not survive the trip
//        is refused rather than stored;
//      - files/get_metadata with `include_deleted` tells a DELETED file (still
//        restorable) apart from one that never existed — the difference
//        between "there is no file" and "the file is one click from coming
//        back" (C13);
//      - failures come back shaped the way Dropbox shapes them: 401 for a
//        token that has expired mid-session, 409 whose NESTED `.tag` is the
//        only thing that tells a FULL ACCOUNT apart from a lost race, and
//        429/5xx for "busy, come back later".
//  * the OAuth token provider — no Dropbox, no popup, no network.
//
// Everything else is the shipping code: the decision table, Dexie (through
// fake-indexeddb), exportBackup/restoreBackup, the upload's compare-and-swap
// and content hash, and the settings bookkeeping.
//
// WHAT IS NO LONGER HERE, because the migration deleted the thing it tested:
// the Drive fake merged appProperties per key, and fourteen tests in this file
// existed to pin the damage that caused (C18/C19). Identity now travels INSIDE
// the body, which every write replaces whole, so it cannot be inherited by a
// foreign writer at all — the block at "identity cannot be inherited" pins
// that structural claim instead. There is likewise no post-write read-back
// (`confirmLanded()`): Drive's 200 said only that the bytes were stored, while
// a Dropbox 200 carries the new rev and content hash of the write it accepted.
//
// A SECOND DEVICE IS A REAL DEVICE HERE. There is one IndexedDB in this
// process, so `atDevice()` parks one browser profile's rows and loads the
// other's — settings row included, which is where a device's identity, its
// ancestry bookkeeping and its change counters live. Both devices then run the
// same real engine against the same fake Dropbox, which is the only way to say
// "and the other device agrees" and mean it.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
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
import {
  createDropboxTransport,
  DROPBOX_CONTENT,
  DROPBOX_RPC,
  SYNC_FILE_NAME,
  SYNC_FILE_PATH,
  type HeadObservation,
  type HeadStore,
} from '../src/sync/transport';
import type { TokenProvider } from '../src/sync/dropboxAuth';
import type { SyncSnapshot, SyncTransport } from '../src/sync/types';
import { remoteRelation, revisionWords, type SyncFacts } from '../src/ui/settings/syncFormat';
import type { Account, Category, Transaction } from '../src/db/types';

const clone = <T>(x: T): T => structuredClone(x);
const T0 = '2026-08-01T10:00:00.000Z';

// ===========================================================================
// A fake Dropbox, at the HTTP layer
// ===========================================================================
//
// Modelled on the behaviours the design actually rests on, not on a convenient
// simplification:
//
//   * files/upload with mode update(rev) is a REAL COMPARE-AND-SWAP. A rev
//     that no longer matches is refused with a 409 conflict, and the bytes
//     never land. There is no window between the check and the write, because
//     they are the same request.
//   * A rev is OPAQUE and changes on every write. Content and rev move
//     together and cannot be separated — which is precisely what Drive's
//     appProperties could not promise.
//   * files/get_metadata with include_deleted tells a DELETED file (still
//     restorable) apart from one that never existed.
//   * failures come back shaped the way Dropbox shapes them: 401 for an access
//     token that expired mid-session, 409 whose nested `.tag` is the only
//     thing that tells a FULL account from a lost race, and 429/5xx for
//     "busy, come back later".

interface StoredFile {
  rev: string;
  content: string;
}

interface Call {
  method: string;
  url: string;
  token: string;
  upload: boolean;
  download: boolean;
  /** The parsed Dropbox-API-Arg, for content endpoints. */
  arg: Record<string, unknown> | null;
}

function dropboxError(summary: string, error: unknown): string {
  return JSON.stringify({ error_summary: summary, error });
}

const CONFLICT_BODY = dropboxError('path/conflict/file/.', {
  '.tag': 'path',
  reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } },
});
const NOT_FOUND_BODY = dropboxError('path/not_found/.', {
  '.tag': 'path',
  path: { '.tag': 'not_found' },
});

function sha256Hex(text: string): string {
  return createHash('sha256').update(Buffer.from(text, 'utf8')).digest('hex');
}

/** Dropbox's content hash for anything under 4 MiB (every snapshot here). */
function contentHash(text: string): string {
  return createHash('sha256')
    .update(createHash('sha256').update(Buffer.from(text, 'utf8')).digest())
    .digest('hex');
}

class FakeDropbox {
  /** The one file, or null. Dropbox addresses by PATH, so there is no id and
   *  nothing for a device to cache and get wrong. */
  file: StoredFile | null = null;
  /** It existed once. Dropbox keeps a deleted file restorable for 30 days, so
   *  "deleted" and "never existed" are different answers (rule 2). */
  everExisted = false;
  readonly calls: Call[] = [];
  private revCounter = 0;
  private expiredToken: string | null = null;
  private uploadRefusal: { status: number; body: string } | null = null;
  private downloadHook: (() => void | Promise<void>) | null = null;
  private preDownloadHook: (() => void) | null = null;
  private uploadedHook: (() => void) | null = null;
  private uploadingHook: (() => void) | null = null;
  private headReadHook: { countdown: number; fn: () => void } | null = null;

  /** Opaque, and deliberately not guessable from the last one. */
  private nextRev(): string {
    this.revCounter += 1;
    return `0${sha256Hex(`rev-${this.revCounter}`).slice(0, 12)}`;
  }

  // ---- what a test looks at -------------------------------------------

  exists(): boolean {
    return this.file !== null;
  }
  only(): StoredFile {
    if (!this.file) throw new Error('expected a live sync file, found none');
    return this.file;
  }
  head(): SyncSnapshot {
    return JSON.parse(this.only().content) as SyncSnapshot;
  }
  rev(): string {
    return this.only().rev;
  }
  mark(): number {
    return this.calls.length;
  }
  callsSince(mark: number): Call[] {
    return this.calls.slice(mark);
  }
  uploadsSince(mark: number): Call[] {
    return this.callsSince(mark).filter((c) => c.upload);
  }
  downloadsSince(mark: number): Call[] {
    return this.callsSince(mark).filter((c) => c.download);
  }

  // ---- what a test does to it ------------------------------------------

  /**
   * Another client replaces the file: some other tool, an older build, a hand
   * edit. Content AND rev change together — there is no way to change one
   * without the other, which is the property that makes RC2 impossible.
   */
  strangerUpdates(snap: SyncSnapshot): void {
    this.file = { rev: this.nextRev(), content: JSON.stringify(snap) };
    this.everExisted = true;
  }
  /** Put a captured copy back exactly as it was. */
  restoreFile(copy: StoredFile): void {
    this.file = { ...copy };
    this.everExisted = true;
  }
  /** Deleted, but restorable — Dropbox's equivalent of Drive's bin. */
  trash(): void {
    this.file = null;
  }
  /** Gone for good: the account was emptied, or this is a different account. */
  remove(): void {
    this.file = null;
    this.everExisted = false;
  }
  expire(token: string): void {
    this.expiredToken = token;
  }
  refuseNextUpload(status: number, body: string): void {
    this.uploadRefusal = { status, body };
  }
  duringNextDownload(fn: () => void | Promise<void>): void {
    this.downloadHook = fn;
  }
  /**
   * Run `fn` immediately BEFORE the next download picks up its bytes — the
   * window between a head read and the body arriving, so the download returns
   * what `fn` left behind rather than what the head described.
   */
  beforeNextDownload(fn: () => void): void {
    this.preDownloadHook = fn;
  }
  afterNextUpload(fn: () => void): void {
    this.uploadedHook = fn;
  }
  /**
   * Run `fn` in the instant BEFORE the next upload is judged — after the
   * client has settled on everything it knows, and before its bytes arrive.
   *
   * ON DRIVE THERE WAS NO SUCH MOMENT TO TEST. The nearest thing was the gap
   * between the transport's last head read and its PATCH, and that gap could
   * only be made smaller, never closed. Here it is the whole of the remaining
   * race, and closing it is what `mode: update(rev)` is for: whatever `fn`
   * leaves behind changes the rev, so the upload that follows is refused
   * rather than landing on top of it.
   */
  beforeNextUpload(fn: () => void): void {
    this.uploadingHook = fn;
  }
  /**
   * Run `fn` immediately before the Nth head read (files/get_metadata) from
   * now. It is how a test opens the window between the engine's decision and
   * the transport's write.
   */
  beforeHeadRead(n: number, fn: () => void): void {
    this.headReadHook = { countdown: n, fn };
  }

  // ---- the API ---------------------------------------------------------

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    const rawArg = headers['dropbox-api-arg'] ?? null;
    const upload = url === `${DROPBOX_CONTENT}/files/upload`;
    const download = url === `${DROPBOX_CONTENT}/files/download`;
    this.calls.push({
      method,
      url,
      token,
      upload,
      download,
      arg: rawArg ? (JSON.parse(rawArg) as Record<string, unknown>) : null,
    });

    const reply = (status: number, body: string, extra: Record<string, string> = {}) =>
      ({
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
        headers: { get: (k: string) => extra[k.toLowerCase()] ?? null },
      }) as unknown as Response;
    const json = (status: number, body: unknown, extra?: Record<string, string>) =>
      reply(status, JSON.stringify(body), extra);

    if (token === '' || token === this.expiredToken) {
      // What Dropbox says to a token that has run out. The transport is
      // expected to refresh, retry once, and tell the owner nothing.
      return json(401, { error_summary: 'expired_access_token/...' });
    }

    const metadata = () => ({
      '.tag': 'file',
      name: SYNC_FILE_NAME,
      path_lower: SYNC_FILE_PATH,
      id: 'id:mymoney',
      rev: this.only().rev,
      size: Buffer.byteLength(this.only().content, 'utf8'),
      content_hash: contentHash(this.only().content),
      server_modified: '2026-08-27T09:15:00Z',
    });

    if (url === `${DROPBOX_RPC}/files/get_metadata`) {
      if (this.headReadHook) {
        this.headReadHook.countdown -= 1;
        if (this.headReadHook.countdown === 0) {
          const { fn } = this.headReadHook;
          this.headReadHook = null;
          fn();
        }
      }
      const arg = JSON.parse(String(init.body ?? '{}')) as { include_deleted?: boolean };
      if (this.file) return json(200, metadata());
      if (this.everExisted && arg.include_deleted === true) {
        // EXISTS AND IS RESTORABLE. Answering "no such file" here is what let a
        // device start a second lineage beside a file one click from coming
        // back (C13).
        return json(200, { '.tag': 'deleted', name: SYNC_FILE_NAME, path_lower: SYNC_FILE_PATH });
      }
      return reply(409, NOT_FOUND_BODY);
    }

    if (download) {
      if (!this.file) return reply(409, NOT_FOUND_BODY);
      const pre = this.preDownloadHook;
      this.preDownloadHook = null;
      pre?.();
      const described = metadata();
      const body = this.only().content;
      // Between the headers and the body: the multi-megabyte download during
      // which the app stays fully interactive.
      const hook = this.downloadHook;
      this.downloadHook = null;
      if (hook) await hook();
      return reply(200, body, { 'dropbox-api-result': JSON.stringify(described) });
    }

    if (upload) {
      if (this.uploadRefusal) {
        const { status, body } = this.uploadRefusal;
        this.uploadRefusal = null;
        return reply(status, body);
      }
      const uploading = this.uploadingHook;
      this.uploadingHook = null;
      uploading?.();
      const arg = JSON.parse(rawArg ?? '{}') as {
        mode: { '.tag'?: string; update?: string } | string;
        autorename?: boolean;
        content_hash?: string;
      };
      // The shorthand is legal only for Void union members, and `update`
      // carries a rev. A transport that ever sent it would be told so here,
      // exactly as Dropbox would.
      if (typeof arg.mode === 'string' && arg.mode === 'update') {
        return reply(400, 'Invalid select-union tag "update". This shorthand is not allowed for non-Void members.');
      }
      const tag = typeof arg.mode === 'string' ? arg.mode : arg.mode['.tag'];
      const wanted = typeof arg.mode === 'string' ? undefined : arg.mode.update;
      const content =
        init.body instanceof Uint8Array ? Buffer.from(init.body).toString('utf8') : String(init.body);
      if (arg.content_hash && arg.content_hash !== contentHash(content)) {
        return reply(409, dropboxError('content_hash_mismatch/.', { '.tag': 'content_hash_mismatch' }));
      }
      // THE COMPARE-AND-SWAP. Nothing here is advisory: a rev that has moved
      // means the bytes are refused, in the same request that carried them.
      const conflicted =
        tag === 'add' ? this.file !== null : this.file === null || this.file.rev !== wanted;
      if (conflicted) return reply(409, CONFLICT_BODY);

      const rev = this.nextRev();
      this.file = { rev, content };
      this.everExisted = true;
      // Anything armed here runs once our bytes are in.
      const hook = this.uploadedHook;
      this.uploadedHook = null;
      hook?.();
      return json(200, {
        name: SYNC_FILE_NAME,
        path_lower: SYNC_FILE_PATH,
        id: 'id:mymoney',
        rev,
        size: Buffer.byteLength(content, 'utf8'),
        content_hash: contentHash(content),
        server_modified: '2026-08-27T09:16:00Z',
      });
    }

    throw new Error(`fake Dropbox got an unexpected request: ${method} ${url}`);
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
  // Each browser profile has its own localStorage, so each device remembers
  // the head separately — and one of them going stale is a case the real
  // transport has to handle rather than a detail to fake away.
  //
  // A rev names one immutable file content, so a stale entry cannot describe
  // the wrong file; it can only be about a file that has moved on, which is
  // exactly the case worth exercising.
  let observed: HeadObservation | null = null;
  return {
    name,
    id,
    parked: freshProfile(name, id),
    transport: createDropboxTransport({
      auth: fakeAuth,
      headStore: {
        get: () => observed,
        set: (v: HeadObservation | null) => {
          observed = v;
        },
      } satisfies HeadStore,
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

let dropbox: FakeDropbox;
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
  dropbox = new FakeDropbox();
  vi.stubGlobal('fetch', dropbox.fetch);
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
  return dropbox.head();
}

// ===========================================================================
describe('a lineage begins', () => {
  it('seeds an empty Dropbox, and a second device pulls the same book', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1', 'tx-2']);

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({ kind: 'pushed', revision: 1 });
    const head = dropbox.head();
    expect(dropbox.exists()).toBe(true);
    expect(SYNC_FILE_PATH).toBe(`/${SYNC_FILE_NAME}`);
    // IDENTITY IS IN THE BODY, and nowhere else. There is no second store
    // beside the file that could describe a different snapshot from the one
    // the bytes contain — which is what RC2 needed and cannot have here.
    expect(head).toMatchObject({
      app: 'MyMoney',
      revision: 1,
      deviceName: 'Laptop',
      schemaVersion: SCHEMA_VERSION,
    });
    expect(head.snapshotId).toBeTruthy();
    expect(head.parentSnapshotId).toBeNull();
    expect(head.ancestry).toEqual([]);
    // The rev is the transport's business and the transport's alone: it is
    // opaque, it came from Dropbox, and nothing in the snapshot mentions it.
    expect(JSON.stringify(head)).not.toContain(dropbox.rev());
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
    const mark = dropbox.mark();
    expect(await syncNow(imac.transport)).toEqual({
      kind: 'up-to-date',
      snapshotId: head.snapshotId,
    });
    expect(dropbox.uploadsSince(mark)).toEqual([]);

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
    const firstRev = dropbox.rev();

    // The iMac pulls, adds something, pushes.
    await atDevice(imac);
    expect((await syncNow(imac.transport)).kind).toBe('pulled');
    await type('tx-imac');
    expect(await syncNow(imac.transport)).toMatchObject({ kind: 'pushed', revision: 2 });

    const second = dropbox.head();
    expect(second.parentSnapshotId).toBe(first.snapshotId);
    expect(second.ancestry).toEqual([first.snapshotId]);
    expect(second.revision).toBe(2);
    // A new write is a new rev, always. Content and rev move together.
    expect(dropbox.rev()).not.toBe(firstRev);

    // The laptop pulls it and pushes on top.
    await atDevice(laptop);
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pulled', revision: 2 });
    expect(await txIds()).toEqual(['tx-1', 'tx-imac']);
    await type('tx-laptop-2');
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 3 });

    const third = dropbox.head();
    expect(third.parentSnapshotId).toBe(second.snapshotId);
    // Newest first, and it carries the whole chain — that is what lets a
    // device two pushes behind prove it is behind rather than diverged.
    expect(third.ancestry).toEqual([second.snapshotId, first.snapshotId]);

    // The iMac fast-forwards, and both books are identical again.
    await atDevice(imac);
    expect(await syncNow(imac.transport)).toMatchObject({ kind: 'pulled', revision: 3 });
    expect(await txIds()).toEqual(['tx-1', 'tx-imac', 'tx-laptop-2']);
    const onImac = await dataRows();
    await atDevice(laptop);
    expect(await dataRows()).toEqual(onImac);

    // ONE file the whole way through: three revisions of one lineage, never a
    // second mymoney-sync.json created beside it. Dropbox addresses by PATH,
    // so there is no file id for a device to cache and get wrong — the whole
    // class of "found the other copy" bugs has nowhere to live.
    expect(dropbox.exists()).toBe(true);
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
    dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1', 'tx-imac-2', 'tx-imac-3']));
    const mark = dropbox.mark();

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
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect(dropbox.head().snapshotId).toBe('stranger-1');
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
  });

  it('refuses the push the engine authorised when the head moved under it', async () => {
    const ours = await seedLineage(['tx-1']);
    const untouched = clone(dropbox.only());
    await type('tx-2'); // ⇒ dirty, so this sync will decide to push

    // The stranger lands in the ONE window that matters: after the engine has
    // read the head and decided to descend from `ours`, and before the bytes
    // arrive. Its revision is BELOW the one we are about to write, so no
    // comparison of revision NUMBERS could save us.
    //
    // AND NOTE WHERE THE REFUSAL NOW COMES FROM. The transport does not
    // re-read the head to catch this; it sends the rev it already observed,
    // and Dropbox rejects the upload because that rev has moved. The
    // precondition and the bytes are one request, so there is no window left
    // between them to lose.
    dropbox.beforeNextUpload(() => {
      dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1']));
    });
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    // The engine declared a parent; the transport found the head was no longer
    // that snapshot and refused. Nothing was uploaded at all.
    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(
      /Another device saved to Dropbox while this one was preparing its upload/,
    );
    // The upload was ATTEMPTED and REFUSED — which is the improvement. On
    // Drive the only way to be sure was to write and then look; here the bytes
    // are turned away at the door and the stranger's file is untouched.
    expect(dropbox.uploadsSince(mark)).toHaveLength(1);
    expect(dropbox.head().snapshotId).toBe('stranger-1');

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
    dropbox.restoreFile(untouched);
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 2 });
    expect(dropbox.head().parentSnapshotId).toBe(ours.snapshotId);
  });

  it('records the push it really made, and catches the overwrite on the NEXT sync', async () => {
    // THE DRIVE VERSION OF THIS TEST ASSERTED THE OPPOSITE, and it is worth
    // saying why it changed rather than quietly rewriting it.
    //
    // On Drive a 200 from the upload said only that the bytes had been
    // accepted; another device could replace them a moment later, so the
    // transport read the file BACK and refused to report success if what it
    // found was not its own. That read-back could never actually close the
    // window — a stranger writing one instant later still won — it only made
    // it smaller. Here the upload is a compare-and-swap, so a 200 means "this
    // write was the one that landed at that rev", which is a fact and stays a
    // fact. Reporting 'pushed' is therefore TRUE.
    //
    // What must still hold — and this is the safety property, not the
    // read-back — is that a device never goes on believing Dropbox holds its
    // book once somebody else has replaced it. That is checked below.
    const ours = await seedLineage(['tx-1']);
    await type('tx-2');

    dropbox.afterNextUpload(() => {
      dropbox.strangerUpdates(strangerSnapshot(9, ['tx-imac-1']));
    });

    const outcome = await syncNow(laptop.transport);

    // Our write genuinely landed. Saying so is not a false claim.
    expect(outcome).toMatchObject({ kind: 'pushed', revision: 2 });
    expect(await txIds()).toEqual(['tx-1', 'tx-2']);

    // And the very next sync notices the file is no longer ours and ASKS,
    // rather than reporting everything is fine or pushing over it.
    expect(dropbox.head().snapshotId).toBe('stranger-1');
    const mark = dropbox.mark();
    const next = await syncNow(laptop.transport);
    expect(next.kind).toBe('conflict');
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect(dropbox.head().snapshotId).toBe('stranger-1');
    expect(ours.snapshotId).toBeTruthy();
  });
});

// ===========================================================================
describe('a sync file that is deleted, or gone for good', () => {
  it('refuses a deleted file, and will not start a second one beside it', async () => {
    const ours = await seedLineage(['tx-1']);
    const deleted = clone(dropbox.only());
    dropbox.trash();
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    // The message has to be the one about the BIN, not the one about a file
    // that is gone: they lead to different actions, and only one of them ends
    // with the owner clicking Restore.
    // The message has to be the one about a RESTORABLE file, not the one
    // about a file that is gone: they lead to different actions, and only one
    // of them ends with the owner clicking Restore.
    expect((outcome as { message: string }).message).toMatch(/deleted files/);
    expect((outcome as { message: string }).message).not.toMatch(/no longer in your Dropbox/);
    // Nothing uploaded, nothing created: a deleted Dropbox file is restorable
    // for 30 days, and a second lineage started beside it is not.
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect(dropbox.exists()).toBe(false);
    expect((JSON.parse(deleted.content) as SyncSnapshot).snapshotId).toBe(ours.snapshotId);

    // Even asked outright to start a new file: a trashed file is not a missing
    // file, so 'reseed-remote' is not an answer to this question.
    const forced = await syncNow(laptop.transport, { resolve: 'reseed-remote' });
    expect(forced.kind).toBe('error');
    expect((forced as { message: string }).message).toMatch(/deleted files/);
    expect(dropbox.exists()).toBe(false);
    expect(dropbox.uploadsSince(mark)).toEqual([]);
  });

  it('stops when the file is gone, and starts a new lineage only when told to', async () => {
    const ours = await seedLineage(['tx-1']);
    dropbox.remove();
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/no longer in your Dropbox/);
    // A device with 47 revisions of history quietly starting again at 1 is how
    // two files called mymoney-sync.json end up holding two different books.
    expect(dropbox.exists()).toBe(false);
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(ours.snapshotId);

    // The owner decides. Only then does a new lineage begin — and it IS a new
    // one: a fresh identity, descending from nothing, numbered from 1.
    const reseeded = await syncNow(laptop.transport, { resolve: 'reseed-remote' });

    expect(reseeded).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(dropbox.exists()).toBe(true);
    const head = dropbox.head();
    expect(head.snapshotId).not.toBe(ours.snapshotId);
    expect(head.parentSnapshotId).toBeNull();
    expect(head.ancestry).toEqual([]);
    expect(head.revision).toBe(1);
    // A create, not an overwrite: `add` is the only mode that cannot land on
    // top of something that reappeared in the meantime.
    expect(dropbox.uploadsSince(mark).at(-1)!.arg!.mode).toEqual({ '.tag': 'add' });
    expect(await txIds()).toEqual(['tx-1']);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(head.snapshotId);
  });
});

// ===========================================================================
describe('what Dropbox says when it refuses', () => {
  it('reports a full account as permanent, and being busy as temporary', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1']);

    // Dropbox nests the reason inside the 409 body, and that nested tag is the
    // only thing that tells "your account is full" apart from a lost race.
    dropbox.refuseNextUpload(
      409,
      JSON.stringify({
        error_summary: 'path/insufficient_space/...',
        error: { '.tag': 'path', reason: { '.tag': 'insufficient_space' } },
      }),
    );
    const full = await syncNow(laptop.transport);

    expect(full.kind).toBe('error');
    const fullMessage = (full as { message: string }).message;
    expect(fullMessage).toMatch(/Dropbox is full/);
    expect(fullMessage).toMatch(/Free up space/);
    // The defect this replaced: telling the owner to "try again shortly" for
    // ever, while every push failed and the off-site copy stopped advancing.
    expect(fullMessage).not.toMatch(/try again shortly/);
    // Nothing was created, and the device knows it still holds the only copy.
    expect(dropbox.exists()).toBe(false);
    expect((await getSettings()).syncLastPulledRevision).toBe(0);
    expect(await hasLocalChanges()).toBe(true);

    // The same shape of failure that IS temporary reads as temporary.
    dropbox.refuseNextUpload(429, '{}');
    const limited = await syncNow(laptop.transport);
    expect((limited as { message: string }).message).toMatch(/try again shortly/);
    expect((limited as { message: string }).message).not.toMatch(/Dropbox is full/);

    dropbox.refuseNextUpload(503, '{}');
    const busy = await syncNow(laptop.transport);
    expect((busy as { message: string }).message).toMatch(/busy right now \(HTTP 503\)/);

    // And when Dropbox stops saying no, the very same push goes through — the
    // refusals were about Dropbox, never about this snapshot.
    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(dropbox.exists()).toBe(true);
  });

  it('renews a token that expired mid-session without bothering the owner', async () => {
    await atDevice(laptop);
    await seedBook(['tx-1']);
    // Access tokens are short-lived, so an expiry mid-session is normal
    // traffic, not an error to show anyone — and unlike Drive, renewing one
    // needs no window, no live browser session and no user at the keyboard.
    dropbox.expire('token-1');

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({ kind: 'pushed', revision: 1 });
    expect(dropbox.calls.some((c) => c.token === 'token-1')).toBe(true);
    expect(dropbox.calls.some((c) => c.token === 'token-2')).toBe(true);
    expect(dropbox.head().tables.transactions).toHaveLength(1);
  });
});

// ===========================================================================
describe('a conflict the owner has settled', () => {
  it('keeps this device and lands ON TOP of the snapshot it was shown', async () => {
    const ours = await seedLineage(['tx-1']);

    // A stranger's book is the head: unrelated lineage, same revision number.
    dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1', 'tx-imac-2']));
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
    const head = dropbox.head();
    expect(head.parentSnapshotId).toBe('stranger-1');
    expect(head.revision).toBe(2);
    expect((head.tables.transactions as Transaction[]).map((t) => t.id)).toEqual(['tx-1']);
    expect(dropbox.exists()).toBe(true);
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
    dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1']));
    expect((await syncNow(laptop.transport)).kind).toBe('conflict');

    // This is the longest window in the whole feature: a multi-megabyte
    // download plus a save dialog that can sit open for minutes. A third
    // device writing inside it must not be flattened by a decision the owner
    // took about a different snapshot. The interloper lands at the very last
    // instant — after everything this device could possibly have read, and
    // before its bytes are judged — and its revision is BELOW the one being
    // written, so no comparison of numbers could be what refuses it.
    dropbox.beforeNextUpload(() => {
      dropbox.strangerUpdates(strangerSnapshot(1, ['tx-third-1']));
    });
    const mark = dropbox.mark();
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
      /Another device saved to Dropbox while this one was preparing its upload/,
    );
    // The bytes were sent and REFUSED. The third device's book is untouched
    // and this device is exactly where it was — the resolution simply did not
    // happen.
    expect(dropbox.uploadsSince(mark)).toHaveLength(1);
    expect(dropbox.head().snapshotId).toBe('stranger-2');
    expect(dropbox.exists()).toBe(true);
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
    const mark = dropbox.mark();

    // The app stays fully interactive during the download (the quick-add
    // button is mounted on every screen), so the owner saves a transaction
    // inside it. restoreBackup clears every table; without the re-check inside
    // that transaction this row would exist nowhere at all.
    dropbox.duringNextDownload(async () => {
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
    expect(dropbox.uploadsSince(mark)).toEqual([]);
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

// ===========================================================================
// RC2 — the failure that used to live here, and no longer has anywhere to live
// ===========================================================================
//
// THE DRIVE VERSION OF THIS FILE HAD FOURTEEN TESTS AT THIS POINT, and they
// are gone because their premise is gone. It is worth writing down what they
// were, so that nobody reads the shorter file as weaker coverage.
//
// Drive's files.update MERGED appProperties: a key the writer left out KEPT
// ITS OLD VALUE. A device still running a build from before causal ancestry
// existed sent no snapshotId at all, so after its upload the file held THAT
// DEVICE'S BOOK while OUR snapshotId was still sitting on it, merged through
// from our own earlier write. Comparing identity and nothing else read that as
// "still mine", answered 'up-to-date' over a stranger's book, and let the next
// push destroy it with no conflict, no prompt and no safety file (C18). The
// same trick worked one field along, on parentSnapshotId, where it bought a
// free fast-forward instead (C19). Two rounds of fixes, and the second one
// introduced a defect of its own.
//
// ON DROPBOX THERE IS NOTHING TO MERGE. Identity lives in the file body, the
// body is replaced wholesale by every write, and there is no second store
// beside it that a writer can leave half-updated. A writer that omits
// snapshotId does not inherit ours; it produces a body with NO identity, which
// is a visibly different thing and is handled below.
//
// What replaces those fourteen tests is a smaller set that pins the STRUCTURAL
// claim rather than the symptoms: that an identity cannot be inherited, and
// that a body without one is refused at the door rather than being allowed to
// drop the engine onto the revision-number table.

/**
 * A writer that does not send identity at all: another tool, a hand-edited
 * file, or — the case Drive actually had — a build from before ancestry
 * existed. On Dropbox this can only produce a body with no ids in it.
 *
 * NOTE it cannot be a MyMoney build. No build of this app has ever written to
 * Dropbox; the pre-ancestry one holds a Google client id and talks to a
 * different API entirely. This models a stranger, not our own past.
 */
function identitylessWriter(revision: number, txs: string[], over: Partial<SyncSnapshot> = {}): SyncSnapshot {
  const snap = strangerSnapshot(revision, txs, over);
  delete snap.snapshotId;
  delete snap.parentSnapshotId;
  delete snap.ancestry;
  dropbox.strangerUpdates(snap);
  return snap;
}

/** Body downloads since `mark` — the multi-megabyte fetch, not the head read. */
function bodyDownloadsSince(mark: number): number {
  return dropbox.downloadsSince(mark).length;
}


describe('identity cannot be inherited', () => {
  it('leaves the stranger’s identity on the file, never ours', async () => {
    // THE WHOLE OF RC2, asserted directly. On Drive this is the line that
    // would have failed: the head went on reporting our snapshotId over
    // somebody else's contents, because the id lived in a store that merged.
    const ours = await seedLineage(['tx-laptop-1']);
    dropbox.strangerUpdates(strangerSnapshot(2, ['tx-imac-1']));

    const head = dropbox.head();
    expect(head.snapshotId).toBe('stranger-1');
    expect(head.snapshotId).not.toBe(ours.snapshotId);
    // There is no second place for an identity to survive. The file is the
    // file, and it says what it says.
    expect(dropbox.only().content).toBe(JSON.stringify(head));
  });

  it('refuses a body that carries no identity, rather than falling back to revision numbers', async () => {
    // WHY THIS IS A REFUSAL AND NOT A TOLERATED CASE. syncEngine takes the
    // ancestry branch only when the head reports an id. Without one it falls
    // through to the revision-NUMBER fallback — the old, unsound table — where
    // a clean device whose recorded number happens to match is told
    // 'up-to-date' over a book it has never seen. Drive tolerated
    // identity-less files because real ones existed in owners' Drives and
    // refusing them would have stranded a working sync file; it then had to
    // spend the whole C18 stamp apparatus keeping that tolerance safe.
    //
    // Here no such file can exist, so the tolerance buys nothing and costs the
    // one guarantee that matters. Refused at the door.
    const ours = await seedLineage(['tx-laptop-1']);
    identitylessWriter(1, ['tx-imac-1', 'tx-imac-2']); // SAME revision number
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome.kind).toBe('error');
    expect((outcome as { message: string }).message).toMatch(/carries no snapshot identity/);
    expect((outcome as { message: string }).message).toMatch(/not written by this app/);
    // NOT 'up-to-date', which is what the revision-number table would have
    // said: same number, clean device.
    expect(outcome.kind).not.toBe('up-to-date');
    // Nothing written in either direction, and the local book is untouched.
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect(await txIds()).toEqual(['tx-laptop-1']);
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
  });

  it('keeps refusing it when this device is dirty, and never pushes over it', async () => {
    const ours = await seedLineage(['tx-laptop-1']);
    const legacy = identitylessWriter(1, ['tx-imac-1']);
    await type('tx-laptop-2');
    const mark = dropbox.mark();

    expect((await syncNow(laptop.transport)).kind).toBe('error');

    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect((dropbox.head().tables.transactions as Transaction[]).map((t) => t.id)).toEqual([
      'tx-imac-1',
    ]);
    expect(dropbox.head().savedAt).toBe(legacy.savedAt);
    // The change is still here, still unsent, and this device still descends
    // from what it did before.
    expect(await txIds()).toEqual(['tx-laptop-1', 'tx-laptop-2']);
    expect(await hasLocalChanges()).toBe(true);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(ours.snapshotId);
  });

  it('will not seed a second file over one it cannot read', async () => {
    // The refusal must not be a back door into "there is no file", which is
    // the one state that permits a create (C13).
    await seedLineage(['tx-laptop-1']);
    identitylessWriter(1, ['tx-imac-1']);
    const mark = dropbox.mark();

    const forced = await syncNow(laptop.transport, { resolve: 'reseed-remote' });

    expect(forced.kind).toBe('error');
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect((dropbox.head().tables.transactions as Transaction[]).map((t) => t.id)).toEqual([
      'tx-imac-1',
    ]);
  });

  it('the write side refuses it too, so this app can never create one', async () => {
    // The other half of the same guarantee: the transport will not send a
    // snapshot without an id either, so the file it refuses to read is one it
    // could not have written.
    await seedLineage(['tx-laptop-1']);
    const noId = { ...dropbox.head() };
    delete noId.snapshotId;
    const mark = dropbox.mark();
    const thrown = await laptop.transport.writeRemote(noId).then(
      () => null,
      (e: unknown) => e as Error,
    );
    expect(thrown?.message).toMatch(/carries no snapshot identity/);
    expect(dropbox.uploadsSince(mark)).toEqual([]);
  });
});

// ===========================================================================
describe('a head that claims descent it does not have', () => {
  it('is a conflict when its parent belongs to another lineage', async () => {
    // The C19 shape, re-expressed for a world with no merge. A stranger writes
    // a body with a perfectly good identity of its own whose parent names
    // SOMEBODY ELSE'S snapshot. A clean device one push behind must be asked,
    // not fast-forwarded: its rows exist nowhere else, and pulling would
    // delete them with no backup and no question.
    const s1 = await seedLineage(['tx-laptop-1']);
    await atDevice(imac);
    expect((await syncNow(imac.transport)).kind).toBe('pulled');
    await type('tx-imac-1');
    expect((await syncNow(imac.transport)).kind).toBe('pushed');

    await atDevice(laptop);
    dropbox.strangerUpdates(
      strangerSnapshot(3, ['tx-stranger-1'], {
        parentSnapshotId: 'other-lineage',
        ancestry: ['other-lineage'],
      }),
    );
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({
      kind: 'conflict',
      remote: { revision: 3, counts: { transactions: 1 } },
    });
    expect(await txIds()).toEqual(['tx-laptop-1']);
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect((await getSettings()).syncLastPulledSnapshotId).toBe(s1.snapshotId);
    // No safety file was needed because nothing was replaced (the saver in
    // beforeEach throws if anything tries).
    expect(await recoveryDb.records.count()).toBe(0);
  });

  it('but a genuine child IS a fast-forward, so the refusal is not indiscriminate', async () => {
    // The counterpart, and the reason the test above is about descent rather
    // than about distrusting everything: a writer that names our snapshot as
    // its parent must have SEEN it — ids are random uid()s — so a clean device
    // one push behind fast-forwards, as it does every day between the owner's
    // own two machines.
    const s1 = await seedLineage(['tx-laptop-1']);
    dropbox.strangerUpdates(
      strangerSnapshot(2, ['tx-laptop-1', 'tx-imac-1'], {
        parentSnapshotId: s1.snapshotId,
        ancestry: [s1.snapshotId!],
      }),
    );

    expect(await syncNow(laptop.transport)).toMatchObject({ kind: 'pulled', revision: 2 });
    expect(await txIds()).toEqual(['tx-imac-1', 'tx-laptop-1']);
  });
});

// ===========================================================================
// THE STAMP IS GONE, AND THESE ARE THE PROPERTIES THAT REPLACED IT (D45)
// ===========================================================================
//
// This block used to be 'the first sync of a device that last synced under the
// old build': the engine recorded savedAt + deviceId beside the snapshot id,
// compared the whole thing against the head, and downloaded the body once to
// settle the 'unproven' case a mid-lineage upgrade left behind. Every line of
// that existed to compensate for Drive MERGING appProperties.
//
// Dropbox derives the head's identity from the body, so the id answers on its
// own and the stamp — with the two settings keys that fed it — is deleted. The
// tests are rewritten around what has to be true INSTEAD, over the real
// transport: an id is recorded only by something that held the bytes, and
// agreeing with the head writes nothing at all.
describe('what this device records, it has seen the body of', () => {
  it('agreeing with the head writes NOTHING — no id, no revision, no stamp (D2)', async () => {
    const ours = await seedLineage(['tx-1']);
    const before = await getSettings();
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toEqual({ kind: 'up-to-date', snapshotId: ours.snapshotId });
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    // The settings row is byte-for-byte what it was. D2 was this call
    // recording a whole stamp for a head it had proved nothing about; the fix
    // is that it now has nothing to record and no reason to write.
    expect(await getSettings()).toEqual(before);
    // And it is still cheap: the head read is answered from the rev-keyed
    // observation, so no second sync fetches the book again.
    const after = dropbox.mark();
    expect(await syncNow(laptop.transport)).toEqual({
      kind: 'up-to-date',
      snapshotId: ours.snapshotId,
    });
    expect(bodyDownloadsSince(after)).toBe(0);
  });

  it('a push records the id of the body it wrote, and no stamp beside it', async () => {
    const first = await seedLineage(['tx-1']);
    await type('tx-2');

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({ kind: 'pushed', revision: 2 });
    const head = dropbox.head();
    expect(head.parentSnapshotId).toBe(first.snapshotId);
    expect((head.tables.transactions as Transaction[]).map((t) => t.id)).toEqual(['tx-1', 'tx-2']);
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(head.snapshotId);
    // The retired keys are not merely null — the row does not have them.
    expect('syncLastPulledSavedAt' in s).toBe(false);
    expect('syncLastPulledDeviceId' in s).toBe(false);
    expect(await hasLocalChanges()).toBe(false);
  });

  it('is not fooled by a stranger at the same revision number', async () => {
    const ours = await seedLineage(['tx-laptop-1']);
    // The stranger writes ITS revision 1 — the same number ours carries, so
    // the number can prove nothing. The identity in the body settles it.
    dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1', 'tx-imac-2']));
    await type('tx-laptop-2');
    const mark = dropbox.mark();

    const outcome = await syncNow(laptop.transport);

    expect(outcome).toMatchObject({
      kind: 'conflict',
      local: { deviceName: 'Laptop', counts: { transactions: 2 } },
      remote: { revision: 1, deviceName: 'iMac', counts: { transactions: 2 } },
    });
    expect(dropbox.uploadsSince(mark)).toEqual([]);
    expect((dropbox.head().tables.transactions as Transaction[]).map((t) => t.id)).toEqual([
      'tx-imac-1',
      'tx-imac-2',
    ]);
    const s = await getSettings();
    expect(s.syncLastPulledSnapshotId).toBe(ours.snapshotId);
    expect(s.syncLastPulledRevision).toBe(1);
    expect(await hasLocalChanges()).toBe(true);
    expect(dropbox.exists()).toBe(true);
  });
});


// ===========================================================================
// C20 — the Sync screen and the engine, over the SAME file
// ===========================================================================
//
// syncFormat's own rule: "the screen and the engine must never be able to
// disagree about what is about to happen to the data." Both are fed by the
// same readRemoteMeta() and the same settings row, and until C18 they agreed
// by accident — both compared identity and nothing else. These tests put the
// two side by side on one real file.
//
// TWO OF THESE TESTS USED TO DESCRIBE A MERGED IDENTITY and have been rewritten
// around what a stranger can actually produce on Dropbox: an identity of its
// own. The card's job is unchanged and so is the property under test — it must
// never say "the same copy" where the engine would stop and ask.

/**
 * The card's facts, built the way SyncSection builds them.
 *
 * The mapping is repeated here rather than imported because SyncSection is a
 * React component with its own state plumbing. Drift is safe by construction
 * in the only direction it can go: every one of these fields is optional and
 * an ABSENT one reads as "no evidence", which can only make the card claim
 * LESS. There is no shape of this object that turns a missing fact into "the
 * same copy".
 */
async function screenFacts(transport: SyncTransport): Promise<SyncFacts> {
  const probe = await transport.readRemoteMeta();
  const s = await getSettings();
  return {
    connected: transport.isConnected(),
    hasLocalChanges: await hasLocalChanges(s),
    lastPulledRevision: s.syncLastPulledRevision,
    remoteRevision: probe === null ? null : probe.revision,
    lastPulledSnapshotId: s.syncLastPulledSnapshotId,
    localAncestry: s.syncAncestry,
    remoteSnapshotId: probe?.snapshotId ?? null,
    remoteParentSnapshotId: probe?.parentSnapshotId ?? null,
    remoteTrashed: probe?.trashed === true,
    everSynced: s.syncLastPulledRevision > 0,
  };
}

const CLAIMS_SAMENESS = /the same copy —/;

describe('the Sync screen never reassures where the engine would stop and ask', () => {
  it('says "the same copy" exactly where the engine says up-to-date', async () => {
    // THE GAP THAT WAS ASSERTED HERE IS CLOSED. It read 'KNOWN GAP: the card
    // still asks for a stamp the engine no longer records': syncFormat's
    // `headStamp()` looked up settings.syncLastPulledSavedAt, a field D45
    // retired, and treated its absence as 'unproven' — so the card said
    // 'same-snapshot-unproven' about every head, including one the engine was
    // certain of. Safe (it under-claimed) and wrong on every device.
    //
    // headStamp and the four stamp facts are gone from syncFormat now, which
    // is what the Drive-era comment above them had asked for: on Dropbox the
    // ids come from the file's own body, so they answer on their own.
    const ours = await seedLineage(['tx-laptop-1']);

    const facts = await screenFacts(laptop.transport);
    expect(remoteRelation(facts)).toBe('same-snapshot');
    expect(revisionWords(facts)).toMatch(CLAIMS_SAMENESS);

    expect(await syncNow(laptop.transport)).toEqual({
      kind: 'up-to-date',
      snapshotId: ours.snapshotId,
    });
  });

  it('a stranger at the SAME revision number reads as divergence, both sides', async () => {
    await seedLineage(['tx-laptop-1']);
    // The stranger writes ITS revision 1 — the same number the head already
    // carries — so the number can prove nothing and only identity can.
    dropbox.strangerUpdates(strangerSnapshot(1, ['tx-imac-1']));

    const facts = await screenFacts(laptop.transport);
    expect(facts.remoteSnapshotId).not.toBe(facts.lastPulledSnapshotId);
    expect(remoteRelation(facts)).toBe('diverged');
    expect(revisionWords(facts)).not.toMatch(CLAIMS_SAMENESS);
    expect(revisionWords(facts)).toContain('not the one this device last matched');

    expect((await syncNow(laptop.transport)).kind).toBe('conflict');
  });

  it('a head that IS our child still promises nothing while this device is dirty', async () => {
    // A body naming our snapshot as its parent is now a fact about the bytes
    // that are there — but it is not on its own a reason to reassure, because
    // whether anything is taken depends on this device too. Here it is DIRTY,
    // so the engine asks; the card has to say the same without being told why.
    const s1 = await seedLineage(['tx-laptop-1']);
    await type('tx-laptop-2');
    dropbox.strangerUpdates(
      strangerSnapshot(2, ['tx-iphone-1'], {
        parentSnapshotId: s1.snapshotId,
        ancestry: [s1.snapshotId!],
        deviceId: 'device-iphone',
        deviceName: 'iPhone',
      }),
    );

    const facts = await screenFacts(laptop.transport);
    expect(facts.remoteParentSnapshotId).toBe(facts.lastPulledSnapshotId);
    expect(remoteRelation(facts)).toBe('remote-is-our-child');
    const words = revisionWords(facts);
    expect(words).not.toMatch(CLAIMS_SAMENESS);
    // It promises the opposite of reassurance, which is the property: the
    // card says the next sync will stop, and the engine then stops.
    expect(words).toMatch(/stop and ask/);

    expect((await syncNow(laptop.transport)).kind).toBe('conflict');
  });

});
