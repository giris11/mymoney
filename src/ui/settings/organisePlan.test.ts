// The "Organise accounts" preview must promise exactly what
// autoGroupAccounts() does — no more (a change that never happens) and no less
// (a change the user wasn't warned about). These pin the rules it mirrors.
//
// The account names here are SYNTHETIC, like every fixture in this repo: it is
// public, so no real account name goes in it (DECISIONS.md D38). They keep the
// shapes the preview has to render — a bank, a bare brand, a savings account,
// and one the classifier could only guess at.
import { describe, expect, it } from 'vitest';
import type { GroupingSuggestion } from '../../domain/accounts';
import { planRows, summarisePlan, type AccountRef, type GroupRef } from './organisePlan';

const suggestion = (over: Partial<GroupingSuggestion> = {}): GroupingSuggestion => ({
  accountId: 'a1',
  name: 'Lloyds Premier',
  currentType: 'current',
  suggestedType: 'current',
  suggestedGroup: 'Bank Accounts',
  confident: true,
  ...over,
});

const OPTS = { applyTypes: true, onlyUngrouped: true };

describe('planRows', () => {
  it('files an ungrouped account and counts its type correction', () => {
    const rows = planRows(
      [suggestion({ suggestedType: 'credit_card', suggestedGroup: 'Credit Cards' })],
      [{ id: 'a1', groupId: null } satisfies AccountRef],
      [],
      OPTS,
    );
    expect(rows[0].filing).toBe(true);
    expect(rows[0].retyping).toBe(true);
    expect(rows[0].currentGroupName).toBeNull();
    expect(rows[0].leftAlone).toBe(false);
  });

  it('leaves an already-grouped account completely alone under onlyUngrouped', () => {
    const rows = planRows(
      [suggestion({ suggestedType: 'savings', suggestedGroup: 'Savings' })],
      [{ id: 'a1', groupId: 'g1' }],
      [{ id: 'g1', name: 'My banks' } satisfies GroupRef],
      OPTS,
    );
    expect(rows[0].leftAlone).toBe(true);
    expect(rows[0].filing).toBe(false);
    expect(rows[0].retyping).toBe(false); // its type is left alone too
    expect(rows[0].currentGroupName).toBe('My banks');
  });

  it('refiles an already-grouped account when onlyUngrouped is off', () => {
    const rows = planRows(
      [suggestion({ suggestedGroup: 'Savings' })],
      [{ id: 'a1', groupId: 'g1' }],
      [{ id: 'g1', name: 'My banks' }],
      { applyTypes: true, onlyUngrouped: false },
    );
    expect(rows[0].leftAlone).toBe(false);
    expect(rows[0].filing).toBe(true);
  });

  it('treats a differently-cased group name as the same group (the domain reuses it)', () => {
    const rows = planRows(
      [suggestion({ suggestedGroup: 'Bank Accounts' })],
      [{ id: 'a1', groupId: 'g1' }],
      [{ id: 'g1', name: '  bank   accounts ' }],
      { applyTypes: true, onlyUngrouped: false },
    );
    expect(rows[0].filing).toBe(false);
  });

  it('never reports a type change when types match, or when applyTypes is off', () => {
    const same = planRows([suggestion()], [{ id: 'a1', groupId: null }], [], OPTS);
    expect(same[0].retyping).toBe(false);

    const off = planRows(
      [suggestion({ suggestedType: 'cash' })],
      [{ id: 'a1', groupId: null }],
      [],
      { applyTypes: false, onlyUngrouped: true },
    );
    expect(off[0].retyping).toBe(false);
    expect(off[0].filing).toBe(true);
  });

  it('survives a suggestion whose account has vanished', () => {
    const rows = planRows([suggestion()], [], [], OPTS);
    expect(rows[0].filing).toBe(true);
    expect(rows[0].currentGroupName).toBeNull();
  });
});

describe('summarisePlan', () => {
  const suggestions: GroupingSuggestion[] = [
    suggestion({ accountId: 'a1', name: 'Lloyds Premier', suggestedGroup: 'Bank Accounts' }),
    suggestion({ accountId: 'a2', name: 'MONZO', suggestedGroup: 'Bank Accounts' }),
    suggestion({
      accountId: 'a3',
      name: 'Santander Bonus Saver',
      suggestedType: 'savings',
      suggestedGroup: 'Savings',
    }),
    suggestion({
      accountId: 'a4',
      name: 'Work Float',
      suggestedGroup: 'Other Accounts',
      confident: false,
    }),
  ];
  const accounts: AccountRef[] = [
    { id: 'a1', groupId: null },
    { id: 'a2', groupId: null },
    { id: 'a3', groupId: null },
    { id: 'a4', groupId: null },
  ];

  it('keeps the order the suggestions arrive in and counts each group', () => {
    const summary = summarisePlan(planRows(suggestions, accounts, [], OPTS), []);
    expect(summary.sections.map((s) => s.name)).toEqual([
      'Bank Accounts',
      'Savings',
      'Other Accounts',
    ]);
    expect(summary.sections.map((s) => s.rows.length)).toEqual([2, 1, 1]);
    expect(summary.filing).toBe(4);
    expect(summary.retyping).toBe(1);
    expect(summary.newGroups).toBe(3);
  });

  it('flags low-confidence rows, per group and in total', () => {
    const summary = summarisePlan(planRows(suggestions, accounts, [], OPTS), []);
    expect(summary.unsure).toBe(1);
    expect(summary.sections.find((s) => s.name === 'Other Accounts')?.unsure).toBe(1);
    expect(summary.sections.find((s) => s.name === 'Bank Accounts')?.unsure).toBe(0);
  });

  it('does not flag a low-confidence row that is being left alone', () => {
    const rows = planRows(
      [suggestion({ confident: false })],
      [{ id: 'a1', groupId: 'g1' }],
      [{ id: 'g1', name: 'Mine' }],
      OPTS,
    );
    expect(summarisePlan(rows, [{ id: 'g1', name: 'Mine' }]).unsure).toBe(0);
  });

  it('counts only groups that do not exist yet, matching names loosely', () => {
    const existing: GroupRef[] = [{ id: 'g1', name: 'bank accounts' }];
    const summary = summarisePlan(planRows(suggestions, accounts, existing, OPTS), existing);
    expect(summary.newGroups).toBe(2); // Savings + Other Accounts
  });

  it('reports nothing to do when every account already sits where it belongs', () => {
    const existing: GroupRef[] = [{ id: 'g1', name: 'Bank Accounts' }];
    const rows = planRows(
      [suggestion({ suggestedGroup: 'Bank Accounts' })],
      [{ id: 'a1', groupId: 'g1' }],
      existing,
      { applyTypes: true, onlyUngrouped: false },
    );
    const summary = summarisePlan(rows, existing);
    expect(summary.filing).toBe(0);
    expect(summary.retyping).toBe(0);
    expect(summary.newGroups).toBe(0);
  });
});
