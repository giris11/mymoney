// Wording for the sync screens (SPEC §8.3 Drive sync, D42).
//
// Every sentence the sync UI shows about *what is about to happen to the data*
// is built here, as pure functions, so it can be tested. The rule the whole
// feature is written to: when in doubt, refuse and ask — so these helpers
// never round, never soften and never invent a winner. If something is
// unknown it says so.
import dayjs from 'dayjs';
import type { SyncOutcome } from '../../sync/types';

// ------------------------------------------------------------------ time

/** "27/08/2026 at 09:15" — the certain form, used next to every relative one. */
export function absoluteWhen(iso: string): string {
  const d = dayjs(iso);
  return d.isValid() ? d.format('DD/MM/YYYY [at] HH:mm') : 'an unknown time';
}

/**
 * "just now" / "8 minutes ago" / "3 hours ago" / "yesterday" / "4 days ago" /
 * "on 20/08/2026".
 *
 * A snapshot written by another device carries that device's clock, which can
 * legitimately run ahead of this one. Rather than print "in 3 hours" — which
 * reads like a bug — anything more than a minute in the future falls back to
 * the absolute date, which is true regardless of whose clock is right.
 */
export function relativeWhen(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return 'at an unknown time';
  const ms = nowMs - t;
  if (ms < -60_000) return `on ${dayjs(iso).format('DD/MM/YYYY')}`;
  const mins = Math.floor(ms / 60_000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 12) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = dayjs(nowMs).startOf('day').diff(dayjs(t).startOf('day'), 'day');
  if (days === 0) return `${hours} hours ago`;
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days} days ago`;
  return `on ${dayjs(iso).format('DD/MM/YYYY')}`;
}

/**
 * "8 minutes ago (27/08/2026 at 09:15)". The conflict screen decides which
 * copy of a real financial history survives, so it never shows a relative time
 * on its own — "yesterday" is friendly, the timestamp is what you check.
 */
export function whenPhrase(iso: string, nowMs: number = Date.now()): string {
  return `${relativeWhen(iso, nowMs)} (${absoluteWhen(iso)})`;
}

// ---------------------------------------------------------------- counts

/** Display order, mirroring db.ALL_TABLES; unknown tables sort after, by name. */
const TABLE_ORDER = [
  'transactions',
  'accounts',
  'accountGroups',
  'categories',
  'payees',
  'tags',
  'budgets',
  'fxRates',
  'importBatches',
  'settings',
];

const TABLE_LABELS: Record<string, [one: string, many: string]> = {
  accounts: ['account', 'accounts'],
  accountGroups: ['account group', 'account groups'],
  transactions: ['transaction', 'transactions'],
  categories: ['category', 'categories'],
  payees: ['payee', 'payees'],
  tags: ['tag', 'tags'],
  budgets: ['budget', 'budgets'],
  fxRates: ['exchange rate', 'exchange rates'],
  importBatches: ['import', 'imports'],
  settings: ['setting', 'settings'],
};

/** camelCase table name → "account groups", so a table added later still reads. */
function humanise(table: string): [string, string] {
  const words = table
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  const one = words.endsWith('s') ? words.slice(0, -1) : words;
  return [one, words.endsWith('s') ? words : `${words}s`];
}

/** "transaction" / "transactions" for a count. */
export function tableLabel(table: string, count: number): string {
  const [one, many] = TABLE_LABELS[table] ?? humanise(table);
  return count === 1 ? one : many;
}

/** en-GB grouping: 5127 → "5,127". Row counts, never money. */
export function formatCount(n: number): string {
  return new Intl.NumberFormat('en-GB').format(n);
}

/** "5,127 transactions" */
export function countPhrase(table: string, n: number): string {
  return `${formatCount(n)} ${tableLabel(table, n)}`;
}

/**
 * Headline for a set of counts, biggest first: "5,127 transactions, 214 payees,
 * 58 accounts and 4 more". Empty tables are left out of the headline — they
 * still appear in the full side-by-side comparison.
 */
export function summariseCounts(counts: Record<string, number>, max = 3): string {
  const entries = Object.entries(counts)
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  if (entries.length === 0) return 'nothing';
  const shown = entries.slice(0, max).map(([t, n]) => countPhrase(t, n));
  const rest = entries.length - shown.length;
  if (rest > 0) shown.push(`${rest} more`);
  if (shown.length === 1) return shown[0];
  return `${shown.slice(0, -1).join(', ')} and ${shown[shown.length - 1]}`;
}

export interface CountRow {
  table: string;
  /** Plural label for the row heading, e.g. "transactions". */
  label: string;
  local: number;
  remote: number;
  /** local - remote. */
  delta: number;
  /** Spelled out, because a "+13" in green would be colour-only meaning. */
  difference: string;
}

/**
 * The side-by-side comparison rows. Every table either side knows about is
 * listed — a table that exists only in one snapshot is exactly the kind of
 * difference the user needs to see, so it is never dropped. Rows that are zero
 * on both sides carry no information and are dropped.
 */
export function countRows(
  local: Record<string, number>,
  remote: Record<string, number>,
): CountRow[] {
  const tables = Array.from(new Set([...Object.keys(local), ...Object.keys(remote)]));
  tables.sort((a, b) => {
    const ia = TABLE_ORDER.indexOf(a);
    const ib = TABLE_ORDER.indexOf(b);
    if (ia !== ib) return (ia < 0 ? TABLE_ORDER.length : ia) - (ib < 0 ? TABLE_ORDER.length : ib);
    return a.localeCompare(b);
  });
  const rows: CountRow[] = [];
  for (const table of tables) {
    const l = local[table] ?? 0;
    const r = remote[table] ?? 0;
    if (l === 0 && r === 0) continue;
    const delta = l - r;
    rows.push({
      table,
      label: tableLabel(table, 2),
      local: l,
      remote: r,
      delta,
      difference:
        delta === 0
          ? 'same'
          : delta > 0
            ? `${formatCount(delta)} more here`
            : `${formatCount(-delta)} more there`,
    });
  }
  return rows;
}

/** "13 more transactions and 214 more payees" — the here/there halves. */
function moreList(parts: string[]): string {
  if (parts.length === 1) return parts[0];
  return `${parts.slice(0, -1).join(', ')} and ${parts[parts.length - 1]}`;
}

/**
 * One sentence naming what each side has more of. Never says which is
 * "better" or "newer" — more rows is not more correct, and a deletion is a
 * change too. Equal counts get their own sentence, because equal counts are
 * NOT the same as identical data and the user must not read them that way.
 */
export function differenceHeadline(
  rows: CountRow[],
  localName: string,
  remoteName: string,
): string {
  const here = rows.filter((r) => r.delta > 0).map((r) => `${formatCount(r.delta)} more ${tableLabel(r.table, r.delta)}`);
  const there = rows.filter((r) => r.delta < 0).map((r) => `${formatCount(-r.delta)} more ${tableLabel(r.table, -r.delta)}`);
  if (here.length === 0 && there.length === 0) {
    return 'Both copies hold the same number of rows in every table — which does not mean they hold the same rows.';
  }
  const out: string[] = [];
  if (here.length > 0) out.push(`${localName} has ${moreList(here)}.`);
  if (there.length > 0) out.push(`${remoteName} has ${moreList(there)}.`);
  return out.join(' ');
}

// --------------------------------------------------------------- outcomes

export type OutcomeTone = 'success' | 'info' | 'warn' | 'error';

export interface OutcomeReport {
  tone: OutcomeTone;
  headline: string;
  /** One sentence saying what actually happened to the data. */
  detail: string;
}

/**
 * Honest, specific reporting for every SyncOutcome. "Sync complete" is a lie
 * when nothing was sent, so each branch names the direction the data moved —
 * or says plainly that it did not move.
 */
export function describeOutcome(outcome: SyncOutcome): OutcomeReport {
  switch (outcome.kind) {
    case 'up-to-date':
      return {
        tone: 'info',
        headline: 'Already up to date',
        detail: 'This device and the copy in Drive already match. Nothing was sent or fetched.',
      };
    case 'pushed':
      return {
        tone: 'success',
        headline: 'Sent to Google Drive',
        detail: `This device's copy is now the one in Drive (version ${outcome.revision}). Your other devices will pick it up the next time they sync.`,
      };
    case 'pulled':
      return {
        tone: 'success',
        headline: 'Updated from Google Drive',
        detail: `This device now holds the copy from Drive (version ${outcome.revision}): ${summariseCounts(outcome.counts, 4)}.`,
      };
    case 'conflict':
      return {
        tone: 'warn',
        headline: 'Both copies have changed',
        detail: `This device and ${outcome.remote.deviceName} both changed since they last matched. Nothing has been changed — choose which copy to keep.`,
      };
    case 'offline':
      return {
        tone: 'info',
        headline: 'No connection',
        detail: 'Google Drive could not be reached, so nothing was sent or fetched. Everything on this device is untouched — try again when you are back online.',
      };
    case 'not-connected':
      return {
        tone: 'warn',
        headline: 'Needs reconnecting',
        detail: 'Google Drive is no longer authorised for this app on this device. Connect again to resume syncing; your data has not been touched.',
      };
    case 'error':
      return {
        tone: 'error',
        headline: 'Sync failed',
        detail: `${outcome.message} Nothing was changed on this device.`,
      };
  }
}

/** The toast palette only has three kinds; a warning is not a success. */
export function toastKind(tone: OutcomeTone): 'success' | 'error' | 'info' {
  if (tone === 'success') return 'success';
  if (tone === 'info') return 'info';
  return 'error';
}

// ------------------------------------------------------------------ state

/**
 * What this screen knows about where the device stands, read straight from the
 * settings row (the authoritative store — src/db/types.ts) plus a live look at
 * the transport. Deliberately NOT the engine's SyncState: `hasLocalChanges`
 * has one definition, `syncLocalRevision !== syncSyncedLocalRevision`, and
 * comparing the two revision numbers by hand anywhere else would eventually
 * disagree with it.
 */
export interface SyncFacts {
  connected: boolean;
  hasLocalChanges: boolean;
  lastPulledRevision: number;
  /**
   * The revision sitting in Drive: a number if known, `null` if there is no
   * file there yet, `undefined` if this device has not looked since it opened.
   * The third case is a real state and gets its own sentence — claiming the
   * two sides "match" without having checked would be a guess.
   */
  remoteRevision?: number | null;
}

/**
 * The local/remote relationship in plain words. Revision numbers are shown
 * separately as small print — this is the sentence that has to be right.
 */
export function revisionWords(f: SyncFacts): string {
  if (!f.connected) return 'Not connected to Google Drive.';
  if (f.remoteRevision === null) {
    return 'There is nothing in Drive yet. The first sync will upload this device\u2019s copy.';
  }
  if (f.remoteRevision === undefined) {
    return f.hasLocalChanges
      ? 'This device has changes that have not been sent to Drive yet.'
      : 'Everything on this device has been sent to Drive. Sync to check whether another device has added anything since.';
  }
  const remoteAhead = f.remoteRevision > f.lastPulledRevision;
  if (f.hasLocalChanges && remoteAhead) {
    return 'Both this device and the copy in Drive have changed since they last matched. The next sync will stop and ask you which to keep.';
  }
  if (f.hasLocalChanges) return 'This device has changes that have not been sent to Drive yet.';
  if (remoteAhead) return 'Drive has newer changes that this device has not taken yet.';
  return 'This device and the copy in Drive match.';
}

/** "Last synced 8 minutes ago (27/08/2026 at 09:15)" — or the honest absence. */
export function lastSyncedWords(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'Never synced.';
  return `Last synced ${whenPhrase(iso, nowMs)}.`;
}

// ----------------------------------------------------------- setup checks

/**
 * Validate a pasted Google OAuth client ID. The important case is the last
 * one: a browser app cannot keep a secret, this app never asks for one, and a
 * secret pasted into a text field would end up in the browser's storage for no
 * benefit at all. So refuse it loudly rather than storing it.
 */
export function clientIdError(raw: string): string | null {
  const text = raw.trim();
  if (!text) return 'Paste the client ID from your Google Cloud project.';
  if (/^GOCSPX-/i.test(text) || /secret/i.test(text)) {
    return 'That looks like a client SECRET. Never paste a secret here — this app does not use one and a web app cannot keep one safe. Copy the client ID instead.';
  }
  if (/\s/.test(text)) return 'That contains a space, so part of it is probably missing. Copy the whole client ID.';
  if (!text.endsWith('.apps.googleusercontent.com')) {
    return 'A Google client ID ends with .apps.googleusercontent.com — copy the whole thing.';
  }
  if (text.length <= '.apps.googleusercontent.com'.length) return 'That client ID looks incomplete.';
  return null;
}

/** Device names appear on the *other* device during a conflict, so require one. */
export function deviceNameError(raw: string): string | null {
  const text = raw.trim();
  if (!text) {
    return 'Give this device a name — it is what you will see on your other devices when the two copies disagree.';
  }
  if (text.length > 40) return 'Keep the name under 40 characters so it fits alongside the other device.';
  return null;
}

/**
 * A first guess at a device name from the browser's own strings. Deliberately
 * generic: it is a starting point the user edits, and "Mac" beats a random id
 * the moment two devices disagree.
 */
export function deviceNameSuggestion(ua: string, platform = ''): string {
  const s = `${ua} ${platform}`;
  if (/iPhone/i.test(s)) return 'iPhone';
  if (/iPad/i.test(s)) return 'iPad';
  if (/Android/i.test(s)) return /Mobile/i.test(s) ? 'Android phone' : 'Android tablet';
  // iPadOS reports itself as a Mac, but only that Mac has a touch screen.
  if (/Mac/i.test(s)) return 'Mac';
  if (/Win/i.test(s)) return 'Windows PC';
  if (/Linux|X11/i.test(s)) return 'Linux PC';
  return 'This device';
}
