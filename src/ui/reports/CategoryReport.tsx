// Spending by category with drill-down (SPEC §8.1.8) — labelled bar list,
// breadcrumb trail, % of level total, leaf rows deep-link to Transactions.
import { useState } from 'react';
import { useLive } from '../../db/useLive';
import { spendingByCategory } from '../../reports/aggregate';
import { formatMinor } from '../../money/money';
import { Card, EmptyState } from '../kit/kit';
import { IconPie } from '../kit/icons';
import { href } from '../router';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { BarList, MissingRateNote, ReportSkeleton, type BarListItem } from './common';

interface Crumb {
  id: string;
  name: string;
}

export default function CategoryReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const [path, setPath] = useState<Crumb[]>([]);
  const parentId = path.length > 0 ? path[path.length - 1].id : null;
  const data = useLive(
    () => spendingByCategory({ from: range.from, to: range.to }, parentId),
    [range.from, range.to, parentId],
  );

  const breadcrumb = (
    <nav aria-label="Category drill-down" className="flex flex-wrap items-center gap-1 text-sm">
      {path.length === 0 ? (
        <span className="font-medium text-text">All categories</span>
      ) : (
        <button
          type="button"
          onClick={() => setPath([])}
          className="cursor-pointer text-accent hover:underline"
        >
          All categories
        </button>
      )}
      {path.map((c, i) => (
        <span key={c.id} className="flex items-center gap-1">
          <span aria-hidden="true" className="text-faint">
            ›
          </span>
          {i === path.length - 1 ? (
            <span className="font-medium text-text">{c.name}</span>
          ) : (
            <button
              type="button"
              onClick={() => setPath(path.slice(0, i + 1))}
              className="cursor-pointer text-accent hover:underline"
            >
              {c.name}
            </button>
          )}
        </span>
      ))}
    </nav>
  );

  if (data === undefined) {
    return (
      <div className="flex flex-col gap-3">
        {breadcrumb}
        <ReportSkeleton kind="list" />
      </div>
    );
  }

  const { rows, totalMinor, missingRateCount } = data;
  const txLink = (categoryId: string) =>
    href(
      `/transactions?category=${encodeURIComponent(categoryId)}&from=${range.from}&to=${range.to}`,
    );

  const items: BarListItem[] = rows.map((r) => {
    const isSelfRow = parentId !== null && r.categoryId === parentId;
    return {
      key: r.categoryId ?? 'uncategorised',
      name: isSelfRow ? `${r.name} (directly)` : r.name,
      colour:
        r.colour ?? (r.categoryId === null ? 'var(--c-faint)' : 'var(--c-neg)'),
      amountMinor: r.spentMinor,
      pctOfTotal: totalMinor > 0 ? r.spentMinor / totalMinor : null,
      onDrill:
        r.hasChildren && r.categoryId !== null
          ? () => setPath([...path, { id: r.categoryId!, name: r.name }])
          : undefined,
      href:
        !r.hasChildren && r.categoryId !== null ? txLink(r.categoryId) : undefined,
    };
  });

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          {breadcrumb}
          <p className="text-sm text-muted">
            Total{' '}
            <span className="tnum font-semibold text-text">
              {formatMinor(totalMinor, currency)}
            </span>
          </p>
        </div>
        {rows.length === 0 ? (
          <EmptyState
            icon={<IconPie size={32} />}
            title="No spending here"
            message={
              parentId === null
                ? 'No spending recorded in this date range.'
                : 'No spending in this category for the selected range.'
            }
          />
        ) : (
          <div className="mt-3">
            <BarList items={items} currency={currency} label="Spending by category" />
          </div>
        )}
      </Card>
      <MissingRateNote count={missingRateCount} />
    </div>
  );
}
