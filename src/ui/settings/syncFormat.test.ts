// These sentences are the only thing standing between the user and a wrong
// decision about which copy of his real finances survives, so they are pinned.
import { afterEach, describe, expect, it, vi } from 'vitest';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { SyncSummary } from '../../sync/types';
import type { TokenProvider } from '../../sync/dropboxAuth';
import { createDropboxTransport } from '../../sync/transport';
import { SYNC_HELD, SYNC_HELD_REASON } from '../../sync/held';
import {
  absoluteWhen,
  appKeyError,
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
    expect(pulled.headline).toBe('Updated from Dropbox');
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
      { kind: 'error', message: 'Dropbox said no.' } as const,
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

  it('THE REVISION NUMBER DECIDES NOTHING (D45)', () => {
    // Equal numbers, no identity on the remote: the engine refuses such a file
    // outright rather than compare two absences, and the card says so. Under
    // Drive this fell into a revision-number fallback that read "not proof it
    // is the same copy. The next sync checks." — a promise the engine no
    // longer keeps, because it has no fallback table left to check with.
    expect(remoteRelation(facts())).toBe('remote-has-no-identity');
    expect(revisionWords(facts())).toContain('was not written by this app');
    expect(revisionWords(facts({ hasLocalChanges: true }))).toContain('not written by this app');

    // A number that has moved changes nothing either: still no identity, still
    // refused. Nothing in this card is allowed to read "Dropbox is ahead" off
    // a pair of integers any more.
    const ahead = revisionWords(facts({ remoteRevision: 11 }));
    expect(ahead).toContain('does not say which snapshot it is');
    expect(ahead).not.toMatch(/newer changes|has not taken yet/);
  });

  it('warns before the sync does when both sides moved', () => {
    expect(
      revisionWords(
        facts({
          hasLocalChanges: true,
          remoteRevision: 12,
          lastPulledSnapshotId: 'snap-a',
          remoteSnapshotId: 'snap-b',
          remoteParentSnapshotId: 'snap-a',
        }),
      ),
    ).toContain('ask you which to keep');
  });

  it('handles the first-ever sync and the disconnected case', () => {
    // "No file" on a device that has NEVER synced. `facts()` has a pulled
    // revision of 10, so the first-sync wording has to be asked for.
    expect(
      revisionWords(facts({ remoteRevision: null, lastPulledRevision: 0, everSynced: false })),
    ).toContain('nothing in Dropbox yet');
    expect(revisionWords(facts({ connected: false }))).toBe('Not connected to Dropbox.');
  });

  it('never claims the two sides match without having looked', () => {
    // remoteRevision undefined = not checked this session. Saying "they match"
    // here would be a guess about the user's data, which is the one thing this
    // screen must not do.
    const unchecked = revisionWords(facts({ remoteRevision: undefined }));
    expect(unchecked).not.toContain('match');
    expect(unchecked).toContain('Sync to check');
    expect(revisionWords(facts({ remoteRevision: undefined, hasLocalChanges: true }))).toContain(
      'not been sent to Dropbox yet',
    );
    // The OTHER half of "has not looked": the remote answered but this
    // device's own settings row has not resolved yet. `undefined` there is
    // "not read", never "this device descends from nothing" — which would
    // have been read as a pristine device and promised a free pull.
    const localUnread = revisionWords(
      facts({ remoteSnapshotId: 'snap-1', lastPulledSnapshotId: undefined }),
    );
    expect(remoteRelation(facts({ remoteSnapshotId: 'snap-1', lastPulledSnapshotId: undefined })))
      .toBe('unchecked');
    expect(localUnread).toContain('Sync to check');
  });

  it('never claims a sync that has not happened', () => {
    expect(lastSyncedWords(null)).toBe('Never synced.');
    expect(lastSyncedWords(ago(8 * MIN), NOW)).toBe(
      'Last synced 8 minutes ago (27/08/2026 at 11:52).',
    );
  });
});

describe('appKeyError', () => {
  // The real app key this build ships, and the shape every Dropbox app key has.
  const GOOD = 'kbqcrqxstpn4baq';

  it('accepts an app key, spaces trimmed', () => {
    expect(appKeyError(GOOD)).toBeNull();
    expect(appKeyError(`  ${GOOD}  `)).toBeNull();
  });

  it('CANNOT tell an app key from an app secret, and the code says so out loud', () => {
    // THE ONE MISTAKE THIS FIELD INVITES, and the honest position on it. The
    // Dropbox console prints "App secret" directly beneath "App key" and both
    // are fifteen lowercase alphanumeric characters — there is no pattern to
    // match, unlike the Google client ID this replaced (a '.apps.google…'
    // suffix, and a secret that began 'GOCSPX-').
    //
    // So this test pins the LIMIT rather than a behaviour: a pasted secret is
    // accepted, silently, because nothing could do otherwise. What protects
    // the owner is the warning on the field and in the setup steps, and the
    // test below reads the components to prove both are actually there.
    const secretShaped = 'p8zj3q1x7v2ncbd';
    expect(appKeyError(secretShaped)).toBeNull();

    // What CAN be caught is the paste that brings the label with it.
    expect(appKeyError('App secret p8zj3q1x7v2ncbd')).toMatch(/never paste a secret/i);
    expect(appKeyError('my app secret')).toMatch(/never paste a secret/i);
  });

  it('catches the ordinary paste mistakes', () => {
    expect(appKeyError('')).toMatch(/paste the app key/i);
    expect(appKeyError('   ')).toMatch(/paste the app key/i);
    expect(appKeyError('kbqcrq xstpn4baq')).toMatch(/space/i);
    expect(appKeyError('kbqcrqxstpn4baq.apps.googleusercontent.com')).toMatch(/letters and numbers/i);
    expect(appKeyError('abc123')).toMatch(/incomplete/i);
  });

  it('is never REQUIRED — a blank field is the normal, working state', () => {
    // Under Drive there was no shipped credential, so an empty field meant no
    // sync at all. Dropbox's app key is public by design and built in, so the
    // setup card must not present this as a step. It refuses to connect only
    // on a value the owner actually typed.
    const screen = readFileSync(
      `${fileURLToPath(new URL('.', import.meta.url))}SyncSection.tsx`,
      'utf8',
    );
    expect(screen).toContain('const err = typed ? appKeyError(typed) : null;');
    // …and the field itself is inside the optional disclosure, not above the
    // Connect button where a required field would live.
    const setupCard = screen.slice(screen.indexOf("stage === 'not-set-up'"));
    const disclosure = setupCard.indexOf('Advanced: use my own Dropbox app key');
    const button = setupCard.indexOf('Connect to Dropbox');
    expect(disclosure).toBeGreaterThan(button);
  });
});

describe('the app secret warning is on the screen, because nothing else can catch it', () => {
  const read = (name: string) =>
    readFileSync(`${fileURLToPath(new URL('.', import.meta.url))}${name}`, 'utf8');

  it('warns on the field the owner types into', () => {
    const screen = read('SyncSection.tsx');
    expect(screen).toMatch(/never paste a secret here/i);
    // And it says WHY validation cannot help: the two values look the same.
    expect(screen).toMatch(/look identical/i);
  });

  it('warns again in the steps that send the owner to the console', () => {
    const steps = read('DropboxSetupSteps.tsx');
    expect(steps).toMatch(/Do not paste the app secret/i);
    expect(steps).toMatch(/never uses a secret/i);
    // The steps must name the two safety-relevant console choices, or they
    // describe an app with wider access than the one that was registered.
    expect(steps).toContain('Scoped access');
    expect(steps).toContain('App folder');
    expect(steps).toMatch(/Public clients/);
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
// under the green "Connected to Dropbox" tick has to say the same thing the
// engine is about to do, or the owner reads a reassurance and then gets a
// conflict dialog.
//
// SINCE D45 THE ENGINE HAS NO REVISION FALLBACK AT ALL, so neither has this.
// Every test below that used to end in 'revision-equal' or 'revision-ahead'
// now ends where the engine ends: at a refusal, or at a question.
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

  it('THE C17 CASE: a file that went BACKWARDS is never called a match', () => {
    // Two devices synced to 7. The file was deleted, the iPhone re-seeded it
    // at revision 1 with a book of its own, and this device is perfectly
    // clean. The old wording fell through every guard to "This device and the
    // copy in Drive match." — while syncNow, two seconds later, returned
    // 'conflict'.
    const rolled = at({
      remoteRevision: 1,
      remoteSnapshotId: 'other-lineage-1',
      remoteParentSnapshotId: null,
    });
    expect(remoteRelation(rolled)).toBe('diverged');
    const words = revisionWords(rolled);
    expect(words).not.toMatch(/\bmatch\b/);
    expect(words).not.toContain('the same copy —');
    expect(words).toContain('gone backwards');
    // Both numbers, so the sentence and the small print cannot contradict.
    expect(words).toContain('version 1');
    expect(words).toContain('version 7');
    // And it promises exactly what the engine does: it stops and asks.
    expect(words).toContain('stops to ask');
  });

  it('claims sameness only when the head IS the snapshot this book came from', () => {
    expect(remoteRelation(at())).toBe('same-snapshot');
    expect(revisionWords(at())).toContain('the same copy');
    // Same id, but this device has moved on: unsent, not "the same copy".
    expect(revisionWords(at({ hasLocalChanges: true }))).toBe(
      'This device has changes that have not been sent to Dropbox yet.',
    );
  });

  it('reads a child of our snapshot as a pull, and a dirty one as a question', () => {
    // WHAT CHANGED WITH DROPBOX, and it is the whole point of the migration.
    // On Drive `parentSnapshotId` lived in appProperties and MERGED, so a head
    // could go on naming our snapshot as its parent over contents that
    // descended from nothing (C19) — the card could only describe a check it
    // could not perform. Here the parent id comes out of the file's own body,
    // which its writer replaced whole, so it describes the bytes that are
    // actually there and the card may say what the sync will do.
    //
    // What it still may not promise is that those bytes will still be there a
    // round trip later — the engine's adoption gate exists for exactly that —
    // so the sentence names the re-check rather than omitting it.
    const child = at({ remoteRevision: 8, remoteSnapshotId: 'snap-8', remoteParentSnapshotId: 'snap-7' });
    expect(remoteRelation(child)).toBe('remote-is-our-child');
    const words = revisionWords(child);
    expect(words).toContain('grew out of this device’s copy');
    expect(words).toContain('if another device writes in between, it stops and asks');
    expect(words).not.toContain('the same copy');
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
    // Equal numbers, so the "gone backwards" clause must stay off.
    expect(words).not.toContain('gone backwards');
  });

  it('names a rollback when the head is one of this device’s own ancestors', () => {
    const back = at({ remoteRevision: 6, remoteSnapshotId: 'snap-6', remoteParentSnapshotId: 'snap-5' });
    expect(remoteRelation(back)).toBe('remote-rolled-back');
    expect(revisionWords(back)).toContain('already moved past');
    expect(revisionWords(back)).toContain('stop and ask');
  });

  it('treats a device that has never agreed with anything as simply new here', () => {
    // The feature's whole purpose: open the app on a second device and get the
    // book. Not a conflict, and not "match" either.
    const fresh = at({
      lastPulledRevision: 0,
      lastPulledSnapshotId: null,
      localAncestry: [],
    });
    expect(remoteRelation(fresh)).toBe('remote-descends');
    expect(revisionWords(fresh)).toContain('the next sync will take it');
    // …unless it already holds something of its own, which the engine counts
    // as dirty and refuses to overwrite without asking.
    expect(revisionWords({ ...fresh, hasLocalChanges: true })).toContain('stop and show you both');
  });

  it('REFUSES rather than falls back where the engine has nothing to fall back to', () => {
    // Both halves of what used to be the revision-number table, and both are
    // now questions the engine answers by stopping.
    //
    // A device upgraded mid-lineage: a pulled revision, no id. The engine's
    // `ancestryOf` cannot say what it descends from, and there is no second
    // table to consult, so syncNow lands it in the conflict branch. The card
    // used to tell it "Drive is at the same version number — the next sync
    // checks", which was a promise about a check that no longer exists.
    const migrating = at({ lastPulledSnapshotId: null });
    expect(remoteRelation(migrating)).toBe('we-have-no-identity');
    expect(revisionWords(migrating)).toContain('does not record which copy it grew out of');
    expect(revisionWords(migrating)).toContain('stop and ask');
    expect(revisionWords(migrating)).not.toContain('the same copy');

    // A file that does not say what it is. The engine refuses it outright
    // (NO_IDENTITY_MESSAGE) rather than compare two absences and read them as
    // agreement, and no sync will clear it — so the card must not imply that
    // pressing the button again might.
    const anonymous = at({ remoteSnapshotId: null });
    expect(remoteRelation(anonymous)).toBe('remote-has-no-identity');
    const words = revisionWords(anonymous);
    expect(words).toContain('does not say which snapshot it is');
    expect(words).toContain('nothing here will be replaced');
    expect(words).not.toMatch(/next sync will take|the same copy/);

    // Checked BEFORE our own side, exactly as the engine checks it: a
    // never-synced device meeting an identity-less head must not have its
    // `null` compared with the file's `null` and be told they agree.
    const bothBlank = at({
      remoteSnapshotId: null,
      lastPulledSnapshotId: null,
      lastPulledRevision: 0,
    });
    expect(remoteRelation(bothBlank)).toBe('remote-has-no-identity');
    expect(revisionWords(bothBlank)).not.toContain('take it');
  });

  it('never says two copies are the same unless the two ids are the same', () => {
    // Exhaustive over every shape this card can be in. One rule, no exceptions:
    // the reassuring sentence requires proof of identity.
    //
    // Both wordings count as a claim — the current one and the one this
    // replaced — so the test cannot be satisfied by renaming the lie.
    const claimsSameness = (w: string) =>
      w.includes('the same copy —') || /and the copy in Dropbox match\./.test(w);
    const ids: (string | null | undefined)[] = [undefined, null, 'snap-7', 'snap-9'];
    let sameCases = 0;
    for (const mine of ids) {
      for (const theirs of [null, 'snap-7', 'snap-9']) {
        for (const parent of [null, 'snap-6', 'snap-7']) {
          for (const rev of [1, 7, 9]) {
            for (const pulled of [0, 7]) {
              for (const dirty of [false, true]) {
                for (const trashed of [false, true]) {
                  const f: SyncFacts = {
                    connected: true,
                    hasLocalChanges: dirty,
                    lastPulledRevision: pulled,
                    remoteRevision: rev,
                    lastPulledSnapshotId: mine,
                    localAncestry: ['snap-6'],
                    remoteSnapshotId: theirs,
                    remoteParentSnapshotId: parent,
                    remoteTrashed: trashed,
                  };
                  if (claimsSameness(revisionWords(f))) {
                    sameCases += 1;
                    expect(theirs).not.toBeNull();
                    expect(theirs).toBe(mine);
                    expect(dirty).toBe(false);
                    expect(trashed).toBe(false);
                  }
                }
              }
            }
          }
        }
      }
    }
    // The rule above must not be satisfied by claiming sameness NOWHERE — that
    // would pass this test while making the card useless.
    expect(sameCases).toBeGreaterThan(0);
  });

  it('never promises a free pull without an identity to justify it', () => {
    // The mirror of the test above, for the OTHER reassuring sentence. The
    // engine hands out an unasked pull in exactly two shapes — the head is our
    // child, or this device is pristine — and nothing else may read as one.
    const promisesAPull = (w: string) =>
      /the next sync will take (them|it)/.test(w);
    let pullCases = 0;
    for (const mine of [undefined, null, 'snap-7'] as (string | null | undefined)[]) {
      for (const theirs of [null, 'snap-7', 'snap-8']) {
        for (const parent of [null, 'snap-6', 'snap-7']) {
          for (const pulled of [0, 7]) {
            for (const dirty of [false, true]) {
              const f: SyncFacts = {
                connected: true,
                hasLocalChanges: dirty,
                lastPulledRevision: pulled,
                remoteRevision: 8,
                lastPulledSnapshotId: mine,
                localAncestry: ['snap-6'],
                remoteSnapshotId: theirs,
                remoteParentSnapshotId: parent,
              };
              if (promisesAPull(revisionWords(f))) {
                pullCases += 1;
                expect(dirty).toBe(false);
                expect(theirs).not.toBeNull();
                const ourChild = mine != null && parent === mine;
                const pristine = mine === null && pulled === 0;
                expect(`${ourChild || pristine}`).toBe('true');
              }
            }
          }
        }
      }
    }
    expect(pullCases).toBeGreaterThan(0);
  });

  it('tells a deleted sync file from a first sync, and a binned one from both', () => {
    // "The first sync will upload this device's copy" on a device whose file was
    // DELETED is false twice: it is not the first sync, and the engine refuses
    // to upload — it will not start a second lineage on its own.
    const gone = at({ remoteRevision: null, everSynced: true });
    expect(remoteRelation(gone)).toBe('no-file');
    expect(revisionWords(gone)).toContain('no longer in your Dropbox');
    expect(revisionWords(gone)).toContain('no off-site copy');

    const first = at({ remoteRevision: null, lastPulledRevision: 0, everSynced: false });
    expect(revisionWords(first)).toContain('nothing in Dropbox yet');

    // A deleted file EXISTS — Dropbox keeps it and one click restores it.
    // Reading it as "no file yet" is what started a second lineage at revision
    // 1, and the card must not imply Dropbox is fine.
    const binned = at({ remoteTrashed: true });
    expect(remoteRelation(binned)).toBe('trashed');
    expect(revisionWords(binned)).toContain('deleted in Dropbox');
    expect(revisionWords(binned)).not.toContain('the same copy');
  });
});

// ===========================================================================
// The nouns, checked by machine rather than by eye
// ===========================================================================
describe('no sentence this module produces still describes Google Drive', () => {
  it('sweeps every relation, every outcome and every setup sentence', () => {
    const said: string[] = [];
    const ids: (string | null | undefined)[] = [undefined, null, 'snap-1', 'snap-2'];
    for (const mine of ids) {
      for (const theirs of ids) {
        for (const parent of ids) {
          for (const rev of [null, undefined, 1, 2] as (number | null | undefined)[]) {
            for (const dirty of [false, true]) {
              for (const trashed of [false, true]) {
                for (const connected of [false, true]) {
                  for (const pulled of [0, 2]) {
                    said.push(
                      revisionWords({
                        connected,
                        hasLocalChanges: dirty,
                        lastPulledRevision: pulled,
                        remoteRevision: rev,
                        lastPulledSnapshotId: mine,
                        localAncestry: ['snap-0'],
                        remoteSnapshotId: theirs,
                        remoteParentSnapshotId: parent,
                        remoteTrashed: trashed,
                      }),
                    );
                  }
                }
              }
            }
          }
        }
      }
    }
    const summary: SyncSummary = {
      revision: 1,
      deviceName: 'iMac',
      savedAt: '2026-08-27T09:00:00.000Z',
      counts: { transactions: 1 },
    };
    for (const outcome of [
      { kind: 'up-to-date' } as const,
      { kind: 'pushed', revision: 2 } as const,
      { kind: 'pulled', revision: 2, counts: { transactions: 1 } } as const,
      { kind: 'conflict', local: summary, remote: summary } as const,
      { kind: 'offline' } as const,
      { kind: 'not-connected' } as const,
    ]) {
      const r = describeOutcome(outcome);
      said.push(r.headline, r.detail);
    }
    for (const everSynced of [false, true]) {
      for (const hasLocalChanges of [false, true]) {
        said.push(signInAgainWords({ everSynced, hasLocalChanges }));
      }
    }
    said.push(lastSyncedWords(null), lastSyncedWords('2026-08-27T09:00:00.000Z'));
    said.push(appKeyError('') ?? '', deviceNameError('') ?? '');

    const offenders = said.filter((w) => /google|\bdrive\b/i.test(w));
    expect(offenders).toEqual([]);
    // Guard the guard: a sweep that produced nothing would pass silently.
    expect(said.length).toBeGreaterThan(500);
  });

  it('the hold on the Sync screen describes the situation it is actually holding', () => {
    // src/sync/held.ts is rendered verbatim by SyncSection. It used to tell
    // the owner "Drive sync is switched off… no data has ever been sent to
    // Drive", which after D44 named a service this build cannot reach at all.
    expect(SYNC_HELD).toBe(true);
    expect(SYNC_HELD_REASON).not.toMatch(/google|\bdrive\b/i);
    expect(SYNC_HELD_REASON).toMatch(/dropbox/i);
    // The two facts the owner needs from it: nothing of his is affected, and
    // the path that still works.
    expect(SYNC_HELD_REASON).toMatch(/nothing on this device/i);
    expect(SYNC_HELD_REASON).toMatch(/backup/i);
  });
});

// ===========================================================================
// C14 / C11 — a permanent failure must not be reported as a passing one
// ===========================================================================
describe('describeOutcome: failures that only the owner can clear', () => {
  it('reports a full Dropbox as permanent and actionable, never "try again"', () => {
    const r = describeOutcome({
      kind: 'error',
      message:
        'Could not upload to Dropbox: Your Dropbox is full, so nothing could be saved to it. ' +
        'Nothing on this device was changed. Free up space in Dropbox and sync again — until ' +
        'then this device is the only copy of your recent changes.',
    });
    expect(r.headline).toBe('Your Dropbox is full');
    expect(r.needsYou).toBe(true);
    expect(r.detail).toContain('Free up space');
    expect(r.detail).not.toMatch(/rate.limit|try again shortly/i);
    // And the generic trailer is gone: the message already says what happened
    // to the data, so appending a second "Nothing was changed" reads like boilerplate.
    expect(r.detail).not.toMatch(/Nothing was changed on this device\.$/);
  });

  it('recognises the deleted-file refusal and offers the one action that answers it', () => {
    // THE SENTENCE THE ENGINE ACTUALLY EMITS, verbatim from syncEngine's
    // LOST_REMOTE_MESSAGE. The generic report carries no `offer`, so failing
    // to classify this costs the Sync screen its re-seed button — and the
    // engine's refusal ("this device will not start one on its own") then has
    // no answer anywhere in the UI: it tells the owner to choose and nothing
    // lets him.
    const r = describeOutcome({
      kind: 'error',
      message:
        'The sync file this device was using is no longer in your Dropbox. Nothing on this ' +
        'device was changed, and nothing was uploaded. Either restore it in Dropbox (check your ' +
        'deleted files) and sync again, or choose to start a new sync file from this device — ' +
        'this device will not start one on its own, because your other devices would then be ' +
        'syncing with a different file.',
    });
    expect(r.headline).toBe('The sync file is gone from Dropbox');
    expect(r.needsYou).toBe(true);
    expect(r.offer).toBe('reseed-remote');
  });

  it('does NOT offer a re-seed for the transport’s stale-precondition failure', () => {
    // A near-identical sentence with an entirely different meaning: the upload
    // was built on a revision that has since moved, which usually means
    // another device wrote — the file is still there. Offering "start a new
    // sync file" here would invite the owner to start a second lineage in
    // answer to a race that resolves itself on the next sync.
    const r = describeOutcome({
      kind: 'error',
      message:
        'Could not upload to Dropbox: The sync file this upload was based on is no longer in ' +
        'Dropbox, so nothing was uploaded and nothing on this device was changed.',
    });
    expect(r.offer).toBeUndefined();
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

  it('names a deleted file as deleted, and offers nothing, because only the owner can restore it', () => {
    // syncEngine's TRASHED_REMOTE_MESSAGE, verbatim. Deliberately no `offer`:
    // a new file created now would sit beside the restored one.
    const r = describeOutcome({
      kind: 'error',
      message:
        'The sync file has been deleted from Dropbox. Nothing on this device was changed, and ' +
        'nothing was uploaded. Restore it from Dropbox’s deleted files and sync again, or empty ' +
        'them first if you meant to start over — while it is merely deleted this device will ' +
        'neither write over it nor start a second file beside it.',
    });
    expect(r.headline).toBe('The sync file has been deleted in Dropbox');
    expect(r.needsYou).toBe(true);
    expect(r.offer).toBeUndefined();
  });

  it('names a file this app did not write, which no amount of syncing will fix', () => {
    // syncEngine's NO_IDENTITY_MESSAGE. Left unclassified it read as a
    // transient "Sync failed", inviting the owner to press the button again
    // for ever against a file the engine will never accept.
    const r = describeOutcome({
      kind: 'error',
      message:
        'The sync file in Dropbox does not say which snapshot it is, so this device cannot tell ' +
        'whether its own book grew out of it. Nothing on this device was changed, and nothing ' +
        'was uploaded. It was not written by this app — replace it from a backup, or delete it ' +
        'and start a new sync file.',
    });
    expect(r.headline).toBe('The file in Dropbox is not this app’s sync file');
    expect(r.needsYou).toBe(true);
    expect(r.offer).toBeUndefined();
  });

  it('FAILS SAFE: a message it does not recognise keeps the old, generic report', () => {
    // The classification reads a string because SyncOutcome carries no error
    // kind. Fail-safe means an unrecognised message costs a headline, never a
    // wrong claim — and never a "needsYou" or an offer to act.
    const r = describeOutcome({ kind: 'error', message: 'Dropbox said no.' });
    expect(r).toEqual({
      tone: 'error',
      headline: 'Sync failed',
      detail: 'Dropbox said no. Nothing was changed on this device.',
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
// rather than trusting a copy pasted into a test file. Wording drifts; a
// wording change here costs a headline and an ACTION (the re-seed button), so
// the string is pinned at the end that produces it, not at the end that reads
// it.
describe('the out-of-space sentence really is the one the transport produces', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('drives the real Dropbox transport into a 409 insufficient_space', async () => {
    const auth: TokenProvider = {
      isConnected: () => true,
      hasValidToken: () => true,
      isLinked: () => true,
      getToken: async () => 'token',
      connect: async () => {},
      invalidate: () => {},
      disconnect: async () => {},
    };
    vi.stubGlobal('navigator', { onLine: true });
    vi.stubGlobal('fetch', async (input: unknown) => {
      const url = String(input);
      const reply = (status: number, body: string) =>
        ({
          status,
          ok: status >= 200 && status < 300,
          text: async () => body,
          headers: { get: () => null },
        }) as unknown as Response;
      if (url.endsWith('/files/upload')) {
        // Dropbox's genuine shape for a full account: the reason is a nested
        // `.tag`, and nothing else in the response distinguishes it from a
        // lost race.
        return reply(
          409,
          JSON.stringify({
            error_summary: 'path/insufficient_space/...',
            error: { '.tag': 'path', reason: { '.tag': 'insufficient_space' } },
          }),
        );
      }
      // The head read: no file yet, so the write takes the create path.
      return reply(
        409,
        JSON.stringify({
          error_summary: 'path/not_found/.',
          error: { '.tag': 'path', path: { '.tag': 'not_found' } },
        }),
      );
    });

    const transport = createDropboxTransport({
      auth,
      headStore: { get: () => null, set: () => {} },
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
    // PERMANENT, and only the owner can clear it. The wording is what the
    // classifier has to recognise.
    expect(message).toMatch(/Your Dropbox is full/);
    expect(message).toMatch(/Free up space/);
    expect(message).not.toMatch(/try again shortly/);

    // …and the screen really does classify it, wrapped in the prefix the
    // engine adds on the way past. This is the assertion the whole test
    // exists for: the two halves of the coupling, in one place.
    const report = describeOutcome({
      kind: 'error',
      message: `Could not upload to Dropbox: ${message}`,
    });
    expect(report.headline).toBe('Your Dropbox is full');
    expect(report.needsYou).toBe(true);
  });
});

// ===========================================================================
// C11 — set up and signed in are different facts
// ===========================================================================
describe('setupStage', () => {
  it('never calls a configured device "not set up"', () => {
    // The C11 state: the grant has been revoked at dropbox.com, so this device
    // is fully configured and holding no way in. Showing the setup form here
    // told the owner his iMac — 5,127 transactions already synced — that it
    // was a blank slate.
    expect(setupStage({ connected: false, hasAppKey: true, everSynced: true })).toBe(
      'needs-sign-in',
    );
    // Either piece of evidence on its own is enough.
    expect(setupStage({ connected: false, hasAppKey: true, everSynced: false })).toBe(
      'needs-sign-in',
    );
    // THE ONE THAT NOW CARRIES THE WEIGHT. Under Drive a stored client ID was
    // proof of setup and almost every device had one; on Dropbox the app key
    // is built in, so a lapsed device usually has nothing but its history —
    // and its history has to be enough.
    expect(setupStage({ connected: false, hasAppKey: false, everSynced: true })).toBe(
      'needs-sign-in',
    );
    // And a genuinely new device still gets the setup screen.
    expect(setupStage({ connected: false, hasAppKey: false, everSynced: false })).toBe(
      'not-set-up',
    );
    expect(setupStage({ connected: true, hasAppKey: false, everSynced: false })).toBe('ready');
  });

  it('answers the question the owner actually has: is anything of mine at risk', () => {
    const risky = signInAgainWords({ everSynced: true, hasLocalChanges: true });
    expect(risky).toContain('has synced with Dropbox before');
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

  it('sanitises table names too — they come out of the file in Dropbox', () => {
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

// ===========================================================================
// C18/C19/C20 — what the head can prove, and what it now can
// ===========================================================================
//
// THIS BLOCK USED TO EXIST BECAUSE OF A DRIVE DEFECT. Drive merged
// appProperties on files.update, so a device running a build from before
// ancestry existed left OUR snapshotId — and OUR parentSnapshotId — on a file
// whose contents were now its book. The engine called both of those states a
// conflict; this card, fed by the same readRemoteMeta(), read the same file as
// "the same copy" and as "Drive has newer changes", reassuring the owner in
// precisely the state that needed him.
//
// ON DROPBOX THAT STATE CANNOT BE CONSTRUCTED. Identity lives in the file
// body, which whoever writes it replaces whole, so a foreign writer leaves an
// identity OF ITS OWN or none at all — never ours. The tests below are the
// same tests, re-aimed at what a stranger can actually produce, because the
// property they defend has not changed: the card must never say "the same
// copy" where the engine would stop and ask.
describe('the card cannot claim more than the head can prove', () => {
  /** In step, and the file's own body says so: the one shape that may reassure. */
  const inStep = (over: Partial<SyncFacts> = {}): SyncFacts => ({
    connected: true,
    hasLocalChanges: false,
    lastPulledRevision: 4,
    remoteRevision: 4,
    lastPulledSnapshotId: 'snap-4',
    localAncestry: ['snap-3'],
    remoteSnapshotId: 'snap-4',
    remoteParentSnapshotId: 'snap-3',
    ...over,
  });

  it('says "the same copy" when the head IS our snapshot, and the engine agrees', () => {
    expect(remoteRelation(inStep())).toBe('same-snapshot');
    expect(revisionWords(inStep())).toContain('the same copy');
  });

  it('THE C18 SHAPE, as a stranger can build it now: its own identity is divergence', () => {
    // The old C18 was our id over another device's write. That is gone. What
    // is left is the honest version — another device wrote its own book, with
    // its own identity, at the same revision number — and the card must read
    // it as divergence on the ids alone, with the number proving nothing.
    const stranger = inStep({
      remoteSnapshotId: 'stranger-1',
      remoteParentSnapshotId: 'stranger-0',
    });
    expect(remoteRelation(stranger)).toBe('diverged');
    const words = revisionWords(stranger);
    expect(words).not.toContain('the same copy');
    expect(words).toContain('not the one this device last matched');
  });

  it('THE C19 SHAPE: a head naming our snapshot as its PARENT is now a fact, not a claim', () => {
    // The sentence changed direction here, deliberately, and this is the one
    // place in the migration where the card says MORE than it used to. On
    // Drive `parentSnapshotId` could be a leftover, so the card could only
    // describe a check. On Dropbox it came out of the body being described, so
    // "these changes grew out of this copy" is true of the bytes that are
    // there — and the engine will pull them for a clean device.
    //
    // What the card still refuses to do is promise the outcome: head read and
    // body download are two different moments, which is exactly what the
    // engine's adoption gate is for, and the sentence says so.
    const child = inStep({
      remoteRevision: 5,
      remoteSnapshotId: 'snap-5',
      remoteParentSnapshotId: 'snap-4',
    });
    expect(remoteRelation(child)).toBe('remote-is-our-child');
    const words = revisionWords(child);
    expect(words).not.toContain('the same copy');
    expect(words).toContain('grew out of this device’s copy');
    expect(words).toContain('stops and asks');
  });

  it('a revision that has moved under an unchanged id is NOT divergence any more', () => {
    // AND THIS IS THE CHANGE, STATED AS A TEST. Under Drive a head carrying
    // our id at a revision we did not write was the C18 wipe in progress, so
    // the card called it divergence. On Dropbox the id is derived from the
    // bytes: if the id is ours, the bytes are ours, and the revision number is
    // a field inside those same bytes rather than a separate, mergeable store.
    // Calling this divergence would now be a false alarm on a file the engine
    // reports as up to date.
    const moved = inStep({ remoteRevision: 5 });
    expect(remoteRelation(moved)).toBe('same-snapshot');
    expect(revisionWords(moved)).toContain('the same copy');
  });

  it('a device that cannot say what it descends from is asked, not reassured', () => {
    // It has a history and no id — the state an upgraded device could be in.
    // Under Drive this fell to a revision-number fallback that told it the
    // numbers matched; the engine has no such fallback and asks, so this does.
    const noIdentity = inStep({ lastPulledSnapshotId: null });
    expect(remoteRelation(noIdentity)).toBe('we-have-no-identity');
    const words = revisionWords(noIdentity);
    expect(words).not.toContain('the same copy');
    expect(words).toContain('stop and ask');
    // With something unsent, the fact that matters is still the unsent change
    // — but only where the sync would in fact just send it. Here it would not,
    // so the question stays on screen.
    expect(revisionWords({ ...noIdentity, hasLocalChanges: true })).toContain('stop and ask');
  });

  it('a card that has not read its own settings yet says so, and claims nothing', () => {
    // The card renders before the settings row resolves. An alarming sentence
    // that un-alarms itself a second later is its own kind of lie — and so is
    // a reassuring one.
    expect(remoteRelation(inStep({ lastPulledSnapshotId: undefined }))).toBe('unchecked');
    const words = revisionWords(inStep({ lastPulledSnapshotId: undefined }));
    expect(words).not.toContain('the same copy');
    expect(words).not.toMatch(/stop and ask|parted/);
  });
});

describe('the screen hands the card every fact the card can use', () => {
  it('SyncSection passes every field of SyncFacts', () => {
    // ROT-PROOFING, and it is the half C18/C20 actually got wrong: the card's
    // logic was fine, and the screen simply never handed it the fields it
    // needed, so it could not tell one file from another however carefully it
    // reasoned. A field added to SyncFacts and not passed here fails silently
    // and safely — it reads as "no evidence" — which is exactly the kind of
    // quiet degradation that survives a review.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    const facts = readFileSync(`${dir}syncFormat.ts`, 'utf8');
    const body = /export interface SyncFacts \{([\s\S]*?)\n\}/.exec(facts)?.[1];
    if (!body) throw new Error('SyncFacts interface not found — this test is checking nothing');
    const fields = [...body.matchAll(/^ {2}(\w+)\??:/gm)].map((m) => m[1]);
    // The two the whole decision now turns on.
    expect(fields).toContain('remoteSnapshotId');
    expect(fields).toContain('remoteParentSnapshotId');
    expect(fields.length).toBeGreaterThan(6);

    const screen = readFileSync(`${dir}SyncSection.tsx`, 'utf8');
    const literal = /const facts: SyncFacts = \{([\s\S]*?)\n {2}\};/.exec(screen)?.[1];
    if (!literal) throw new Error('SyncSection no longer builds a SyncFacts literal');
    for (const field of fields) {
      // `x: probe?.x ?? null` or the shorthand `x,` — both count as passed.
      const passed = new RegExp(`(^|[\\s{,])${field}\\s*[,:]`, 'm').test(literal);
      expect(`${field}: ${passed}`).toBe(`${field}: true`);
    }
  });

  it('and reads NO setting the database has retired', () => {
    // D45 retired `syncLastPulledSavedAt` and `syncLastPulledDeviceId` to
    // `?: undefined` tombstones. While this screen still named them the card
    // asked for a stamp nothing records and reported every head as unproven —
    // safe, and wrong on every device. They are declared in src/db/types.ts
    // only until this file stops reading them, so this is the test that says
    // it has.
    const dir = fileURLToPath(new URL('.', import.meta.url));
    for (const name of ['SyncSection.tsx', 'syncFormat.ts']) {
      const source = readFileSync(`${dir}${name}`, 'utf8');
      expect(`${name}: ${source.includes('syncLastPulledSavedAt')}`).toBe(`${name}: false`);
      expect(`${name}: ${source.includes('syncLastPulledDeviceId')}`).toBe(`${name}: false`);
    }
  });
});
