// Onboarding — the first five minutes, and the least forgiving code in the app:
// everything here runs exactly once, on a device with no data to compare
// against, and writes the opening balances every future balance is built on.
//
// Two things are pinned:
//  1. Idempotency. `onboarded` is written LAST (so a failure leaves onboarding
//     retryable), which means a reload, an abandoned import wizard or a crash
//     before that flip re-runs the wizard on top of its own earlier writes.
//     The guard has to live in the DATABASE — a React ref dies with the page,
//     and a second set of starter accounts silently doubles net worth.
//  2. A rejected opening balance must never become 0.00.
//
// The suite has no DOM, so the component wiring is pinned by reading the source
// (the same approach tests/theme-boot.test.ts takes with index.html).
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, updateSettings } from '../src/db/db';
import {
  accountsStepError,
  buildAccounts,
  defaultAccountRows,
  openingBalanceProblem,
  type AccountRowState,
} from '../src/ui/onboarding/AccountsStep';
import { completeRestore, createAccountsAndSettings } from '../src/ui/onboarding/setup';
import type { Account } from '../src/db/types';

const reset = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

/** A fresh page: the wizard always starts from defaultAccountRows(). */
const freshRows = () => defaultAccountRows();

const withBalances = (rows: AccountRowState[], texts: string[]): AccountRowState[] =>
  rows.map((r, i) => ({ ...r, openingText: texts[i] ?? '' }));

const totalOpening = async () =>
  (await db.accounts.toArray()).reduce((sum, a) => sum + a.openingBalanceMinor, 0);

beforeEach(reset);

// ---------------------------------------------------------------------------
// B1 — the durable guard
// ---------------------------------------------------------------------------
describe('createAccountsAndSettings is idempotent', () => {
  it('creates the ticked accounts and the base currency on a first run', async () => {
    const rows = withBalances(freshRows(), ['1200.50', '5000', '-250.25', '20']);
    const result = await createAccountsAndSettings(rows, 'GBP');

    expect(result).toEqual({ created: 4, adopted: 0 });
    expect(await db.accounts.count()).toBe(4);
    expect(await totalOpening()).toBe(120050 + 500000 - 25025 + 2000);
    expect((await getSettings()).baseCurrency).toBe('GBP');
    // The flip is deliberately NOT part of this write.
    expect((await getSettings()).onboarded).toBe(false);
  });

  it('adopts the existing set on a second run instead of doubling it (reload mid-wizard)', async () => {
    const rows = withBalances(freshRows(), ['1200.50', '5000', '-250.25', '20']);
    await createAccountsAndSettings(rows, 'GBP');
    const before = await db.accounts.orderBy('id').toArray();
    const totalBefore = await totalOpening();

    // The page died and onboarding started over with brand-new row state.
    const second = await createAccountsAndSettings(
      withBalances(freshRows(), ['1200.50', '5000', '-250.25', '20']),
      'GBP',
    );

    expect(second).toEqual({ created: 0, adopted: 4 });
    expect(await db.accounts.count()).toBe(4);
    expect(await totalOpening()).toBe(totalBefore); // net worth did not double
    expect(await db.accounts.orderBy('id').toArray()).toEqual(before); // untouched
  });

  it('survives a crash between the account write and the onboarded flip', async () => {
    // Run 1: accounts land, then the tab is closed before `onboarded: true`.
    await createAccountsAndSettings(withBalances(freshRows(), ['100', '', '', '']), 'GBP');
    expect((await getSettings()).onboarded).toBe(false);

    // Run 2: onboarding is shown again (that is the design) and completes.
    await createAccountsAndSettings(withBalances(freshRows(), ['100', '', '', '']), 'GBP');
    await updateSettings({ onboarded: true });

    expect(await db.accounts.count()).toBe(4);
    expect(await totalOpening()).toBe(10000);
  });

  it('keeps accounts an import created and adds none of its own (abandoned wizard)', async () => {
    await createAccountsAndSettings(freshRows(), 'GBP');
    const imported: Account = {
      id: 'imported-1',
      name: 'Northwind Bank (from MoneyWiz)',
      type: 'current',
      currency: 'GBP',
      openingBalanceMinor: 4567,
      colour: '#2563eb',
      groupId: null,
      sortOrder: 9,
      archived: false,
    };
    await db.accounts.add(imported); // the import wizard created this, then Cancel

    const again = await createAccountsAndSettings(freshRows(), 'GBP');

    expect(again).toEqual({ created: 0, adopted: 5 });
    expect(await db.accounts.count()).toBe(5);
    expect(await db.accounts.get('imported-1')).toEqual(imported);
  });

  it('honours a base currency changed on the re-run without touching the accounts', async () => {
    await createAccountsAndSettings(freshRows(), 'GBP');
    await createAccountsAndSettings(freshRows(), 'EUR');

    expect((await getSettings()).baseCurrency).toBe('EUR');
    expect((await db.accounts.toArray()).every((a) => a.currency === 'GBP')).toBe(true);
    expect(await db.accounts.count()).toBe(4);
  });

  it('two runs racing in parallel still produce exactly one set', async () => {
    const [a, b] = await Promise.all([
      createAccountsAndSettings(freshRows(), 'GBP'),
      createAccountsAndSettings(freshRows(), 'GBP'),
    ]);
    expect(await db.accounts.count()).toBe(4);
    expect(a.created + b.created).toBe(4);
  });

  it('writes nothing at all when an opening balance cannot be read', async () => {
    const rows = withBalances(freshRows(), ['12.345', '', '', '']);
    await expect(createAccountsAndSettings(rows, 'GBP')).rejects.toThrow(/decimal place/);
    expect(await db.accounts.count()).toBe(0);
    expect(await db.settings.get('app')).toBeUndefined(); // the write rolled back
  });

  it('never re-reads stale row state once the device has accounts', async () => {
    // Reachable only in theory (the step blocks first), but adoption must not
    // depend on row state it is going to ignore anyway.
    await createAccountsAndSettings(freshRows(), 'GBP');
    const stale = withBalances(freshRows(), ['12.345', '', '', '']);
    await expect(createAccountsAndSettings(stale, 'GBP')).resolves.toEqual({
      created: 0,
      adopted: 4,
    });
  });
});

// ---------------------------------------------------------------------------
// B2 — "typed but unreadable" must block, never become 0.00
// ---------------------------------------------------------------------------
describe('openingBalanceProblem', () => {
  it('accepts blank — that is what "leave it at zero" looks like', () => {
    expect(openingBalanceProblem('', 'GBP')).toBe(null);
    expect(openingBalanceProblem('   ', 'GBP')).toBe(null);
  });

  it('accepts everything the money parser accepts', () => {
    for (const ok of ['0', '20', '1234.56', '-250.25', '1,234.56', '(50)', '£12.34', '12.']) {
      expect(openingBalanceProblem(ok, 'GBP')).toBe(null);
    }
  });

  it('names the real problem when there are too many decimal places', () => {
    expect(openingBalanceProblem('12.345', 'GBP')).toBe(
      'GBP amounts have at most 2 decimal places.',
    );
    expect(openingBalanceProblem('12.3', 'JPY')).toBe('JPY amounts don’t have decimal places.');
    expect(openingBalanceProblem('12.3456', 'KWD')).toBe(
      'KWD amounts have at most 3 decimal places.',
    );
    expect(openingBalanceProblem('12', 'JPY')).toBe(null);
  });

  it('rejects text that is not an amount, and says what one looks like', () => {
    expect(openingBalanceProblem('1e6', 'GBP')).toBe(
      '“1e6” isn’t an amount — try something like 1234.56.',
    );
    expect(openingBalanceProblem('about 20', 'GBP')).toMatch(/isn’t an amount/);
    expect(openingBalanceProblem('.', 'GBP')).toMatch(/isn’t an amount/);
    expect(openingBalanceProblem('1e6', 'JPY')).toBe(
      '“1e6” isn’t an amount — try something like 1234.',
    );
  });

  it('rejects a number too large to hold exactly', () => {
    expect(openingBalanceProblem('99999999999999999999', 'GBP')).toBe(
      'That number is too large to store.',
    );
  });
});

describe('accountsStepError', () => {
  const rows = () => freshRows();

  it('still blocks the original two cases', () => {
    expect(accountsStepError(rows().map((r) => ({ ...r, ticked: false })), 'GBP')).toBe(
      'Tick at least one account to continue.',
    );
    const blank = rows();
    blank[1] = { ...blank[1], name: '  ' };
    expect(accountsStepError(blank, 'GBP')).toBe('Give every ticked account a name.');
  });

  it('blocks a ticked row whose typed balance cannot be read, and names the account', () => {
    const r = withBalances(rows(), ['', '12.345', '', '']);
    expect(accountsStepError(r, 'GBP')).toBe(
      'Opening balance for Savings — GBP amounts have at most 2 decimal places.',
    );
    expect(accountsStepError(withBalances(rows(), ['1e6', '', '', '']), 'GBP')).toMatch(
      /^Opening balance for Current Account — /,
    );
  });

  it('reads the balance in the row currency, not the base currency', () => {
    const r = withBalances(rows(), ['', '', '', '500.25']);
    expect(accountsStepError(r, 'GBP')).toBe(null);
    r[3] = { ...r[3], currency: 'JPY' };
    expect(accountsStepError(r, 'GBP')).toBe(
      'Opening balance for Cash — JPY amounts don’t have decimal places.',
    );
    // …and following the base currency does the same
    const following = withBalances(rows(), ['', '', '', '500.25']);
    expect(accountsStepError(following, 'JPY')).toMatch(/JPY amounts don’t have decimal places\./);
  });

  it('lets blanks and valid amounts through', () => {
    expect(accountsStepError(withBalances(rows(), ['', '0', '-99.99', '1,000']), 'GBP')).toBe(null);
  });

  it('validates nothing when the device already has accounts (this step creates none)', () => {
    const broken = withBalances(rows(), ['12.345', '', '', '']);
    expect(accountsStepError(broken, 'GBP', { hasExistingAccounts: true })).toBe(null);
    expect(
      accountsStepError(
        rows().map((r) => ({ ...r, ticked: false })),
        'GBP',
        { hasExistingAccounts: true },
      ),
    ).toBe(null);
  });
});

describe('buildAccounts', () => {
  it('turns typed text into minor units, blank into zero', () => {
    const built = buildAccounts(withBalances(freshRows(), ['1200.50', '', '-250.25', '20']), 'GBP');
    expect(built.map((a) => a.openingBalanceMinor)).toEqual([120050, 0, -25025, 2000]);
    expect(built.every((a) => a.currency === 'GBP')).toBe(true);
  });

  it('refuses to store an unreadable balance as zero', () => {
    expect(() => buildAccounts(withBalances(freshRows(), ['12.345', '', '', '']), 'GBP')).toThrow(
      'Opening balance for Current Account — GBP amounts have at most 2 decimal places.',
    );
    expect(() => buildAccounts(withBalances(freshRows(), ['1e6', '', '', '']), 'GBP')).toThrow(
      /isn’t an amount/,
    );
  });

  it('ignores unticked rows entirely, however broken', () => {
    const rows = withBalances(freshRows(), ['12.345', '5000', '', '']).map((r, i) =>
      i === 0 ? { ...r, ticked: false } : r,
    );
    const built = buildAccounts(rows, 'GBP');
    expect(built).toHaveLength(3);
    expect(built[0].openingBalanceMinor).toBe(500000);
  });
});

// ---------------------------------------------------------------------------
// B3 — the restore path still has to ask for durable storage (SPEC §9)
// ---------------------------------------------------------------------------
describe('completeRestore', () => {
  it('requests persistent storage and lands on the dashboard', () => {
    const persist = vi.fn(async () => 'persisted');
    const go = vi.fn();
    completeRestore(persist, go);
    expect(persist).toHaveBeenCalledTimes(1);
    expect(go).toHaveBeenCalledWith('/dashboard');
  });

  it('does not wait on the persistence request before navigating', () => {
    const go = vi.fn();
    completeRestore(() => new Promise(() => {}), go); // never resolves
    expect(go).toHaveBeenCalledWith('/dashboard');
  });
});

// ---------------------------------------------------------------------------
// B3/B4 — component wiring. No DOM in this suite, so these read the source and
// pin the two props whose absence is invisible until a user is stuck.
// ---------------------------------------------------------------------------
describe('Onboarding wiring', () => {
  const src = readFileSync(new URL('../src/ui/pages/Onboarding.tsx', import.meta.url), 'utf8');

  /** The single JSX element for `tag`, comments stripped. */
  const element = (tag: string): string => {
    const match = new RegExp(`<${tag}[\\s\\S]*?/>`).exec(src);
    if (!match) throw new Error(`<${tag}> is not rendered by Onboarding at all`);
    return match[0].replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  };

  it('renders the restore screen standalone, so it has a heading and a Back button', () => {
    // Without `standalone`, RestoreFromBackup renders neither — the user
    // reaches this screen and can only leave it by reloading the app.
    expect(element('RestoreFromBackup')).toMatch(/\sstandalone(\s|=|\/|>)/);
    expect(element('RestoreFromBackup')).toMatch(/onCancel=/);
  });

  it('asks for persistent storage when a restore finishes', () => {
    expect(element('RestoreFromBackup')).toMatch(/completeRestore\(/);
  });

  it('treats Cancel in the import wizard as Back, not as "finish onboarding"', () => {
    const wizard = element('ImportWizard');
    expect(wizard).toMatch(/onCancel=\{\(\)\s*=>\s*setImporting\(false\)\}/);
    expect(wizard).not.toMatch(/onCancel=\{\(\)\s*=>\s*void finish\(/);
  });
});
