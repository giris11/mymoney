// Transaction register (SPEC §8.1.2): virtualised list with instant search
// and combinable filters.
//
// THE FILTERS LIVE IN THE URL, NOT IN useState. `filtersFromParams(route)` is
// the single source of truth for what the register is showing, and every
// filter change is a navigation (see `applyFilters`). That is what makes a
// narrowed register a real place: the browser's Back button returns to the
// previous view instead of skipping past it to the previous PAGE, and the
// filtered view can be reloaded, bookmarked and shared. The deep links other
// pages use (?account/?category/?payee/?tag/?from/?to — docs/CONTRACTS.md)
// stop being a special case: they are simply this state, written down.
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
import type { Payee, Transaction } from '../../db/types';
import { getTransferPair, queryTransactions } from '../../domain/transactions';
import { cn, todayISO } from '../../lib/util';
import { goBack, navigate, useCanGoBack, useRoute } from '../router';
import { Amount, Button, EmptyState, Input } from '../kit/kit';
import { useToast } from '../kit/toast';
import { IconChevronLeft, IconFilter, IconList, IconPlus, IconSearch } from '../kit/icons';
import { FilterBar } from '../tx/FilterBar';
import { TxRow } from '../tx/TxRow';
import TxEditor from '../tx/TxEditor';
import {
  copyCategoryId,
  duplicateContextFrom,
  duplicateDraftFrom,
  type TxDraft,
} from '../tx/duplicate';
import {
  DEFAULT_RANGE_DAYS,
  REGISTER_ACTION_COL,
  REGISTER_GRID,
  countActiveFilters,
  defaultRegisterRange,
  emptyFilters,
  filtersFromParams,
  filtersToPath,
  hasAnyFilter,
  hasNonDateFilter,
  rangeSummary,
  sumByCurrency,
  toTxFilter,
  type FilterState,
} from '../tx/txShared';

export default function Transactions() {
  const route = useRoute();
  const canGoBack = useCanGoBack();
  // The URL, parsed. Derived — never assigned to — so the UI and the address
  // bar cannot drift apart, whether the change came from a control on this
  // page, a deep link from the sidebar, or the browser's Back button.
  const paramsKey = route.params.toString();
  const filters = useMemo(() => filtersFromParams(new URLSearchParams(paramsKey)), [paramsKey]);
  // Two pieces of *display* state that narrow nothing and so stay out of the
  // URL: the raw search box (the URL gets the debounced value) and the payee
  // combobox's text (the URL gets the picked payee's id).
  const [searchText, setSearchText] = useState(() => filters.text);
  const [payeeText, setPayeeText] = useState('');
  const [filtersExpanded, setFiltersExpanded] = useState(false);
  // `tx` = the transaction being edited; `draft` = a prefilled CREATE (a
  // duplicate). They are never both set: a copy is a new transaction.
  const [editor, setEditor] = useState<{
    open: boolean;
    tx: Transaction | null;
    draft: TxDraft | null;
  }>({ open: false, tx: null, draft: null });
  const { toast } = useToast();

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

  // ------------------------------------------------- writing filters to the URL
  /**
   * PUSH vs REPLACE. Every filter change is a navigation, so this choice is
   * the difference between a Back button that works and one that is useless:
   *
   *  - PUSH for a discrete choice — an account, a category, a payee, a tag, a
   *    status, a date preset, Clear-all. One deliberate act, one entry, one
   *    Back step to undo it.
   *  - REPLACE for anything that fires as you type — the debounced search box
   *    and the amount boxes. Typing "tesco" is ONE act; six entries would bury
   *    the view the user actually wants to get back to under six Backs.
   *
   * (The register is not remounted by any of this: it is the same component
   * with new props derived from the new URL.)
   */
  const applyFilters = (next: FilterState, mode: 'push' | 'replace' = 'push') =>
    navigate(filtersToPath(next), { replace: mode === 'replace' });

  const patchFilters = (patch: Partial<FilterState>) => applyFilters({ ...filters, ...patch });
  const patchFiltersWhileTyping = (patch: Partial<FilterState>) =>
    applyFilters({ ...filters, ...patch }, 'replace');

  // --------------------------------------------------------- search box <-> URL
  /**
   * Two effects push data in opposite directions, so they need a guard or they
   * ping-pong: the box writes the URL (debounced), and the URL writes the box.
   * The guard is `lastPushedText` — the last value THIS page put in the URL.
   * A URL value equal to it is our own write coming back (ignore it); anything
   * else came from Back/Forward or a deep link (adopt it). Comparing against
   * the live input instead would also stop the loop, but it would clobber
   * whatever the user typed in the 150ms since.
   */
  const lastPushedText = useRef(filters.text);

  useEffect(() => {
    if (searchText === lastPushedText.current) return;
    const t = window.setTimeout(() => {
      lastPushedText.current = searchText;
      applyFilters({ ...filters, text: searchText }, 'replace');
    }, 150);
    return () => window.clearTimeout(t);
  }, [searchText, filters]);

  useEffect(() => {
    if (filters.text === lastPushedText.current) return;
    lastPushedText.current = filters.text;
    setSearchText(filters.text);
  }, [filters.text]);

  // --------------------------------------------------------- payee box <-> URL
  // The URL carries the payee's id; the box shows its name, which has to be
  // read from the db. Same shape of guard as the search box: `payeeLocal`
  // remembers the pairing this page already knows about, so a name the user is
  // typing is never overwritten by a lookup for the payee they just cleared.
  const payeeLocal = useRef<{ id: string | null; text: string }>({ id: null, text: '' });
  useEffect(() => {
    const id = filters.payeeId;
    if (id === payeeLocal.current.id) return;
    if (!id) {
      payeeLocal.current = { id: null, text: '' };
      setPayeeText('');
      return;
    }
    let cancelled = false;
    void db.payees.get(id).then((pp) => {
      if (cancelled) return;
      const text = pp?.name ?? '';
      payeeLocal.current = { id, text };
      setPayeeText(text);
    });
    return () => {
      cancelled = true;
    };
  }, [filters.payeeId]);

  // Free typing in the payee box selects nothing, so it changes no results and
  // writes no history — but it does drop a payee that WAS picked, and that
  // does widen the list, so that part is a normal discrete change.
  const onPayeeText = (text: string) => {
    payeeLocal.current = { id: null, text };
    setPayeeText(text);
    if (filters.payeeId !== null) patchFilters({ payeeId: null });
  };
  const onPayeePick = (pp: Payee) => {
    payeeLocal.current = { id: pp.id, text: pp.name };
    setPayeeText(pp.name);
    patchFilters({ payeeId: pp.id });
  };

  const clearAll = () => {
    lastPushedText.current = '';
    setSearchText('');
    payeeLocal.current = { id: null, text: '' };
    setPayeeText('');
    applyFilters(emptyFilters());
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
  const openEditor = (tx: Transaction | null) => setEditor({ open: true, tx, draft: null });

  /**
   * "Same thing again": open the editor on a prefilled COPY of `tx` (SPEC §4 —
   * repeat spending should not be re-typed). Reachable from every row and from
   * the editor's own footer; both land here.
   *
   * A transfer leg copies as a whole pair, so the editor saves a new pair
   * through saveTransfer rather than leaving an orphan leg behind. The copy is
   * always dated today and says so — see `TxDraft.sourceDate`.
   */
  const startDuplicate = async (tx: Transaction) => {
    let pair: [Transaction, Transaction] | null = null;
    if (tx.transferGroupId !== null) {
      pair = await getTransferPair(tx.transferGroupId);
      if (!pair) {
        toast('Could not copy this transfer — its legs are missing', 'error');
        return;
      }
    }
    let ctx = duplicateContextFrom(tx, { payeesById, tagsById, categoriesById }, pair);
    // Those maps hold what the row is displaying, so they are normally
    // complete. If one of them has not loaded yet, re-resolve from the db
    // rather than let the copy silently lose a payee, a tag, or the
    // income-vs-refund cue the category carries.
    const incomplete =
      ctx.tagNames.length !== tx.tagIds.length ||
      (tx.payeeId !== null && ctx.payeeName === '') ||
      (copyCategoryId(tx) !== null && ctx.categoryKind === null);
    if (incomplete) {
      const [ps, ts, cs] = await Promise.all([
        db.payees.toArray(),
        db.tags.toArray(),
        db.categories.toArray(),
      ]);
      ctx = duplicateContextFrom(
        tx,
        {
          payeesById: new Map(ps.map((p) => [p.id, p])),
          tagsById: new Map(ts.map((t) => [t.id, t])),
          categoriesById: new Map(cs.map((c) => [c.id, c])),
        },
        pair,
      );
    }
    setEditor({ open: true, tx: null, draft: duplicateDraftFrom(tx, ctx, todayISO()) });
  };
  const onDuplicate = (tx: Transaction) => void startDuplicate(tx);

  return (
    <div className="flex h-full min-h-0 flex-col gap-3 p-4 lg:p-6">
      <header className="flex flex-wrap items-center justify-between gap-2">
        <h1 className="text-xl font-semibold text-text">Transactions</h1>
        <div className="flex flex-wrap items-center gap-2">
          {/* The way out of a narrowed view. Shown only while something is
              narrowing the list AND there is an in-app step to return to:
              offering "Back" on a cold-started deep link would either lie or
              throw the user out of the app, so that case gets "Clear filters"
              — which is the honest equivalent — and nothing else. */}
          {anyActive && canGoBack && (
            <Button
              size="sm"
              onClick={() => goBack('/transactions')}
              aria-label="Back to the previous view"
            >
              <IconChevronLeft size={16} />
              Back
            </Button>
          )}
          {anyActive && (
            <Button size="sm" variant="ghost" onClick={clearAll}>
              Clear filters
            </Button>
          )}
          <Button variant="primary" size="sm" onClick={() => openEditor(null)}>
            <IconPlus size={16} />
            Add
          </Button>
        </div>
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
        onPatchWhileTyping={patchFiltersWhileTyping}
        payeeText={payeeText}
        onPayeeText={onPayeeText}
        onPayeePick={onPayeePick}
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
        {/* Column headings. Same skeleton as a row — labelled cells in a
            flex-1 grid, then the action-column spacer — so the labels stay
            over their columns without a hand-tuned padding. */}
        <div
          className="sticky top-0 z-10 hidden border-b border-border bg-surface lg:flex"
          aria-hidden="true"
        >
          <div
            className={cn(
              'min-w-0 flex-1 px-4 py-2 text-xs font-semibold uppercase tracking-wide text-faint lg:grid lg:gap-3',
              REGISTER_GRID,
            )}
          >
            <span>Date</span>
            <span>Payee</span>
            <span>Category</span>
            <span>Account</span>
            <span>Tags</span>
            <span className="text-right">Amount</span>
          </div>
          <div className={REGISTER_ACTION_COL} />
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
                    onDuplicate={onDuplicate}
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
        draft={editor.draft}
        onDuplicate={onDuplicate}
        onClose={() => setEditor((e) => ({ ...e, open: false }))}
      />
    </div>
  );
}
