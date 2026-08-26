// Google Drive sync transport (D42). This is the first feature in the app that
// can destroy real data, so these tests are written against the failure modes
// rather than the happy path:
//
//   * nothing leaves the device before the user connects;
//   * a file that exists is NEVER reported as absent (that would make the
//     engine push over a snapshot nobody has seen);
//   * a write is one atomic request — a dead connection cannot leave a
//     truncated file or a file whose stated revision lies about its contents;
//   * 401 / timeout / malformed JSON all come back as calm, typed errors;
//   * the OAuth scope is exactly `drive.file` — the test at the bottom fails
//     the build if anyone ever widens it.
//
// No test here touches the network: fetch is stubbed in every case, and the
// Google Identity Services script is never loaded (a fake document proves it).
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import {
  createGoogleTokenProvider,
  DRIVE_SCOPE,
  GSI_SCRIPT_SRC,
  isReconnectNeeded,
  resetGsiLoaderForTests,
  SyncTransportError,
  type GisTokenResponse,
  type TokenProvider,
} from '../src/sync/googleAuth';
import {
  createDriveTransport,
  DRIVE_API,
  DRIVE_UPLOAD_API,
  MAX_APP_PROPERTY_BYTES,
  SYNC_FILE_NAME,
} from '../src/sync/transport';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/**
 * Mirrors the pinned SyncSnapshot. Declared locally on purpose: these tests
 * must not depend on src/sync/types.ts having landed yet, and a local copy
 * also fails loudly if the pinned shape ever drifts.
 */
interface Snap {
  app: 'MyMoney';
  schemaVersion: number;
  revision: number;
  deviceId: string;
  deviceName: string;
  savedAt: string;
  tables: Record<string, unknown[]>;
}

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
    tables: {
      accounts: [{ id: 'a1', name: 'Current', currency: 'GBP', openingBalance: 123456 }],
      transactions: [
        { id: 't1', accountId: 'a1', date: '2026-08-01', amountMinor: -4599 },
        { id: 't2', accountId: 'a1', date: '2026-08-02', amountMinor: 250000 },
      ],
      settings: [{ id: 'app', baseCurrency: 'GBP' }],
    },
    ...over,
  };
}

interface FakeFile {
  id: string;
  name: string;
  trashed: boolean;
  appProperties: Record<string, string>;
  content: string;
}

interface DriveCall {
  url: string;
  method: string;
  body?: string;
  contentType?: string;
  hasSignal: boolean;
}

const json = (body: unknown, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
    text: async () => JSON.stringify(body),
  }) as unknown as Response;

const raw = (text: string, status = 200) =>
  ({
    ok: status >= 200 && status < 300,
    status,
    json: async () => JSON.parse(text) as unknown,
    text: async () => text,
  }) as unknown as Response;

/** Split a multipart/related upload back into its metadata and media parts. */
function parseMultipart(body: string, contentType: string): { metadata: Record<string, unknown>; content: string } {
  const boundary = /boundary=(.+)$/.exec(contentType)?.[1];
  if (!boundary) throw new Error(`not a multipart body: ${contentType}`);
  const parts = body
    .split(`--${boundary}`)
    .map((p) => p.trim())
    .filter((p) => p !== '' && p !== '--');
  const payloads = parts.map((p) => {
    const i = p.indexOf('\r\n\r\n');
    return p.slice(i + 4).trim();
  });
  return {
    metadata: JSON.parse(payloads[0] ?? '{}') as Record<string, unknown>,
    content: payloads[1] ?? '',
  };
}

/**
 * A stand-in for Drive v3: enough of files.list / files.get / files.create /
 * files.update to exercise every path the transport takes.
 */
function createFakeDrive() {
  const files = new Map<string, FakeFile>();
  const calls: DriveCall[] = [];
  let nextId = 1;
  /** Set to make the next N responses fail with a given status. */
  let forced: { status: number; times: number; body?: string } | null = null;
  /** Runs when the next upload request arrives — lets a test pull the file out
   *  from under a write, the way another device could. */
  let onNextUpload: (() => void) | null = null;
  /** Makes the next upload request fail at the transport level. */
  let uploadFailure: Error | null = null;

  const handler = vi.fn(async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const url = String(input);
    const method = (init.method ?? 'GET').toUpperCase();
    const headers = (init.headers ?? {}) as Record<string, string>;
    calls.push({
      url,
      method,
      body: typeof init.body === 'string' ? init.body : undefined,
      contentType: headers['content-type'],
      hasSignal: Boolean(init.signal),
    });

    if (!headers.authorization?.startsWith('Bearer ')) {
      return json({ error: { code: 401, message: 'Missing credentials' } }, 401);
    }
    if (forced && forced.times > 0) {
      forced.times -= 1;
      const status = forced.status;
      const body = forced.body;
      if (forced.times === 0) forced = null;
      return body === undefined ? json({ error: { code: status, message: 'forced' } }, status) : raw(body, status);
    }

    const u = new URL(url);
    const upload = u.pathname.startsWith('/upload/drive/v3/files');
    const idFromPath = /\/files\/([^/?]+)/.exec(u.pathname)?.[1];

    if (upload && onNextUpload) {
      const hook = onNextUpload;
      onNextUpload = null;
      hook();
    }
    if (upload && uploadFailure) {
      const e = uploadFailure;
      uploadFailure = null;
      throw e;
    }

    if (upload && method === 'POST') {
      const { metadata, content } = parseMultipart(String(init.body), headers['content-type'] ?? '');
      const id = `file-${nextId++}`;
      files.set(id, {
        id,
        name: String(metadata.name),
        trashed: false,
        appProperties: (metadata.appProperties ?? {}) as Record<string, string>,
        content,
      });
      return json({ id });
    }
    if (upload && method === 'PATCH' && idFromPath) {
      const existing = files.get(idFromPath);
      if (!existing) return json({ error: { code: 404, message: 'File not found' } }, 404);
      const { metadata, content } = parseMultipart(String(init.body), headers['content-type'] ?? '');
      files.set(idFromPath, {
        ...existing,
        name: String(metadata.name ?? existing.name),
        appProperties: (metadata.appProperties ?? existing.appProperties) as Record<string, string>,
        content,
      });
      return json({ id: idFromPath });
    }
    if (!upload && method === 'GET' && u.searchParams.get('q')) {
      const q = u.searchParams.get('q') ?? '';
      const wanted = /name = '([^']+)'/.exec(q)?.[1];
      const matches = [...files.values()].filter((f) => f.name === wanted && !f.trashed);
      return json({
        files: matches.map((f) => ({ id: f.id, name: f.name, appProperties: f.appProperties })),
      });
    }
    if (!upload && method === 'GET' && idFromPath) {
      const f = files.get(idFromPath);
      if (!f) return json({ error: { code: 404, message: 'File not found' } }, 404);
      if (u.searchParams.get('alt') === 'media') return raw(f.content);
      return json({ id: f.id, trashed: f.trashed, appProperties: f.appProperties });
    }
    throw new Error(`fake Drive got an unexpected request: ${method} ${url}`);
  });

  return {
    handler,
    files,
    calls,
    /** URLs of every request made so far. */
    urls: () => calls.map((c) => c.url),
    only: () => [...files.values()][0]!,
    force(status: number, times = 1, body?: string) {
      forced = { status, times, body };
    },
    /** The next upload request dies at the transport level (cable pulled). */
    breakNextUpload(error: Error) {
      uploadFailure = error;
    },
    /** Run `fn` the moment the next upload request arrives. */
    duringNextUpload(fn: () => void) {
      onNextUpload = fn;
    },
    install() {
      vi.stubGlobal('fetch', handler);
      return this;
    },
  };
}

/** In-memory replacement for the localStorage file-id cache. */
function memoryStore(initial: string | null = null) {
  let id = initial;
  return {
    get: () => id,
    set: (next: string | null) => {
      id = next;
    },
  };
}

/** A TokenProvider that never touches Google. */
function fakeAuth(over: Partial<TokenProvider> = {}): TokenProvider {
  let valid = true;
  return {
    hasValidToken: () => valid,
    isLinked: () => true,
    getToken: async () => 'token-abc',
    connect: async () => {
      valid = true;
    },
    invalidate: () => {
      valid = false;
    },
    disconnect: async () => {
      valid = false;
    },
    ...over,
  };
}

function transportWith(drive: ReturnType<typeof createFakeDrive>, auth = fakeAuth(), fileId: string | null = null) {
  return createDriveTransport({ auth, fileIdStore: memoryStore(fileId) });
}

/** Let queued microtasks (and the fake consent popup) run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

let drive: ReturnType<typeof createFakeDrive>;

beforeEach(() => {
  drive = createFakeDrive().install();
});

afterEach(() => {
  vi.unstubAllGlobals();
  resetGsiLoaderForTests();
});

// ---------------------------------------------------------------------------
// Nothing happens until the user asks for it
// ---------------------------------------------------------------------------

describe('silence before connect', () => {
  it('makes no request at all before connect() has been called', async () => {
    const notConnected = fakeAuth({
      hasValidToken: () => false,
      isLinked: () => false,
      getToken: async () => {
        throw new SyncTransportError('not-connected', 'Google Drive sync is not connected yet.');
      },
    });
    const t = transportWith(drive, notConnected);

    expect(t.isConnected()).toBe(false);
    await expect(t.readRemote()).rejects.toMatchObject({ kind: 'not-connected' });
    await expect(t.readRemoteMeta()).rejects.toMatchObject({ kind: 'not-connected' });
    await expect(t.writeRemote(snapshot())).rejects.toMatchObject({ kind: 'not-connected' });

    expect(drive.handler).not.toHaveBeenCalled();
  });

  it('does not load the Google script until connect() is called', async () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc.document);

    const provider = createGoogleTokenProvider({ clientId: () => 'test-client.apps.googleusercontent.com' });
    createDriveTransport({ auth: provider, fileIdStore: memoryStore() });

    // Creating the provider and the transport is inert: no script, no fetch.
    expect(doc.appended).toHaveLength(0);
    expect(drive.handler).not.toHaveBeenCalled();
    expect(provider.hasValidToken()).toBe(false);

    const connecting = provider.connect();
    await tick();
    expect(doc.appended).toHaveLength(1);
    expect(doc.appended[0]!.src).toBe(GSI_SCRIPT_SRC);
    expect(doc.appended[0]!.async).toBe(true);

    const gis = installFakeGis();
    doc.appended[0]!.fire('load');
    await tick();
    gis.respond({ access_token: 'tok-1', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;

    expect(provider.hasValidToken()).toBe(true);
    expect(drive.handler).not.toHaveBeenCalled(); // connecting is not syncing
  });
});

// ---------------------------------------------------------------------------
// Reading
// ---------------------------------------------------------------------------

describe('readRemote', () => {
  it('returns null when no sync file exists yet', async () => {
    const t = transportWith(drive);
    await expect(t.readRemote()).resolves.toBeNull();
    // One search, nothing else.
    expect(drive.calls).toHaveLength(1);
    expect(drive.calls[0]!.url).toContain(`${DRIVE_API}/files?q=`);
    expect(decodeURIComponent(drive.calls[0]!.url)).toContain(`name = '${SYNC_FILE_NAME}'`);
  });

  it('round-trips a snapshot: create, then read back verbatim', async () => {
    const t = transportWith(drive);
    const snap = snapshot();
    await t.writeRemote(snap);

    const back = (await t.readRemote()) as Snap | null;
    expect(back).toEqual(snap);
    // Integer minor units are moved, never transformed (SPEC §6).
    const txs = back!.tables.transactions as Array<{ amountMinor: number }>;
    expect(txs[0]!.amountMinor).toBe(-4599);
    expect(txs[1]!.amountMinor).toBe(250000);
    expect(Number.isInteger(txs[1]!.amountMinor)).toBe(true);
    expect(drive.only().name).toBe(SYNC_FILE_NAME);
  });

  it('reports malformed remote JSON instead of throwing it raw', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot());
    // Someone hand-edited the file in Drive and broke it.
    drive.only().content = '{"app":"MyMoney", oops';

    const err = await t.readRemote().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect(err).not.toBeInstanceOf(SyntaxError);
    expect((err as SyncTransportError).kind).toBe('remote');
    expect((err as SyncTransportError).message).toMatch(/isn't readable/i);
    expect((err as SyncTransportError).message).toMatch(/Nothing on this device was changed/i);
  });

  it('refuses a remote file that is valid JSON but not a MyMoney snapshot', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot());
    drive.only().content = JSON.stringify({ app: 'SomethingElse', tables: {} });

    await expect(t.readRemote()).rejects.toMatchObject({ kind: 'remote' });
  });

  // A conflict dialog asks "keep this device's copy, or the one saved on X at
  // Y?". A snapshot that cannot name X or Y is one nobody can judge, so it is
  // refused rather than rendered with blanks in it.
  it('refuses a snapshot that cannot say when or where it was written', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot());
    const good = JSON.parse(drive.only().content) as Record<string, unknown>;

    for (const missing of ['savedAt', 'deviceName', 'deviceId']) {
      drive.only().content = JSON.stringify({ ...good, [missing]: '' });
      await expect(t.readRemote()).rejects.toMatchObject({ kind: 'remote' });
    }
  });
});

// ---------------------------------------------------------------------------
// The cheap metadata path
// ---------------------------------------------------------------------------

describe('readRemoteMeta', () => {
  it('reads appProperties and never downloads the file body', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 12, deviceName: 'Laptop' }));
    drive.calls.length = 0;

    const meta = await t.readRemoteMeta();
    expect(meta).toEqual({
      revision: 12,
      savedAt: '2026-08-27T09:15:00.000Z',
      deviceName: 'Laptop',
    });
    // The whole point: a 3 MB snapshot is NOT fetched to answer this.
    expect(drive.urls().some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('is cheap on a fresh device too — the search already carries appProperties', async () => {
    await transportWith(drive).writeRemote(snapshot({ revision: 3 }));
    // A second device: no cached file id, so it searches by name.
    const fresh = transportWith(drive);
    drive.calls.length = 0;

    await expect(fresh.readRemoteMeta()).resolves.toMatchObject({ revision: 3 });
    expect(drive.urls().some((u) => u.includes('alt=media'))).toBe(false);
  });

  it('never reports "no remote" for a file whose appProperties are unusable', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 9 }));
    // Metadata lost (hand-edited file, or written by some other tool).
    drive.only().appProperties = {};
    drive.calls.length = 0;

    // It falls back to the slow path rather than answering null, because null
    // would tell the engine to push straight over this snapshot.
    const meta = await t.readRemoteMeta();
    expect(meta).toMatchObject({ revision: 9, deviceName: "Girish's iMac" });
    expect(drive.urls().some((u) => u.includes('alt=media'))).toBe(true);
  });

  it('returns null only when the file is genuinely absent', async () => {
    await expect(transportWith(drive).readRemoteMeta()).resolves.toBeNull();
  });

  it('recovers when the cached file id points at a deleted file', async () => {
    const t = transportWith(drive, fakeAuth(), 'file-that-is-gone');
    await expect(t.readRemoteMeta()).resolves.toBeNull();
    // Tried the cached id, got a 404, then searched by name.
    expect(drive.calls).toHaveLength(2);
    expect(drive.calls[1]!.url).toContain('files?q=');
  });
});

// ---------------------------------------------------------------------------
// Writing — the dangerous direction
// ---------------------------------------------------------------------------

describe('writeRemote', () => {
  it('sends content and appProperties in ONE multipart request', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot());

    const uploads = drive.calls.filter((c) => c.url.startsWith(DRIVE_UPLOAD_API));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.method).toBe('POST');
    expect(uploads[0]!.url).toContain('uploadType=multipart');
    expect(uploads[0]!.contentType).toMatch(/^multipart\/related; boundary=/);

    // Both halves really are in that one body — so Drive commits them together
    // or not at all, and a dropped connection cannot leave the file's stated
    // revision disagreeing with its contents.
    const { metadata, content } = parseMultipart(uploads[0]!.body!, uploads[0]!.contentType!);
    expect(metadata.name).toBe(SYNC_FILE_NAME);
    expect(metadata.appProperties).toMatchObject({ revision: '7', deviceName: "Girish's iMac" });
    expect(JSON.parse(content)).toEqual(snapshot());
  });

  it('updates the existing file instead of creating a second one', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 1 }));
    await t.writeRemote(snapshot({ revision: 2 }));

    expect(drive.files.size).toBe(1);
    expect(drive.only().appProperties.revision).toBe('2');
    const uploads = drive.calls.filter((c) => c.url.startsWith(DRIVE_UPLOAD_API));
    expect(uploads.map((c) => c.method)).toEqual(['POST', 'PATCH']);
  });

  it('leaves the remote untouched when the upload fails mid-flight', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 4 }));
    const before = { ...drive.only() };

    // The cable is pulled during the upload: fetch rejects, and Drive never
    // commits the partial body.
    drive.breakNextUpload(Object.assign(new Error('network down'), { name: 'TypeError' }));
    const err = await t.writeRemote(snapshot({ revision: 5 })).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect((err as SyncTransportError).kind).toBe('network');

    expect(drive.only().content).toBe(before.content);
    expect(drive.only().appProperties.revision).toBe('4');
  });

  // Drive rejects the whole upload if one appProperties entry exceeds 124
  // BYTES (key + value). Truncating by character count would pass this test's
  // ASCII cases and fail for anyone whose device name is in Tamil, Sinhala or
  // has an emoji in it — i.e. exactly this owner.
  it('keeps every appProperties entry inside Drive’s 124-byte limit', async () => {
    const t = transportWith(drive);
    const deviceName = `${'📱'.repeat(40)} கிரிஷ் இன் ஐபோன்`;
    await t.writeRemote(snapshot({ deviceName }));

    const props = drive.only().appProperties;
    const encoder = new TextEncoder();
    for (const [key, value] of Object.entries(props)) {
      expect(encoder.encode(key + value).length).toBeLessThanOrEqual(MAX_APP_PROPERTY_BYTES);
    }
    // Trimmed at a code-point boundary: no half-emoji, no lone surrogate.
    expect(props.deviceName).toBe(Array.from(props.deviceName!).join(''));
    expect(props.deviceName!.startsWith('📱')).toBe(true);
    // The snapshot itself keeps the name in full — only the preview is clipped.
    const back = (await t.readRemote()) as Snap;
    expect(back.deviceName).toBe(deviceName);
  });

  it('refuses to upload something that is not a MyMoney snapshot', async () => {
    const t = transportWith(drive);
    await expect(t.writeRemote({ app: 'Nope', tables: {} } as never)).rejects.toMatchObject({
      kind: 'remote',
    });
    expect(drive.handler).not.toHaveBeenCalled();
  });

  it('re-creates the file if it was deleted between the check and the write', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 1 }));
    const id = drive.only().id;

    // The file vanishes in the window between our existence check and the
    // upload landing, so the PATCH 404s.
    drive.duringNextUpload(() => drive.files.delete(id));
    await t.writeRemote(snapshot({ revision: 2 }));

    // It tried the update, was told the file is gone, and created it again
    // rather than dropping the push on the floor.
    const uploads = drive.calls.filter((c) => c.url.startsWith(DRIVE_UPLOAD_API));
    expect(uploads.map((c) => c.method)).toEqual(['POST', 'PATCH', 'POST']);
    expect(drive.files.size).toBe(1);
    expect(drive.only().appProperties.revision).toBe('2');
  });
});

// ---------------------------------------------------------------------------
// Failure modes
// ---------------------------------------------------------------------------

describe('failures stay calm', () => {
  it('surfaces an expired grant as "reconnect", not a crash', async () => {
    const auth = fakeAuth();
    const invalidate = vi.spyOn(auth, 'invalidate');
    const t = transportWith(drive, auth);
    drive.force(401, 2); // the retry gets a 401 too

    const err = await t.readRemoteMeta().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect((err as SyncTransportError).kind).toBe('auth');
    expect(isReconnectNeeded(err)).toBe(true);
    expect((err as SyncTransportError).message).toMatch(/reconnect/i);
    // It dropped the dead token and tried exactly once more before giving up.
    expect(invalidate).toHaveBeenCalledTimes(1);
    expect(drive.handler).toHaveBeenCalledTimes(2);
  });

  it('retries once after a 401 and succeeds when the new token works', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot({ revision: 6 }));
    drive.calls.length = 0;
    drive.force(401, 1);

    await expect(t.readRemoteMeta()).resolves.toMatchObject({ revision: 6 });
  });

  it('surfaces an aborted request as a timeout, and does pass an abort signal', async () => {
    const t = transportWith(drive);
    drive.handler.mockImplementationOnce(async (_input: unknown, init: RequestInit = {}) => {
      expect(init.signal).toBeInstanceOf(AbortSignal);
      throw Object.assign(new Error('aborted'), { name: 'AbortError' });
    });

    const err = await t.readRemote().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SyncTransportError);
    expect((err as SyncTransportError).kind).toBe('timeout');
    expect((err as SyncTransportError).message).toMatch(/took too long/i);
    expect((err as SyncTransportError).message).toMatch(/Nothing was changed/i);
  });

  it('reports being offline without making a request', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const t = transportWith(drive);
    await expect(t.readRemoteMeta()).rejects.toMatchObject({ kind: 'offline' });
    expect(drive.handler).not.toHaveBeenCalled();
  });

  it('treats a Drive outage as a transient network problem, not data trouble', async () => {
    const t = transportWith(drive);
    drive.force(503, 1);
    const err = await t.readRemoteMeta().catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('network');
    expect((err as SyncTransportError).message).toMatch(/Nothing was changed/i);
  });

  // Drive overloads 403 for both "you may not" and "you asked too often".
  // Sending someone round a consent loop over a rate limit helps nobody.
  it('does not mistake rate limiting for a lost permission', async () => {
    const t = transportWith(drive);
    drive.force(
      403,
      1,
      JSON.stringify({ error: { code: 403, message: 'User rate limit exceeded.' } }),
    );
    const err = await t.readRemoteMeta().catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('network');
    expect(isReconnectNeeded(err)).toBe(false);
  });

  it('does treat a genuinely refused request as needing a reconnect', async () => {
    const t = transportWith(drive);
    drive.force(
      403,
      1,
      JSON.stringify({ error: { code: 403, message: 'Insufficient permissions for this file.' } }),
    );
    const err = await t.readRemoteMeta().catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('auth');
    expect(isReconnectNeeded(err)).toBe(true);
  });

  it('never deletes the Drive file when disconnecting', async () => {
    const t = transportWith(drive);
    await t.writeRemote(snapshot());
    drive.calls.length = 0;

    await t.disconnect();

    expect(drive.files.size).toBe(1);
    expect(drive.calls.some((c) => c.method === 'DELETE')).toBe(false);
    expect(t.isConnected()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// OAuth
// ---------------------------------------------------------------------------

describe('OAuth scope and token handling', () => {
  it('requests EXACTLY the drive.file scope', async () => {
    const doc = fakeDocument();
    vi.stubGlobal('document', doc.document);
    const gis = installFakeGis();

    const provider = createGoogleTokenProvider({ clientId: () => 'abc.apps.googleusercontent.com' });
    const connecting = provider.connect();
    await tick();
    gis.respond({ access_token: 'tok', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;

    expect(gis.config!.scope).toBe('https://www.googleapis.com/auth/drive.file');
    // One scope, not a list: a space would mean a second scope crept in.
    expect(gis.config!.scope.trim().split(/\s+/)).toHaveLength(1);
    expect(gis.config!.client_id).toBe('abc.apps.googleusercontent.com');
  });

  // The one that matters most: this fails if anyone widens the grant later,
  // whether by editing the constant or by adding a second scope anywhere in
  // the sync code. drive.file = only files this app created. Full `drive`
  // would hand a personal-finance app the user's entire Drive.
  it('mentions no Google scope other than drive.file anywhere in the sync code', () => {
    const here = fileURLToPath(new URL('.', import.meta.url));
    const sources = ['googleAuth.ts', 'transport.ts'].map((f) =>
      readFileSync(`${here}../src/sync/${f}`, 'utf8'),
    );
    const found = new Set<string>();
    for (const src of sources) {
      for (const m of src.matchAll(/https:\/\/www\.googleapis\.com\/auth\/[A-Za-z0-9._-]+/g)) {
        found.add(m[0]);
      }
    }
    expect([...found]).toEqual(['https://www.googleapis.com/auth/drive.file']);
    expect(DRIVE_SCOPE).toBe('https://www.googleapis.com/auth/drive.file');
  });

  it('refuses a token granted without the drive.file scope', async () => {
    vi.stubGlobal('document', fakeDocument().document);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const connecting = provider.connect();
    await tick();
    gis.respond({ access_token: 'tok', expires_in: 3600, scope: 'openid email' });

    await expect(connecting).rejects.toMatchObject({ kind: 'auth' });
    expect(provider.hasValidToken()).toBe(false);
  });

  it('re-requests silently when the token expires, and only then', async () => {
    vi.stubGlobal('document', fakeDocument().document);
    const gis = installFakeGis();
    let clock = 1_000_000;
    const provider = createGoogleTokenProvider({ clientId: () => 'abc', now: () => clock });

    const connecting = provider.connect();
    await tick();
    gis.respond({ access_token: 'tok-1', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;
    expect(gis.prompts).toEqual(['consent']);

    await expect(provider.getToken()).resolves.toBe('tok-1');
    expect(gis.prompts).toEqual(['consent']); // still valid: nothing asked

    clock += 3600_000; // an hour later
    expect(provider.hasValidToken()).toBe(false);
    const refreshing = provider.getToken();
    await tick();
    gis.respond({ access_token: 'tok-2', expires_in: 3600, scope: DRIVE_SCOPE });
    await expect(refreshing).resolves.toBe('tok-2');
    expect(gis.prompts).toEqual(['consent', '']); // '' = the silent path
  });

  it('turns a blocked popup into a clear reconnect state', async () => {
    vi.stubGlobal('document', fakeDocument().document);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const connecting = provider.connect();
    await tick();
    gis.fail({ type: 'popup_failed_to_open' });

    const err = await connecting.catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('popup-blocked');
    expect((err as SyncTransportError).message).toMatch(/pop-ups/i);
    expect(isReconnectNeeded(err)).toBe(true);
  });

  it('treats a closed consent popup as a choice, not an error to shout about', async () => {
    vi.stubGlobal('document', fakeDocument().document);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const connecting = provider.connect();
    await tick();
    gis.fail({ type: 'popup_closed' });

    await expect(connecting).rejects.toMatchObject({ kind: 'cancelled' });
    expect(isReconnectNeeded(await connecting.catch((e: unknown) => e))).toBe(false);
  });

  it('says what to do when no client id has been set up', async () => {
    const provider = createGoogleTokenProvider({ clientId: () => '   ' });
    const err = await provider.connect().catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('config');
    expect((err as SyncTransportError).message).toMatch(/DRIVE-SETUP/);
    expect(drive.handler).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// Tiny DOM / GIS doubles
// ---------------------------------------------------------------------------

interface FakeScript {
  src: string;
  async: boolean;
  defer: boolean;
  fire(type: string): void;
  addEventListener(type: string, fn: () => void): void;
}

function fakeDocument() {
  const appended: FakeScript[] = [];
  const make = (): FakeScript => {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      src: '',
      async: false,
      defer: false,
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      fire(type) {
        for (const fn of listeners[type] ?? []) fn();
      },
    };
  };
  const document = {
    createElement: () => make(),
    querySelector: () => null,
    head: {
      appendChild: (el: FakeScript) => {
        appended.push(el);
        return el;
      },
    },
  };
  return { document: document as unknown as Document, appended };
}

/**
 * Stand-in for `google.accounts.oauth2`. `respond`/`fail` play the part of the
 * consent popup coming back.
 */
function installFakeGis() {
  const state: {
    config: { client_id: string; scope: string } | null;
    prompts: string[];
    respond: (r: GisTokenResponse) => void;
    fail: (e: { type: string }) => void;
    revoked: string[];
  } = {
    config: null,
    prompts: [],
    respond: () => {},
    fail: () => {},
    revoked: [],
  };
  vi.stubGlobal('google', {
    accounts: {
      oauth2: {
        initTokenClient: (config: {
          client_id: string;
          scope: string;
          callback: (r: GisTokenResponse) => void;
          error_callback?: (e: { type: string }) => void;
        }) => {
          state.config = config;
          state.respond = config.callback;
          state.fail = (e) => config.error_callback?.(e);
          return {
            requestAccessToken: (o?: { prompt?: string }) => state.prompts.push(o?.prompt ?? ''),
          };
        },
        revoke: (token: string, done?: () => void) => {
          state.revoked.push(token);
          done?.();
        },
      },
    },
  });
  return state;
}
