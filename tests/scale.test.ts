// SPEC §9 — "smooth with 50,000–100,000 transactions".
//
// These tests assert the SHAPE of the work, never wall-clock timings (which
// say more about the machine than the code): that the hot paths narrow inside
// a Dexie index instead of reading the whole transactions table, that a single
// id uses `.equals()` rather than `.anyOf()`, and that balances + net worth
// cost one pass over the table rather than two or three.
//
// The dataset deliberately crosses balances' SCAN_BATCH boundary, so a paging
// bug that double-counted or skipped a batch would show up as a wrong balance.
import 'fake-indexeddb/auto';
import dayjs from 'dayjs';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { db } from '../src/db/db';
import type { Account, Payee, Tag, Transaction } from '../src/db/types';
import {
  SCAN_BATCH,
  accountBalances,
  balanceSnapshot,
  netWorth,
} from '../src/domain/balances';
import { queryTransactions, type TxFilter } from '../src/domain/transactions';
import { todayISO } from '../src/lib/util';
import {
  DEFAULT_RANGE_DAYS,
  countActiveFilters,
  defaultRegisterRange,
  emptyFilters,
  hasAnyFilter,
  hasNonDateFilter,
  isDefaultRange,
  isSaveableAmount,
  rangeSummary,
  toTxFilter,
  txSaveDisabled,
} from '../src/ui/tx/txShared';

// One row past a batch boundary: batch 1 fills, batch 2 is the short tail.
const ROWS = SCAN_BATCH + 7;
const TODAY = todayISO();

const ACCOUNTS: Account[] = ['a-current', 'a-savings', 'a-card'].map((id, i) => ({
  id,
  name: `Account ${i}`,
  type: 'current',
  currency: 'GBP',
  openingBalanceMinor: 100_000 * (i + 1),
  colour: '#123456',
  groupId: null,
  sortOrder: i,
  archived: false,
}));

const PAYEES: Payee[] = ['p0', 'p1', 'p2', 'p3'].map((id, i) => ({
  id,
  name: `Payee ${i}`,
  nameLower: `payee ${i}`,
  defaultCategoryId: null,
}));

const TAGS: Tag[] = ['t0', 't1'].map((id, i) => ({
  id,
  name: `Tag ${i}`,
  nameLower: `tag ${i}`,
}));

/** Deterministic ledger — sequential ids so batch boundaries are reproducible. */
function seedRows(): Transaction[] {
  const rows: Transaction[] = [];
  for (let i = 0; i < ROWS; i++) {
    // ~2 years of history, so only a slice falls inside the default window.
    const date = dayjs(TODAY).subtract(i % 700, 'day').format('YYYY-MM-DD');
    rows.push({
      id: `tx-${String(i).padStart(6, '0')}`,
      accountId: ACCOUNTS[i % ACCOUNTS.length]!.id,
      date,
      amountMinor: (i % 7 === 0 ? 1 : -1) * (100 + i),
      currency: 'GBP',
      payeeId: PAYEES[i % PAYEES.length]!.id,
      categoryId: null,
      tagIds: i % 3 === 0 ? [TAGS[0]!.id] : i % 3 === 1 ? [TAGS[1]!.id] : [],
      notes: '',
      status: i % 5 === 0 ? 'pending' : 'cleared',
      splits: [],
      transferGroupId: null,
      importBatchId: null,
      dedupeHash: `h-${i}`,
      createdAt: `2020-01-01T00:00:${String(i % 60).padStart(2, '0')}.000Z`,
      updatedAt: '2020-01-01T00:00:00.000Z',
    });
  }
  return rows;
}

const ROWS_IN_MEMORY = seedRows();

beforeAll(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
  await db.accounts.bulkAdd(ACCOUNTS);
  await db.payees.bulkAdd(PAYEES);
  await db.tags.bulkAdd(TAGS);
  await db.transactions.bulkAdd(ROWS_IN_MEMORY);
}, 120_000);

afterEach(() => vi.restoreAllMocks());
afterAll(async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
});

// ---------------------------------------------------------------- spies
/**
 * Records which index+method combinations a query used, e.g. `date.between`
 * or `accountId.equals`. The WhereClause is proxied rather than replaced, so
 * the real query still runs and the results stay assertable.
 */
function trackWhere() {
  const calls: string[] = [];
  const table = db.transactions as unknown as {
    where: (index: string) => Record<string, unknown>;
  };
  const original = table.where.bind(table);
  const tracked = ['equals', 'anyOf', 'between', 'above', 'aboveOrEqual', 'startsWith'];
  vi.spyOn(table, 'where').mockImplementation((index: string) => {
    const clause = original(index);
    return new Proxy(clause, {
      get(target, prop) {
        if (typeof prop === 'string' && tracked.includes(prop)) calls.push(`${index}.${prop}`);
        const value = (target as Record<string | symbol, unknown>)[prop];
        return typeof value === 'function' ? (value as (...a: unknown[]) => unknown).bind(target) : value;
      },
    });
  });
  return calls;
}

/** Counts full reads of the transactions table (`Table.toArray`, i.e. getAll). */
function trackWholeTableReads() {
  return vi.spyOn(db.transactions, 'toArray');
}

/**
 * Counts full passes over the transactions table, whatever mechanism does the
 * reading: a batched scan opens with `orderBy('id')`, a naive one calls
 * `Table.toArray()`. Either way, one pass = one count.
 */
function trackScans() {
  const orderBy = vi.spyOn(db.transactions, 'orderBy');
  const toArray = vi.spyOn(db.transactions, 'toArray');
  return {
    get count(): number {
      return (
        orderBy.mock.calls.filter((c) => c[0] === 'id').length + toArray.mock.calls.length
      );
    },
  };
}

// ------------------------------------------------------- D1: default window
describe('the register opens on a date window (D1)', () => {
  it('emptyFilters() carries the default window and reads as unfiltered', () => {
    const f = emptyFilters();
    expect(f.range).toEqual(defaultRegisterRange());
    expect(isDefaultRange(f.range)).toBe(true);
    // The window is the resting state, not a filter the user switched on —
    // it must not light up the filter badge or the "clear all" button.
    expect(countActiveFilters(f)).toBe(0);
    expect(hasAnyFilter(f)).toBe(false);
    expect(hasNonDateFilter(f)).toBe(false);
  });

  it('is open-ended at the top so a future-dated row is never hidden', () => {
    const range = defaultRegisterRange('2026-08-26');
    expect(range).toEqual({ from: '2026-05-29', to: '' });
    expect(dayjs(range.to || '9999-12-31').isAfter('2026-08-26')).toBe(true);
  });

  it('states the window in words, and never says "all" while one is set', () => {
    expect(rangeSummary(defaultRegisterRange('2026-08-26'), '2026-08-26')).toBe(
      `the last ${DEFAULT_RANGE_DAYS} days (since 29/05/2026)`,
    );
    expect(rangeSummary({ from: '2026-03-01', to: '2026-03-31' })).toBe('01/03/2026 – 31/03/2026');
    expect(rangeSummary(null)).toBe('all dates');
  });

  it('turns into an indexed date range, never a whole-table read', async () => {
    const filter = toTxFilter(emptyFilters());
    expect(filter.dateFrom).toBe(defaultRegisterRange().from);
    expect(filter.dateTo).toBeUndefined();

    const whole = trackWholeTableReads();
    const where = trackWhere();
    const rows = await queryTransactions(filter);

    expect(where).toContain('date.between');
    expect(whole).not.toHaveBeenCalled();
    // …and it is genuinely a slice of the ledger, not the whole thing.
    const expected = ROWS_IN_MEMORY.filter((t) => t.date >= filter.dateFrom!);
    expect(rows).toHaveLength(expected.length);
    expect(rows.length).toBeLessThan(ROWS / 3);
  });

  it('still reads everything when the user explicitly widens to all dates', async () => {
    const whole = trackWholeTableReads();
    const rows = await queryTransactions(toTxFilter({ ...emptyFilters(), range: null }));
    // The escape hatch costs a full scan — that is exactly why it is opt-in.
    expect(whole).toHaveBeenCalledTimes(1);
    expect(rows).toHaveLength(ROWS);
  });

  it('lets a deep link with its own range replace the default', () => {
    const deepLinked = { ...emptyFilters(), range: { from: '2025-01-01', to: '2025-01-31' } };
    const filter = toTxFilter(deepLinked);
    expect(filter).toMatchObject({ dateFrom: '2025-01-01', dateTo: '2025-01-31' });
    expect(isDefaultRange(deepLinked.range)).toBe(false);
    expect(countActiveFilters(deepLinked)).toBe(1); // a chosen range DOES count
  });
});

// -------------------------------------------------- D2: single-id index path
describe('single-id filters use .equals(), not .anyOf() (D2)', () => {
  const sorted = (rows: Transaction[]) => rows.map((r) => r.id).sort();

  it('one account takes the accountId index with equals', async () => {
    const where = trackWhere();
    const rows = await queryTransactions({ accountIds: ['a-card'] });
    expect(where).toContain('accountId.equals');
    expect(where).not.toContain('accountId.anyOf');
    expect(sorted(rows)).toEqual(
      sorted(ROWS_IN_MEMORY.filter((t) => t.accountId === 'a-card')),
    );
  });

  it('several accounts still use anyOf, with identical results', async () => {
    const where = trackWhere();
    const rows = await queryTransactions({ accountIds: ['a-card', 'a-savings'] });
    expect(where).toContain('accountId.anyOf');
    expect(sorted(rows)).toEqual(
      sorted(ROWS_IN_MEMORY.filter((t) => t.accountId !== 'a-current')),
    );
  });

  it('one account plus the default window is ONE compound range', async () => {
    const where = trackWhere();
    const filter: TxFilter = { ...toTxFilter(emptyFilters()), accountIds: ['a-current'] };
    const rows = await queryTransactions(filter);
    expect(where.filter((c) => c === '[accountId+date].between')).toHaveLength(1);
    expect(
      rows.every((t) => t.accountId === 'a-current' && t.date >= filter.dateFrom!),
    ).toBe(true);
  });

  it('one payee takes the payeeId index with equals', async () => {
    const where = trackWhere();
    const rows = await queryTransactions({ payeeIds: ['p2'] });
    expect(where).toContain('payeeId.equals');
    expect(where).not.toContain('payeeId.anyOf');
    expect(sorted(rows)).toEqual(sorted(ROWS_IN_MEMORY.filter((t) => t.payeeId === 'p2')));
  });

  it('one tag takes the tagIds multiEntry index with equals, still distinct', async () => {
    const where = trackWhere();
    const rows = await queryTransactions({ tagIds: ['t1'] });
    expect(where).toContain('tagIds.equals');
    expect(where).not.toContain('tagIds.anyOf');
    const expected = ROWS_IN_MEMORY.filter((t) => t.tagIds.includes('t1'));
    expect(sorted(rows)).toEqual(sorted(expected));
    expect(new Set(rows.map((r) => r.id)).size).toBe(rows.length);
  });

  it('two tags still use anyOf', async () => {
    const where = trackWhere();
    const rows = await queryTransactions({ tagIds: ['t0', 't1'] });
    expect(where).toContain('tagIds.anyOf');
    expect(sorted(rows)).toEqual(
      sorted(ROWS_IN_MEMORY.filter((t) => t.tagIds.length > 0)),
    );
  });
});

// --------------------------------------------------------- D3: balances cost
describe('balances stream the table instead of materialising it (D3)', () => {
  /** Ground truth, computed straight from the seed array. */
  const expected = (accountId: string) => {
    const mine = ROWS_IN_MEMORY.filter((t) => t.accountId === accountId);
    const opening = ACCOUNTS.find((a) => a.id === accountId)!.openingBalanceMinor;
    return {
      balanceMinor: mine.reduce((s, t) => s + t.amountMinor, opening),
      clearedMinor: mine
        .filter((t) => t.status === 'cleared')
        .reduce((s, t) => s + t.amountMinor, opening),
      txCount: mine.length,
    };
  };

  it('never pulls the whole transactions table into an array', async () => {
    const whole = trackWholeTableReads();
    await accountBalances();
    expect(whole).not.toHaveBeenCalled();
  });

  it('pages by primary key and totals every row exactly once across batches', async () => {
    expect(ROWS).toBeGreaterThan(SCAN_BATCH); // the boundary is really crossed
    const where = trackWhere();
    const balances = await accountBalances();

    // Batch 1 opens with orderBy('id'); later batches resume with above().
    expect(where.filter((c) => c === 'id.above').length).toBeGreaterThanOrEqual(1);
    expect(balances.reduce((s, b) => s + b.txCount, 0)).toBe(ROWS);
    for (const b of balances) {
      expect({
        balanceMinor: b.balanceMinor,
        clearedMinor: b.clearedMinor,
        txCount: b.txCount,
      }).toEqual(expected(b.account.id));
    }
  });

  it('does not re-read the table to derive net worth from balances', async () => {
    const scans = trackScans();
    const balances = await accountBalances();
    expect(scans.count).toBe(1);

    await netWorth(balances);
    expect(scans.count).toBe(1); // still one — nothing re-read
  });

  it('balanceSnapshot() costs ONE pass where two subscriptions cost two', async () => {
    const separate = trackScans();
    await accountBalances();
    await netWorth();
    expect(separate.count).toBe(2); // what the sidebar's two subscriptions cost
    vi.restoreAllMocks();

    const together = trackScans();
    const snap = await balanceSnapshot();
    expect(together.count).toBe(1);

    expect(snap.balances.map((b) => b.balanceMinor)).toEqual(
      (await accountBalances()).map((b) => b.balanceMinor),
    );
    expect(snap.netWorth).toEqual(await netWorth(snap.balances));
  });

  it('net worth still equals the sum of unarchived balances', async () => {
    const { balances, netWorth: nw } = await balanceSnapshot();
    const sum = balances
      .filter((b) => !b.account.archived)
      .reduce((s, b) => s + b.balanceMinor, 0);
    expect(nw.totalBaseMinor).toBe(sum);
    expect(nw.missingRateCurrencies).toEqual([]);
  });
});

// ------------------------------------------------------- D4: zero amounts
describe('both entry points refuse a zero amount (D4)', () => {
  it('isSaveableAmount rejects empty AND zero', () => {
    expect(isSaveableAmount(null)).toBe(false);
    expect(isSaveableAmount(0)).toBe(false);
    expect(isSaveableAmount(1)).toBe(true);
    expect(isSaveableAmount(-1)).toBe(true); // domain explains the sign problem
    expect(isSaveableAmount(1.5)).toBe(false); // minor units are integers
  });

  const gate = (over: Partial<Parameters<typeof txSaveDisabled>[0]> = {}) =>
    txSaveDisabled({
      mode: 'expense',
      saving: false,
      amountMinor: 1000,
      accountId: 'a-current',
      splitCount: 0,
      splitIssue: null,
      transfer: {
        hasFromAccount: true,
        hasToAccount: true,
        amountFromMinor: 1000,
        amountToMinor: 1000,
        crossCurrency: false,
      },
      ...over,
    });

  it('disables Save on a typed zero, exactly as Quick Add refuses it', () => {
    expect(gate()).toBe(false);
    expect(gate({ amountMinor: 0 })).toBe(true);
    expect(gate({ amountMinor: null })).toBe(true);
  });

  it('keeps the existing gates intact', () => {
    expect(gate({ saving: true })).toBe(true);
    expect(gate({ accountId: '' })).toBe(true);
    expect(gate({ splitCount: 2, splitIssue: 'Splits must add up' })).toBe(true);
    expect(gate({ splitCount: 2, splitIssue: null })).toBe(false);
  });

  it('applies the same rule to both legs of a transfer', () => {
    expect(gate({ mode: 'transfer' })).toBe(false);
    expect(gate({ mode: 'transfer', transfer: { ...t(), amountFromMinor: 0 } })).toBe(true);
    expect(gate({ mode: 'transfer', transfer: { ...t(), hasToAccount: false } })).toBe(true);
    // The receiving amount only matters when the currencies differ.
    expect(gate({ mode: 'transfer', transfer: { ...t(), amountToMinor: 0 } })).toBe(false);
    expect(
      gate({
        mode: 'transfer',
        transfer: { ...t(), amountToMinor: 0, crossCurrency: true },
      }),
    ).toBe(true);
  });

  function t() {
    return {
      hasFromAccount: true,
      hasToAccount: true,
      amountFromMinor: 1000,
      amountToMinor: 1000,
      crossCurrency: false,
    };
  }
});
