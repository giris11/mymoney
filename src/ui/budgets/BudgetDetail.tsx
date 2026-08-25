// Budget detail (/budgets?id=<id>): progress for a viewed period window,
// ‹ › period navigation via shiftWindow, and the transactions that count
// toward the budget in that window.
import { useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import {
  budgetProgress,
  shiftWindow,
  windowContaining,
} from '../../domain/budgets';
import { queryTransactions } from '../../domain/transactions';
import type { Transaction } from '../../db/types';
import { formatDate, todayISO } from '../../lib/util';
import { href, navigate } from '../router';
import { Amount, Button, Card, Chip, EmptyState, IconButton, ProgressBar } from '../kit/kit';
import { IconChevronLeft, IconChevronRight, IconPencil } from '../kit/icons';
import BudgetEditor from './BudgetEditor';
import { BudgetStatusLine, MissingRateChip, OverBadge, windowLabel } from './budgetFormat';

const MAX_ROWS = 200;

export default function BudgetDetail({ id }: { id: string }) {
  const [offset, setOffset] = useState(0); // periods away from the current one
  const [editing, setEditing] = useState(false);

  const data = useLive(async () => {
    const budget = await db.budgets.get(id);
    if (!budget) return null;
    const current = windowContaining(budget, todayISO());
    const win = offset === 0 ? current : shiftWindow(budget, current, offset);
    const [settings, progress, txs, cats, payees] = await Promise.all([
      getSettings(),
      budgetProgress(budget, win.start),
      queryTransactions({ categoryIds: budget.categoryIds, dateFrom: win.start, dateTo: win.end }),
      db.categories.toArray(),
      db.payees.toArray(),
    ]);
    return {
      budget,
      win,
      progress,
      txs,
      baseCurrency: settings.baseCurrency,
      catById: new Map(cats.map((c) => [c.id, c])),
      payeeById: new Map(payees.map((p) => [p.id, p])),
    };
  }, [id, offset]);

  if (data === undefined) return null; // first paint
  if (data === null) {
    return (
      <div className="p-4 lg:p-6">
        <EmptyState
          title="Budget not found"
          message="It may have been deleted."
          action={<Button onClick={() => navigate('/budgets')}>All budgets</Button>}
        />
      </div>
    );
  }

  const { budget, win, progress, txs, baseCurrency, catById, payeeById } = data;
  const registerLink =
    `/transactions?from=${win.start}&to=${win.end}` +
    // The register's category filter takes a single id; with several covered
    // categories the link filters by the window dates only.
    (budget.categoryIds.length === 1 ? `&category=${budget.categoryIds[0]}` : '');
  const shown = txs.slice(0, MAX_ROWS);

  const rowTitle = (t: Transaction): string => {
    if (t.payeeId) return payeeById.get(t.payeeId)?.name ?? '—';
    return t.notes || '—';
  };
  const rowCategory = (t: Transaction): string => {
    if (t.splits.length > 0) return 'Split';
    if (t.categoryId) return catById.get(t.categoryId)?.name ?? '—';
    return 'Uncategorised';
  };

  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-4 p-4 lg:p-6">
      <div>
        <a
          href={href('/budgets')}
          className="inline-flex items-center gap-1 text-sm text-muted hover:text-text"
        >
          <IconChevronLeft size={16} />
          All budgets
        </a>
      </div>

      <div className="flex items-center justify-between gap-3">
        <h1 className="min-w-0 truncate text-xl font-semibold">{budget.name}</h1>
        <div className="flex shrink-0 items-center gap-2">
          {budget.archived && <Chip>Archived</Chip>}
          <Button size="sm" onClick={() => setEditing(true)}>
            <IconPencil size={15} />
            Edit
          </Button>
        </div>
      </div>

      <Card>
        <div className="flex items-center justify-between gap-2">
          <IconButton label="Previous period" onClick={() => setOffset((o) => o - 1)}>
            <IconChevronLeft size={18} />
          </IconButton>
          <div className="flex min-w-0 flex-col items-center">
            <span className="truncate text-sm font-medium text-text">{windowLabel(win)}</span>
            <Button
              size="sm"
              variant="ghost"
              className="text-xs text-muted"
              disabled={offset === 0}
              onClick={() => setOffset(0)}
            >
              Current period
            </Button>
          </div>
          <IconButton label="Next period" onClick={() => setOffset((o) => o + 1)}>
            <IconChevronRight size={18} />
          </IconButton>
        </div>

        <ProgressBar value={progress.pct} over={progress.over} className="my-3 h-3" />
        <div className="flex flex-wrap items-center justify-between gap-2">
          <BudgetStatusLine progress={progress} currency={baseCurrency} />
          <span className="text-xs text-muted tnum">{Math.round(progress.pct * 100)}% used</span>
        </div>
        {(progress.over || progress.missingRateCount > 0) && (
          <div className="mt-2 flex flex-wrap gap-1.5">
            {progress.over && <OverBadge />}
            <MissingRateChip count={progress.missingRateCount} />
          </div>
        )}

        <div className="mt-3 flex flex-wrap items-center gap-1.5 border-t border-border pt-3">
          {budget.categoryIds.map((cid) => {
            const c = catById.get(cid);
            return (
              <Chip key={cid}>
                {c?.colour && (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: c.colour }}
                  />
                )}
                {c?.name ?? 'Deleted category'}
              </Chip>
            );
          })}
          <span className="text-xs text-faint">subcategories included</span>
        </div>
      </Card>

      <section className="flex flex-col gap-2">
        <div className="flex items-baseline justify-between gap-3">
          <h2 className="text-sm font-semibold text-text">Transactions this period</h2>
          <a href={href(registerLink)} className="shrink-0 text-sm text-accent hover:underline">
            Open in register →
          </a>
        </div>
        <Card className="p-0">
          {shown.length === 0 ? (
            <p className="p-4 text-sm text-faint">No transactions in this period.</p>
          ) : (
            <ul className="divide-y divide-border">
              {shown.map((t) => (
                <li key={t.id} className="flex items-center justify-between gap-3 px-4 py-2.5">
                  <div className="min-w-0">
                    <p className="truncate text-sm text-text">{rowTitle(t)}</p>
                    <p className="truncate text-xs text-muted">{rowCategory(t)}</p>
                  </div>
                  <div className="shrink-0 text-right">
                    <Amount minor={t.amountMinor} currency={t.currency} signColour className="text-sm" />
                    <p className="text-xs text-muted tnum">{formatDate(t.date)}</p>
                  </div>
                </li>
              ))}
            </ul>
          )}
          {txs.length > MAX_ROWS && (
            <p className="border-t border-border p-3 text-xs text-muted">
              Showing the first {MAX_ROWS} of {txs.length} — open in register for the rest.
            </p>
          )}
        </Card>
      </section>

      <BudgetEditor
        open={editing}
        budget={budget}
        onClose={() => setEditing(false)}
        onDeleted={() => navigate('/budgets')}
      />
    </div>
  );
}
