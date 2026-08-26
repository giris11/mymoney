// Google Drive transport for sync (D42) — Drive v3 REST over fetch.
//
// The user's own Drive holds ONE file, `mymoney-sync.json`, created by this
// app. Nothing else in Drive is visible to us: the grant is `drive.file`
// (see src/sync/googleAuth.ts), which is per-file access to files this app
// created. There is no server of ours anywhere in this path, no SDK, and no
// new dependency — Drive v3 is a plain REST API and `fetch` is enough.
//
// THE RULE THIS FILE IS BUILT AROUND: never silently lose the remote.
// A sync that stops and asks is a good sync; one that quietly loses a week of
// spending is worthless (SPEC §2.6). Concretely, that means:
//
//  1. WRITES ARE ONE ATOMIC REQUEST. Content and metadata travel together in a
//     single `uploadType=multipart` call, so Drive either commits BOTH or
//     neither. If the network dies mid-upload, Drive never completes the
//     request: it discards the partial body, the existing file keeps its
//     previous content AND its previous appProperties, and the local side sees
//     a thrown SyncTransportError meaning "not pushed" — nothing to reconcile,
//     just retry. The alternative (upload content, then patch appProperties)
//     was rejected precisely because its failure window leaves the file's
//     stated revision disagreeing with its contents, and every device would
//     then reason from a lie.
//  2. A FILE THAT EXISTS IS NEVER REPORTED AS ABSENT. readRemoteMeta() returns
//     null ONLY when there is genuinely no sync file. If a file exists but its
//     appProperties are missing or unusable, it falls back to reading the file
//     and deriving the metadata from the snapshot itself. Returning null there
//     would tell the engine "no remote yet", and the engine would push — over
//     the top of a snapshot nobody had seen.
//  3. WE NEVER DELETE ANYTHING. disconnect() drops the local grant; the Drive
//     file is left exactly where it is. There is no code path in this app that
//     deletes the remote snapshot.
//  4. MONEY IS MOVED, NEVER TOUCHED. The snapshot is serialised with
//     JSON.stringify and parsed with JSON.parse. Amounts are integer minor
//     units and stay integers; no rounding, no coercion, no re-interpretation
//     happens anywhere in this file (SPEC §6).
//
// COST: metadata checks run on every sync check and the owner's snapshot is
// ~3 MB, so readRemoteMeta() reads the file's appProperties — a few hundred
// bytes — and never the file body. Locked by test.

import type { SyncSnapshot, SyncTransport } from './types';
import {
  createGoogleTokenProvider,
  isOffline,
  SyncTransportError,
  type TokenProvider,
} from './googleAuth';

/** The one file this app keeps in the user's Drive. */
export const SYNC_FILE_NAME = 'mymoney-sync.json';

export const DRIVE_API = 'https://www.googleapis.com/drive/v3';
export const DRIVE_UPLOAD_API = 'https://www.googleapis.com/upload/drive/v3';

/** Metadata calls are small; a hung one must never wedge the app. */
export const DRIVE_TIMEOUT_MS = 20_000;

/** Uploads/downloads carry megabytes over a phone connection — be patient,
 *  but still bounded. */
export const DRIVE_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * Google recommends resumable upload above ~5 MB. Below it, a single multipart
 * request is both simpler and strictly safer (see rule 1 above). The owner's
 * snapshot is ~3 MB today; if it ever crosses this line, writeRemote refuses
 * rather than pushing its luck on a phone connection — that is the "when in
 * doubt, refuse and ask" rule applied to our own upload.
 */
export const MULTIPART_MAX_BYTES = 5 * 1024 * 1024;

/**
 * Drive's hard limit on one appProperties entry: 124 BYTES for key and value
 * together, in UTF-8. Bytes, not characters — "Girish's iPhone 📱" is 18
 * characters but 21 bytes, and a device named in Tamil or Sinhala runs to
 * three bytes a letter. Truncating by character count would sail past the
 * limit, Drive would reject the whole upload with a 400, and sync would be
 * dead for exactly the users with non-Latin device names. See fitProperty().
 */
export const MAX_APP_PROPERTY_BYTES = 124;

/** Cached pointer to the Drive file. A hint, not a record: it holds no
 *  financial data and is rebuilt by searching Drive by name if it is wrong or
 *  missing, so losing it costs one extra request and nothing else. */
export const FILE_ID_STORAGE_KEY = 'mymoney.sync.drive.fileId';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Re-exported, not redeclared: the interface itself lives in ./types.ts so the
 * engine can depend on it without an import edge into this Google-specific
 * module, while `import type { SyncTransport } from './transport'` still works
 * as pinned. One declaration, so the two halves cannot drift apart.
 */
export type { SyncTransport } from './types';

// ---------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

interface FileIdStore {
  get(): string | null;
  set(id: string | null): void;
}

const localFileIdStore: FileIdStore = {
  get() {
    try {
      return storage()?.getItem(FILE_ID_STORAGE_KEY) ?? null;
    } catch {
      return null;
    }
  },
  set(id) {
    try {
      const s = storage();
      if (!s) return;
      if (id) s.setItem(FILE_ID_STORAGE_KEY, id);
      else s.removeItem(FILE_ID_STORAGE_KEY);
    } catch {
      /* the pointer is a cache; failing to persist it is harmless */
    }
  },
};

/**
 * Fit one appProperties value inside Drive's per-entry byte budget, trimming
 * whole CODE POINTS so an emoji or a combining pair is dropped intact rather
 * than sliced in half into a lone surrogate.
 *
 * This only ever shortens the label carried in the cheap metadata read; the
 * snapshot itself keeps the full value, so nothing about the user's data is
 * lost — only the preview string a conflict dialog shows before the full file
 * is fetched.
 */
export function fitProperty(key: string, value: string): string {
  const encoder = new TextEncoder();
  const budget = MAX_APP_PROPERTY_BYTES - encoder.encode(key).length;
  if (budget <= 0) return '';
  if (encoder.encode(value).length <= budget) return value;
  const points = Array.from(value);
  while (points.length > 0 && encoder.encode(points.join('')).length > budget) points.pop();
  return points.join('');
}

function isAbort(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    ((e as { name?: string }).name === 'AbortError' ||
      (e as { name?: string }).name === 'TimeoutError')
  );
}

/**
 * Turn a non-OK Drive response into a typed error with a message a person can
 * act on. Drive answers `{"error":{"code":403,"message":"…"}}`; a body we
 * cannot parse must not stop us reporting the status.
 */
async function errorFromResponse(res: Response, what: string): Promise<SyncTransportError> {
  let detail = '';
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { error?: { message?: string } };
        detail = body.error?.message ?? text.slice(0, 200);
      } catch {
        detail = text.slice(0, 200);
      }
    }
  } catch {
    /* body unreadable — the status is still worth reporting */
  }
  if (res.status === 401) {
    return new SyncTransportError('auth', 'Google sign-in has expired. Reconnect to sync.');
  }
  if (res.status === 403) {
    // Drive overloads 403: it is both "you may not" and "you asked too often".
    // Telling someone to reconnect when they have merely hit a rate limit sends
    // them round a consent loop that cannot help.
    if (/rate|quota|limit|backend/i.test(detail)) {
      return new SyncTransportError(
        'network',
        'Google Drive is rate-limiting requests just now. Nothing was changed; try again shortly.',
      );
    }
    return new SyncTransportError(
      'auth',
      `Google Drive refused the request (${detail || 'permission denied'}). Reconnect to sync.`,
    );
  }
  if (res.status === 429 || res.status >= 500) {
    return new SyncTransportError(
      'network',
      `Google Drive is busy right now (HTTP ${res.status}). Nothing was changed; try again shortly.`,
    );
  }
  return new SyncTransportError(
    'remote',
    `Google Drive couldn't ${what} (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`,
  );
}

/**
 * Parse and vet a remote snapshot. A file we cannot fully trust is REPORTED,
 * never half-used: the caller gets a SyncTransportError with a readable
 * message instead of a raw SyntaxError, and nothing local is touched.
 */
export function parseSnapshot(text: string): SyncSnapshot {
  let json: unknown;
  try {
    json = JSON.parse(text) as unknown;
  } catch {
    throw new SyncTransportError(
      'remote',
      "The sync file in Google Drive isn't readable (it is not valid JSON). Nothing on this device was changed.",
    );
  }
  return vetSnapshot(json, 'The sync file in Google Drive');
}

function vetSnapshot(json: unknown, subject: string): SyncSnapshot {
  const bad = (why: string) =>
    new SyncTransportError('remote', `${subject} ${why}. Nothing on this device was changed.`);

  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw bad('is not a MyMoney snapshot');
  }
  const o = json as Record<string, unknown>;
  if (o.app !== 'MyMoney') throw bad('was not written by MyMoney');
  if (typeof o.schemaVersion !== 'number' || !Number.isFinite(o.schemaVersion)) {
    throw bad('has no usable schema version');
  }
  if (typeof o.revision !== 'number' || !Number.isInteger(o.revision) || o.revision < 0) {
    throw bad('has no usable revision number');
  }
  // savedAt / deviceName / deviceId are what a conflict dialog puts in front of
  // the user before they choose which side to keep. A snapshot that cannot say
  // when it was written or where it came from is one nobody can judge, so it is
  // refused rather than shown with blanks in it.
  for (const field of ['savedAt', 'deviceId', 'deviceName'] as const) {
    if (typeof o[field] !== 'string' || (o[field] as string) === '') {
      throw bad(`does not say ${field === 'savedAt' ? 'when it was written' : 'which device wrote it'}`);
    }
  }
  if (typeof o.tables !== 'object' || o.tables === null || Array.isArray(o.tables)) {
    throw bad('has no data tables');
  }
  for (const [name, rows] of Object.entries(o.tables as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw bad(`has a damaged "${name}" table`);
  }
  return json as SyncSnapshot;
}

/** Rows across every table — used for the summary counts the UI shows. */
export function countRows(snap: SyncSnapshot): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const [name, rows] of Object.entries(snap.tables ?? {})) {
    counts[name] = Array.isArray(rows) ? rows.length : 0;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface DriveTransportOptions {
  /** Identity source. Defaults to the real GIS-backed provider. */
  auth?: TokenProvider;
  /** The user's own OAuth client id, when using the default provider. */
  clientId?: () => string | Promise<string>;
  /** Test seam for the cached Drive file id. */
  fileIdStore?: FileIdStore;
}

interface FileRef {
  id: string;
  appProperties?: Record<string, string>;
}

export function createDriveTransport(opts: DriveTransportOptions = {}): SyncTransport {
  const auth =
    opts.auth ??
    createGoogleTokenProvider({
      clientId:
        opts.clientId ??
        (() => {
          throw new SyncTransportError(
            'config',
            'No Google client ID configured for sync. See docs/DRIVE-SETUP.md.',
          );
        }),
    });
  const fileIds = opts.fileIdStore ?? localFileIdStore;

  /**
   * One authorised Drive request, on a leash, with exactly one retry after a
   * 401 (tokens last about an hour, so an expiry mid-session is normal, not an
   * error to show anyone). `allowStatus` lets a caller handle an expected
   * status — 404 for "the cached file id is stale" — instead of throwing.
   */
  async function driveRequest(
    url: string,
    init: RequestInit,
    o: { timeoutMs?: number; what: string; allowStatus?: number[]; retried?: boolean } = {
      what: 'talk to Drive',
    },
  ): Promise<Response> {
    if (isOffline()) {
      throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
    }
    const token = await auth.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? DRIVE_TIMEOUT_MS);
    let res: Response;
    try {
      res = await fetch(url, {
        ...init,
        signal: controller.signal,
        // Nothing about the user rides along besides the bearer token: no
        // cookies, no referrer. The URL never carries personal data.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      });
    } catch (e) {
      if (isAbort(e)) {
        throw new SyncTransportError(
          'timeout',
          `Google Drive took too long to ${o.what}. Nothing was changed; try again.`,
        );
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }
      throw new SyncTransportError(
        'network',
        `Couldn't reach Google Drive to ${o.what}. Nothing was changed.`,
        { cause: e },
      );
    } finally {
      clearTimeout(timer);
    }

    if (res.status === 401 && !o.retried) {
      // The token died mid-session. Drop it, get a fresh one, try once more.
      auth.invalidate();
      return driveRequest(url, init, { ...o, retried: true });
    }
    if (res.ok || o.allowStatus?.includes(res.status)) return res;
    throw await errorFromResponse(res, o.what);
  }

  async function fetchRefById(id: string): Promise<FileRef | null> {
    const res = await driveRequest(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,trashed,appProperties`,
      { method: 'GET' },
      { what: 'check the sync file', allowStatus: [404] },
    );
    if (res.status === 404) return null;
    const body = (await res.json()) as { id?: string; trashed?: boolean; appProperties?: Record<string, string> };
    if (!body.id || body.trashed) return null;
    return { id: body.id, appProperties: body.appProperties };
  }

  /**
   * Find the sync file. `drive.file` means this search can only ever see files
   * this app created, so there is no way for it to stumble onto the user's own
   * documents.
   *
   * If several files share the name (Drive allows duplicates, and a user can
   * copy a file), the one with the HIGHEST revision wins, then the most
   * recently modified. Picking by revision is the only tie-break that matches
   * what the number means; the chosen id is then cached so the choice is
   * stable across sessions.
   */
  async function searchForRef(): Promise<FileRef | null> {
    const q = `name = '${SYNC_FILE_NAME}' and trashed = false`;
    const url =
      `${DRIVE_API}/files?q=${encodeURIComponent(q)}&spaces=drive&pageSize=20` +
      `&orderBy=modifiedTime desc&fields=${encodeURIComponent('files(id,name,modifiedTime,appProperties)')}`;
    const res = await driveRequest(url, { method: 'GET' }, { what: 'look for the sync file' });
    const body = (await res.json()) as {
      files?: Array<{ id?: string; appProperties?: Record<string, string>; modifiedTime?: string }>;
    };
    const files = (body.files ?? []).filter((f): f is { id: string; appProperties?: Record<string, string>; modifiedTime?: string } =>
      typeof f.id === 'string' && f.id.length > 0,
    );
    if (files.length === 0) return null;
    // Already ordered newest-first by Drive; a real revision beats that.
    let best = files[0]!;
    let bestRevision = revisionOf(best.appProperties);
    for (const f of files.slice(1)) {
      const rev = revisionOf(f.appProperties);
      if (rev > bestRevision) {
        best = f;
        bestRevision = rev;
      }
    }
    fileIds.set(best.id);
    return { id: best.id, appProperties: best.appProperties };
  }

  function revisionOf(props: Record<string, string> | undefined): number {
    const raw = Number(props?.revision);
    return Number.isInteger(raw) && raw >= 0 ? raw : -1;
  }

  /** The current sync file, or null when there genuinely is not one. */
  async function findRef(): Promise<FileRef | null> {
    const cached = fileIds.get();
    if (cached) {
      const ref = await fetchRefById(cached);
      if (ref) return ref;
      fileIds.set(null); // stale pointer (deleted or trashed) — search again
    }
    return searchForRef();
  }

  async function downloadSnapshot(id: string): Promise<SyncSnapshot> {
    const res = await driveRequest(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`,
      { method: 'GET' },
      { what: 'download the sync file', timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS },
    );
    return parseSnapshot(await res.text());
  }

  /**
   * Build the single multipart/related body that carries metadata and content
   * together. The boundary is random and verified absent from the payload — a
   * boundary that appeared inside the JSON would truncate the upload, which is
   * exactly the class of silent corruption this file refuses to allow.
   */
  function multipart(metadata: unknown, content: string): { body: string; contentType: string } {
    const meta = JSON.stringify(metadata);
    let boundary = '';
    do {
      boundary = `mymoney-${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`;
      // The metadata carries the user's device name, so check it too — not just
      // the snapshot body.
    } while (content.includes(boundary) || meta.includes(boundary));
    const body =
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${meta}\r\n` +
      `--${boundary}\r\n` +
      'Content-Type: application/json; charset=UTF-8\r\n\r\n' +
      `${content}\r\n` +
      `--${boundary}--`;
    return { body, contentType: `multipart/related; boundary=${boundary}` };
  }

  return {
    isConnected: () => auth.hasValidToken(),

    connect: () => auth.connect(),

    async disconnect() {
      // The Drive file stays exactly where it is. Disconnecting is about this
      // device's access, never about destroying the user's data.
      fileIds.set(null);
      await auth.disconnect();
    },

    async readRemote() {
      const ref = await findRef();
      if (!ref) return null;
      return downloadSnapshot(ref.id);
    },

    async readRemoteMeta() {
      const ref = await findRef();
      if (!ref) return null; // genuinely no file — the only null this returns

      const props = ref.appProperties;
      const revision = Number(props?.revision);
      const savedAt = props?.savedAt;
      const deviceName = props?.deviceName;
      if (
        Number.isInteger(revision) &&
        revision >= 0 &&
        typeof savedAt === 'string' &&
        savedAt !== '' &&
        typeof deviceName === 'string'
      ) {
        return { revision, savedAt, deviceName };
      }

      // The cheap path failed: the file exists but its appProperties are
      // missing or damaged (hand-edited, or written by some other tool). Read
      // the file and take the metadata from the snapshot itself. This is the
      // slow path on purpose — reporting null here would tell the engine there
      // is no remote, and the next push would flatten a snapshot nobody saw.
      const snap = await downloadSnapshot(ref.id);
      return {
        revision: snap.revision,
        savedAt: snap.savedAt,
        deviceName: snap.deviceName,
      };
    },

    async writeRemote(snap) {
      // Vet our own payload before it leaves: a snapshot we would refuse to
      // read back is a snapshot we must not write.
      vetSnapshot(snap, 'This snapshot');

      const content = JSON.stringify(snap);
      // Measured in BYTES, not string length: a payee name in Tamil is one
      // JS character but three UTF-8 bytes, so counting characters would let a
      // snapshot well over the limit through.
      const bytes = new TextEncoder().encode(content).length;
      if (bytes > MULTIPART_MAX_BYTES) {
        throw new SyncTransportError(
          'remote',
          `This snapshot is ${(bytes / 1024 / 1024).toFixed(1)} MB, too large for a single safe upload. Use a backup file to move it (Settings → Backup).`,
        );
      }

      const metadata = {
        name: SYNC_FILE_NAME,
        mimeType: 'application/json',
        // Read by readRemoteMeta() so a sync check costs a few hundred bytes
        // instead of megabytes. Values must be strings.
        appProperties: {
          app: 'MyMoney',
          revision: String(snap.revision),
          savedAt: fitProperty('savedAt', String(snap.savedAt)),
          deviceId: fitProperty('deviceId', String(snap.deviceId)),
          deviceName: fitProperty('deviceName', String(snap.deviceName)),
          schemaVersion: String(snap.schemaVersion),
        },
      };
      const { body, contentType } = multipart(metadata, content);

      const cached = fileIds.get();
      const existing = cached ? await fetchRefById(cached) : await findRef();

      // ONE request. Drive commits content and appProperties together or not
      // at all, so a connection that drops mid-upload leaves the previous
      // snapshot completely intact — not a truncated file, not a file whose
      // stated revision lies about its contents.
      const send = (url: string, method: 'POST' | 'PATCH') =>
        driveRequest(
          url,
          { method, body, headers: { 'content-type': contentType } },
          { what: 'save the sync file', timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS, allowStatus: [404] },
        );

      if (existing) {
        const res = await send(
          `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(existing.id)}?uploadType=multipart&fields=id`,
          'PATCH',
        );
        if (res.status !== 404) return;
        // Someone deleted the file between our check and our write. Fall
        // through and create it again rather than losing the push.
        fileIds.set(null);
      }

      const res = await send(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, 'POST');
      if (res.status === 404) {
        throw new SyncTransportError('remote', "Google Drive wouldn't create the sync file.");
      }
      const created = (await res.json()) as { id?: string };
      if (created.id) fileIds.set(created.id);
    },
  };
}
