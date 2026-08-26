// Transaction register (SPEC §8.1.2): virtualised list with instant search
// and combinable filters; honours deep links (?account/?category/?payee/?tag/
// ?from/?to) and reacts when they change while on the page.
//
// SCALE (SPEC §9): the register opens on a date window (see
// `defaultRegisterRange`) so `queryTransactions` narrows on the `date` index
// instead of reading and sorting the whole table on every keystroke and every
// write. The window is stated in the summary line with a one-click widen — it
// is a visible default, not a hidden filter — and a deep link carrying its own
// ?from/?to replaces it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import type { Transaction } from '../../db/types';
import { queryTransactions } from '../../domain/transactions';
import { cn } from '../../lib/util';
import { navigate, useRoute } from '../router';
import { Amount, Button, EmptyState, Input } from '../kit/kit';
import { IconFilter, IconList, IconPlus, IconSearch } from '../kit/icons';
import { FilterBar } from '../tx/FilterBar';
import { TxRow } from '../tx/TxRow';
import TxEditor from '../tx/TxEditor';
import {
  DEFAULT_RANGE_DAYS,
  REGISTER_GRID,
  countActiveFilters,
  defaultRegisterRange,
  emptyFilters,
  hasAnyFilter,
  hasNonDateFilter,
  rangeSummary,
  sumByCurrency,
  toTxFilter,
  type FilterState,
} from '../tx/txShared';

export default function Transactions() {
  const route = useRoute();
  const [filters, setFilters] = useState<FilterState>(emptyFilters);
  const [searchText, setSearchText] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  const [editor, setEditor] = useState<{ open: boolean; tx: Transaction | null }>({
    open: false,
    tx: null,
  });

  // ----------------------------------------------------------- live data
  const accounts = useLive(() => db.accounts.toArray(), []);
  const categories = useLive(() => db.categories.toArray(), []);
  const payees = useLive(() => db.payees.toArray(), []);
  const tags = useLive(() => db.tags.toArray(), []);
  const settings = useLive(() => getSettings(), []);
  const totalCount = useLive(() => db.transactions.count(), []);
  // All transfer legs (transferGroupId is indexed; nulls are never in the
  // index, so this returns only actual legs) — used to label "Transfer to X"
  // even when the other leg is filtered out of the visible rows.
  const transferLegs = useLive(() => db.transactions.orderBy('transferGroupId').toArray(), []);

  const txFilter = useMemo(() => toTxFilter(filters), [filters]);
  const filterKey = useMemo(() => JSON.stringify(txFilter), [txFilter]);
  const rows = useLive(() => queryTransactions(txFilter), [filterKey]);

  const accountsById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const categoriesById = useMemo(
    () => new Map((categories ?? []).map((c) => [c.id, c])),
    [categories],
  );
  const payeesById = useMemo(() => new Map((payees ?? []).map((p) => [p.id, p])), [payees]);
  const tagsById = useMemo(() => new Map((tags ?? []).map((t) => [t.id, t])), [tags]);
  const sortedAccounts = useMemo(
    () =>
      [...(accounts ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [accounts],
  );

  /** legId → the OTHER leg's account name. */
  const otherLegAccountName = useMemo(() => {
    const byGroup = new Map<string, Transaction[]>();
    for (const leg of transferLegs ?? []) {
      if (leg.transferGroupId === null) continue;
      const list = byGroup.get(leg.transferGroupId) ?? [];
      list.push(leg);
      byGroup.set(leg.transferGroupId, list);
    }
    const out = new Map<string, string>();
    for (const legs of byGroup.values()) {
      if (legs.length !== 2) continue;
      const [a, b] = legs as [Transaction, Transaction];
      const nameOf = (t: Transaction) => accountsById.get(t.accountId)?.name ?? 'another account';
      out.set(a.id, nameOf(b));
      out.set(b.id, nameOf(a));
    }
    return out;
  }, [transferLegs, accountsById]);

  // ----------------------------------------------------------- search debounce
  useEffect(() => {
    const t = window.setTimeout(() => {
      setFilters((f) => (f.text === searchText ? f : { ...f, text: searchText }));
    }, 150);
    return () => window.clearTimeout(t);
  }, [searchText]);

  // ----------------------------------------------------------- deep links
  const paramsKey = route.params.toString();
  useEffect(() => {
    const p = new URLSearchParams(paramsKey);
    const patch: Partial<FilterState> = {};
    const account = p.get('account');
    if (account) patch.accountId = account;
    const category = p.get('category');
    if (category) patch.categoryId = category;
    const tag = p.get('tag');
    if (tag) patch.tagId = tag;
    const from = p.get('from');
    const to = p.get('to');
    if (from || to) patch.range = { from: from ?? '', to: to ?? '' };
    if (Object.keys(patch).length > 0) setFilters((f) => ({ ...f, ...patch }));
    const payeeId = p.get('payee');
    if (payeeId) {
      let cancelled = false;
      void db.payees.get(payeeId).then((pp) => {
        if (cancelled) return;
        setFilters((f) => ({ ...f, payeeId, payeeText: pp?.name ?? f.payeeText }));
      });
      return () => {
        cancelled = true;
      };
    }
  }, [paramsKey]);

  const clearAll = () => {
    setFilters(emptyFilters());
    setSearchText('');
    if (paramsKey) navigate('/transactions');
  };

  // Manual filter edits strip any deep-link params from the URL so that a
  // later navigation to the SAME params (e.g. re-clicking a sidebar account)
  // still fires a hashchange and re-applies the filter.
  const patchFilters = (patch: Partial<FilterState>) => {
    setFilters((f) => ({ ...f, ...patch }));
    if (paramsKey) navigate('/transactions');
  };

  // The visible escape hatch from the default window, and the way back.
  const toggleAllDates = () =>
    patchFilters({ range: filters.range ? null : defaultRegisterRange() });

  // ----------------------------------------------------------- virtual list
  const data = rows ?? [];
  const listRef = useRef<HTMLDivElement>(null);
  const virtualizer = useVirtualizer({
    count: data.length,
    getScrollElement: () => listRef.current,
    estimateSize: () => 56,
    overscan: 12,
    getItemKey: (i) => data[i]!.id,
  });

  const totals = useMemo(() => sumByCurrency(data), [data]);
  const activeCount = countActiveFilters(filters);
  // An empty list caused by the date window alone gets a different story from
  // one caused by the filters — the two must never be confused.
  const emptyByDateOnly = !!filters.range && !hasNonDateFilter(filters);
  const anyActive = hasAnyFilter(filters) || searchText.trim() !== '';
  const openEditor = (tx: Transaction | null) => setEditor({ open: true, tx });

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 lg:p-6">
      <header className="flex items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <Button variant="primary" size="sm" onClick={() => openEditor(null)}>
          <IconPlus size={16} />
          Add
        </Button>
      </header>

      {/* Search + mobile filters disclosure */}
      <div className="flex items-center gap-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch
            size={16}
            className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
          />
          <Input
            aria-label="Search transactions"
            placeholder="Search payee, notes, category…"
            className="pl-9"
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
          />
        </div>
        <Button aria-expanded={filtersExpanded} onClick={() => setFiltersExpanded((v) => !v)}>
          <IconFilter size={16} />
          Filters
          {activeCount > 0 && (
            <span className="rounded-full bg-accent px-1.5 text-xs font-semibold text-on-accent">
              {activeCount}
            </span>
          )}
        </Button>
      </div>

      <FilterBar
        value={filters}
        onPatch={patchFilters}
        accounts={sortedAccounts}
        tags={tags ?? []}
        baseCurrency={settings?.baseCurrency ?? 'GBP'}
        expanded={filtersExpanded}
        anyActive={anyActive}
        onClearAll={clearAll}
      />

      {/* Summary line: count + per-currency net totals (no conversion) + the
          date window the register is on, which is never left implicit. */}
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted">
        <span>
          {rows === undefined
            ? 'Loading…'
            : `${data.length.toLocaleString('en-GB')} transaction${data.length === 1 ? '' : 's'}`}
        </span>
        {totals.map(([cur, minor]) => (
          <span key={cur} className="inline-flex items-center gap-1">
            Net <Amount minor={minor} currency={cur} signColour />
          </span>
        ))}
        <span className="inline-flex items-center gap-1.5">
          <span>
            Showing <span className="font-medium text-text">{rangeSummary(filters.range)}</span>
          </span>
          <button
            type="button"
            onClick={toggleAllDates}
            className="cursor-pointer rounded-full border border-border px-2 py-0.5 font-medium text-accent transition-colors hover:bg-surface2"
          >
            {filters.range ? 'Show all dates' : `Back to last ${DEFAULT_RANGE_DAYS} days`}
          </button>
        </span>
      </div>

      {/* Register */}
      <div
        ref={listRef}
        className="min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-xl border border-border bg-surface"
      >
        <div
          className={cn(
            'sticky top-0 z-10 hidden border-b border-border bg-surface px-4 py-2 text-xs font-semibold uppercase tracking-wide text-faint lg:grid lg:gap-3',
            REGISTER_GRID,
          )}
          aria-hidden="true"
        >
          <span>Date</span>
          <span>Payee</span>
          <span>Category</span>
          <span>Account</span>
          <span>Tags</span>
          <span className="text-right">Amount</span>
        </div>

        {totalCount === 0 ? (
          <EmptyState
            icon={<IconList size={40} />}
            title="No transactions yet"
            message="Add your first transaction, or import your history from Settings."
            action={
              <Button variant="primary" onClick={() => openEditor(null)}>
                <IconPlus size={16} />
                Add transaction
              </Button>
            }
          />
        ) : rows !== undefined && data.length === 0 ? (
          // An empty list must never read as "you have no transactions" when it
          // only means "none in this window" — say which, and say how many there
          // really are.
          <EmptyState
            icon={<IconSearch size={40} />}
            title={
              emptyByDateOnly
                ? `Nothing in ${rangeSummary(filters.range)}`
                : 'Nothing matches your filters'
            }
            message={
              <>
                You have {(totalCount ?? 0).toLocaleString('en-GB')} transaction
                {totalCount === 1 ? '' : 's'} in total
                {emptyByDateOnly
                  ? ' — none of them in this date window.'
                  : '. Try widening the date window or clearing a filter.'}
              </>
            }
            action={
              <div className="flex flex-wrap items-center justify-center gap-2">
                {filters.range && (
                  <Button variant="primary" onClick={toggleAllDates}>
                    Show all dates
                  </Button>
                )}
                <Button onClick={clearAll} disabled={!anyActive}>
                  Clear all filters
                </Button>
              </div>
            }
          />
        ) : (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((vi) => {
              const t = data[vi.index]!;
              return (
                <div
                  key={vi.key}
                  data-index={vi.index}
                  ref={virtualizer.measureElement}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${vi.start}px)`,
                  }}
                >
                  <TxRow
                    tx={t}
                    accountsById={accountsById}
                    categoriesById={categoriesById}
                    payeesById={payeesById}
                    tagsById={tagsById}
                    otherAccountName={
                      t.transferGroupId !== null ? (otherLegAccountName.get(t.id) ?? null) : null
                    }
                    onOpen={openEditor}
                  />
                </div>
              );
            })}
          </div>
        )}
      </div>

      <TxEditor
        open={editor.open}
        tx={editor.tx}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
      />
    </div>
  );
}
