import dayjs from 'dayjs';

/**
 * Build an RFC 4122 version-4 UUID string from 16 random bytes, stamping the
 * version (byte 6, high nibble = 4) and variant (byte 8, top bits = 10) fields.
 * Mutates the array it is given — it is always a throwaway buffer.
 */
function uuidV4FromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40; // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80; // variant 10xx (RFC 4122)
  let hex = '';
  for (let i = 0; i < 16; i++) hex += bytes[i]!.toString(16).padStart(2, '0');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/**
 * New record id (a v4 UUID string).
 *
 * Deliberately NOT a bare `crypto.randomUUID()`. That method is specified as
 * **secure-context only**: it exists on https:// and http://localhost, and is
 * simply ABSENT when the app is opened over a LAN address such as
 * http://192.168.1.20:5173 — which is exactly how SPEC §11.6 promises the
 * phone gets it ("open it on my iPhone (same wifi)"). Every id in the app
 * comes from here, including the startup category seed, so an absent
 * randomUUID would take onboarding down with a generic error. Hence the
 * ladder:
 *
 *  1. `crypto.randomUUID()` when the platform offers it (https / localhost /
 *     installed PWA).
 *  2. `crypto.getRandomValues()` otherwise — it is NOT secure-context gated
 *     and is present in every browser this app targets, including Safari on
 *     an iPhone loading a plain http:// LAN URL.
 *  3. `Math.random()` only if neither exists. This is a LAST RESORT for id
 *     UNIQUENESS, not for security: these are local record ids for rows in
 *     the user's own IndexedDB — never tokens, keys, salts or anything an
 *     attacker could gain from predicting. (The app has no secrets to
 *     generate; if Phase 2's optional encryption lands, it must use
 *     WebCrypto directly and must never call this.) 122 random bits from
 *     Math.random still make a collision within one device's ledger
 *     vanishingly unlikely, and a broken id is far better than a dead app.
 */
export function uid(): string {
  const c = globalThis.crypto as Crypto | undefined;
  if (typeof c?.randomUUID === 'function') return c.randomUUID();
  const bytes = new Uint8Array(16);
  if (typeof c?.getRandomValues === 'function') {
    c.getRandomValues(bytes);
  } else {
    for (let i = 0; i < 16; i++) bytes[i] = Math.floor(Math.random() * 256);
  }
  return uuidV4FromBytes(bytes);
}

export const nowISO = (): string => new Date().toISOString();

/** Today as a 'YYYY-MM-DD' calendar date in the device's timezone. */
export const todayISO = (): string => dayjs().format('YYYY-MM-DD');

/** Display a 'YYYY-MM-DD' date the en-GB way. */
export const formatDate = (isoDate: string): string => dayjs(isoDate).format('DD/MM/YYYY');

/** join class names, skipping falsy */
export const cn = (...parts: (string | false | null | undefined)[]): string =>
  parts.filter(Boolean).join(' ');

/** Case/whitespace-insensitive key for name lookups (payees, tags, accounts). */
export const nameKey = (s: string): string => s.trim().toLowerCase().replace(/\s+/g, ' ');
