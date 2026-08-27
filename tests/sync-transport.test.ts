// Dropbox sync transport (D44). This is the first feature in the app that can
// destroy real data, so these tests are written against the failure modes
// rather than the happy path.
//
// THE ONE THAT MATTERS MOST is the serialised `Dropbox-API-Arg` of a real
// write. Dropbox's union encoding allows the bare-string shorthand only for
// members that carry no value, so `"mode":"update"` is a MALFORMED REQUEST —
// and the tempting way to "fix" the resulting 400 is to fall back to
// `overwrite`, which is an unconditional write and would reinstate exactly the
// Drive failure this migration exists to end. So the header is parsed and
// asserted field by field, from a write the transport actually performed.
//
// Everything else follows the same rule as the Drive suite it replaces:
//
//   * nothing leaves the device before the user connects;
//   * a file that EXISTS is never reported as absent (that would make the
//     engine push over a snapshot nobody has seen) — a DELETED file included;
//   * a write that loses the race is REFUSED by Dropbox, not detected
//     afterwards, and the local device is told;
//   * the new rev is taken from the response and never assumed;
//   * 401 / 429 / timeout / malformed JSON all come back as calm, typed errors,
//     and a FULL account is told apart from a busy one;
//   * the OAuth scopes are exactly four — the test at the bottom fails the
//     build if anyone widens them, and another fails it if a client secret
//     ever appears in the auth module.
//
// No test here touches the network: `fetch` is stubbed in every case.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  DROPBOX_SCOPE,
  DROPBOX_SCOPES,
  isOfflineError,
  isReconnectNeeded,
  SyncTransportError,
  type TokenProvider,
} from '../src/sync/dropboxAuth';
import {
  createDropboxTransport,
  dropboxContentHash,
  DROPBOX_CONTENT,
  DROPBOX_RPC,
  DROPBOX_TIMEOUT_MS,
  DROPBOX_TRANSFER_TIMEOUT_MS,
  errorTags,
  serialiseApiArg,
  SYNC_FILE_NAME,
  SYNC_FILE_PATH,
  uploadArg,
  type HeadObservation,
  type HeadStore,
} from '../src/sync/transport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Mirrors the pinned SyncSnapshot. Declared locally on purpose: a local copy
 * fails loudly if the pinned shape ever drifts.
 */
interface Snap {
  app: 'MyMoney';
  schemaVersion: number;
  revision: number;
  deviceId: string;
  deviceName: string;
  savedAt: string;
  snapshotId: string;
  parentSnapshotId: string | null;
  tables: Record<string, unknown[]>;
}

let snapshotIdCounter = 0;

/** Amounts are integer minor units and must survive the round trip
 *  byte-for-byte (SPEC §6). */
function snapshot(over: Partial<Snap> = {}): Snap {
  return {
    app: 'MyMoney',
    schemaVersion: 1,
    revision: 7,
    deviceId: 'device-imac',
    deviceName: "Girish's iMac",
    savedAt: '2026-08-27T09:15:00.000Z',
    snapshotId: `snap-${++snapshotIdCounter}`,
    parentSnapshotId: null,
    tables: {
      accounts: [{ id: 'a1', name: 'Current', currency: 'GBP', openingBalance: 123456 }],
      transactions: [
        { id: 't1', accountId: 'a1', amountMinor: -429327, date: '2026-08-01', payee: 'Rent' },
      ],
    },
    ...over,
  };
}

/** The hash, computed a second time by a different implementation. */
function nodeContentHash(text: string): string {
  const bytes = Buffer.from(text, 'utf8');
  const BLOCK = 4 * 1024 * 1024;
  const digests: Buffer[] = [];
  for (let i = 0; i < bytes.length; i += BLOCK) {
    digests.push(createHash('sha256').update(bytes.subarray(i, i + BLOCK)).digest());
  }
  return createHash('sha256').update(Buffer.concat(digests)).digest('hex');
}

// ---------------------------------------------------------------------------
// A fake Dropbox, at the HTTP layer
// ---------------------------------------------------------------------------

interface Call {
  url: string;
  method: string;
  token: string;
  /** The parsed Dropbox-API-Arg header, for content endpoints. */
  arg: Record<string, unknown> | null;
  /** The RAW header, before parsing — what actually went on the wire. */
  rawArg: string | null;
  body: string;
}

/** The body Dropbox sends when it says no. */
function dropboxError(summary: string, error: unknown): string {
  return JSON.stringify({ error_summary: summary, error });
}

const CONFLICT_BODY = dropboxError('path/conflict/file/.', {
  '.tag': 'path',
  reason: { '.tag': 'conflict', conflict: { '.tag': 'file' } },
  upload_session_id: 'x',
});
const NOT_FOUND_BODY = dropboxError('path/not_found/.', {
  '.tag': 'path',
  path: { '.tag': 'not_found' },
});

class FakeDropbox {
  file: { rev: string; content: string } | null = null;
  /** It existed once and was deleted. Dropbox keeps it restorable. */
  everExisted = false;
  readonly calls: Call[] = [];
  /** Revs are OPAQUE. Deliberately not sequential, so any code that tries to
   *  guess the next one fails here rather than in front of the owner. */
  private revs = ['0159a3f2b1c', '02ae77d0913', '03bb1c40772', '04c9e6f1885', '05d0aa22996'];
  private revIndex = 0;
  /** The next request fails with this instead of being served. */
  refusal: { status: number; body: string; headers?: Record<string, string> } | null = null;
  /** Pretend Dropbox renamed the file despite autorename:false. */
  forceRenameTo: string | null = null;
  /** Runs immediately before an upload is committed. */
  beforeUpload: (() => void) | null = null;
  /** Tokens the fake has decided are past their life. */
  expiredTokens = new Set<string>();

  nextRev(): string {
    const rev = this.revs[this.revIndex++ % this.revs.length]!;
    return this.revIndex > this.revs.length ? `${rev}-${this.revIndex}` : rev;
  }

  seed(content: string): string {
    const rev = this.nextRev();
    this.file = { rev, content };
    this.everExisted = true;
    return rev;
  }

  /** Another client replaces the file. Content AND rev change together, which
   *  is the property Drive's appProperties did not have. */
  strangerWrites(content: string): string {
    const rev = this.nextRev();
    this.file = { rev, content };
    this.everExisted = true;
    return rev;
  }

  deleteFile(): void {
    this.file = null; // everExisted stays true: Dropbox can restore it
  }

  metadata(): Record<string, unknown> {
    const f = this.file!;
    return {
      '.tag': 'file',
      name: SYNC_FILE_NAME,
      path_lower: SYNC_FILE_PATH,
      id: 'id:abc123',
      rev: f.rev,
      size: Buffer.byteLength(f.content, 'utf8'),
      content_hash: nodeContentHash(f.content),
      server_modified: '2026-08-27T09:15:00Z',
      client_modified: '2026-08-27T09:15:00Z',
    };
  }

  uploads(): Call[] {
    return this.calls.filter((c) => c.url === `${DROPBOX_CONTENT}/files/upload`);
  }
  downloads(): Call[] {
    return this.calls.filter((c) => c.url === `${DROPBOX_CONTENT}/files/download`);
  }
  metadataCalls(): Call[] {
    return this.calls.filter((c) => c.url === `${DROPBOX_RPC}/files/get_metadata`);
  }

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const headers = (init.headers ?? {}) as Record<string, string>;
    const rawArg = headers['dropbox-api-arg'] ?? null;
    const bodyText =
      typeof init.body === 'string'
        ? init.body
        : init.body instanceof Uint8Array
          ? Buffer.from(init.body).toString('utf8')
          : '';
    this.calls.push({
      url,
      method: (init.method ?? 'GET').toUpperCase(),
      token: (headers.authorization ?? '').replace(/^Bearer /, ''),
      arg: rawArg ? (JSON.parse(rawArg) as Record<string, unknown>) : null,
      rawArg,
      body: bodyText,
    });

    const reply = (status: number, body: string, extra: Record<string, string> = {}) =>
      ({
        status,
        ok: status >= 200 && status < 300,
        text: async () => body,
        headers: {
          get: (k: string) => extra[k.toLowerCase()] ?? null,
        },
      }) as unknown as Response;
    const json = (status: number, body: unknown, extra?: Record<string, string>) =>
      reply(status, JSON.stringify(body), extra);

    if (this.refusal) {
      const { status, body, headers: h } = this.refusal;
      this.refusal = null;
      return reply(status, body, h ?? {});
    }

    const token = (headers.authorization ?? '').replace(/^Bearer /, '');
    if (token === '' || this.expiredTokens.has(token)) {
      return json(401, { error_summary: 'expired_access_token/...' });
    }

    if (url === `${DROPBOX_RPC}/files/get_metadata`) {
      const arg = JSON.parse(bodyText) as { path: string; include_deleted?: boolean };
      expect(arg.path).toBe(SYNC_FILE_PATH);
      if (this.file) return json(200, this.metadata());
      // A deleted file is reported as DELETED, not as missing — but only when
      // the caller asked. This is the whole reason include_deleted is sent.
      if (this.everExisted && arg.include_deleted === true) {
        return json(200, { '.tag': 'deleted', name: SYNC_FILE_NAME, path_lower: SYNC_FILE_PATH });
      }
      return reply(409, NOT_FOUND_BODY);
    }

    if (url === `${DROPBOX_CONTENT}/files/download`) {
      if (!this.file) return reply(409, NOT_FOUND_BODY);
      return reply(200, this.file.content, {
        'dropbox-api-result': JSON.stringify(this.metadata()),
      });
    }

    if (url === `${DROPBOX_CONTENT}/files/upload`) {
      const arg = JSON.parse(rawArg ?? '{}') as {
        path: string;
        mode: unknown;
        autorename?: boolean;
        strict_conflict?: boolean;
        content_hash?: string;
      };
      // ---- Dropbox's OWN validation, modelled faithfully ------------------
      // The shorthand is legal only for Void union members. `update` carries a
      // rev, so a bare "update" is rejected with this exact complaint.
      if (typeof arg.mode === 'string' && arg.mode === 'update') {
        return reply(
          400,
          'Error in call to API function "files/upload": Invalid select-union tag "update". ' +
            'This shorthand is not allowed for non-Void members.',
        );
      }
      const mode = arg.mode as { '.tag'?: string; update?: string } | string;
      const tag = typeof mode === 'string' ? mode : mode['.tag'];
      const wantedRev = typeof mode === 'string' ? undefined : mode.update;

      if (arg.content_hash && arg.content_hash !== nodeContentHash(bodyText)) {
        return reply(
          409,
          dropboxError('content_hash_mismatch/.', { '.tag': 'content_hash_mismatch' }),
        );
      }

      const conflicted =
        tag === 'add' ? this.file !== null : this.file === null || this.file.rev !== wantedRev;

      if (conflicted) {
        if (arg.autorename) {
          // What autorename:true actually does to a lost race: a 200 OK on a
          // DIFFERENT file. This branch exists so the "we never send it" test
          // is testing something real.
          this.beforeUpload?.();
          return json(200, {
            name: 'mymoney-sync (1).json',
            path_lower: '/mymoney-sync (1).json',
            rev: this.nextRev(),
            size: Buffer.byteLength(bodyText, 'utf8'),
            content_hash: nodeContentHash(bodyText),
          });
        }
        return reply(409, CONFLICT_BODY);
      }

      this.beforeUpload?.();
      this.beforeUpload = null;
      const rev = this.nextRev();
      this.file = { rev, content: bodyText };
      this.everExisted = true;
      return json(200, {
        name: SYNC_FILE_NAME,
        path_lower: this.forceRenameTo ?? SYNC_FILE_PATH,
        id: 'id:abc123',
        rev,
        size: Buffer.byteLength(bodyText, 'utf8'),
        content_hash: nodeContentHash(bodyText),
        server_modified: '2026-08-27T09:16:00Z',
      });
    }

    throw new Error(`fake Dropbox got an unexpected request: ${url}`);
  };
}

function memoryHeadStore(): HeadStore {
  let value: HeadObservation | null = null;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}

function fakeAuth(over: Partial<TokenProvider> = {}): TokenProvider {
  return {
    isConnected: () => true,
    hasValidToken: () => true,
    isLinked: () => true,
    getToken: async () => 'tok-1',
    connect: async () => {},
    invalidate: () => {},
    disconnect: async () => {},
    ...over,
  };
}

let dropbox: FakeDropbox;

function transport(auth: TokenProvider = fakeAuth(), heads: HeadStore = memoryHeadStore()) {
  return createDropboxTransport({ auth, headStore: heads });
}

beforeEach(() => {
  dropbox = new FakeDropbox();
  vi.stubGlobal('fetch', dropbox.fetch);
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

/** The rejection, or a failure if the call unexpectedly succeeded. */
async function rejection(p: Promise<unknown>): Promise<SyncTransportError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, 'expected this call to be refused, and it was not').toBeInstanceOf(SyncTransportError);
  return e as SyncTransportError;
}

// ===========================================================================
// The serialised Dropbox-API-Arg — the trap this migration is built around
// ===========================================================================

describe('the write mode that goes on the wire', () => {
  it('sends mode as {".tag":"update","update":<rev>} and NEVER the shorthand', async () => {
    const first = snapshot();
    const rev = dropbox.seed(JSON.stringify(first));
    const heads = memoryHeadStore();
    const t = transport(fakeAuth(), heads);
    await t.readRemoteMeta(); // the engine always reads the head first

    await t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId }));

    const arg = dropbox.uploads()[0]!.arg!;
    // The exact shape, not a loose match: this is the assertion that fails if
    // anyone "simplifies" the union encoding.
    expect(arg.mode).toEqual({ '.tag': 'update', update: rev });
    expect(typeof arg.mode).toBe('object');
    expect(arg.mode).not.toBe('update');
    // And on the wire, character for character.
    expect(dropbox.uploads()[0]!.rawArg).toContain('"mode":{".tag":"update","update":"');
  });

  it('sends autorename false, strict_conflict true, mute true and a content_hash on every write', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();
    const second = snapshot({ revision: 8, parentSnapshotId: first.snapshotId });
    await t.writeRemote(second);

    const call = dropbox.uploads()[0]!;
    const arg = call.arg!;
    expect(arg.path).toBe(SYNC_FILE_PATH);
    expect(arg.autorename).toBe(false);
    expect(arg.strict_conflict).toBe(true);
    expect(arg.mute).toBe(true);
    // The hash is of the bytes actually sent, not of some other rendering.
    expect(arg.content_hash).toBe(nodeContentHash(call.body));
    expect(JSON.parse(call.body)).toEqual(second);
  });

  it('a first write uses mode add, so a race to seed the file fails rather than making a second one', async () => {
    const t = transport();
    expect(await t.readRemoteMeta()).toBeNull();
    await t.writeRemote(snapshot({ revision: 1, parentSnapshotId: null }));

    const arg = dropbox.uploads()[0]!.arg!;
    expect(arg.mode).toEqual({ '.tag': 'add' });
    expect(arg.autorename).toBe(false);
  });

  it('models Dropbox rejecting the shorthand, so the fake is not being kind to us', async () => {
    // Proof that the assertion above is about a real failure: if the transport
    // DID send the shorthand, this is what would come back.
    const res = await dropbox.fetch(`${DROPBOX_CONTENT}/files/upload`, {
      method: 'POST',
      headers: {
        authorization: 'Bearer tok-1',
        'dropbox-api-arg': JSON.stringify({ path: SYNC_FILE_PATH, mode: 'update' }),
      },
      body: '{}',
    });
    expect(res.status).toBe(400);
    expect(await res.text()).toContain('not allowed for non-Void members');
  });

  it('uploadArg() maps a null rev to add and a rev to update', () => {
    expect(uploadArg(null, 'hash').mode).toEqual({ '.tag': 'add' });
    expect(uploadArg('rev-9', 'hash').mode).toEqual({ '.tag': 'update', update: 'rev-9' });
    expect(uploadArg('rev-9', 'hash')).toMatchObject({
      path: SYNC_FILE_PATH,
      autorename: false,
      mute: true,
      strict_conflict: true,
      content_hash: 'hash',
    });
  });

  it('serialises the arg header as pure ASCII', () => {
    // Header values are bytes. A device named in Tamil must not put a raw
    // multi-byte character into an HTTP header.
    const out = serialiseApiArg({ path: '/x', note: 'Girish’s iPhone 📱 கணக்கு' });
    expect(out).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.parse(out)).toEqual({ path: '/x', note: 'Girish’s iPhone 📱 கணக்கு' });
  });
});

// ===========================================================================
// content_hash
// ===========================================================================

describe('dropboxContentHash', () => {
  const utf8 = (s: string) => new TextEncoder().encode(s);

  it('matches Dropbox’s definition for a small file', async () => {
    const text = JSON.stringify(snapshot());
    expect(await dropboxContentHash(utf8(text))).toBe(nodeContentHash(text));
  });

  it('hashes the empty concatenation for an empty file', async () => {
    expect(await dropboxContentHash(utf8(''))).toBe(createHash('sha256').update(Buffer.alloc(0)).digest('hex'));
  });

  it('blocks at 4 MiB, so a file over one block is not hashed as one lump', async () => {
    const text = 'x'.repeat(4 * 1024 * 1024 + 17);
    const ours = await dropboxContentHash(utf8(text));
    expect(ours).toBe(nodeContentHash(text));
    // …and is NOT simply sha256 of the whole thing, which is what a
    // single-block implementation would produce.
    expect(ours).not.toBe(createHash('sha256').update(Buffer.from(text)).digest('hex'));
  });

  it('refuses the upload when Dropbox says the stored bytes differ from ours', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();
    dropbox.refusal = {
      status: 409,
      body: JSON.stringify({
        error_summary: 'content_hash_mismatch/.',
        error: { '.tag': 'content_hash_mismatch' },
      }),
    };
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId })),
    );
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/Nothing was changed/);
  });

  it('refuses to record a push when the response describes different bytes', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();
    // A 200 whose metadata does not describe what we sent. Believing it would
    // record "Dropbox holds my book" over something else.
    const original = dropbox.fetch;
    vi.stubGlobal('fetch', async (u: unknown, i: RequestInit = {}) => {
      const res = await original(u, i);
      if (String(u).endsWith('/files/upload')) {
        const body = JSON.parse(await res.text()) as Record<string, unknown>;
        body.content_hash = 'f'.repeat(64);
        return { status: 200, ok: true, text: async () => JSON.stringify(body), headers: { get: () => null } } as unknown as Response;
      }
      return res;
    });
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId })),
    );
    expect(e.message).toMatch(/different from what this device sent/);
    expect(e.message).toMatch(/NOT been recorded/);
  });
});

// ===========================================================================
// Compare-and-swap — RC1, prevented rather than detected
// ===========================================================================

describe('the write is conditional on the rev', () => {
  it('refuses when another device wrote between our head read and our upload', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    const meta = await t.readRemoteMeta();
    expect(meta!.snapshotId).toBe(first.snapshotId);

    // The window the precondition exists for: a save dialog left open, a slow
    // 3 MB export, a phone on a train.
    const stranger = snapshot({ revision: 8, parentSnapshotId: first.snapshotId });
    const strangerRev = dropbox.strangerWrites(JSON.stringify(stranger));

    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId })),
    );
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/Another device saved to Dropbox/);
    expect(e.message).toMatch(/nothing was uploaded/);
    // And the stranger's book is untouched.
    expect(dropbox.file!.rev).toBe(strangerRev);
    expect(JSON.parse(dropbox.file!.content)).toEqual(stranger);
  });

  it('takes the new rev FROM THE RESPONSE and preconditions the next write on it', async () => {
    const first = snapshot({ revision: 1, parentSnapshotId: null });
    const t = transport();
    await t.readRemoteMeta();
    await t.writeRemote(first);
    const revAfterFirst = dropbox.file!.rev;

    const second = snapshot({ revision: 2, parentSnapshotId: first.snapshotId });
    await t.writeRemote(second);

    // The second upload's precondition is exactly the rev the FIRST response
    // reported — not a guess, not an increment of anything.
    expect(dropbox.uploads()[1]!.arg!.mode).toEqual({ '.tag': 'update', update: revAfterFirst });
    expect(JSON.parse(dropbox.file!.content)).toEqual(second);
  });

  it('is refused by DROPBOX even when this device still believes its stale head', async () => {
    // THE STRUCTURAL POINT OF THE MIGRATION, in one test. The transport holds
    // an observation saying "the head is snapshot P", and it is wrong — a
    // stranger replaced the file without going through us. On Drive that
    // belief WAS the precondition, so a stale one meant a silent clobber and
    // the only recourse was to read the file back afterwards and notice. Here
    // the belief only chooses which rev to send; the rev is what Dropbox
    // actually checks, and it refuses. The upload leaves, and lands nowhere.
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();
    const stranger = snapshot({ revision: 99 });
    const strangerRev = dropbox.strangerWrites(JSON.stringify(stranger));

    const mine = snapshot({ revision: 8, parentSnapshotId: first.snapshotId });
    const e = await rejection(t.writeRemote(mine));
    expect(e.message).toMatch(/Another device saved to Dropbox/);
    // Trying again without re-reading must not suddenly succeed either.
    await rejection(t.writeRemote(mine));
    expect(dropbox.uploads()).toHaveLength(2);
    // Both attempts were refused. The stranger's book is byte-for-byte intact.
    expect(dropbox.file!.rev).toBe(strangerRev);
    expect(JSON.parse(dropbox.file!.content)).toEqual(stranger);
  });

  it('refuses to seed when a file appeared in the meantime (mode add conflicts)', async () => {
    const t = transport();
    expect(await t.readRemoteMeta()).toBeNull();
    const stranger = snapshot({ revision: 1 });
    dropbox.seed(JSON.stringify(stranger));

    const e = await rejection(t.writeRemote(snapshot({ revision: 1, parentSnapshotId: null })));
    expect(e.kind).toBe('remote');
    // The wording matters: the same 409 means something different depending on
    // which mode we sent, and "sync again to see what CHANGED" is wrong advice
    // about a file that has only just appeared.
    expect(e.message).toMatch(/A sync file appeared in Dropbox/);
    expect(e.message).not.toMatch(/built on an older version/);
    expect(JSON.parse(dropbox.file!.content)).toEqual(stranger);
  });

  it('never sends autorename, and refuses a response that came back on another path', async () => {
    const first = snapshot({ revision: 1, parentSnapshotId: null });
    const t = transport();
    await t.writeRemote(first);
    // Dropbox answers 200 but names a different file. autorename:false means
    // this cannot happen — and if it ever did, believing it would record a
    // successful backup of a file called "mymoney-sync (1).json".
    dropbox.forceRenameTo = '/mymoney-sync (1).json';
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 2, parentSnapshotId: first.snapshotId })),
    );
    expect(e.message).toMatch(/mymoney-sync \(1\)\.json/);
    expect(e.message).toMatch(/NOT been recorded/);
  });

  it('goes and looks when it holds no observation of the parent, and refuses if the head is not it', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    // A fresh tab: empty head cache, so the transport must fetch and check.
    const t = transport(fakeAuth(), memoryHeadStore());
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: 'snap-from-another-lineage' })),
    );
    expect(e.message).toMatch(/Another device saved to Dropbox/);
    expect(dropbox.uploads()).toHaveLength(0);
    expect(dropbox.metadataCalls().length).toBeGreaterThan(0);
  });

  it('refuses a write whose parent no longer exists at all', async () => {
    const t = transport();
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: 'snap-gone' })),
    );
    expect(e.message).toMatch(/no longer in Dropbox/);
    expect(dropbox.uploads()).toHaveLength(0);
  });

  it('refuses to write over a DELETED file rather than re-creating it', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    dropbox.deleteFile();
    const t = transport();
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: 'snap-1' })),
    );
    expect(e.message).toMatch(/deleted files/);
    expect(dropbox.uploads()).toHaveLength(0);
  });

  // THIS TEST USED TO BE `checks the whole stamp when the caller supplies one`,
  // and it encoded DRIVE behaviour, so it is rewritten rather than kept.
  //
  // It passed a second argument — `expectHead`, the whole SyncStamp the caller
  // had read — and asserted the transport refused when any field of it had
  // moved. That check was load-bearing on Drive, where appProperties MERGED
  // and our snapshotId could survive a stranger's write (C18). On Dropbox the
  // identity is in the body, which is replaced wholesale, so `snapshotId`
  // answers on its own; and D45 stopped the engine passing a stamp at all,
  // which left a SECOND identity check reachable only through an argument no
  // caller supplied. It has been removed (see ./src/sync/types.ts, where
  // `SyncStamp` was declared).
  //
  // What replaces it is the stronger claim: there is now no channel through
  // which a caller can state an expectation ALONGSIDE the snapshot, so the
  // engine's causal parent and the transport's precondition cannot drift apart
  // — they are the same field.
  it('takes its precondition from the snapshot alone — there is no second channel', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();

    // One parameter. A caller cannot smuggle in a parallel expectation, which
    // is what "two fields each doing two jobs" looked like from this side.
    expect(t.writeRemote.length).toBe(1);

    // And the parent in the BODY is what decides: naming the head is accepted,
    // naming anything else is refused, with no way to override either.
    await t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId }));
    expect(dropbox.uploads()).toHaveLength(1);

    const e = await rejection(
      t.writeRemote(snapshot({ revision: 9, parentSnapshotId: 'snap-not-the-head' })),
    );
    expect(e.message).toMatch(/Another device saved to Dropbox|no longer in Dropbox/);
    expect(dropbox.uploads()).toHaveLength(1);
  });
});

// ===========================================================================
// The head read
// ===========================================================================

describe('readRemoteMeta', () => {
  it('returns null ONLY when the file has never existed', async () => {
    const t = transport();
    expect(await t.readRemoteMeta()).toBeNull();
    expect(dropbox.downloads()).toHaveLength(0);
  });

  it('reports a DELETED file as existing-but-gone, never as absent', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    dropbox.deleteFile();
    const meta = await transport().readRemoteMeta();
    expect(meta).not.toBeNull();
    expect(meta!.trashed).toBe(true);
    // include_deleted is what makes that distinction possible.
    expect(JSON.parse(dropbox.metadataCalls()[0]!.body)).toMatchObject({ include_deleted: true });
  });

  it('reports identity, ancestry and revision from the file body', async () => {
    const snap = snapshot({ revision: 12, parentSnapshotId: 'snap-parent' });
    const rev = dropbox.seed(JSON.stringify(snap));
    const meta = await transport().readRemoteMeta();
    expect(meta).toMatchObject({
      revision: 12,
      savedAt: snap.savedAt,
      deviceName: snap.deviceName,
      deviceId: snap.deviceId,
      snapshotId: snap.snapshotId,
      parentSnapshotId: 'snap-parent',
      rev,
    });
  });

  it('downloads once, then answers an unchanged head without downloading again', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    const heads = memoryHeadStore();
    const t = transport(fakeAuth(), heads);
    await t.readRemoteMeta();
    expect(dropbox.downloads()).toHaveLength(1);
    await t.readRemoteMeta();
    await t.readRemoteMeta();
    // The rev has not moved, so there is nothing new to learn. This is the
    // cost note in the transport header being kept honest.
    expect(dropbox.downloads()).toHaveLength(1);
    expect(dropbox.metadataCalls()).toHaveLength(3);
  });

  it('downloads again as soon as the rev moves', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    const t = transport();
    await t.readRemoteMeta();
    const other = snapshot({ revision: 20, deviceName: "Girish's iPhone" });
    dropbox.strangerWrites(JSON.stringify(other));
    const meta = await t.readRemoteMeta();
    expect(dropbox.downloads()).toHaveLength(2);
    expect(meta!.snapshotId).toBe(other.snapshotId);
    expect(meta!.deviceName).toBe("Girish's iPhone");
  });

  it('ignores a cached observation whose content hash no longer matches the head', async () => {
    const snap = snapshot();
    const rev = dropbox.seed(JSON.stringify(snap));
    const heads = memoryHeadStore();
    // A cache entry claiming this rev but describing something else. It is
    // rejected because the head's content_hash is compared too.
    heads.set({ rev, contentHash: 'not-the-hash', meta: { revision: 1, savedAt: 'x', deviceName: 'y', deviceId: 'z', snapshotId: 'wrong', parentSnapshotId: null } });
    const meta = await transport(fakeAuth(), heads).readRemoteMeta();
    expect(meta!.snapshotId).toBe(snap.snapshotId);
    expect(dropbox.downloads()).toHaveLength(1);
  });

  it('refuses a file that is not a MyMoney snapshot instead of half-using it', async () => {
    dropbox.seed(JSON.stringify({ app: 'SomethingElse', tables: {} }));
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/was not written by MyMoney/);
  });

  it('refuses a file with a damaged table', async () => {
    dropbox.seed(JSON.stringify({ ...snapshot(), tables: { accounts: 'not-an-array' } }));
    const e = await rejection(transport().readRemoteMeta());
    expect(e.message).toMatch(/damaged "accounts" table/);
  });

  it('refuses a file that is not valid JSON', async () => {
    dropbox.seed('{ this is not json');
    const e = await rejection(transport().readRemoteMeta());
    expect(e.message).toMatch(/isn't readable/);
  });
});

describe('readRemote', () => {
  it('returns the rows exactly as written — integer minor units survive', async () => {
    const snap = snapshot();
    dropbox.seed(JSON.stringify(snap));
    const got = await transport().readRemote();
    expect(got).toEqual(snap);
    expect((got!.tables.transactions![0] as { amountMinor: number }).amountMinor).toBe(-429327);
  });

  it('returns null when there is no file, and refuses when the file was deleted', async () => {
    expect(await transport().readRemote()).toBeNull();
    dropbox.seed(JSON.stringify(snapshot()));
    dropbox.deleteFile();
    const e = await rejection(transport().readRemote());
    expect(e.message).toMatch(/deleted from Dropbox/);
  });

  it('refuses a download Dropbox did not describe readably, rather than throwing a SyntaxError', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    const original = dropbox.fetch;
    vi.stubGlobal('fetch', async (u: unknown, i: RequestInit = {}) => {
      const res = await original(u, i);
      if (String(u).endsWith('/files/download')) {
        return {
          status: 200,
          ok: true,
          text: () => res.text(),
          headers: { get: () => '<html>not json</html>' },
        } as unknown as Response;
      }
      return res;
    });
    const e = await rejection(transport().readRemote());
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/not readable/);
  });

  it('refuses a download whose bytes do not match the hash Dropbox reported', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    const original = dropbox.fetch;
    vi.stubGlobal('fetch', async (u: unknown, i: RequestInit = {}) => {
      const res = await original(u, i);
      if (String(u).endsWith('/files/download')) {
        // Truncated in transit, but still valid-looking to a naive reader.
        const meta = res.headers.get('dropbox-api-result');
        return {
          status: 200,
          ok: true,
          text: async () => (await res.text()).slice(0, 40),
          headers: { get: (k: string) => (k.toLowerCase() === 'dropbox-api-result' ? meta : null) },
        } as unknown as Response;
      }
      return res;
    });
    const e = await rejection(transport().readRemote());
    expect(e.message).toMatch(/transfer was damaged/);
  });
});

// ===========================================================================
// Errors: permanent vs transient, and the tab never wedges
// ===========================================================================

describe('failures', () => {
  it('refreshes and retries exactly once after a 401, invisibly', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    dropbox.expiredTokens.add('tok-1');
    let current = 'tok-1';
    let invalidated = 0;
    const auth = fakeAuth({
      getToken: async () => current,
      invalidate: () => {
        invalidated += 1;
        current = 'tok-2';
      },
    });
    const meta = await transport(auth).readRemoteMeta();
    expect(invalidated).toBe(1);
    expect(meta).not.toBeNull();
  });

  it('gives up with a reconnect error when the second 401 arrives', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    dropbox.expiredTokens.add('tok-1');
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('auth');
    expect(isReconnectNeeded(e)).toBe(true);
  });

  it('tells a FULL Dropbox apart from a busy one', async () => {
    const first = snapshot();
    dropbox.seed(JSON.stringify(first));
    const t = transport();
    await t.readRemoteMeta();
    dropbox.refusal = {
      status: 409,
      body: JSON.stringify({
        error_summary: 'path/insufficient_space/...',
        error: { '.tag': 'path', reason: { '.tag': 'insufficient_space' } },
      }),
    };
    const e = await rejection(
      t.writeRemote(snapshot({ revision: 8, parentSnapshotId: first.snapshotId })),
    );
    // PERMANENT. It will not clear on its own and only the owner can fix it, so
    // it must never say "try again shortly".
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/Your Dropbox is full/);
    expect(e.message).not.toMatch(/try again shortly/);
    expect(isOfflineError(e)).toBe(false);
  });

  it('treats 429 and 5xx as transient, and passes on how long to wait', async () => {
    dropbox.refusal = { status: 429, body: '{}', headers: { 'retry-after': '17' } };
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('network');
    expect(isOfflineError(e)).toBe(true);
    expect(e.message).toMatch(/about 17 seconds/);

    dropbox.refusal = { status: 503, body: '{}' };
    const e2 = await rejection(transport().readRemoteMeta());
    expect(e2.kind).toBe('network');
    expect(e2.message).toMatch(/try again shortly/);
  });

  it('reports a 400 as OUR bug, loudly, and never as something to retry', async () => {
    dropbox.refusal = {
      status: 400,
      body: 'Error in call to API function "files/upload": Invalid select-union tag "update".',
    };
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/fault in the app, not in your data/);
    expect(isOfflineError(e)).toBe(false);
  });

  it('reports an unreadable answer rather than throwing a SyntaxError', async () => {
    dropbox.refusal = { status: 200, body: '<html>proxy sign-in page</html>' };
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('remote');
    expect(e.message).toMatch(/not readable/);
  });

  it('does not touch the network at all when the device is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const e = await rejection(transport().readRemoteMeta());
    expect(e.kind).toBe('offline');
    expect(dropbox.calls).toHaveLength(0);
  });

  it('bounds a metadata request, body read included', async () => {
    vi.useFakeTimers();
    vi.stubGlobal('fetch', (_u: unknown, init: RequestInit = {}) =>
      new Promise((_resolve, reject) => {
        init.signal?.addEventListener('abort', () =>
          reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
        );
      }),
    );
    const p = rejection(transport().readRemoteMeta());
    await vi.advanceTimersByTimeAsync(DROPBOX_TIMEOUT_MS + 1_000);
    expect((await p).kind).toBe('timeout');
  });

  it('bounds a transfer whose HEADERS arrive and whose BODY never does (C10)', async () => {
    vi.useFakeTimers();
    const snap = JSON.stringify(snapshot());
    vi.stubGlobal('fetch', (u: unknown, init: RequestInit = {}) => {
      if (String(u).endsWith('/files/get_metadata')) {
        return Promise.resolve({
          status: 200,
          ok: true,
          text: async () => JSON.stringify({ '.tag': 'file', rev: 'r1', path_lower: SYNC_FILE_PATH, content_hash: nodeContentHash(snap) }),
          headers: { get: () => null },
        } as unknown as Response);
      }
      // 200 OK, then silence.
      return Promise.resolve({
        status: 200,
        ok: true,
        headers: { get: () => null },
        text: () =>
          new Promise((_r, reject) => {
            init.signal?.addEventListener('abort', () =>
              reject(Object.assign(new Error('aborted'), { name: 'AbortError' })),
            );
          }),
      } as unknown as Response);
    });
    const p = rejection(transport().readRemote());
    await vi.advanceTimersByTimeAsync(DROPBOX_TRANSFER_TIMEOUT_MS + 1_000);
    expect((await p).kind).toBe('timeout');
  });
});

describe('errorTags', () => {
  it('finds a tag however deeply Dropbox has nested it', () => {
    expect(errorTags(CONFLICT_BODY).has('conflict')).toBe(true);
    expect(errorTags(NOT_FOUND_BODY).has('not_found')).toBe(true);
    expect(
      errorTags(
        JSON.stringify({ error: { a: { b: { c: { '.tag': 'insufficient_space' } } } } }),
      ).has('insufficient_space'),
    ).toBe(true);
    // error_summary is corroboration, never the only source.
    expect(errorTags(JSON.stringify({ error_summary: 'path/insufficient_space/.' })).has('insufficient_space')).toBe(true);
    expect(errorTags('not json').size).toBe(0);
  });
});

// ===========================================================================
// What the transport refuses to send
// ===========================================================================

describe('writeRemote vets its own payload', () => {
  it('refuses a snapshot with no identity — nothing could ever descend from it', async () => {
    const { snapshotId: _drop, ...rest } = snapshot();
    const e = await rejection(transport().writeRemote(rest as never));
    expect(e.message).toMatch(/no snapshot id/);
    expect(dropbox.calls).toHaveLength(0);
  });

  it('refuses a snapshot that cannot say which device wrote it', async () => {
    const e = await rejection(transport().writeRemote(snapshot({ deviceName: '' }) as never));
    expect(e.message).toMatch(/which device wrote it/);
    expect(dropbox.calls).toHaveLength(0);
  });

  it('accepts a long snapshot id — there is no byte budget to fit any more', async () => {
    // On Drive an id had to fit inside a 124-byte appProperties entry. Identity
    // now travels in the body, and a TRUNCATED identity was always the more
    // dangerous half of that apparatus.
    const long = `snap-${'x'.repeat(400)}`;
    const t = transport();
    await t.writeRemote(snapshot({ revision: 1, parentSnapshotId: null, snapshotId: long }));
    expect(JSON.parse(dropbox.file!.content).snapshotId).toBe(long);
  });
});

// ===========================================================================
// Nothing happens until it is asked to
// ===========================================================================

describe('quiet by default', () => {
  it('constructing a transport makes no request', () => {
    createDropboxTransport({ auth: fakeAuth(), headStore: memoryHeadStore() });
    expect(dropbox.calls).toHaveLength(0);
  });

  it('reports connection from the standing grant, not from a live token', () => {
    expect(transport(fakeAuth({ isConnected: () => false })).isConnected()).toBe(false);
    expect(transport(fakeAuth({ isConnected: () => true })).isConnected()).toBe(true);
  });

  it('disconnect never deletes anything in Dropbox', async () => {
    dropbox.seed(JSON.stringify(snapshot()));
    let disconnected = 0;
    await transport(fakeAuth({ disconnect: async () => void (disconnected += 1) })).disconnect();
    expect(disconnected).toBe(1);
    expect(dropbox.file).not.toBeNull();
    expect(dropbox.calls.some((c) => /delete/i.test(c.url))).toBe(false);
  });

  it('clears the head cache on disconnect, so a reconnected device re-reads', async () => {
    const heads = memoryHeadStore();
    dropbox.seed(JSON.stringify(snapshot()));
    const t = transport(fakeAuth(), heads);
    await t.readRemoteMeta();
    expect(heads.get()).not.toBeNull();
    await t.disconnect();
    expect(heads.get()).toBeNull();
  });
});

// ===========================================================================
// Locked by test: the grant, and the absence of a secret
// ===========================================================================

describe('the OAuth grant stays minimal', () => {
  it('asks for exactly four scopes and no more', () => {
    expect([...DROPBOX_SCOPES]).toEqual([
      'account_info.read',
      'files.metadata.read',
      'files.content.read',
      'files.content.write',
    ]);
    expect(DROPBOX_SCOPE).toBe(
      'account_info.read files.metadata.read files.content.read files.content.write',
    );
  });

  it('never asks for files.metadata.write — that scope is how RC2 would come back', () => {
    // Dropbox's property groups are written in a SEPARATE request from the
    // upload, so they can disagree with the file's contents. Not requesting
    // the scope is the cheapest possible guarantee nobody reintroduces them.
    expect([...DROPBOX_SCOPES]).not.toContain('files.metadata.write');
    expect(DROPBOX_SCOPE).not.toMatch(/sharing|file_requests|contacts|metadata\.write/);
  });

  it('the auth module contains no client secret, in any form', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/sync/dropboxAuth.ts', import.meta.url)),
      'utf8',
    );
    // COMMENTS ARE STRIPPED FIRST, on purpose. The file talks about the secret
    // at length — why a browser app cannot have one, and what to do if Dropbox
    // ever demands it — and that prose is worth keeping. What must never
    // appear is the string in CODE.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/client_secret/);
    expect(code).not.toMatch(/clientSecret/);
    // …and the app key IS present in code, which is the point: it is public.
    expect(code).toMatch(/kbqcrqxstpn4baq/);
  });

  it('the transport module keeps no Drive-era metadata apparatus', () => {
    const source = readFileSync(
      fileURLToPath(new URL('../src/sync/transport.ts', import.meta.url)),
      'utf8',
    );
    // These existed ONLY because Drive lacked a conditional write and capped
    // its metadata entries. Their return would be a regression, not a feature.
    expect(source).not.toMatch(/function fitProperty/);
    expect(source).not.toMatch(/function confirmLanded/);
    expect(source).not.toMatch(/appProperties:/);
    // And the stamp apparatus, retired in this pass: a SECOND identity check
    // behind an optional argument the engine no longer passes. Two checks
    // answering one question is the shape of the whole defect class.
    expect(source).not.toMatch(/function stampMismatch/);
    expect(source).not.toMatch(/expectHead\s*[),]/);
  });
});
