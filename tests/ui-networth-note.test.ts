// The "not counted" line every net-worth surface shows (sidebar, dashboard
// card, net-worth report). The rendering is JSX and this app has no DOM test
// environment — but the SENTENCE is a pure function, and it is the part that
// can lie about someone's money, so it is the part that is tested.
//
// The rule it exists to protect (SPEC §6): when a rate is missing the amount
// is genuinely unknown, and an unknown amount is said out loud, never rounded
// down to a number that quietly leaves an account out.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { notCountedSummary } from '../src/ui/settings/NetWorthCount';

describe('notCountedSummary', () => {
  it('says nothing at all when nothing is excluded', () => {
    expect(notCountedSummary(0, 0, 'GBP')).toBe(null);
    expect(notCountedSummary(0, null, 'GBP')).toBe(null);
  });

  it('names the amount and the number of accounts', () => {
    expect(notCountedSummary(3, 9_012_345, 'GBP')).toBe('£90,123.45 in 3 accounts not counted');
  });

  it('uses the singular for one account', () => {
    const text = notCountedSummary(1, 9_000_000, 'GBP');
    expect(text).toBe('£90,000.00 in 1 account not counted');
    expect(text).not.toContain('accounts');
  });

  it('keeps a negative total negative (lending ledgers can be money owed)', () => {
    expect(notCountedSummary(2, -125_000, 'GBP')).toBe('-£1,250.00 in 2 accounts not counted');
  });

  it('formats in the base currency it is given', () => {
    expect(notCountedSummary(1, 500_000, 'JPY')).toContain('¥500,000');
  });

  it('admits it cannot total them rather than printing a number', () => {
    const text = notCountedSummary(2, null, 'GBP');
    expect(text).toBe('2 accounts not counted — no exchange rate, so the amount can’t be shown');
    // no currency symbol and no digits beyond the account count: nothing here
    // can be mistaken for "these accounts hold £0"
    expect(text).not.toContain('£');
    expect(text?.replace('2 accounts', '')).not.toMatch(/\d/);
  });
});
