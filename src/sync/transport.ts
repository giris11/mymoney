// Dropbox transport for sync (D44) — Dropbox HTTP API v2 over fetch.
//
// The user's own Dropbox holds ONE file, `/mymoney-sync.json`, inside the app
// folder Dropbox creates for this app. Nothing else in their Dropbox is
// visible to us: the app is registered as a SCOPED APP WITH APP FOLDER ACCESS
// (see src/sync/dropboxAuth.ts), so every path below is relative to that
// folder and the rest of their Dropbox may as well not exist. There is no
// server of ours anywhere in this path, no SDK, and no new dependency — the
// Dropbox API is plain HTTP and `fetch` is enough.
//
// ===========================================================================
// WHY THIS FILE REPLACED THE GOOGLE DRIVE ONE
// ===========================================================================
//
// Drive sync accumulated twenty confirmed defects across four review rounds
// and was held in code (src/sync/held.ts) rather than shipped. Two of the root
// causes were properties of the DRIVE API, not of our logic, and no amount of
// care in this file could have removed them:
//
//   RC1  DRIVE HAS NO CONDITIONAL WRITE. Two devices that both read revision N
//        could both write revision N. The loser could not tell, and neither
//        could anyone else. All we could do was read the file back afterwards
//        and hope to notice — detection, after the bytes had already landed on
//        top of somebody's book.
//   RC2  DRIVE'S appProperties MERGE PER KEY. A device on an older build,
//        writing no snapshot id, left the PREVIOUS device's identity stamped
//        on a file whose contents were now its own. Our engine read that
//        identity as proof of ancestry and said "up to date" over a stranger's
//        book (C18), then found the same hole through a second door (C19).
//
// The design underneath both was one where TWO FIELDS EACH DID TWO
// INCOMPATIBLE JOBS: `parentSnapshotId` was both the transport's
// compare-and-swap token and a causal-descent claim other devices trust, and a
// recorded stamp was both "what I last saw" and "what I have proved". That is
// what kept regenerating defects (see the hold note in src/sync/held.ts).
//
// ON DROPBOX THOSE TWO JOBS SEPARATE CLEANLY, AND THIS FILE KEEPS THEM APART.
// It is the entire point of the migration:
//
//   rev            THE COMPARE-AND-SWAP TOKEN. Opaque, issued by Dropbox,
//                  changes on every write, and cannot be forged, merged or
//                  guessed by any writer. It lives ONLY in this file: neither
//                  the engine nor the snapshot body has any business with it.
//                  `files/upload` takes it as `mode: update(<rev>)`, so the
//                  precondition, the bytes and an integrity check are ONE
//                  request that Dropbox either commits or rejects. RC1 becomes
//                  PREVENTED rather than detected.
//
//   snapshotId /   CAUSAL IDENTITY. Lives INSIDE THE FILE BODY, which is
//   parentSnapshotId/  replaced wholesale on every write. There is no per-key
//   ancestry       metadata store to merge, so a writer cannot inherit another
//                  writer's identity by omitting a field — it has no way to
//                  leave the old value behind. RC2 becomes STRUCTURALLY
//                  IMPOSSIBLE rather than guarded against.
//
// The join between them is the only interesting thing this file does. The
// engine's precondition is causal ("replace the head only if it is still
// snapshot P"); Dropbox's precondition is a rev. So the transport translates:
// it uses a rev it has OBSERVED to belong to snapshot P — an observation it
// can vouch for, because a rev names one exact file content and therefore one
// exact snapshotId. If it holds no such observation it goes and looks. And if
// the observation has since gone stale, IT DOES NOT MATTER: Dropbox rejects
// the write, because the rev is the real precondition and the read was only
// ever how we found it.
//
// ===========================================================================
// WHAT WAS DELETED WITH DRIVE, AND MUST NOT COME BACK
// ===========================================================================
//
//   fitProperty(), MAX_APP_PROPERTY_BYTES, MAX_SNAPSHOT_ID_BYTES — Drive
//     capped one appProperties entry at 124 BYTES for key and value together,
//     so a device named in Tamil could overflow it and kill sync outright. Our
//     identity fields now travel in the JSON body with everything else. There
//     is no byte budget, nothing to truncate, and truncating an identity was
//     always the more dangerous half of that apparatus.
//   THE PRE-WRITE HEAD RE-READ — Drive had no If-Match, so the only
//     approximation of a compare-and-swap was to re-read the head as late as
//     possible and hope the gap was small. The gap could not be closed. Now
//     the rev in `mode: update` closes it exactly, and any read this file does
//     before a write is an optimisation (a better error message, and the
//     causal check the engine asks for) — never the safety mechanism. Bringing
//     back a mandatory pre-write read would be re-adding a race.
//   confirmLanded() — the post-write read-back. A Drive 200 said only that the
//     bytes were accepted, so we re-read the file to see whether somebody had
//     overwritten it in the meantime. Dropbox's upload RESPONSE is the
//     confirmation: it carries the new `rev`, the `path_lower` (which proves
//     nothing was renamed) and the `content_hash` (which proves the stored
//     bytes are our bytes). One request, verified from its own answer.
//   Dropbox's own equivalent of appProperties — "property groups", via
//     files/properties/*. NOT USED, and `files.metadata.write` is deliberately
//     not requested. Property groups are written in a SEPARATE call from the
//     upload, so they can disagree with the file's contents. That is RC2 with
//     a different logo.
//
// ===========================================================================
// THE RULES THIS FILE IS STILL BUILT AROUND (unchanged; they were never the
// problem)
// ===========================================================================
//
//  1. NEVER SILENTLY LOSE THE REMOTE. A sync that stops and asks is a good
//     sync; one that quietly loses a week of spending is worthless (SPEC §2.6).
//  2. A FILE THAT EXISTS IS NEVER REPORTED AS ABSENT. readRemoteMeta() returns
//     null ONLY when the file has never existed. A DELETED file is reported as
//     existing-but-gone (`trashed: true`), because Dropbox keeps deleted files
//     restorable and a device that answered "no file" there went on to start a
//     second lineage at revision 1 (C13).
//  3. WE NEVER DELETE ANYTHING. disconnect() drops this device's grant; the
//     file stays exactly where it is. No code path in this app deletes it.
//  4. MONEY IS MOVED, NEVER TOUCHED. JSON.stringify out, JSON.parse in.
//     Amounts are integer minor units and stay integers; no rounding, no
//     coercion, no re-interpretation happens anywhere in this file (SPEC §6).
//  5. EVERY REQUEST IS BOUNDED END TO END, BODY INCLUDED. The abort timer is
//     held until the response body has been read, not released when the
//     headers arrive: a connection that delivers "200 OK" and then goes silent
//     used to leave the read hanging for ever behind a spinner that never
//     stopped and an error that never came (C10).
//
// COST, AND HOW IT IS PAID. Drive kept a copy of the head's identity in
// appProperties, so a sync check cost a few hundred bytes. Dropbox has no such
// store — identity is in the body, which is the whole reason RC2 is gone — so
// the cheap head read (files/get_metadata) returns the `rev` and the
// `content_hash` and nothing else we can read. That is still enough to answer
// the commonest question ("has anything changed?") for free, and the transport
// remembers the identity it derived for a given rev. THAT CACHE CANNOT LIE:
// a rev names one immutable file content, so an entry keyed by rev (and
// re-checked against content_hash) describes that content or misses. Only a
// rev this device has never seen costs a download — and a rev it has never
// seen is one it is about to pull anyway.

import type { SyncRemoteMeta, SyncSnapshot, SyncTransport } from './types';
import {
  createDropboxTokenProvider,
  isOffline,
  SyncTransportError,
  type TokenProvider,
} from './dropboxAuth';

/** The one file this app keeps, inside its own Dropbox app folder. */
export const SYNC_FILE_NAME = 'mymoney-sync.json';

/** Its path. App-folder-relative: this is the root as far as the app can see. */
export const SYNC_FILE_PATH = `/${SYNC_FILE_NAME}`;

export const DROPBOX_RPC = 'https://api.dropboxapi.com/2';
export const DROPBOX_CONTENT = 'https://content.dropboxapi.com/2';

/** Metadata calls are small; a hung one must never wedge the app. */
export const DROPBOX_TIMEOUT_MS = 20_000;

/** Uploads/downloads carry megabytes over a phone connection — be patient,
 *  but still bounded. */
export const DROPBOX_TRANSFER_TIMEOUT_MS = 120_000;

/**
 * Dropbox's hard ceiling for a single `files/upload` request is 150 MB; above
 * it an upload SESSION is required, which is a different protocol with a
 * different failure surface. The owner's snapshot is ~3 MB, so this is never
 * close — and if it ever were, refusing is the "when in doubt, refuse and ask"
 * rule applied to our own upload.
 */
export const UPLOAD_MAX_BYTES = 150 * 1024 * 1024;

/**
 * The transport's memory of the head, kept across reloads. Holds NO financial
 * data — a rev, a hash, and the identity fields a conflict dialog prints. See
 * the COST note in the header for why it is sound: it is keyed by a rev, and a
 * rev names one exact file content.
 */
export const HEAD_CACHE_STORAGE_KEY = 'mymoney.sync.dropbox.head';

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * Re-exported, not redeclared: the interface itself lives in ./types.ts so the
 * engine can depend on it without an import edge into this provider-specific
 * module, while `import type { SyncTransport } from './transport'` still works
 * as pinned. One declaration, so the two halves cannot drift apart.
 */
export type { SyncTransport } from './types';

// ---------------------------------------------------------------------------
// The Dropbox-API-Arg wire format — the part with a trap in it
// ---------------------------------------------------------------------------

/**
 * How `files/upload` is told what to do with the bytes.
 *
 * ⚠️ `update` MUST be spelled `{".tag":"update","update":"<rev>"}` and NEVER
 * `"update"`. Dropbox's union serialisation allows the bare-string shorthand
 * ONLY for members that carry no value; `update` carries a rev, and the
 * shorthand is rejected outright: "This shorthand is not allowed for non-Void
 * members." A 400 is the good outcome. The bad outcome is the one this type
 * exists to make impossible — somebody "fixing" that 400 by falling back to
 * `overwrite`, which would reinstate RC1 exactly: an unconditional write that
 * silently replaces whatever is there. `add` is a Void member, so `"add"`
 * would be legal, but it is spelled the long way here too so that no reader
 * has to remember which is which.
 *
 * Locked by test: tests/sync-transport.test.ts inspects the serialised header
 * of a real write, not this type.
 */
export type DropboxWriteMode = { '.tag': 'add' } | { '.tag': 'update'; update: string };

/** The exact CommitInfo this app sends. Every field is load-bearing. */
export interface DropboxUploadArg {
  path: string;
  mode: DropboxWriteMode;
  /**
   * FALSE, ALWAYS. `autorename: true` turns a lost race into a 200 OK on a
   * file called "mymoney-sync (1).json": the write "succeeds", the device
   * records that Dropbox holds its book, and the book it actually holds is
   * somebody else's. The response's path_lower is checked against what we
   * asked for as well, so a server-side rename could not slip past unnoticed
   * either.
   */
  autorename: false;
  /** No push notification for a background housekeeping write. */
  mute: true;
  /**
   * Dropbox's own words: be more strict about how each WriteMode detects
   * conflict — for example, always return a conflict error when mode is
   * `update` and the given rev does not match, EVEN IF THE EXISTING FILE HAS
   * BEEN DELETED. Without it, a `update(rev)` against a deleted file can be
   * treated as a create, which is precisely the "start a second lineage over a
   * restorable file" failure (C13) arriving through the write path.
   */
  strict_conflict: true;
  /**
   * Dropbox verifies the stored bytes against this and rejects a mismatch, so
   * a corrupted upload cannot land and be believed. Sent on EVERY write.
   */
  content_hash: string;
}

/**
 * Build the CommitInfo. `rev === null` means "there is no file yet", which is
 * `add` — with autorename false, so a race to seed the file FAILS rather than
 * quietly creating a second one beside it.
 */
export function uploadArg(rev: string | null, contentHash: string): DropboxUploadArg {
  return {
    path: SYNC_FILE_PATH,
    mode: rev === null ? { '.tag': 'add' } : { '.tag': 'update', update: rev },
    autorename: false,
    mute: true,
    strict_conflict: true,
    content_hash: contentHash,
  };
}

/**
 * Serialise an API arg for the `Dropbox-API-Arg` HTTP HEADER.
 *
 * Header values are bytes, not text: a raw non-ASCII character in one is at
 * best mangled and at worst rejected by an intermediary, and the failure would
 * be silent and intermittent. Dropbox documents the fix — escape everything
 * above U+007F as \uXXXX, which JSON accepts and which is pure ASCII. Our args
 * are ASCII by construction today (a fixed path, a rev, a hex hash), so this
 * is belt and braces; it is here because "by construction today" is exactly
 * the kind of assumption that stops being true quietly.
 */
export function serialiseApiArg(arg: unknown): string {
  // Escapes everything outside printable ASCII, DEL included. Written with
  // explicit \u escapes rather than the literal characters so that the range
  // stays readable in a diff.
  return JSON.stringify(arg).replace(
    /[\u007f-\uffff]/g,
    (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`,
  );
}

// ---------------------------------------------------------------------------
// content_hash
// ---------------------------------------------------------------------------

const HASH_BLOCK_BYTES = 4 * 1024 * 1024;

/**
 * Dropbox's content hash, exactly as they define it: split the file into 4 MiB
 * blocks, SHA-256 each block, concatenate those digests in order, SHA-256 the
 * concatenation, print it as lowercase hex. (An empty file therefore hashes
 * the empty concatenation, which is SHA-256 of nothing — no special case.)
 *
 * It is computed here, sent with the upload, and compared against what Dropbox
 * reports back. That is the difference between "Dropbox accepted 3 MB" and
 * "Dropbox is holding the 3 MB we meant to send".
 */
export async function dropboxContentHash(bytes: Uint8Array<ArrayBuffer>): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SyncTransportError(
      'config',
      'This browser cannot check the integrity of the sync file (it may not be a secure ' +
        'context), so nothing was uploaded.',
    );
  }
  const blocks: Uint8Array<ArrayBuffer>[] = [];
  for (let offset = 0; offset < bytes.length; offset += HASH_BLOCK_BYTES) {
    const slice = bytes.subarray(offset, Math.min(offset + HASH_BLOCK_BYTES, bytes.length));
    blocks.push(new Uint8Array(await subtle.digest('SHA-256', slice)));
  }
  const joined = new Uint8Array(blocks.length * 32);
  blocks.forEach((b, i) => joined.set(b, i * 32));
  const digest = new Uint8Array(await subtle.digest('SHA-256', joined));
  return [...digest].map((b) => b.toString(16).padStart(2, '0')).join('');
}

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

function isAbort(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    ((e as { name?: string }).name === 'AbortError' ||
      (e as { name?: string }).name === 'TimeoutError')
  );
}

/**
 * One Dropbox response, with its body ALREADY READ — see dropboxRequest.
 * Callers never touch a live stream, which is what keeps every read inside the
 * request's timeout (rule 5).
 */
interface DropboxResponse {
  status: number;
  ok: boolean;
  /** The complete body, read while the abort timer was still armed. */
  text: string;
  /** `Dropbox-API-Result` on a content endpoint: the file's metadata. */
  apiResult: string | null;
  retryAfterSeconds: number | null;
}

function parseJson<T>(res: DropboxResponse, what: string): T {
  try {
    return JSON.parse(res.text) as T;
  } catch {
    throw new SyncTransportError(
      'remote',
      `Dropbox's answer when asked to ${what} was not readable. Nothing was changed.`,
    );
  }
}

/**
 * Every `.tag` anywhere inside a Dropbox error body, plus the slash-separated
 * words of `error_summary`.
 *
 * Dropbox nests its errors ({"error":{".tag":"path","reason":{".tag":
 * "conflict","conflict":{".tag":"file"}}}}) and the exact depth differs per
 * endpoint and has changed over time. Matching on a FLAT SET of tags is
 * deliberately shallow-minded: it cannot be broken by a new wrapper level, and
 * every question this file asks ("was that a conflict?", "is the account
 * full?") is a question about whether a tag is present at all.
 *
 * `error_summary` is included because Dropbox documents it as debug-only, so
 * it is used as CORROBORATION, never as the sole source — the structured tags
 * come first and the summary only adds words the structure already implied.
 */
export function errorTags(body: string): Set<string> {
  const tags = new Set<string>();
  let parsed: unknown;
  try {
    parsed = JSON.parse(body) as unknown;
  } catch {
    return tags;
  }
  const walk = (node: unknown, depth: number): void => {
    if (depth > 8 || typeof node !== 'object' || node === null) return;
    for (const [key, value] of Object.entries(node as Record<string, unknown>)) {
      if (key === '.tag' && typeof value === 'string') tags.add(value);
      else walk(value, depth + 1);
    }
  };
  walk(parsed, 0);
  const summary = (parsed as { error_summary?: unknown }).error_summary;
  if (typeof summary === 'string') {
    for (const word of summary.split(/[/.]/)) {
      if (word !== '') tags.add(word);
    }
  }
  return tags;
}

/**
 * Turn a non-OK Dropbox response into a typed error with a message a person
 * can act on.
 *
 * The distinction that matters most here is PERMANENT versus TRANSIENT. A full
 * Dropbox will not clear on its own, no amount of waiting helps, and only the
 * owner can fix it; reporting it as rate limiting told the owner of the Drive
 * build to "try again shortly" for ever while every push failed and the
 * off-site copy silently stopped advancing.
 */
function errorFromResponse(res: DropboxResponse, what: string): SyncTransportError {
  const tags = errorTags(res.text);
  const detail = res.text ? res.text.slice(0, 200) : '';

  if (res.status === 401) {
    return new SyncTransportError('auth', 'Dropbox sign-in has expired. Reconnect to sync.');
  }
  if (res.status === 403) {
    return new SyncTransportError(
      'auth',
      `Dropbox refused the request (${detail || 'permission denied'}). Reconnect to sync.`,
    );
  }
  if (res.status === 409) {
    // PERMANENT, and only the owner can fix it.
    if (tags.has('insufficient_space')) {
      return new SyncTransportError(
        'remote',
        'Your Dropbox is full, so nothing could be saved to it. Nothing on this device was ' +
          'changed. Free up space in Dropbox and sync again — until then this device is the ' +
          'only copy of your recent changes.',
      );
    }
    // THE COMPARE-AND-SWAP REFUSAL. This is the whole mechanism working: the
    // file is no longer the revision this upload was built on, so Dropbox
    // refused it rather than letting it land. Nothing was written.
    if (tags.has('conflict')) {
      return new SyncTransportError(
        'remote',
        'Another device saved to Dropbox while this one was preparing its upload, so nothing ' +
          'was uploaded — this snapshot was built on an older version of the file. Nothing on ' +
          'this device was changed. Sync again to see what changed.',
      );
    }
    if (tags.has('not_found')) {
      return new SyncTransportError(
        'remote',
        'The sync file this upload was based on is no longer in Dropbox, so nothing was ' +
          'uploaded and nothing on this device was changed.',
      );
    }
    if (tags.has('no_write_permission') || tags.has('team_folder')) {
      return new SyncTransportError(
        'auth',
        'Dropbox will not let this app write its sync file. Nothing was changed.',
      );
    }
    return new SyncTransportError(
      'remote',
      `Dropbox refused to ${what} (${detail || 'no reason given'}). Nothing was changed.`,
    );
  }
  if (res.status === 429 || res.status >= 500) {
    const wait = res.retryAfterSeconds;
    return new SyncTransportError(
      'network',
      `Dropbox is busy right now (HTTP ${res.status}). Nothing was changed; try again` +
        `${wait ? ` in about ${wait} seconds` : ' shortly'}.`,
    );
  }
  if (res.status === 400) {
    // Dropbox's 400 means WE sent something malformed — a bad Dropbox-API-Arg,
    // most likely. It is our bug, not the user's, and it must be loud rather
    // than swallowed as "try again": the one way to make it go away by
    // "fixing" the request is to weaken the write mode, which is the failure
    // this whole migration exists to end.
    return new SyncTransportError(
      'remote',
      `Dropbox rejected this app's request as malformed, so nothing was uploaded and nothing ` +
        `on this device was changed. This is a fault in the app, not in your data. (${detail})`,
    );
  }
  return new SyncTransportError(
    'remote',
    `Dropbox couldn't ${what} (HTTP ${res.status}${detail ? `: ${detail}` : ''}).`,
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
      "The sync file in Dropbox isn't readable (it is not valid JSON). Nothing on this device was changed.",
    );
  }
  return vetSnapshot(json, 'The sync file in Dropbox');
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
      throw bad(
        `does not say ${field === 'savedAt' ? 'when it was written' : 'which device wrote it'}`,
      );
    }
  }
  // ---- IDENTITY IS NOW REQUIRED IN BOTH DIRECTIONS, AND THAT IS A CHANGE ---
  //
  // The Drive version was asymmetric on purpose: writing a snapshot with no id
  // was refused, but READING one was tolerated, because a file written by a
  // build from before ancestry existed was sitting in the owner's Drive and
  // refusing it would have stranded a working sync file.
  //
  // ON DROPBOX THERE IS NO SUCH FILE AND THERE NEVER CAN BE. No build of this
  // app has ever written to Dropbox — the app folder is created by this
  // migration — and the pre-ancestry build cannot reach it even in principle:
  // it holds a Google client id and talks to a different API. So the only
  // things that could produce an identity-less body here are a hand edit, a
  // third-party tool, or a future build of ours that regressed.
  //
  // TOLERATING IT WOULD BE ACTIVELY DANGEROUS, which is why the asymmetry goes
  // rather than merely being unnecessary. syncEngine takes the ancestry branch
  // only when the head reports an id; without one it falls through to the
  // revision-NUMBER fallback, where a clean device whose recorded number
  // happens to match reports 'up-to-date' — over a book it has never seen. On
  // Drive that hole was closed by comparing the whole stamp (C18), which
  // worked because Drive's merge left the id in place and the OTHER fields
  // gave the writer away. Here there is no merge and no stamp to compare: the
  // body simply has no id, so the engine never reaches the branch that would
  // have questioned it.
  //
  // Refusing at the door restores "when in doubt, refuse and ask", and makes
  // the unsound fallback table unreachable through this transport.
  //
  // NOTE also what is NOT checked here any more: the id's LENGTH IN BYTES.
  // Drive capped one appProperties entry at 124 bytes for key and value
  // together, so an id had to be measured before it could be stored. Identity
  // now travels in the body with everything else and has no budget to fit in.
  const idField = (field: 'snapshotId' | 'parentSnapshotId', nullable: boolean) => {
    const v = o[field];
    if (v === undefined || (nullable && v === null)) return null;
    if (typeof v !== 'string' || v === '') throw bad(`has an unusable ${field}`);
    return v;
  };
  if (idField('snapshotId', false) === null) {
    throw bad(
      'carries no snapshot identity, so no device could tell what it descends from ' +
        '(it was not written by this app)',
    );
  }
  idField('parentSnapshotId', true);

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

/** Identity read out of a snapshot body: absent and empty both mean "none". */
function idOf(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null;
}

/** The identity fields of a snapshot, in the shape the engine reads. */
function metaOf(snap: SyncSnapshot): Omit<SyncRemoteMeta, 'rev' | 'trashed'> {
  return {
    revision: snap.revision,
    savedAt: snap.savedAt,
    deviceName: snap.deviceName,
    deviceId: idOf(snap.deviceId),
    snapshotId: idOf(snap.snapshotId),
    parentSnapshotId: idOf(snap.parentSnapshotId),
  };
}

// ---------------------------------------------------------------------------
// The head cache — a rev, and what this device knows that rev to be
// ---------------------------------------------------------------------------

/**
 * One observation: "the file at rev R has content hash H, and its body says it
 * is snapshot S descending from P".
 *
 * The reason this is sound, and the reason Drive's equivalent was not: a rev
 * names one exact immutable file content. Two devices that observe the same
 * rev necessarily observed the same bytes, so an entry can be shared, cached,
 * persisted or handed between profiles without ever describing a file it did
 * not come from. Drive's appProperties were a SEPARATE mutable store that
 * could disagree with the bytes beside it — which is exactly what RC2 was.
 *
 * It is still only ever a cache: every entry is re-checked against the rev AND
 * the content hash that a fresh files/get_metadata reports, and a miss simply
 * costs a download.
 */
export interface HeadObservation {
  rev: string;
  contentHash: string;
  meta: Omit<SyncRemoteMeta, 'rev' | 'trashed'>;
}

export interface HeadStore {
  get(): HeadObservation | null;
  set(value: HeadObservation | null): void;
}

const localHeadStore: HeadStore = {
  get() {
    try {
      const raw = storage()?.getItem(HEAD_CACHE_STORAGE_KEY);
      if (!raw) return null;
      const parsed = JSON.parse(raw) as HeadObservation;
      // A cache entry missing either key cannot be matched against anything,
      // so it is not an entry.
      if (typeof parsed?.rev !== 'string' || typeof parsed?.contentHash !== 'string') return null;
      if (typeof parsed?.meta !== 'object' || parsed.meta === null) return null;
      return parsed;
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      const s = storage();
      if (!s) return;
      if (value) s.setItem(HEAD_CACHE_STORAGE_KEY, JSON.stringify(value));
      else s.removeItem(HEAD_CACHE_STORAGE_KEY);
    } catch {
      /* the cache is an optimisation; failing to persist it costs a download */
    }
  },
};

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

export interface DropboxTransportOptions {
  /** Identity source. Defaults to the real PKCE-backed provider. */
  auth?: TokenProvider;
  /** The Dropbox app key, when using the default provider. */
  appKey?: () => string | Promise<string>;
  /**
   * @deprecated The Drive-era name, where the owner supplied their own OAuth
   * client id. Passed through to the auth provider, which treats a non-empty
   * value as an app key and ignores a blank one. Accepted only so the Settings
   * screen keeps working unchanged across the provider swap.
   */
  clientId?: () => string | Promise<string>;
  /** Test seam for the head cache. */
  headStore?: HeadStore;
}

/** What files/get_metadata told us: a live file, a deleted one, or nothing. */
type HeadState =
  | { kind: 'file'; rev: string; contentHash: string | null }
  | { kind: 'deleted' }
  | { kind: 'absent' };

export function createDropboxTransport(opts: DropboxTransportOptions = {}): SyncTransport {
  const auth =
    opts.auth ??
    createDropboxTokenProvider({ appKey: opts.appKey, clientId: opts.clientId });
  const heads = opts.headStore ?? localHeadStore;

  /**
   * One authorised Dropbox request, on a leash, with exactly one retry after a
   * 401 (access tokens are short-lived, so an expiry mid-session is normal,
   * not an error to show anyone). `allowStatus` lets a caller handle an
   * expected status — 409 for "no such path" — instead of throwing.
   */
  async function dropboxRequest(
    url: string,
    init: RequestInit,
    o: { timeoutMs?: number; what: string; allowStatus?: number[]; retried?: boolean },
  ): Promise<DropboxResponse> {
    if (isOffline()) {
      throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
    }
    const token = await auth.getToken();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), o.timeoutMs ?? DROPBOX_TIMEOUT_MS);
    let status: number;
    let ok: boolean;
    let text: string;
    let apiResult: string | null = null;
    let retryAfterSeconds: number | null = null;
    try {
      const res = await fetch(url, {
        ...init,
        signal: controller.signal,
        // Nothing about the user rides along besides the bearer token: no
        // cookies, no referrer. The URL never carries personal data.
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: {
          ...(init.headers as Record<string, string> | undefined),
          authorization: `Bearer ${token}`,
        },
      });
      status = res.status;
      ok = res.ok;
      apiResult = res.headers?.get?.('dropbox-api-result') ?? null;
      const retryAfter = res.headers?.get?.('retry-after') ?? null;
      const seconds = Number(retryAfter);
      retryAfterSeconds = Number.isFinite(seconds) && seconds > 0 ? seconds : null;
      // THE BODY IS READ HERE, INSIDE THE LEASH (rule 5). `fetch` resolves
      // when the HEADERS arrive; the megabytes come afterwards. Releasing the
      // timer at that point left every body read unbounded and unabortable, so
      // a connection that answered "200 OK" and then went silent hung for
      // ever: the promise never settled and the Sync screen sat on "Syncing…"
      // with no error and no way out but a reload.
      text = await res.text();
    } catch (e) {
      if (isAbort(e)) {
        throw new SyncTransportError(
          'timeout',
          `Dropbox took too long to ${o.what}. Nothing was changed; try again.`,
        );
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }
      throw new SyncTransportError('network', `Couldn't reach Dropbox to ${o.what}.`, { cause: e });
    } finally {
      clearTimeout(timer);
    }

    if (status === 401 && !o.retried) {
      // The access token died mid-session. Drop it, refresh, try once more.
      auth.invalidate();
      return dropboxRequest(url, init, { ...o, retried: true });
    }
    const res: DropboxResponse = { status, ok, text, apiResult, retryAfterSeconds };
    if (ok || o.allowStatus?.includes(status)) return res;
    throw errorFromResponse(res, o.what);
  }

  /** A Dropbox FileMetadata, in the fields this file reads. */
  interface FileMetadata {
    '.tag'?: string;
    rev?: string;
    size?: number;
    path_lower?: string;
    content_hash?: string;
  }

  function vetFileMetadata(m: FileMetadata, what: string): { rev: string; contentHash: string | null } {
    if (typeof m.rev !== 'string' || m.rev === '') {
      throw new SyncTransportError(
        'remote',
        `Dropbox did not say which version of the sync file this is, so this device can't ${what} safely. Nothing was changed.`,
      );
    }
    return { rev: m.rev, contentHash: typeof m.content_hash === 'string' ? m.content_hash : null };
  }

  /**
   * The cheap head read. Costs a few hundred bytes and never the file body.
   *
   * `include_deleted` is what makes rule 2 possible on Dropbox: without it, a
   * deleted file and a file that never existed both come back as path/not_found
   * and are indistinguishable. Dropbox keeps deleted files restorable, so
   * telling the engine "there is no file" about one is how a device that had
   * synced 47 times would start a second lineage at revision 1 (C13).
   */
  async function readHead(): Promise<HeadState> {
    const res = await dropboxRequest(
      `${DROPBOX_RPC}/files/get_metadata`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ path: SYNC_FILE_PATH, include_deleted: true }),
      },
      { what: 'check the sync file', allowStatus: [409] },
    );
    if (res.status === 409) {
      const tags = errorTags(res.text);
      if (tags.has('not_found')) return { kind: 'absent' };
      throw errorFromResponse(res, 'check the sync file');
    }
    const body = parseJson<FileMetadata>(res, 'check the sync file');
    if (body['.tag'] === 'deleted') return { kind: 'deleted' };
    if (body['.tag'] === 'folder') {
      throw new SyncTransportError(
        'remote',
        'There is a FOLDER where the sync file should be in Dropbox, so nothing was read or ' +
          'written. Move or rename it and sync again.',
      );
    }
    const { rev, contentHash } = vetFileMetadata(body, 'read the sync file');
    return { kind: 'file', rev, contentHash };
  }

  /**
   * Download the file, verify it, and remember what rev it was.
   *
   * The integrity check is the one Dropbox offers and costs a hash of bytes we
   * already hold: `Dropbox-API-Result` carries the file's own content_hash, so
   * a truncated or mangled transfer is caught here rather than becoming a
   * parse error the user cannot interpret — or, worse, valid JSON that is
   * missing rows.
   */
  async function download(): Promise<{ snap: SyncSnapshot; observation: HeadObservation }> {
    const res = await dropboxRequest(
      `${DROPBOX_CONTENT}/files/download`,
      {
        method: 'POST',
        headers: { 'dropbox-api-arg': serialiseApiArg({ path: SYNC_FILE_PATH }) },
      },
      { what: 'download the sync file', timeoutMs: DROPBOX_TRANSFER_TIMEOUT_MS },
    );
    let described: { rev: string; contentHash: string | null } | null = null;
    if (res.apiResult) {
      let parsed: FileMetadata;
      try {
        parsed = JSON.parse(res.apiResult) as FileMetadata;
      } catch {
        throw new SyncTransportError(
          'remote',
          "Dropbox's description of the sync file was not readable, so this device can't trust " +
            'what it downloaded. Nothing on this device was changed.',
        );
      }
      described = vetFileMetadata(parsed, 'read the sync file');
    }
    if (!described) {
      throw new SyncTransportError(
        'remote',
        "Dropbox sent the sync file without saying which version it is, so this device can't " +
          'trust it. Nothing on this device was changed.',
      );
    }
    const bytes = new TextEncoder().encode(res.text);
    const hash = await dropboxContentHash(bytes);
    if (described.contentHash && described.contentHash !== hash) {
      throw new SyncTransportError(
        'remote',
        'The sync file downloaded from Dropbox does not match the copy Dropbox is holding — ' +
          'the transfer was damaged. Nothing on this device was changed; try again.',
      );
    }
    const snap = parseSnapshot(res.text);
    const observation: HeadObservation = {
      rev: described.rev,
      contentHash: described.contentHash ?? hash,
      meta: metaOf(snap),
    };
    heads.set(observation);
    return { snap, observation };
  }

  /**
   * What this device knows about the file at `rev`: the cached observation if
   * it is genuinely about that rev, otherwise a download.
   */
  async function observe(head: { rev: string; contentHash: string | null }): Promise<HeadObservation> {
    const cached = heads.get();
    if (
      cached &&
      cached.rev === head.rev &&
      (head.contentHash === null || cached.contentHash === head.contentHash)
    ) {
      return cached;
    }
    return (await download()).observation;
  }

  // `stampMismatch()` USED TO LIVE HERE, and its removal is the last of the
  // Drive apparatus. It compared the head's whole stamp — snapshotId, then
  // revision, savedAt and deviceId — and named which field had moved. On Drive
  // it was the ONLY check that could see a legacy writer replacing the file's
  // contents while our snapshotId merged through on top (C18).
  //
  // It went because it had become a SECOND identity check that no caller could
  // reach. Its own note said it stayed "because syncEngine still passes
  // `expectHead`"; D45 stopped passing it, leaving the branches dead behind an
  // optional argument nothing supplied. Dropbox has no merge — the identity in
  // the body is written by whoever wrote the body, so `snapshotId` answers the
  // question on its own, and the rev in `mode: update` refuses the write
  // regardless of what any read concluded. See the note where `SyncStamp` used
  // to be declared in ./types.ts.

  return {
    isConnected: () => auth.isConnected(),

    connect: () => auth.connect(),

    async disconnect() {
      // The Dropbox file stays exactly where it is. Disconnecting is about
      // this device's access, never about destroying the user's data (rule 3).
      heads.set(null);
      await auth.disconnect();
    },

    async readRemote() {
      const head = await readHead();
      if (head.kind === 'absent') return null;
      if (head.kind === 'deleted') {
        throw new SyncTransportError(
          'remote',
          'The sync file has been deleted from Dropbox, so there was nothing to read. Restore ' +
            'it from Dropbox’s deleted files and sync again.',
        );
      }
      // No cache short-circuit here on purpose: readRemote's contract is the
      // ROWS, and the head cache holds only identity. The cache earns its
      // keep in readRemoteMeta, which is the call that runs on every sync
      // check whether or not anything has changed.
      return (await download()).snap;
    },

    async readRemoteMeta(): Promise<SyncRemoteMeta | null> {
      const head = await readHead();
      // The ONLY null this returns: the file has never existed (rule 2).
      if (head.kind === 'absent') return null;
      if (head.kind === 'deleted') {
        // It EXISTS and is restorable, so it must never read as "no file yet".
        // Dropbox's DeletedMetadata carries a path and nothing else — no rev,
        // no size, no bytes — so the identity fields below are genuinely
        // unknowable here rather than merely unread. The engine tests
        // `trashed` before it looks at any of them and stops.
        return {
          revision: 0,
          savedAt: '',
          deviceName: '',
          deviceId: null,
          snapshotId: null,
          parentSnapshotId: null,
          trashed: true,
        };
      }
      const observation = await observe(head);
      return { ...observation.meta, rev: observation.rev };
    },

    async writeRemote(snap) {
      // Vet our own payload before it leaves: a snapshot we would refuse to
      // read back is a snapshot we must not write. Stricter than the read
      // side — this one must carry an identity (see vetSnapshot).
      vetSnapshot(snap, 'This snapshot');
      const parentSnapshotId = snap.parentSnapshotId ?? null;

      const content = JSON.stringify(snap);
      // Measured in BYTES, not string length: a payee name in Tamil is one JS
      // character but three UTF-8 bytes, so counting characters would let a
      // snapshot well over the limit through.
      const bytes = new TextEncoder().encode(content);
      if (bytes.length > UPLOAD_MAX_BYTES) {
        throw new SyncTransportError(
          'remote',
          `This snapshot is ${(bytes.length / 1024 / 1024).toFixed(1)} MB, too large for a single safe upload. Use a backup file to move it (Settings → Backup).`,
        );
      }
      const contentHash = await dropboxContentHash(bytes);

      // ---- THE PRECONDITION, in two clearly separate halves ---------------
      //
      // CAUSAL (the engine's): replace the head only if it is still the
      // snapshot this book was built on. Answered from the file BODY, which no
      // writer can inherit from another.
      //
      // TRANSPORT (Dropbox's): the file must still be at this exact rev when
      // the bytes arrive. Answered by Dropbox, atomically, in the same request
      // as the upload.
      //
      // The second is what makes the first safe to answer from an OBSERVATION
      // rather than a fresh read. Drive had to re-read the head as late as
      // possible and hope; here a stale observation simply produces a rev
      // Dropbox rejects. That is why the pre-write head re-read is gone.
      let rev: string | null = null;

      if (parentSnapshotId === null) {
        // "There is no file." Deliberately NOT preceded by a check that there
        // is no file: `add` with autorename:false IS that check, performed by
        // Dropbox at the moment of the write, so a race to seed the file loses
        // cleanly instead of quietly creating a second one beside it.
        rev = null;
      } else {
        const cached = heads.get();
        if (cached && cached.meta.snapshotId === parentSnapshotId) {
          // The ordinary path: the engine read the head moments ago, so we
          // already hold the rev that IS that snapshot. No request.
          rev = cached.rev;
        } else {
          // No usable observation — a fresh tab, a cleared cache, or a head
          // that has moved. Go and look, which may cost a download.
          const head = await readHead();
          if (head.kind === 'absent') {
            throw new SyncTransportError(
              'remote',
              'The sync file this upload was based on is no longer in Dropbox, so nothing was ' +
                'uploaded and nothing on this device was changed.',
            );
          }
          if (head.kind === 'deleted') {
            throw new SyncTransportError(
              'remote',
              'The sync file has been deleted from Dropbox, so nothing was uploaded. Restore it ' +
                'from Dropbox’s deleted files, or empty them, and sync again.',
            );
          }
          const observation = await observe(head);
          if (observation.meta.snapshotId !== parentSnapshotId) {
            throw new SyncTransportError(
              'remote',
              'Another device saved to Dropbox while this one was preparing its upload, so ' +
                'nothing was uploaded — this snapshot was built on an older version of the ' +
                'file. Nothing on this device was changed. Sync again to see what changed.',
            );
          }
          rev = observation.rev;
        }
      }

      // ---- ONE REQUEST: precondition, bytes and integrity check together ---
      const arg = uploadArg(rev, contentHash);
      const res = await dropboxRequest(
        `${DROPBOX_CONTENT}/files/upload`,
        {
          method: 'POST',
          headers: {
            'content-type': 'application/octet-stream',
            'dropbox-api-arg': serialiseApiArg(arg),
          },
          body: bytes,
        },
        {
          what: 'save the sync file',
          timeoutMs: DROPBOX_TRANSFER_TIMEOUT_MS,
          // 409 is handled here rather than by the generic mapper, because the
          // SAME status means two different things to a person depending on
          // which mode we sent, and "sync again to see what changed" is wrong
          // advice for a file that has only just appeared.
          allowStatus: [409],
        },
      );
      if (res.status === 409) {
        if (rev === null && errorTags(res.text).has('conflict')) {
          throw new SyncTransportError(
            'remote',
            'A sync file appeared in Dropbox while this one was preparing its upload, so ' +
              'nothing was uploaded and nothing on this device was changed. Sync again to see ' +
              'what is in it.',
          );
        }
        throw errorFromResponse(res, 'save the sync file');
      }

      // ---- THE RESPONSE IS THE CONFIRMATION -------------------------------
      // No read-back. Dropbox has told us what it stored; the three things
      // worth knowing are all in this one body.
      const landed = parseJson<FileMetadata>(res, 'save the sync file');

      // 1. NOT RENAMED. autorename is false, so this can only differ if
      //    Dropbox changed behaviour under us — and a "successful" write to
      //    "mymoney-sync (1).json" is a lost race wearing a 200.
      if (typeof landed.path_lower !== 'string' || landed.path_lower !== SYNC_FILE_PATH) {
        throw new SyncTransportError(
          'remote',
          `Dropbox saved the upload to ${landed.path_lower ?? 'somewhere unexpected'} instead of ` +
            `${SYNC_FILE_PATH}, so this device has NOT been recorded as backed up. Sync again.`,
        );
      }
      // 2. OUR BYTES. Dropbox validates content_hash on the way in and echoes
      //    it back; comparing it here means a silent corruption cannot be
      //    recorded as a successful push.
      if (typeof landed.content_hash === 'string' && landed.content_hash !== contentHash) {
        throw new SyncTransportError(
          'remote',
          'Dropbox stored something different from what this device sent, so the upload has ' +
            'NOT been recorded. Nothing on this device was changed; sync again.',
        );
      }
      // 3. THE NEW REV, TAKEN FROM THE RESPONSE. Never assumed, never derived,
      //    never "the old one plus something" — it is an opaque token and the
      //    only authority on its value is the answer we were just given. Every
      //    later write preconditions on it.
      const { rev: newRev } = vetFileMetadata(landed, 'confirm the upload');
      heads.set({ rev: newRev, contentHash, meta: metaOf(snap) });
    },
  };
}
