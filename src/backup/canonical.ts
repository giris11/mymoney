// Canonical serialisation: one book, one set of bytes.
//
// WHY THIS EXISTS. A backup is about to become an ORACLE — the statement of
// what the owner's data IS, against which a second implementation (the planned
// Swift/SQLite port) can be proved correct field for field, not merely
// "arrives at the same total". That only works if two exports of an unchanged
// database produce the SAME BYTES, so "did the import reproduce it?" can be
// answered by comparing a hash rather than by reading 5,127 rows by eye.
//
// Plain JSON.stringify cannot promise that. Key order is whatever order the
// keys were inserted in — an accident of how a row was built, of Dexie's
// structured clone, and of nothing that is a fact about the money. Swift
// dictionaries have no insertion order at all, so a Swift export could never
// match a JS one except by luck. So this module defines the format:
//
//   1. OBJECT KEYS ARE SORTED, ascending by UTF-16 code unit (`Array.sort()`'s
//      default). Every key this format uses is ASCII, where that is plain byte
//      order and any language reproduces it.
//   2. ARRAY ORDER IS DATA and is left exactly as given — row order is decided
//      once, by the exporter (sorted by primary key), not here.
//   3. Otherwise the output is byte-for-byte what JSON.stringify would emit:
//      same escaping, same number formatting, same 2-space indentation rules,
//      same treatment of undefined (dropped in an object, `null` in an array).
//
// A hand-written emitter, not "rebuild the object with sorted keys and hand it
// to JSON.stringify", because that shortcut is quietly broken: a JS object puts
// INTEGER-LIKE keys first, in numeric order, whatever order they were inserted
// in. `settings.savedMappings` is keyed by CSV file signature, and one
// all-digits signature would be silently reordered — the canonical form would
// then be unreproducible in any language that just sorts its keys.
import type { BackupManifest } from './manifest';

/** Mirror JSON.stringify's toJSON hook (a Date becomes its ISO string). */
function toJsonValue(raw: unknown): unknown {
  if (raw !== null && typeof raw === 'object') {
    const maybe = raw as { toJSON?: unknown };
    if (typeof maybe.toJSON === 'function') {
      return (maybe.toJSON as (key?: string) => unknown).call(raw);
    }
  }
  return raw;
}

/** Values JSON.stringify drops from objects and writes as `null` in arrays. */
const isOmitted = (v: unknown): boolean =>
  v === undefined || typeof v === 'function' || typeof v === 'symbol';

/**
 * `"key":` — quoted, escaped and given its separator once per DISTINCT key,
 * not once per row.
 *
 * A backup is tens of thousands of rows drawn from ten table shapes: the same
 * seventeen transaction field names, re-quoted for every single row. Doing
 * that per row made canonical serialisation ~13x the cost of JSON.stringify —
 * about a second of an iPhone's export at 100,000 rows, and enough extra CPU
 * to make an unrelated timing test elsewhere in this suite flaky.
 *
 * Keyed on the exact key string, never on a signature of several: a collision
 * would print one row's field names against another row's values, and no
 * saving is worth that. Bounded, because object keys are not all field names —
 * `settings.savedMappings` is keyed by CSV file signature, and an unbounded
 * memo of arbitrary strings is a leak. Past the limit the quoting is simply
 * redone: slower, never different.
 */
const QUOTED_KEY_LIMIT = 512;
const quotedCompact = new Map<string, string>();
const quotedIndented = new Map<string, string>();

function quotedKey(key: string, indent: number): string {
  const cache = indent > 0 ? quotedIndented : quotedCompact;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;
  const made = JSON.stringify(key) + (indent > 0 ? ': ' : ':');
  if (cache.size < QUOTED_KEY_LIMIT) cache.set(key, made);
  return made;
}

function emit(out: string[], raw: unknown, indent: number, depth: number): void {
  const v = toJsonValue(raw);
  if (v === null) {
    out.push('null');
    return;
  }
  switch (typeof v) {
    case 'boolean':
      out.push(v ? 'true' : 'false');
      return;
    case 'number':
      // Non-finite numbers become null, exactly as JSON.stringify does. They
      // cannot occur in a backup (money is integer minor units), and turning
      // one into `null` rather than throwing keeps this function total.
      out.push(Number.isFinite(v) ? JSON.stringify(v)! : 'null');
      return;
    case 'string':
      out.push(JSON.stringify(v));
      return;
    case 'bigint':
      // JSON.stringify throws here too. A silent substitution would be a
      // wrong number in a finance file, which is the one thing never allowed.
      throw new TypeError('Do not know how to serialize a BigInt');
    case 'undefined':
    case 'function':
    case 'symbol':
      out.push('null');
      return;
  }

  const pad = (d: number) => (indent > 0 ? '\n' + ' '.repeat(indent * d) : '');
  if (Array.isArray(v)) {
    if (v.length === 0) {
      out.push('[]');
      return;
    }
    out.push('[');
    for (let i = 0; i < v.length; i++) {
      if (i > 0) out.push(',');
      out.push(pad(depth + 1));
      const el = v[i];
      if (isOmitted(toJsonValue(el))) out.push('null');
      else emit(out, el, indent, depth + 1);
    }
    out.push(pad(depth), ']');
    return;
  }

  const obj = v as Record<string, unknown>;
  // Object.keys() hands back a fresh array, so it is sorted in place: one
  // allocation per object matters at 100,000 rows. Sorted with no comparator,
  // i.e. by UTF-16 code unit — never localeCompare, which is locale-dependent
  // and would make the canonical form depend on where the user lives.
  const keys = Object.keys(obj).sort();
  let written = 0;
  for (let i = 0; i < keys.length; i++) {
    const key = keys[i]!;
    const value = obj[key];
    // Dropped exactly as JSON.stringify drops them, and checked here rather
    // than by pre-filtering the key list — an object whose every value is a
    // real value (which is every row in a backup) then costs no extra array.
    if (isOmitted(value) || isOmitted(toJsonValue(value))) continue;
    out.push(written === 0 ? '{' : ',', pad(depth + 1), quotedKey(key, indent));
    emit(out, value, indent, depth + 1);
    written += 1;
  }
  if (written === 0) {
    out.push('{}');
    return;
  }
  out.push(pad(depth), '}');
}

/**
 * JSON with deterministic key order. `indent` matches JSON.stringify's third
 * argument (0 = compact, 2 = the pretty form small backups are written in).
 *
 * Chunks are collected and joined rather than concatenated onto one growing
 * string: a 100,000-transaction book serialises to tens of megabytes, and
 * repeated `+=` on a string that size is how an export turns into a stall.
 */
export function canonicalJson(value: unknown, indent = 0): string {
  const out: string[] = [];
  emit(out, value, indent, 0);
  return out.join('');
}

// ===========================================================================
// SHA-256
// ===========================================================================
//
// WHY A HAND-WRITTEN ONE, and not `crypto.subtle.digest('SHA-256', …)`:
//
//  * WebCrypto is SECURE-CONTEXT ONLY. SPEC §11.6's promised route onto the
//    owner's iPhone is http://192.168.1.x:5173 over the LAN, which is not a
//    secure context: `crypto.subtle` is simply absent there (the same trap
//    `uid()` in src/lib/util.ts already had to climb out of). A fingerprint
//    that exists on the desktop and not on the phone is not a fingerprint.
//  * it is async, and this has to run inside the export path where the
//    alternative is threading a promise through canonical serialisation.
//  * SHA-256 is fixed by FIPS 180-4, so CryptoKit's `SHA256` in the Swift port
//    produces the identical digest for the identical bytes. That is the whole
//    point: the hash has to be comparable ACROSS implementations.
//
// A cheap non-cryptographic hash (FNV-1a and friends) was rejected outright:
// this figure is used to assert two copies of a financial history are the same
// data, and a 32-bit hash collides by accident at that job.

// FIPS 180-4 §4.2.2: the first 32 bits of the fractional parts of the cube
// roots of the first 64 primes.
const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const rotr = (x: number, n: number): number => (x >>> n) | (x << (32 - n));

/** One 64-byte block into the running state (FIPS 180-4 §6.2.2). */
function compress(h: Uint32Array, w: Uint32Array, view: DataView, off: number): void {
  for (let i = 0; i < 16; i++) w[i] = view.getUint32(off + i * 4);
  for (let i = 16; i < 64; i++) {
    const x = w[i - 15]!;
    const y = w[i - 2]!;
    const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
    const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
    w[i] = (w[i - 16]! + s0 + w[i - 7]! + s1) >>> 0;
  }
  let a = h[0]!;
  let b = h[1]!;
  let c = h[2]!;
  let d = h[3]!;
  let e = h[4]!;
  let f = h[5]!;
  let g = h[6]!;
  let hh = h[7]!;
  for (let i = 0; i < 64; i++) {
    const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
    const ch = (e & f) ^ (~e & g);
    const t1 = (hh + s1 + ch + K[i]! + w[i]!) >>> 0;
    const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
    const maj = (a & b) ^ (a & c) ^ (b & c);
    const t2 = (s0 + maj) >>> 0;
    hh = g;
    g = f;
    f = e;
    e = (d + t1) >>> 0;
    d = c;
    c = b;
    b = a;
    a = (t1 + t2) >>> 0;
  }
  h[0] = (h[0]! + a) >>> 0;
  h[1] = (h[1]! + b) >>> 0;
  h[2] = (h[2]! + c) >>> 0;
  h[3] = (h[3]! + d) >>> 0;
  h[4] = (h[4]! + e) >>> 0;
  h[5] = (h[5]! + f) >>> 0;
  h[6] = (h[6]! + g) >>> 0;
  h[7] = (h[7]! + hh) >>> 0;
}

/**
 * SHA-256 of a string's UTF-8 bytes, lowercase hex.
 *
 * The whole-message blocks are read straight out of the encoded bytes and only
 * the final partial block is copied into a padding buffer: a second full-size
 * copy of a 36 MB export is a real cost on a phone, and it buys nothing.
 */
export function sha256Hex(text: string): string {
  const bytes = new TextEncoder().encode(text);
  const h = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ]);
  const w = new Uint32Array(64);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const whole = bytes.length - (bytes.length % 64);
  for (let off = 0; off < whole; off += 64) compress(h, w, view, off);

  // Padding: 0x80, zeroes, then the message length in BITS as a 64-bit
  // big-endian integer. One extra block when the remainder plus the marker and
  // the length no longer fit in 64 bytes.
  const rest = bytes.length - whole;
  const tailLen = rest + 1 + 8 <= 64 ? 64 : 128;
  const tail = new Uint8Array(tailLen);
  tail.set(bytes.subarray(whole));
  tail[rest] = 0x80;
  const bits = bytes.length * 8;
  const tv = new DataView(tail.buffer);
  // Split by hand: bit lengths beyond 2^32 are perfectly reachable (a 537 MB
  // file), and `>>> 0` is ToUint32, i.e. exactly the low word modulo 2^32.
  tv.setUint32(tailLen - 8, Math.floor(bits / 0x1_0000_0000));
  tv.setUint32(tailLen - 4, bits >>> 0);
  for (let off = 0; off < tailLen; off += 64) compress(h, w, tv, off);

  let hex = '';
  for (let i = 0; i < 8; i++) hex += h[i]!.toString(16).padStart(8, '0');
  return hex;
}

// ===========================================================================
// The fingerprint of a backup's CONTENT
// ===========================================================================

/**
 * The one field that is allowed to differ between two exports of an unchanged
 * book. It appears twice — once at the top of the file, once inside the
 * manifest, which must state when it was taken — and both copies are dropped
 * here so the fingerprint describes the DATA and nothing else.
 */
export const TIMESTAMP_FIELD = 'exportedAt';

/**
 * Anything shaped enough like a backup to be fingerprinted: the file this app
 * just built, or a parsed one whose type nothing has vouched for yet.
 */
export interface HashableBackup {
  exportedAt?: unknown;
  manifest?: BackupManifest | null;
}

/**
 * The part of a backup file the fingerprint covers: everything except the
 * export timestamp. Exported so a test — or a curious owner — can see exactly
 * what is and is not being hashed, rather than trusting the hash function.
 */
export function backupContentForHash(file: HashableBackup): unknown {
  const { [TIMESTAMP_FIELD]: _when, ...rest } = file as Record<string, unknown>;
  const manifest = rest.manifest;
  if (manifest === undefined || manifest === null || typeof manifest !== 'object') return rest;
  const { [TIMESTAMP_FIELD]: _manifestWhen, ...manifestRest } = manifest as Record<
    string,
    unknown
  >;
  return { ...rest, manifest: manifestRest };
}

/**
 * Canonical fingerprint of a backup's contents, ignoring when it was taken.
 *
 * Two exports of an unchanged database have the same fingerprint; a book that
 * has changed by one penny does not. Always computed over the COMPACT form, so
 * a pretty-printed small backup and the same content written compactly (see
 * PRETTY_PRINT_ROW_LIMIT) fingerprint identically — whitespace is not data.
 *
 * This is the figure to write down before freezing the data and to compare
 * against after the Swift port imports it.
 *
 * ONE THING IT COVERS THAT MIGHT SURPRISE YOU: the settings row, device-local
 * half included — theme, install date, sync identity. That is deliberate (the
 * fingerprint describes the FILE, and a faithful import reproduces the file),
 * but it means the same book on two devices fingerprints differently, and so
 * does export → restore → export when the restore happened on a device that
 * had wiped its own settings row: restoreBackup keeps THIS browser's identity
 * rather than taking the file's (C8, see backup.ts). Same device, same book,
 * same fingerprint; a different device is a different file.
 */
export function canonicalBackupHash(file: HashableBackup): string {
  return sha256Hex(canonicalJson(backupContentForHash(file), 0));
}
