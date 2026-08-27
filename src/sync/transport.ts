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
//  1a. A WRITE IS CONDITIONAL ON ITS PARENT, AND IS READ BACK. Drive has no
//     If-Match for files.update, so the check is done here: immediately before
//     the upload we re-read the head and refuse unless its snapshotId is still
//     the `parentSnapshotId` this snapshot was built on, and immediately after
//     we read it back and refuse to report success unless OUR snapshotId is
//     what landed. Without this, two devices that both read revision N both
//     PATCH revision N, the second silently erases the first, and both record
//     agreement — the wipe this subsystem exists to prevent. The window being
//     closed is long: a 3 MB export plus a 3 MB upload on a phone connection,
//     and in the conflict path a save dialog that can sit open for minutes.
//     A refused write costs one redundant sync; an unrefused one costs a book.
//  1b. …AND THE PARENT'S ID IS NOT ENOUGH ON ITS OWN (C18). files.update
//     MERGES appProperties: a key the writer omits KEEPS ITS OLD VALUE. A
//     device on a build from before ancestry existed sends no snapshotId, so
//     its upload leaves the PREVIOUS writer's id sitting on a file whose
//     contents it has just replaced — and 1a's check, reading only that id,
//     says "still the parent I was built on". Neither does the revision it
//     also writes save us: the engine asks for head + 1, so our write is
//     always strictly above, and that guard can only fire on a legacy writer
//     that is AHEAD of us. So writeRemote also takes `expectHead` — the whole
//     stamp the caller read (revision, savedAt, deviceId beside the id) — and
//     refuses unless the head still matches all of it. Those are exactly the
//     fields such a writer DOES write, which is the only reason they can
//     testify that it wrote.
//  2. A FILE THAT EXISTS IS NEVER REPORTED AS ABSENT. readRemoteMeta() returns
//     null ONLY when there is genuinely no sync file. If a file exists but its
//     appProperties are missing or unusable, it falls back to reading the file
//     and deriving the metadata from the snapshot itself. Returning null there
//     would tell the engine "no remote yet", and the engine would push — over
//     the top of a snapshot nobody had seen. A file in DRIVE'S BIN counts as
//     existing: `files.list` hides trashed files, so the known file id is
//     looked up directly and its `trashed` flag reported, because a device
//     that answered "no file" there went on to start a second lineage at
//     revision 1 while the first was one click from being restored.
//  3. WE NEVER DELETE ANYTHING. disconnect() drops the local grant; the Drive
//     file is left exactly where it is. There is no code path in this app that
//     deletes the remote snapshot.
//  4. MONEY IS MOVED, NEVER TOUCHED. The snapshot is serialised with
//     JSON.stringify and parsed with JSON.parse. Amounts are integer minor
//     units and stay integers; no rounding, no coercion, no re-interpretation
//     happens anywhere in this file (SPEC §6).
//  5. EVERY REQUEST IS BOUNDED END TO END, BODY INCLUDED. The abort timer is
//     held until the response body has been read, not released when the
//     headers arrive: a connection that delivers "200 OK" and then goes silent
//     used to leave the read hanging for ever behind a spinner that never
//     stopped and an error that never came.
//
// COST: metadata checks run on every sync check and the owner's snapshot is
// ~3 MB, so readRemoteMeta() reads the file's appProperties — a few hundred
// bytes — and never the file body. Locked by test.

import type { SyncRemoteMeta, SyncSnapshot, SyncStamp, SyncTransport } from './types';
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

/**
 * The room a snapshot id has inside that budget, measured against the LONGEST
 * key it is stored under ('parentSnapshotId'). Ids are uid()s — 36 ASCII
 * characters — so this is never close, and it is checked rather than trimmed
 * on purpose: fitProperty() shortens a display label, which is harmless, but a
 * TRUNCATED IDENTITY is worse than no identity at all. Two half-ids can
 * collide, and a collision here reads as "the same snapshot" to every device.
 */
export const MAX_SNAPSHOT_ID_BYTES = MAX_APP_PROPERTY_BYTES - 'parentSnapshotId'.length;

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
 * One Drive response, with its body ALREADY READ — see driveRequest. Callers
 * never touch a live stream, which is what keeps every read inside the
 * request's timeout.
 */
interface DriveResponse {
  status: number;
  ok: boolean;
  /** The complete body, read while the abort timer was still armed. */
  text: string;
}

/** JSON from a body we have in hand, as a typed error rather than a raw throw. */
function parseJson<T>(res: DriveResponse, what: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new SyncTransportError(
      'remote',
      `Google Drive's answer when asked to ${what} was not readable. Nothing was changed.`,
    );
  }
}

/**
 * Turn a non-OK Drive response into a typed error with a message a person can
 * act on. Drive answers `{"error":{"code":403,"errors":[{"reason":"…"}],
 * "message":"…"}}`; a body we cannot parse must not stop us reporting the
 * status.
 */
function errorFromResponse(res: DriveResponse, what: string): SyncTransportError {
  let detail = '';
  let reasons: string[] = [];
  if (res.text) {
    try {
      const body = JSON.parse(res.text) as {
        error?: { message?: string; errors?: { reason?: string }[] };
      };
      detail = body.error?.message ?? res.text.slice(0, 200);
      reasons = (body.error?.errors ?? [])
        .map((e) => (typeof e?.reason === 'string' ? e.reason : ''))
        .filter((r) => r !== '');
    } catch {
      detail = res.text.slice(0, 200);
    }
  }
  if (res.status === 401) {
    return new SyncTransportError('auth', 'Google sign-in has expired. Reconnect to sync.');
  }
  if (res.status === 403) {
    // Drive overloads 403 THREE ways: "you may not", "you asked too often",
    // and "your Drive is full" — and the last two both say the word "quota".
    //
    // A FULL DRIVE IS PERMANENT. It will not clear on its own, no amount of
    // waiting helps, and only the owner can fix it. Reporting it as rate
    // limiting told them to "try again shortly" for ever while every push
    // failed and the off-site copy silently stopped advancing. The reason code
    // that tells the two apart is in the body Drive already sent; it used to
    // be parsed and thrown away.
    if (reasons.includes('storageQuotaExceeded') || /storage quota/i.test(detail)) {
      return new SyncTransportError(
        'remote',
        'Your Google Drive is full, so nothing could be saved to it. Nothing on this ' +
          'device was changed. Free up space in Drive (emptying its bin often does it) ' +
          'and sync again — until then this device is the only copy of your recent changes.',
      );
    }
    // Telling someone to reconnect when they have merely hit a rate limit sends
    // them round a consent loop that cannot help.
    if (
      reasons.some((r) => /rate|quota|limit|backend/i.test(r)) ||
      /rate|quota|limit|backend/i.test(detail)
    ) {
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

function vetSnapshot(json: unknown, subject: string, opts: { forWriting?: boolean } = {}): SyncSnapshot {
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
  // Identity and ancestry. ASYMMETRIC ON PURPOSE: reading tolerates a file
  // written before ancestry existed (refusing it would strand a working sync
  // file, and the engine already treats "no identity" as "cannot use the
  // ancestry table"), but WRITING one is refused outright — a snapshot with no
  // id cannot be pointed at by its children, and cannot be checked when it is
  // read back, so it would reopen the hole this whole mechanism closes.
  const idField = (field: 'snapshotId' | 'parentSnapshotId', nullable: boolean) => {
    const v = o[field];
    if (v === undefined || (nullable && v === null)) return null;
    if (typeof v !== 'string' || v === '') throw bad(`has an unusable ${field}`);
    if (new TextEncoder().encode(v).length > MAX_SNAPSHOT_ID_BYTES) {
      throw bad(`has a ${field} too long to store safely`);
    }
    return v;
  };
  const snapshotId = idField('snapshotId', false);
  idField('parentSnapshotId', true);
  if (opts.forWriting && snapshotId === null) {
    throw bad('has no snapshot id, so nothing could descend from it');
  }

  if (typeof o.tables !== 'object' || o.tables === null || Array.isArray(o.tables)) {
    throw bad('has no data tables');
  }
  for (const [name, rows] of Object.entries(o.tables as Record<string, unknown>)) {
    if (!Array.isArray(rows)) throw bad(`has a damaged "${name}" table`);
  }
  return json as SyncSnapshot;
}

/**
 * An appProperties value read back as an id: absent, empty and non-string all
 * mean "no id". Empty string matters — it is how a null parent is stored,
 * because Drive's files.update MERGES appProperties (a key left out keeps its
 * previous value, which would let a stale parent survive a write) while a null
 * value DELETES the key. Storing '' and decoding it here covers both.
 */
function idProperty(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
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
  /** The file is in Drive's bin. It still exists (rule 2). */
  trashed?: boolean;
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
  ): Promise<DriveResponse> {
    if (isOffline()) {
      throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
    }
    const token = await auth.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? DRIVE_TIMEOUT_MS);
    let status: number;
    let ok: boolean;
    let text: string;
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        // Nothing about the user rides along besides the bearer token: no
        // cookies, no referrer. The URL never carries personal data.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { ...(init.headers as Record<string, string> | undefined), authorization: `Bearer ${token}` },
      });
      status = res.status;
      ok = res.ok;
      // THE BODY IS READ HERE, INSIDE THE LEASH. `fetch` resolves when the
      // HEADERS arrive; the megabytes come afterwards. Releasing the timer at
      // that point — which is what a `finally` around the fetch alone does —
      // left every body read in this file unbounded and unabortable, so a
      // connection that answered "200 OK" and then went silent (a phone
      // leaving coverage, a captive portal) hung for ever: the promise never
      // settled, the caller never returned, and the Sync screen sat on
      // "Syncing…" with no error and no way out but a reload. Reading here
      // costs one buffered string on paths that discard it (the largest is the
      // ~3 MB snapshot we were going to parse anyway) and makes the timeout
      // mean what its name says.
      text = await res.text();
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

    if (status === 401 && !o.retried) {
      // The token died mid-session. Drop it, get a fresh one, try once more.
      auth.invalidate();
      return driveRequest(url, init, { ...o, retried: true });
    }
    const res: DriveResponse = { status, ok, text };
    if (ok || o.allowStatus?.includes(status)) return res;
    throw errorFromResponse(res, o.what);
  }

  /**
   * The file with this id, or null if there is no such file. A TRASHED file is
   * returned, flagged — see rule 2 in the header: it exists, it is restorable,
   * and calling it absent is what let a device start a second lineage.
   */
  async function fetchRefById(id: string): Promise<FileRef | null> {
    const res = await driveRequest(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?fields=id,trashed,appProperties`,
      { method: 'GET' },
      { what: 'check the sync file', allowStatus: [404] },
    );
    if (res.status === 404) return null;
    const body = parseJson<{ id?: string; trashed?: boolean; appProperties?: Record<string, string> }>(
      res,
      'check the sync file',
    );
    if (!body.id) return null;
    return { id: body.id, appProperties: body.appProperties, trashed: Boolean(body.trashed) };
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
    const body = parseJson<{
      files?: Array<{ id?: string; appProperties?: Record<string, string>; modifiedTime?: string }>;
    }>(res, 'look for the sync file');
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

  /**
   * Which field of the stamp the head no longer agrees with, or null when it
   * still matches in every respect. The NAME is returned rather than a
   * boolean so the refusal can tell the owner what actually changed.
   *
   * A field the head does not report ABSTAINS instead of failing: damaged or
   * hand-edited appProperties must not turn every push into a refusal, and a
   * head missing these keys is one readRemoteMeta() would have read from the
   * file body anyway. Abstention is safe here because it is never the only
   * check — identity is compared exactly, above and here, and the fields that
   * matter for C18 (revision, savedAt, deviceId) are precisely the ones a
   * legacy writer DOES write. It is "no evidence", not "evidence of no".
   */
  function headStampMismatch(
    props: Record<string, string> | undefined,
    expected: SyncStamp,
  ): string | null {
    if (idProperty(props?.snapshotId) !== expected.snapshotId) return 'identity';
    const revision = revisionOf(props);
    if (revision >= 0 && revision !== expected.revision) return 'version number';
    const savedAt = props?.savedAt;
    if (typeof savedAt === 'string' && savedAt !== '' && savedAt !== expected.savedAt) {
      return 'save time';
    }
    const deviceId = idProperty(props?.deviceId);
    const expectedDeviceId = expected.deviceId ?? null;
    if (deviceId !== null && expectedDeviceId !== null && deviceId !== expectedDeviceId) {
      return 'writing device';
    }
    return null;
  }

  /**
   * The current sync file, or null when there genuinely is not one.
   *
   * The trashed case is the interesting one. `files.list` cannot see a file in
   * the bin (its query says `trashed = false`, and Drive excludes them anyway),
   * so a device whose known file was binned used to search, find nothing, and
   * report "no sync file" — indistinguishable from a device that had never
   * synced. The known id is therefore looked up DIRECTLY: if it comes back
   * trashed we prefer a live file of the same name when the user has already
   * made one, and otherwise return the trashed file, flagged, with the pointer
   * left intact. Deliberately: that pointer is the only evidence left that the
   * file exists at all.
   */
  async function findRef(): Promise<FileRef | null> {
    const cached = fileIds.get();
    if (cached) {
      const ref = await fetchRefById(cached);
      if (ref && !ref.trashed) return ref;
      if (ref?.trashed) return (await searchForRef()) ?? ref;
      fileIds.set(null); // stale pointer (the file was deleted) — search again
    }
    return searchForRef();
  }

  async function downloadSnapshot(id: string): Promise<SyncSnapshot> {
    const res = await driveRequest(
      `${DRIVE_API}/files/${encodeURIComponent(id)}?alt=media`,
      { method: 'GET' },
      { what: 'download the sync file', timeoutMs: DRIVE_TRANSFER_TIMEOUT_MS },
    );
    return parseSnapshot(res.text);
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

  /**
   * Prove that the file in Drive is OUR write, and throw if it is not.
   *
   * A 200 from the upload only says Drive accepted the bytes; it says nothing
   * about what happened a moment later. Another device's push can land between
   * our PATCH and this read, and the one thing that must never follow is this
   * device recording "Drive holds my book". It costs one small GET on the rare
   * path (a push), and buys the difference between a redundant sync and a
   * silent, unrecoverable overwrite.
   *
   * It fails CLOSED: an unreadable read-back is reported as a clobber. The
   * caller then leaves the device dirty and pushes again next time, which is
   * the harmless direction to be wrong in.
   */
  async function confirmLanded(id: string, snapshotId: string): Promise<void> {
    const after = await fetchRefById(id);
    if (after && !after.trashed && idProperty(after.appProperties?.snapshotId) === snapshotId) {
      return;
    }
    throw new SyncTransportError(
      'remote',
      'Google Drive accepted the upload but the sync file no longer holds this ' +
        "device's data — another device wrote at the same moment. Nothing on this device " +
        'was changed, and it has NOT been recorded as backed up. Sync again to see what ' +
        'the other device wrote.',
    );
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

    async readRemoteMeta(): Promise<SyncRemoteMeta | null> {
      const ref = await findRef();
      if (!ref) return null; // genuinely no file — the only null this returns

      // `trashed` is carried on every branch below: the engine must be able to
      // tell "the file is in the bin" from "the file is fine", and it is not
      // the transport's business which of them ends the sync.
      const trashed = ref.trashed ? { trashed: true as const } : {};
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
        return {
          revision,
          savedAt,
          deviceName,
          // Carried because the engine compares the WHOLE stamp, not just the
          // identity: `snapshotId` survives a writer that omits it (Drive
          // merges appProperties), while `deviceId` is written by every
          // writer, including a build from before ancestry existed. See
          // SyncStamp and Settings.syncLastPulledSavedAt.
          deviceId: idProperty(props?.deviceId),
          snapshotId: idProperty(props?.snapshotId),
          parentSnapshotId: idProperty(props?.parentSnapshotId),
          ...trashed,
        };
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
        deviceId: idProperty(snap.deviceId),
        snapshotId: idProperty(snap.snapshotId),
        parentSnapshotId: idProperty(snap.parentSnapshotId),
        ...trashed,
      };
    },

    async writeRemote(snap, expectHead) {
      // Vet our own payload before it leaves: a snapshot we would refuse to
      // read back is a snapshot we must not write. Stricter than the read
      // side — this one must carry an identity (see vetSnapshot).
      vetSnapshot(snap, 'This snapshot', { forWriting: true });
      const snapshotId = snap.snapshotId as string; // guaranteed by vetSnapshot
      const parentSnapshotId = snap.parentSnapshotId ?? null;

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
          // NOT passed through fitProperty: an id is compared, not displayed,
          // and a trimmed one would quietly compare equal to somebody else's.
          // vetSnapshot has already refused anything that would not fit.
          snapshotId,
          // '' rather than an omitted key, because Drive MERGES appProperties
          // on update: leaving it out would keep the previous write's parent.
          parentSnapshotId: parentSnapshotId ?? '',
        },
      };
      const { body, contentType } = multipart(metadata, content);

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

      // THE PRECONDITION. Read the head as late as possible — Drive has no
      // If-Match for files.update, so this is the closest thing to a
      // compare-and-swap available, and the comparison is against the snapshot
      // this upload was actually built on. `findRef` already fetches
      // appProperties, so the id we need costs nothing extra; the old code
      // fetched exactly this and used only `existing.id`.
      const head = await findRef();

      if (head?.trashed) {
        throw new SyncTransportError(
          'remote',
          "The sync file is in Google Drive's bin, so nothing was uploaded. Restore it in " +
            'Drive, or empty the bin, and sync again.',
        );
      }

      // The caller asserted there is NO file — the only state in which a
      // create is safe. One appeared between its head read and this one, so
      // whatever is in it was written by somebody whose work a create would
      // sit beside (two files called mymoney-sync.json) or, worse, whose head
      // this upload would replace unseen.
      if (expectHead === null && head) {
        throw new SyncTransportError(
          'remote',
          'A sync file appeared in Google Drive while this one was preparing its upload, so ' +
            'nothing was uploaded and nothing on this device was changed. Sync again to see ' +
            'what is in it.',
        );
      }

      if (head) {
        // SECOND, INDEPENDENT GUARD: never write at or below the head's own
        // revision. Every legitimate write of ours is strictly above both
        // sides, so this cannot refuse a sound push — but it catches one case
        // the identity check cannot. A device still running a build from
        // before ancestry writes appProperties WITHOUT a snapshotId, and
        // files.update merges, so the previous snapshotId survives on a file
        // whose contents have changed underneath it. Identity alone would then
        // read as "still mine". The revision it also writes gives it away —
        // but ONLY when that revision is at or above ours, which is why it is
        // not sufficient on its own either (see the stamp check below).
        const headRevision = revisionOf(head.appProperties);
        if (headRevision >= 0 && headRevision >= snap.revision) {
          throw new SyncTransportError(
            'remote',
            `The sync file in Google Drive is already at version ${headRevision}, so nothing ` +
              'was uploaded — another device has saved since this snapshot was built. Nothing ' +
              'on this device was changed. Sync again to see what changed.',
          );
        }
        const headSnapshotId = idProperty(head.appProperties?.snapshotId);
        if (headSnapshotId !== parentSnapshotId) {
          throw new SyncTransportError(
            'remote',
            'Another device saved to Google Drive while this one was preparing its upload, ' +
              'so nothing was uploaded — this snapshot was built on an older version of the ' +
              'file. Nothing on this device was changed. Sync again to see what changed.',
          );
        }
        // THIRD GUARD, AND THE ONLY ONE THAT SEES A LEGACY WRITE THAT IS
        // BEHIND US (C18). The two checks above are both blind to it: the
        // revision guard only fires at or above our own number, and the
        // identity check compares a field the legacy writer never sent, which
        // Drive therefore MERGED FROM OUR OWN PREVIOUS WRITE. So a device on
        // an old build can replace the file's contents in the window between
        // the caller's head read and this one, and the head will still swear
        // it is ours. The stamp the caller actually read is the only thing
        // left to compare against, and every field in it — revision, savedAt,
        // deviceId — is a field that writer DID write.
        //
        // Rejected: making this the ONLY check and dropping the identity one
        // above. It cannot be, because `expectHead` is optional (a caller
        // written against the older shape passes nothing) and because the
        // identity check is the one that names the right cause when a modern
        // device wins the race.
        if (expectHead) {
          const mismatch = headStampMismatch(head.appProperties, expectHead);
          if (mismatch) {
            throw new SyncTransportError(
              'remote',
              'The sync file in Google Drive is no longer the one this upload was built on ' +
                `(its ${mismatch} has changed), so nothing was uploaded — another device wrote ` +
                "to it, and it kept this file's old identity because Drive merges file " +
                'properties. Nothing on this device was changed. Sync again to see what ' +
                'that device wrote.',
            );
          }
        }
        const res = await send(
          `${DRIVE_UPLOAD_API}/files/${encodeURIComponent(head.id)}?uploadType=multipart&fields=id`,
          'PATCH',
        );
        if (res.status !== 404) {
          await confirmLanded(head.id, snapshotId);
          return;
        }
        // The file was deleted between our check and our write. Re-creating it
        // is only safe for a snapshot that descends from nothing: for any
        // other, a fresh file would start a SECOND lineage at this revision
        // number while the original may still be in the bin, and every device
        // would then compare two unrelated histories as one.
        fileIds.set(null);
        if (parentSnapshotId !== null) {
          throw new SyncTransportError(
            'remote',
            'The sync file this upload was based on has been deleted from Google Drive, so ' +
              'nothing was uploaded and nothing on this device was changed.',
          );
        }
      } else if (parentSnapshotId !== null) {
        // Same rule, reached the other way: we were told to descend from a
        // file that is no longer there.
        throw new SyncTransportError(
          'remote',
          'The sync file this upload was based on is no longer in Google Drive, so nothing ' +
            'was uploaded and nothing on this device was changed.',
        );
      }

      const res = await send(`${DRIVE_UPLOAD_API}/files?uploadType=multipart&fields=id`, 'POST');
      if (res.status === 404) {
        throw new SyncTransportError('remote', "Google Drive wouldn't create the sync file.");
      }
      const created = parseJson<{ id?: string }>(res, 'save the sync file');
      if (!created.id) {
        // We asked for `fields=id`, so this cannot normally happen — and
        // without an id there is no way to read the write back. Reporting
        // success unverified is the one thing this path may not do.
        throw new SyncTransportError(
          'remote',
          "Google Drive did not say where it saved the sync file, so this device can't " +
            'confirm the upload. Nothing on this device was changed; sync again.',
        );
      }
      fileIds.set(created.id);
      await confirmLanded(created.id, snapshotId);
    },
  };
}
