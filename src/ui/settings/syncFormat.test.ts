// These sentences are the only thing standing between the user and a wrong
// decision about which copy of his real finances survives, so they are pinned.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SyncSummary } from '../../sync/types';
import type { TokenProvider } from '../../sync/googleAuth';
import { createDriveTransport } from '../../sync/transport';
import {
  absoluteWhen,
  clientIdError,
  countRows,
  countPhrase,
  describeOutcome,
  differenceHeadline,
  deviceNameError,
  deviceNameSuggestion,
  formatCount,
  lastSyncedWords,
  relativeWhen,
  remoteRelation,
  revisionWords,
  safeDeviceName,
  sanitiseUserText,
  setupStage,
  signInAgainWords,
  type SyncFacts,
  summariseCounts,
  tableLabel,
  toastKind,
  whenPhrase,
} from './syncFormat';

// Local noon, so "20 hours earlier" is unambiguously the previous calendar day
// in any timezone the tests run in.
const NOW = new Date(2026, 7, 27, 12, 0, 0).getTime();
const ago = (ms: number): string => new Date(NOW - ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const DAY = 24 * HOUR;

describe('relativeWhen', () => {
  it('reads as a person would at each distance', () => {
    expect(relativeWhen(ago(30_000), NOW)).toBe('just now');
    expect(relativeWhen(ago(MIN), NOW)).toBe('1 minute ago');
    expect(relativeWhen(ago(8 * MIN), NOW)).toBe('8 minutes ago');
    expect(relativeWhen(ago(HOUR), NOW)).toBe('1 hour ago');
    expect(relativeWhen(ago(3 * HOUR), NOW)).toBe('3 hours ago');
    expect(relativeWhen(ago(20 * HOUR), NOW)).toBe('yesterday');
    expect(relativeWhen(ago(4 * DAY), NOW)).toBe('4 days ago');
  });

  it('falls back to a date once "days ago" stops being useful', () => {
    expect(relativeWhen(ago(10 * DAY), NOW)).toBe('on 17/08/2026');
  });

  it('never says "in 3 hours" when the other device clock runs fast', () => {
    // A snapshot stamped in the future is a clock difference, not a bug worth
    // showing; the absolute date is true whichever clock is right.
    expect(relativeWhen(ago(-3 * HOUR), NOW)).toBe('on 27/08/2026');
    // A few seconds of skew still reads as "just now".
    expect(relativeWhen(ago(-5_000), NOW)).toBe('just now');
  });

  it('admits when a timestamp is unreadable rather than guessing', () => {
    expect(relativeWhen('not-a-date', NOW)).toBe('at an unknown time');
    expect(absoluteWhen('not-a-date')).toBe('an unknown time');
  });
});

describe('whenPhrase', () => {
  it('always carries the exact timestamp beside the friendly one', () => {
    expect(whenPhrase(ago(20 * HOUR), NOW)).toBe('yesterday (26/08/2026 at 16:00)');
  });
});

describe('counts', () => {
  it('groups thousands and agrees in number', () => {
    expect(formatCount(5127)).toBe('5,127');
    expect(countPhrase('transactions', 1)).toBe('1 transaction');
    expect(countPhrase('transactions', 5127)).toBe('5,127 transactions');
    expect(tableLabel('accountGroups', 3)).toBe('account groups');
    expect(tableLabel('fxRates', 1)).toBe('exchange rate');
  });

  it('humanises a table it has never heard of', () => {
    // A table added by a later phase must still read as English here.
    expect(tableLabel('scheduledItems', 2)).toBe('scheduled items');
    expect(tableLabel('scheduledItems', 1)).toBe('scheduled item');
  });

  it('summarises biggest-first and counts the tail', () => {
    expect(
      summariseCounts({ transactions: 5127, accounts: 58, payees: 214, tags: 9, budgets: 4 }),
    ).toBe('5,127 transactions, 214 payees, 58 accounts and 2 more');
    expect(summariseCounts({ transactions: 1 })).toBe('1 transaction');
    expect(summariseCounts({ transactions: 0, accounts: 0 })).toBe('nothing');
  });
});

describe('countRows', () => {
  const rows = countRows(
    { transactions: 5140, accounts: 58, payees: 214, importBatches: 0 },
    { transactions: 5127, accounts: 58, tags: 9, importBatches: 0 },
  );
  const byTable = Object.fromEntries(rows.map((r) => [r.table, r]));

  it('lists tables in the app’s own order, unknown ones last', () => {
    expect(rows.map((r) => r.table)).toEqual(['transactions', 'accounts', 'payees', 'tags']);
  });

  it('spells the difference out instead of relying on a colour', () => {
    expect(byTable.transactions.difference).toBe('13 more here');
    expect(byTable.accounts.difference).toBe('same');
    // Present on one side only — exactly what the user must not miss.
    expect(byTable.tags).toMatchObject({ local: 0, remote: 9, difference: '9 more there' });
    expect(byTable.payees).toMatchObject({ local: 214, remote: 0, difference: '214 more here' });
  });

  it('drops rows that are empty on both sides and keeps the rest', () => {
    expect(byTable.importBatches).toBeUndefined();
    expect(byTable.transactions.delta).toBe(13);
  });
});

describe('differenceHeadline', () => {
  const rows = countRows(
    { transactions: 5140, payees: 214, tags: 2 },
    { transactions: 5127, payees: 214, tags: 11 },
  );

  it('names what each side has more of, and takes no side', () => {
    const line = differenceHeadline(rows, 'This device', 'Girish’s laptop');
    expect(line).toBe('This device has 13 more transactions. Girish’s laptop has 9 more tags.');
    expect(line).not.toMatch(/newer|better|recommend|should/i);
  });

  it('uses only the side that actually has more', () => {
    expect(differenceHeadline(countRows({ tags: 4 }, { tags: 1 }), 'A', 'B')).toBe(
      'A has 3 more tags.',
    );
  });

  it('refuses to let equal counts imply equal data', () => {
    // The trap this exists to close: 5,127 = 5,127 does not mean the same
    // 5,127 rows, and a user told "identical" would resolve carelessly.
    const line = differenceHeadline(countRows({ transactions: 5127 }, { transactions: 5127 }), 'A', 'B');
    expect(line).toContain('does not mean they hold the same rows');
  });
});

describe('describeOutcome', () => {
  const summary = (over: Partial<SyncSummary> = {}): SyncSummary => ({
    revision: 3,
    deviceName: 'Girish’s laptop',
    savedAt: ago(DAY),
    counts: { transactions: 5127 },
    ...over,
  });

  it('names the direction the data moved', () => {
    expect(describeOutcome({ kind: 'pushed', revision: 13 })).toMatchObject({ tone: 'success' });
    expect(describeOutcome({ kind: 'pushed', revision: 13 }).detail).toContain('version 13');
    const pulled = describeOutcome({
      kind: 'pulled',
      revision: 13,
      counts: { transactions: 5127, accounts: 58 },
    });
    expect(pulled.headline).toBe('Updated from Google Drive');
    expect(pulled.detail).toContain('5,127 transactions');
  });

  it('does not call "nothing happened" a success', () => {
    const r = describeOutcome({ kind: 'up-to-date' });
    expect(r.tone).toBe('info');
    expect(r.detail).toContain('Nothing was sent or fetched');
  });

  it('reassures that nothing changed whenever the sync did not complete', () => {
    for (const outcome of [
      { kind: 'offline' } as const,
      { kind: 'not-connected' } as const,
      { kind: 'error', message: 'Drive said no.' } as const,
      { kind: 'conflict', local: summary(), remote: summary() } as const,
    ]) {
      expect(describeOutcome(outcome).detail.toLowerCase()).toMatch(
        /nothing (was|has been) (sent|changed)|has not been touched|untouched/,
      );
    }
  });

  it('names the other device in a conflict', () => {
    const r = describeOutcome({
      kind: 'conflict',
      local: summary({ deviceName: 'Girish’s iMac' }),
      remote: summary({ deviceName: 'Girish’s laptop' }),
    });
    expect(r.tone).toBe('warn');
    expect(r.detail).toContain('Girish’s laptop');
  });

  it('maps a warning to something that does not look like success', () => {
    expect(toastKind('warn')).toBe('error');
    expect(toastKind('success')).toBe('success');
    expect(toastKind('info')).toBe('info');
  });
});

describe('revisionWords', () => {
  const facts = (over: Partial<SyncFacts> = {}): SyncFacts => ({
    connected: true,
    hasLocalChanges: false,
    lastPulledRevision: 10,
    remoteRevision: 10,
    ...over,
  });

  it('says which side is ahead, in words', () => {
    // Equal revision numbers with no identity to check them against. This used
    // to read "This device and the copy in Drive match." — see the C17 block
    // below for why a number is not allowed to claim that any more.
    expect(revisionWords(facts())).toContain('not proof it is the same copy');
    expect(revisionWords(facts({ hasLocalChanges: true }))).toBe(
      'This device has changes that have not been sent to Drive yet.',
    );
    expect(revisionWords(facts({ remoteRevision: 11 }))).toBe(
      'Drive has newer changes that this device has not taken yet.',
    );
  });

  it('warns before the sync does when both sides moved', () => {
    expect(revisionWords(facts({ hasLocalChanges: true, remoteRevision: 12 }))).toContain(
      'ask you which to keep',
    );
  });

  it('handles the first-ever sync and the disconnected case', () => {
    // "No file in Drive" on a device that has NEVER synced. `facts()` has a
    // pulled revision of 10, so the first-sync wording has to be asked for.
    expect(
      revisionWords(facts({ remoteRevision: null, lastPulledRevision: 0, everSynced: false })),
    ).toContain('nothing in Drive yet');
    expect(revisionWords(facts({ connected: false }))).toBe('Not connected to Google Drive.');
  });

  it('never claims the two sides match without having looked', () => {
    // remoteRevision undefined = not checked this session. Saying "they match"
    // here would be a guess about the user's data, which is the one thing this
    // screen must not do.
    const unchecked = revisionWords(facts({ remoteRevision: undefined }));
    expect(unchecked).not.toContain('match');
    expect(unchecked).toContain('Sync to check');
    expect(revisionWords(facts({ remoteRevision: undefined, hasLocalChanges: true }))).toContain(
      'not been sent to Drive yet',
    );
  });

  it('never claims a sync that has not happened', () => {
    expect(lastSyncedWords(null)).toBe('Never synced.');
    expect(lastSyncedWords(ago(8 * MIN), NOW)).toBe(
      'Last synced 8 minutes ago (27/08/2026 at 11:52).',
    );
  });
});

describe('clientIdError', () => {
  const GOOD = '1234567890-abcdefg.apps.googleusercontent.com';

  it('accepts a real client ID, spaces trimmed', () => {
    expect(clientIdError(GOOD)).toBeNull();
    expect(clientIdError(`  ${GOOD}  `)).toBeNull();
  });

  it('refuses a client SECRET outright', () => {
    // The one input the user could paste that would actively harm them.
    expect(clientIdError('GOCSPX-abc123def456')).toMatch(/never paste a secret/i);
    expect(clientIdError('my client secret value')).toMatch(/never paste a secret/i);
  });

  it('catches the ordinary paste mistakes', () => {
    expect(clientIdError('')).toMatch(/paste the client id/i);
    expect(clientIdError('   ')).toMatch(/paste the client id/i);
    expect(clientIdError('1234567890-abcdefg')).toMatch(/apps\.googleusercontent\.com/);
    expect(clientIdError('1234 5678.apps.googleusercontent.com')).toMatch(/space/i);
    expect(clientIdError('.apps.googleusercontent.com')).toMatch(/incomplete/i);
  });
});

describe('device names', () => {
  it('requires a name, because the other device has to recognise it', () => {
    expect(deviceNameError('')).toMatch(/give this device a name/i);
    expect(deviceNameError('Girish’s iMac')).toBeNull();
    expect(deviceNameError('x'.repeat(41))).toMatch(/under 40/i);
  });

  it('guesses something recognisable from the browser', () => {
    expect(deviceNameSuggestion('Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)')).toBe(
      'iPhone',
    );
    expect(deviceNameSuggestion('Mozilla/5.0 (iPad; CPU OS 18_0 like Mac OS X)')).toBe('iPad');
    expect(deviceNameSuggestion('Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)')).toBe('Mac');
    expect(deviceNameSuggestion('Mozilla/5.0 (Windows NT 10.0; Win64; x64)')).toBe('Windows PC');
    expect(deviceNameSuggestion('Mozilla/5.0 (Linux; Android 14; Pixel 8) Mobile')).toBe(
      'Android phone',
    );
    expect(deviceNameSuggestion('something unrecognisable')).toBe('This device');
  });
});

// ===========================================================================
// C17 — "the same copy" means the same SNAPSHOT, never the same number
// ===========================================================================
//
// The engine decides by ancestry: a remote is the same copy when its
// snapshotId IS the one this book descends from, a fast-forward when the
// remote's parent is that id, and a conflict otherwise — including when the
// numbers are equal and including when the remote's number is LOWER. The card
// under the green "Connected to Google Drive" tick has to say the same thing
// the engine is about to do, or the owner reads a reassurance and then gets a
// conflict dialog.
describe('revisionWords: identity, not revision numbers', () => {
  const at = (over: Partial<SyncFacts> = {}): SyncFacts => ({
    connected: true,
    hasLocalChanges: false,
    lastPulledRevision: 7,
    remoteRevision: 7,
    lastPulledSnapshotId: 'snap-7',
    localAncestry: ['snap-6', 'snap-5'],
    remoteSnapshotId: 'snap-7',
    remoteParentSnapshotId: 'snap-6',
    ...over,
  });

  it('THE C17 CASE: a Drive file that went BACKWARDS is never called a match', () => {
    // Two devices synced to 7. The file was deleted, the iPhone re-seeded it at
    // revision 1 with a different book, and this device is perfectly clean. The
    // old wording fell through every guard to "This device and the copy in
    // Drive match." — while syncNow, two seconds later, returns 'conflict'.
    const rolled = at({
      lastPulledRevision: 7,
      remoteRevision: 1,
      lastPulledSnapshotId: null, // a device that has synced but has no id
      remoteSnapshotId: null, // a file written by a pre-ancestry build
      remoteParentSnapshotId: null,
    });
    expect(remoteRelation(rolled)).toBe('revision-behind');
    const words = revisionWords(rolled);
    expect(words).not.toMatch(/\bmatch\b/);
    expect(words).not.toContain('the same copy —');
    expect(words).toContain('gone backwards');
    // Both numbers, so the sentence and the small print cannot contradict.
    expect(words).toContain('version 1');
    expect(words).toContain('version 7');
    // And it promises exactly what the engine does: it stops and asks.
    expect(words).toContain('stop and ask');
  });

  it('claims sameness only when the head IS the snapshot this book came from', () => {
    expect(remoteRelation(at())).toBe('same-snapshot');
    expect(revisionWords(at())).toContain('the same copy');
    // Same id, but this device has moved on: unsent, not "the same copy".
    expect(revisionWords(at({ hasLocalChanges: true }))).toBe(
      'This device has changes that have not been sent to Drive yet.',
    );
  });

  it('reads a child of our snapshot as a fast-forward, and a dirty one as a question', () => {
    const child = at({ remoteRevision: 8, remoteSnapshotId: 'snap-8', remoteParentSnapshotId: 'snap-7' });
    expect(remoteRelation(child)).toBe('remote-descends');
    expect(revisionWords(child)).toBe('Drive has newer changes that this device has not taken yet.');
    expect(revisionWords({ ...child, hasLocalChanges: true })).toContain('ask you which to keep');
  });

  it('does not call a re-seeded file a match, even though the numbers are equal', () => {
    // The nastiest shape: the replacement file happens to have reached the same
    // revision number, so every number-based test says "same". The ids do not.
    const reseeded = at({ remoteSnapshotId: 'other-lineage', remoteParentSnapshotId: 'other-parent' });
    expect(remoteRelation(reseeded)).toBe('diverged');
    const words = revisionWords(reseeded);
    expect(words).not.toContain('the same copy');
    expect(words).toContain('not the one this device last matched');
    // It must NOT promise a conflict either: a device two pushes behind lands
    // here too, and the engine fast-forwards it after reading the chain.
    expect(words).toContain('stops to ask if they really have parted');
  });

  it('names a rollback when the head is one of this device’s own ancestors', () => {
    const back = at({ remoteRevision: 6, remoteSnapshotId: 'snap-6', remoteParentSnapshotId: 'snap-5' });
    expect(remoteRelation(back)).toBe('remote-rolled-back');
    expect(revisionWords(back)).toContain('already moved past');
  });

  it('treats a device that has never agreed with anything as simply new here', () => {
    // The feature's whole purpose: open the app on a second device and get the
    // book. Not a conflict, and not "match" either.
    const fresh = at({
      lastPulledRevision: 0,
      lastPulledSnapshotId: null,
      localAncestry: [],
      remoteSnapshotId: 'snap-7',
      remoteParentSnapshotId: 'snap-6',
    });
    expect(remoteRelation(fresh)).toBe('remote-descends');
    expect(revisionWords(fresh)).toContain('Drive has newer changes');
  });

  it('falls back to revision numbers exactly where the engine does, and claims less', () => {
    // A device upgraded mid-lineage: it has a pulled revision but no id. The
    // engine calls this "ancestry unknown" and uses the numbers; so does this.
    const migrating = at({ lastPulledSnapshotId: null });
    expect(remoteRelation(migrating)).toBe('revision-equal');
    expect(revisionWords(migrating)).toContain('not proof it is the same copy');
    // A file written before ancestry existed: same fallback, from the other side.
    expect(remoteRelation(at({ remoteSnapshotId: null }))).toBe('revision-equal');
    // Settings not read yet is the cautious answer, not an optimistic one.
    expect(remoteRelation(at({ lastPulledSnapshotId: undefined }))).toBe('revision-equal');
  });

  it('never says two copies are the same unless the two ids are the same', () => {
    // Exhaustive over every shape this card can be in. One rule, no exceptions:
    // the reassuring sentence requires proof of identity.
    //
    // Both wordings count as a claim — the current one and the one this
    // replaced — so the test cannot be satisfied by renaming the lie.
    const claimsSameness = (w: string) =>
      w.includes('the same copy —') || /and the copy in Drive match\./.test(w);
    const ids: (string | null | undefined)[] = [undefined, null, 'snap-7', 'snap-9'];
    for (const mine of ids) {
      for (const theirs of [null, 'snap-7', 'snap-9']) {
        for (const parent of [null, 'snap-6', 'snap-7']) {
          for (const rev of [1, 7, 9]) {
            for (const pulled of [0, 7]) {
              for (const dirty of [false, true]) {
                const f: SyncFacts = {
                  connected: true,
                  hasLocalChanges: dirty,
                  lastPulledRevision: pulled,
                  remoteRevision: rev,
                  lastPulledSnapshotId: mine,
                  localAncestry: ['snap-6'],
                  remoteSnapshotId: theirs,
                  remoteParentSnapshotId: parent,
                };
                if (claimsSameness(revisionWords(f))) {
                  expect(theirs).not.toBeNull();
                  expect(theirs).toBe(mine);
                  expect(dirty).toBe(false);
                }
              }
            }
          }
        }
      }
    }
  });

  it('tells a deleted sync file from a first sync, and a binned one from both', () => {
    // "The first sync will upload this device's copy" on a device whose file was
    // DELETED is false twice: it is not the first sync, and the engine refuses
    // to upload — it will not start a second lineage on its own.
    const gone = at({ remoteRevision: null, everSynced: true });
    expect(remoteRelation(gone)).toBe('no-file');
    expect(revisionWords(gone)).toContain('no longer in your Drive');
    expect(revisionWords(gone)).toContain('no off-site copy');

    const first = at({ remoteRevision: null, lastPulledRevision: 0, everSynced: false });
    expect(revisionWords(first)).toContain('nothing in Drive yet');

    // A binned file EXISTS. Reading it as "no file yet" is what started a
    // second lineage at revision 1, and the card must not imply Drive is fine.
    const binned = at({ remoteTrashed: true });
    expect(remoteRelation(binned)).toBe('trashed');
    expect(revisionWords(binned)).toContain('bin');
    expect(revisionWords(binned)).not.toContain('the same copy');
  });
});

// ===========================================================================
// C14 / C11 — a permanent failure must not be reported as a passing one
// ===========================================================================
describe('describeOutcome: failures that only the owner can clear', () => {
  it('reports a full Drive as permanent and actionable, never "try again"', () => {
    const r = describeOutcome({
      kind: 'error',
      message:
        'Could not upload to Google Drive: Your Google Drive is full, so nothing could be saved to it. ' +
        'Nothing on this device was changed. Free up space in Drive (emptying its bin often does it) ' +
        'and sync again — until then this device is the only copy of your recent changes.',
    });
    expect(r.headline).toBe('Your Google Drive is full');
    expect(r.needsYou).toBe(true);
    expect(r.detail).toContain('Free up space');
    expect(r.detail).not.toMatch(/rate.limit|try again shortly/i);
    // And the generic trailer is gone: the message already says what happened
    // to the data, so appending a second "Nothing was changed" reads like boilerplate.
    expect(r.detail).not.toMatch(/Nothing was changed on this device\.$/);
  });

  it('offers the one action that answers a deleted sync file', () => {
    const r = describeOutcome({
      kind: 'error',
      message:
        'The sync file this device was using is no longer in your Google Drive. Nothing on this ' +
        'device was changed, and nothing was uploaded. Either restore it in Drive (check the bin) ' +
        'and sync again, or choose to start a new sync file from this device — this device will ' +
        'not start one on its own, because your other devices would then be syncing with a ' +
        'different file.',
    });
    expect(r.headline).toBe('The sync file is gone from Drive');
    expect(r.needsYou).toBe(true);
    // Without this the engine's refusal is a dead end: it tells the owner to
    // choose, and nothing in the app lets him.
    expect(r.offer).toBe('reseed-remote');
  });

  it('does not shout "Sync failed" over a change it just protected', () => {
    const r = describeOutcome({
      kind: 'error',
      message:
        'This device changed while the sync was running, so nothing was replaced. Your change is ' +
        'still here and still unsent — sync again to send it, or to be shown both sides if the ' +
        'other device has changed too.',
    });
    expect(r.headline).not.toMatch(/failed/i);
    expect(r.headline).toContain('still here');
    expect(r.tone).toBe('warn');
    expect(r.offer).toBeUndefined();
  });

  it('names a binned sync file as its own condition', () => {
    const r = describeOutcome({
      kind: 'error',
      message:
        "The sync file is in Google Drive's bin. Nothing on this device was changed, and nothing " +
        'was uploaded. Restore it in Drive and sync again, or empty the bin first if you meant to ' +
        'start over — while it sits in the bin this device will neither write over it nor start a ' +
        'second file beside it.',
    });
    expect(r.headline).toContain('bin');
    expect(r.needsYou).toBe(true);
  });

  it('FAILS SAFE: a message it does not recognise keeps the old, generic report', () => {
    // The classification reads a string because SyncOutcome carries no error
    // kind. Fail-safe means an unrecognised message costs a headline, never a
    // wrong claim — and never a "needsYou" or an offer to act.
    const r = describeOutcome({ kind: 'error', message: 'Drive said no.' });
    expect(r).toEqual({
      tone: 'error',
      headline: 'Sync failed',
      detail: 'Drive said no. Nothing was changed on this device.',
    });
  });

  it('distinguishes "needs a fresh sign-in" from "never set up" (C11)', () => {
    const r = describeOutcome({ kind: 'not-connected' });
    expect(r.headline).toBe('Needs a fresh sign-in');
    expect(r.detail).toContain('still set up');
    expect(r.detail).toMatch(/not been touched/);
    expect(r.needsYou).toBe(true);
  });
});

// This is the coupling the classification above rests on: the sentence is a
// constant inside src/sync, and this test makes the real transport produce it
// rather than trusting a copy pasted into a test file. If the wording there
// changes, this fails loudly here instead of quietly in front of the owner.
describe('the full-Drive sentence really is the one the transport produces', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives the real Drive transport into a 403 storageQuotaExceeded', async () => {
    const auth: TokenProvider = {
      isConnected: () => true,
      hasValidToken: () => true,
      isLinked: () => true,
      getToken: async () => 'token',
      connect: async () => {},
      invalidate: () => {},
      disconnect: async () => {},
    };
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      if (url.includes('/upload/')) {
        // Google's genuine body for a full account.
        return new Response(
          JSON.stringify({
            error: {
              code: 403,
              errors: [{ reason: 'storageQuotaExceeded', message: 'The user has exceeded their Drive storage quota.' }],
              message: "The user's Drive storage quota has been exceeded.",
            },
          }),
          { status: 403, headers: { 'content-type': 'application/json' } },
        );
      }
      // The head read: no file yet, so the write takes the create path.
      return new Response(JSON.stringify({ files: [] }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      });
    });

    const transport = createDriveTransport({
      auth,
      fileIdStore: { get: () => null, set: () => {} },
    });
    const thrown = await transport
      .writeRemote({
        app: 'MyMoney',
        schemaVersion: 1,
        revision: 1,
        deviceId: 'device-imac',
        deviceName: 'Girish’s iMac',
        savedAt: '2026-08-27T09:15:00.000Z',
        snapshotId: 'snap-1',
        parentSnapshotId: null,
        tables: { transactions: [] },
      })
      .then(
        () => null,
        (e: unknown) => e,
      );

    expect(thrown).toBeInstanceOf(Error);
    const message = (thrown as Error).message;
    // What the transport says, wrapped the way syncEngine's outcomeFromError
    // wraps it before this screen ever sees it.
    const report = describeOutcome({
      kind: 'error',
      message: `Could not upload to Google Drive: ${message}`,
    });
    expect(report.headline).toBe('Your Google Drive is full');
    expect(report.needsYou).toBe(true);
  });
});

// ===========================================================================
// C11 — set up and signed in are different facts
// ===========================================================================
describe('setupStage', () => {
  it('never calls a configured device "not set up"', () => {
    // The exact C11 state: page reloaded, so no token is in hand, but the
    // client ID is stored and the book is already in Drive. Showing the setup
    // form here told the owner his iMac was a blank slate.
    expect(setupStage({ connected: false, hasClientId: true, everSynced: true })).toBe(
      'needs-sign-in',
    );
    // Either piece of evidence on its own is enough.
    expect(setupStage({ connected: false, hasClientId: true, everSynced: false })).toBe(
      'needs-sign-in',
    );
    expect(setupStage({ connected: false, hasClientId: false, everSynced: true })).toBe(
      'needs-sign-in',
    );
    // And a genuinely new device still gets the setup screen.
    expect(setupStage({ connected: false, hasClientId: false, everSynced: false })).toBe(
      'not-set-up',
    );
    expect(setupStage({ connected: true, hasClientId: true, everSynced: true })).toBe('ready');
  });

  it('answers the question the owner actually has: is anything of mine at risk', () => {
    const risky = signInAgainWords({ everSynced: true, hasLocalChanges: true });
    expect(risky).toContain('has synced with Drive before');
    expect(risky).toContain('only copy of them');
    expect(risky).not.toMatch(/not set up|never been set up/i);

    const safe = signInAgainWords({ everSynced: true, hasLocalChanges: false });
    expect(safe).toContain('Nothing here has been touched.');
    expect(safe).not.toContain('only copy of them');

    // A device with a client ID that has never actually synced is a half-done
    // setup, and saying so is different again.
    expect(signInAgainWords({ everSynced: false, hasLocalChanges: false })).toContain(
      'never synced',
    );
  });
});

// ===========================================================================
// Text that came from outside this device
// ===========================================================================
describe('safeDeviceName', () => {
  it('stops a device name forging a new paragraph of the app’s own voice', () => {
    const forged = 'iPhone\n\nNothing will be replaced. Press Keep this device’s copy.';
    const clean = safeDeviceName(forged);
    expect(clean).not.toContain('\n');
    expect(Array.from(clean).length).toBeLessThanOrEqual(40);
    // It still names the device, because that is the fact the choice turns on.
    expect(clean.startsWith('iPhone')).toBe(true);
  });

  it('removes bidi overrides, which rewrite the text around them', () => {
    // U+202E flips the rendering of everything after it, so a name can reverse
    // the meaning of the sentence it is dropped into.
    expect(safeDeviceName('iMac‮placeholder')).toBe('iMacplaceholder');
    expect(safeDeviceName('a⁦b⁩c')).toBe('abc');
    expect(safeDeviceName('a​b')).toBe('ab');
  });

  it('bounds the length, and says something rather than nothing', () => {
    expect(Array.from(safeDeviceName('x'.repeat(4000))).length).toBe(40);
    expect(safeDeviceName('x'.repeat(4000)).endsWith('…')).toBe(true);
    expect(safeDeviceName('')).toBe('the other device');
    expect(safeDeviceName('   ‪‬  ')).toBe('the other device');
    expect(safeDeviceName(undefined)).toBe('the other device');
    expect(safeDeviceName(42 as unknown)).toBe('the other device');
    expect(safeDeviceName('', 'an unnamed device')).toBe('an unnamed device');
  });

  it('leaves an ordinary name exactly as typed', () => {
    expect(safeDeviceName('Girish’s iMac')).toBe('Girish’s iMac');
    expect(safeDeviceName('  Girish’s iMac  ')).toBe('Girish’s iMac');
  });

  it('does not cut a non-BMP character in half', () => {
    // Slicing by code unit would leave a lone surrogate in the DOM.
    const out = sanitiseUserText('😀'.repeat(40), 10);
    expect(Array.from(out).length).toBe(10);
    // Array.from splits by code point, so a half-emoji would show up here as a
    // lone surrogate of its own.
    const lone = Array.from(out).filter((c) => {
      const cp = c.codePointAt(0) ?? 0;
      return cp >= 0xd800 && cp <= 0xdfff;
    });
    expect(lone).toEqual([]);
  });

  it('keeps the joiners real names and emoji are built from', () => {
    // U+200C/U+200D cannot reorder or forge anything, and they are load-bearing
    // in Devanagari, Persian and every multi-person emoji. Stripping them (the
    // first cut of this function did) silently misspelt names.
    expect(safeDeviceName('👨‍👩‍👧‍👦 iMac')).toBe('👨‍👩‍👧‍👦 iMac');
    expect(safeDeviceName('क्‍ष')).toBe('क्‍ष');
  });

  it('applies the same bound to the name typed on THIS device', () => {
    // One number for both sides: what this device may type is what the other
    // device will be able to read back.
    expect(deviceNameError('x'.repeat(40))).toBeNull();
    expect(deviceNameError('x'.repeat(41))).toMatch(/under 40/);
  });

  it('sanitises table names too — they come out of the file in Drive', () => {
    // countRows/summariseCounts label rows from the KEYS of the remote
    // snapshot's `tables`, which is whatever is in the file.
    expect(tableLabel('transactions\n— already saved', 2)).not.toContain('\n');
    expect(Array.from(tableLabel('x'.repeat(200), 2)).length).toBeLessThanOrEqual(25);
    expect(tableLabel('', 2)).toBe('rows');
    expect(tableLabel('‮', 1)).toBe('row');
    // The ordinary path is untouched.
    expect(tableLabel('scheduledItems', 2)).toBe('scheduled items');
  });

  it('carries the cleaned name into the conflict sentence', () => {
    const summary = (deviceName: string): SyncSummary => ({
      revision: 3,
      deviceName,
      savedAt: '2026-08-26T16:00:00.000Z',
      counts: { transactions: 1 },
    });
    const r = describeOutcome({
      kind: 'conflict',
      local: summary('iMac'),
      remote: summary('laptop\nNothing has changed.'),
    });
    expect(r.detail).not.toContain('\n');
    expect(r.detail).toContain('laptop Nothing has changed.');
  });
});

describe('the sync UI never renders raw markup', () => {
  it('has no dangerouslySetInnerHTML anywhere in Settings', () => {
    // The sanitiser above is about the app's own VOICE, not about markup —
    // markup is handled by React escaping every {value}. This test is what makes
    // that second sentence true, and keeps it true.
    // Assembled, not written out, so this file does not fail its own check.
    const needle = `dangerously${'SetInnerHTML'}`;
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const checked: string[] = [];
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.tsx')) continue;
      const source = readFileSync(`${dir}${name}`, 'utf8');
      expect(`${name}: ${source.includes(needle)}`).toBe(`${name}: false`);
      checked.push(name);
    }
    // Guard the guard: a moved directory would otherwise make this pass by
    // checking nothing at all.
    expect(checked).toContain('SyncSection.tsx');
    expect(checked).toContain('SyncConflictDialog.tsx');
  });
});
