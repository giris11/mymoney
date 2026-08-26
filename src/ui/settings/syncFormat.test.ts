// These sentences are the only thing standing between the user and a wrong
// decision about which copy of his real finances survives, so they are pinned.
import { describe, expect, it } from 'vitest';
import type { SyncSummary } from '../../sync/types';
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
  revisionWords,
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
    expect(revisionWords(facts())).toContain('match');
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
    expect(revisionWords(facts({ remoteRevision: null }))).toContain('nothing in Drive yet');
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
