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

// ------------------------------------------------------- user-supplied text

/**
 * The longest a device name is ever shown at. `deviceNameError` holds THIS
 * device to the same bound; a name that arrives inside a snapshot has been
 * through no such check, because it was typed on another device (possibly an
 * older build) and the file itself can be hand-edited in Drive.
 */
export const DEVICE_NAME_DISPLAY_MAX = 40;

/** Table names come out of the snapshot too, so they get the same treatment. */
export const TABLE_LABEL_DISPLAY_MAX = 24;

/**
 * Make a string from *outside this device* safe to drop into a sentence.
 *
 * NOT an HTML escaper — React escapes every `{value}` it renders, and nothing
 * in this UI uses dangerouslySetInnerHTML (there is a test). The danger here is
 * the other one: these strings are interpolated into prose that tells the owner
 * what is about to happen to his money, so a name is a chance to IMPERSONATE
 * THE APP'S OWN VOICE. Three shapes do it, and all three are removed:
 *
 *  * control characters and newlines — a name containing "\n\nNothing will be
 *    replaced." reads as a new paragraph of the app's own reassurance;
 *  * bidi overrides and isolates (U+202A–202E, U+2066–2069, …) — these reorder
 *    the characters AROUND them, so a name can reverse the meaning of the
 *    sentence it sits in, and zero-width characters hide the join;
 *  * unbounded length — a 4,000-character "name" pushes the two options in the
 *    conflict dialog off the screen, and a decision the user cannot see is a
 *    decision made for him.
 *
 * Rejected alternative: refusing to show a name that fails these checks. The
 * conflict dialog's whole job is to say WHICH device wrote the other copy, and
 * "(unrecognised name)" would take away the one fact the choice turns on. So it
 * is cleaned and shown, never dropped.
 */
export function sanitiseUserText(raw: unknown, max: number): string {
  if (typeof raw !== 'string') return '';
  const flat = raw
    // C0/C1 controls, including newline and tab, become a space rather than
    // vanishing: "Girish\niMac" is two words, not one.
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    // Bidi controls, zero-width spaces and word joiners: removed outright.
    // They have no visible width, so a space in their place would be a change
    // the user can see for no reason.
    //
    // NOT the zero-width joiner and non-joiner (U+200C, U+200D), although they
    // sit in the middle of this range. They cannot reorder or forge anything —
    // and they are load-bearing in Devanagari, Persian and every multi-person
    // emoji, so stripping them turned "👨‍👩‍👧‍👦" into four separate people and
    // misspelt real names. Only what can actually deceive is removed.
    .replace(/[\u061C\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  // Count CODE POINTS: slicing by code unit can cut an emoji or a non-BMP
  // script in half and leave a lone surrogate in the DOM.
  const chars = Array.from(flat);
  if (chars.length <= max) return flat;
  return `${chars.slice(0, max - 1).join('')}…`;
}

/**
 * A device name fit to put in a sentence. `fallback` is used when the name is
 * missing or was made entirely of characters that had to be removed — the
 * sentence still has to name a side.
 */
export function safeDeviceName(raw: unknown, fallback = 'the other device'): string {
  return sanitiseUserText(raw, DEVICE_NAME_DISPLAY_MAX) || fallback;
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

/**
 * camelCase table name → "account groups", so a table added later still reads.
 *
 * Sanitised on the way through, because this branch only ever runs on a name
 * that is NOT one of ours: the counts in a conflict come from the keys of the
 * remote snapshot's `tables`, which is whatever is in the file in Drive. A key
 * of "transactions — already saved" would otherwise be printed as a row label
 * in the comparison table, in the app's own voice.
 */
function humanise(table: string): [string, string] {
  const words = sanitiseUserText(table, TABLE_LABEL_DISPLAY_MAX)
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .trim();
  // Nothing legible survived (an empty key, or one made only of characters we
  // strip). "rows" is true of every table and claims nothing.
  if (!words) return ['row', 'rows'];
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
  /**
   * Waiting cannot clear this. Only the owner can — by freeing space in Drive,
   * restoring a file, or choosing something. The screen must not offer "try
   * again" as though time were the answer.
   */
  needsYou?: boolean;
  /**
   * The one action the app can offer for this failure, when there is one.
   * 'reseed-remote' = "start a new sync file from this device", the answer to a
   * sync file that has been deleted from Drive (SyncOptions.resolve).
   */
  offer?: 'reseed-remote';
}

/**
 * Failures that are PERMANENT and ACTIONABLE, recognised from the sentence the
 * sync modules produced.
 *
 * WHY MATCH ON TEXT, WHICH IS OBVIOUSLY FRAGILE. `SyncOutcome` has exactly one
 * failure variant — `{kind:'error', message}` — and syncEngine's
 * `outcomeFromError` has already flattened the transport's typed
 * `SyncErrorKind` into that string by the time this screen sees it. Widening
 * the outcome type is the right fix and it belongs to the module that owns
 * src/sync/types.ts, not here.
 *
 * So this is written to FAIL SAFE rather than to be clever: a message it does
 * not recognise falls through to the generic report the screen already showed,
 * which is honest if unhelpful. A wording change in the sync modules therefore
 * costs a headline, never a wrong claim — and the tests below drive the real
 * transport to produce the real string, so the coupling fails loudly in CI
 * rather than quietly in front of the owner.
 */
function classifyFailure(message: string): OutcomeReport | null {
  // A FULL DRIVE IS NOT RATE LIMITING (C14). It will never clear on its own,
  // every push from now on fails, and the off-site copy has silently stopped
  // advancing — so it gets its own headline and no "try again shortly".
  if (/your google drive is full/i.test(message)) {
    return {
      tone: 'error',
      headline: 'Your Google Drive is full',
      detail: message,
      needsYou: true,
    };
  }
  // There is no off-site copy at all any more. The engine refuses to start a
  // second file on its own, so this is a question only the owner can answer.
  if (/no longer in your google drive/i.test(message)) {
    return {
      tone: 'error',
      headline: 'The sync file is gone from Drive',
      detail: message,
      needsYou: true,
      offer: 'reseed-remote',
    };
  }
  if (/drive['’]s bin/i.test(message)) {
    return {
      tone: 'error',
      headline: 'The sync file is in Drive’s bin',
      detail: message,
      needsYou: true,
    };
  }
  // Not a failure of the data at all: the sync refused to apply over a change
  // that landed while it was running. Saying "Sync failed" over the top of a
  // change the app just PROTECTED reads like loss, which is the opposite.
  if (/still here and still unsent/i.test(message)) {
    return {
      tone: 'warn',
      headline: 'Nothing was replaced — your change is still here',
      detail: message,
    };
  }
  return null;
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
        detail: `This device and ${safeDeviceName(outcome.remote.deviceName)} both changed since they last matched. Nothing has been changed — choose which copy to keep.`,
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
        // NOT "not set up" (C11): this device IS set up — it has a client ID,
        // a name, and in all likelihood a book in Drive. What it has lost is
        // the sign-in, and the two need different words because they need
        // different actions.
        headline: 'Needs a fresh sign-in',
        detail:
          'This device is still set up for sync, but it is not signed in to Google right now, so nothing could be sent or fetched. Sign in again to resume; your data has not been touched.',
        needsYou: true,
      };
    case 'error':
      return (
        classifyFailure(outcome.message) ?? {
          tone: 'error',
          headline: 'Sync failed',
          detail: `${outcome.message} Nothing was changed on this device.`,
        }
      );
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
  /**
   * IDENTITY — the thing the revision number was wrongly asked to be (C17).
   *
   * `settings.syncLastPulledSnapshotId` exactly as stored: the id of the remote
   * snapshot this device's book grew out of, or `null` if it has never agreed
   * with any file. `undefined` means the screen has not read settings yet,
   * which is the safe direction: every branch then falls back to revision
   * numbers, and none of those claims the two sides are the same copy.
   */
  lastPulledSnapshotId?: string | null;
  /** `settings.syncAncestry`: what sits BEHIND lastPulledSnapshotId. */
  localAncestry?: readonly string[];
  /** The head's own id, from readRemoteMeta. `null` on a pre-ancestry file. */
  remoteSnapshotId?: string | null;
  /** What the head descends from, from readRemoteMeta. */
  remoteParentSnapshotId?: string | null;
  /** The file exists but is in Drive's bin — never the same as "no file". */
  remoteTrashed?: boolean;
  /**
   * Has this device ever agreed with a file in Drive? It decides whether "no
   * file in Drive" is the first sync (harmless) or a file that has been
   * DELETED — where the off-site copy is gone and the engine refuses to start
   * a new one on its own. Defaults to `lastPulledRevision > 0`.
   */
  everSynced?: boolean;
}

/**
 * How the copy in Drive is RELATED to this device's book.
 *
 * Mirrors syncNow's decision table one branch at a time, deliberately: the
 * screen and the engine must never be able to disagree about what is about to
 * happen to the data. The names are the engine's own.
 */
export type RemoteRelation =
  | 'not-connected'
  | 'unchecked'
  /** No file in Drive at all. */
  | 'no-file'
  /** The file exists, in the bin. */
  | 'trashed'
  /** The head IS the snapshot this book grew out of. */
  | 'same-snapshot'
  /** The head is a child of ours — or we descend from nothing and it is all new here. */
  | 'remote-descends'
  /** The head is one of OUR ancestors: Drive has been rolled back. */
  | 'remote-rolled-back'
  /** Shared history cannot be shown from the head alone. */
  | 'diverged'
  /** Identity unavailable; the numbers are equal, which proves nothing. */
  | 'revision-equal'
  | 'revision-ahead'
  | 'revision-behind';

/**
 * Which snapshot id this device descends from, applying the SAME migration
 * rule as syncEngine's `ancestryOf`: a stored id is the truth; `null` is only
 * believed on a device that has never pulled anything; on a device that HAS
 * synced but carries no id (upgraded mid-lineage) the answer is "unknown",
 * which sends the sentence to the revision-number fallback — the same place
 * the engine sends the decision.
 */
function pulledSnapshotId(f: SyncFacts): string | null | undefined {
  if (f.lastPulledSnapshotId === undefined) return undefined;
  if (f.lastPulledSnapshotId !== null) return f.lastPulledSnapshotId;
  return f.lastPulledRevision === 0 ? null : undefined;
}

export function remoteRelation(f: SyncFacts): RemoteRelation {
  if (!f.connected) return 'not-connected';
  if (f.remoteRevision === undefined) return 'unchecked';
  // Before the null check on purpose: a binned file EXISTS. Reading it as "no
  // file yet" is the mistake that started a second lineage at revision 1.
  if (f.remoteTrashed) return 'trashed';
  if (f.remoteRevision === null) return 'no-file';

  const mine = pulledSnapshotId(f);
  const theirs = f.remoteSnapshotId ?? null;
  if (mine !== undefined && theirs !== null) {
    if (theirs === mine) return 'same-snapshot';
    if ((f.remoteParentSnapshotId ?? null) === mine) return 'remote-descends';
    // A device that has never agreed with anything descends from nothing, so
    // there is no ancestry for the remote to violate: the file is simply new
    // here, and a clean device takes it.
    if (mine === null) return 'remote-descends';
    // The head is something this device has already moved PAST — the file in
    // Drive was restored to an older version, or replaced. Visible only
    // because this device keeps its own chain.
    if ((f.localAncestry ?? []).includes(theirs)) return 'remote-rolled-back';
    // Everything else: this may still turn out to be a fast-forward (the head
    // names only its parent, so a device two pushes behind lands here too),
    // but the head read alone cannot show it. The engine settles it by reading
    // the snapshot's own chain; this sentence must not pre-judge either way.
    return 'diverged';
  }

  // ---- the fallback, when identity is missing on one side or the other -----
  //
  // THIS IS WHERE C17 LIVED. `remoteRevision > lastPulledRevision` was the only
  // test, so a remote BELOW the local pointer — a re-created file counting from
  // 1 again — fell past every branch into "This device and the copy in Drive
  // match." It matched nothing: the engine sends exactly that state to a
  // conflict. Both directions now have a branch, and equality no longer claims
  // sameness, because two equal numbers never proved it.
  if (f.remoteRevision === f.lastPulledRevision) return 'revision-equal';
  return f.remoteRevision > f.lastPulledRevision ? 'revision-ahead' : 'revision-behind';
}

const UNSENT = 'This device has changes that have not been sent to Drive yet.';
const BOTH_MOVED =
  'Both this device and the copy in Drive have changed since they last matched. The next sync will stop and ask you which to keep.';
const REMOTE_AHEAD = 'Drive has newer changes that this device has not taken yet.';

/**
 * The local/remote relationship in plain words. Revision numbers are shown
 * separately as small print — this is the sentence that has to be right.
 *
 * "The same copy" is claimed in exactly one branch, and there it means the head
 * in Drive IS the snapshot this book came from. Nothing here infers sameness
 * from a number.
 */
export function revisionWords(f: SyncFacts): string {
  const everSynced = f.everSynced ?? f.lastPulledRevision > 0;
  switch (remoteRelation(f)) {
    case 'not-connected':
      return 'Not connected to Google Drive.';

    case 'unchecked':
      return f.hasLocalChanges
        ? UNSENT
        : 'Everything on this device has been sent to Drive. Sync to check whether another device has added anything since.';

    case 'no-file':
      // Two very different situations wear the same face, and only one is
      // harmless. Telling a device whose file has been DELETED that "the first
      // sync will upload this device's copy" would be false twice over: it is
      // not the first sync, and the engine refuses to upload — it will not
      // start a second lineage on its own.
      return everSynced
        ? 'The sync file this device was using is no longer in your Drive, so there is no off-site copy of this book any more. Nothing here has been touched. Restore it from Drive’s bin, or start a new sync file from this device.'
        : 'There is nothing in Drive yet. The first sync will upload this device’s copy.';

    case 'trashed':
      return 'The sync file is in Google Drive’s bin. Nothing is reaching Drive while it sits there — this device will neither write over it nor start a second file beside it. Restore it in Drive, or empty the bin if you meant to start again.';

    case 'same-snapshot':
      return f.hasLocalChanges
        ? UNSENT
        : 'This device and the copy in Drive are the same copy — the file in Drive is the exact snapshot this book came from, and nothing has changed here since.';

    case 'remote-descends':
      return f.hasLocalChanges ? BOTH_MOVED : REMOTE_AHEAD;

    case 'remote-rolled-back':
      return 'The copy in Drive is one this device has already moved past — it has been rolled back to an older version, or replaced. The next sync will stop and ask; nothing is replaced without you choosing.';

    case 'diverged':
      return 'The copy in Drive is not the one this device last matched. The next sync compares them in full and stops to ask if they really have parted — nothing is replaced without you choosing.';

    case 'revision-equal':
      return f.hasLocalChanges
        ? UNSENT
        : 'This device has sent everything it holds, and Drive is at the same version number — which is not proof it is the same copy. The next sync checks.';

    case 'revision-ahead':
      return f.hasLocalChanges ? BOTH_MOVED : REMOTE_AHEAD;

    case 'revision-behind':
      return `The copy in Drive has gone backwards: it is at version ${formatCount(f.remoteRevision as number)}, below the version ${formatCount(f.lastPulledRevision)} this device last took, so it is not the same copy. It has been replaced, or restored from an older one. The next sync will stop and ask; nothing is replaced without you choosing.`;
  }
}

/** "Last synced 8 minutes ago (27/08/2026 at 09:15)" — or the honest absence. */
export function lastSyncedWords(iso: string | null, nowMs: number = Date.now()): string {
  if (!iso) return 'Never synced.';
  return `Last synced ${whenPhrase(iso, nowMs)}.`;
}

// ------------------------------------------------------------ setup stage

/**
 * The three states this screen can be in — and they ARE three, not two (C11).
 *
 * "Connected" used to mean "holds a live Google access token". The token is
 * memory-only by design, so every page reload and every hour in an open tab
 * turned a fully configured device — client ID stored, name stored, 5,127
 * transactions already in Drive — into the "Set up this device" screen, with
 * "Sync now" disabled and no way back except an account-chooser popup.
 *
 * Being signed in and being set up are different facts with different remedies,
 * so they get different words:
 *
 *   'not-set-up'     nothing has ever been configured here. Show the client ID
 *                    form and explain what sync does.
 *   'needs-sign-in'  configured, and not signed in to Google right now. The
 *                    data is untouched and possibly unsent; one button fixes it.
 *   'ready'          signed in. Sync may proceed.
 */
export type SetupStage = 'not-set-up' | 'needs-sign-in' | 'ready';

export function setupStage(f: {
  /** transport.isConnected(): a stored client ID and a standing Google grant. */
  connected: boolean;
  /** A client ID is stored in settings. */
  hasClientId: boolean;
  /** This device has agreed with a file in Drive at least once. */
  everSynced: boolean;
}): SetupStage {
  if (f.connected) return 'ready';
  // Either one is proof this device was set up. `everSynced` is included so a
  // device that somehow lost its client ID — cleared storage, a half-finished
  // restore — is still not told it is a new device, because it is not: its book
  // may hold rows that only exist here.
  return f.hasClientId || f.everSynced ? 'needs-sign-in' : 'not-set-up';
}

/**
 * What to say on a device that is set up but not signed in. Never "not set up",
 * and never a bare "reconnect" either — the sentence has to answer the question
 * the owner actually has, which is whether anything of his is at risk.
 */
export function signInAgainWords(f: {
  everSynced: boolean;
  hasLocalChanges: boolean;
}): string {
  const head = f.everSynced
    ? 'This device is set up for sync and has synced with Drive before. It is not signed in to Google right now, so nothing can be sent or fetched.'
    : 'This device has a Google client ID stored but has never synced. Sign in to Google to finish setting it up.';
  const tail = f.hasLocalChanges
    ? ' Nothing here has been touched — but there are changes on this device that have not reached Drive, so this is the only copy of them until you sign in and sync.'
    : ' Nothing here has been touched.';
  return head + tail;
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
  // The same bound safeDeviceName() enforces on a name arriving from another
  // device: one number, so what this device is allowed to type is exactly what
  // the other device will be able to read.
  if (Array.from(text).length > DEVICE_NAME_DISPLAY_MAX) {
    return `Keep the name under ${DEVICE_NAME_DISPLAY_MAX} characters so it fits alongside the other device.`;
  }
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
