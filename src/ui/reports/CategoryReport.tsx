// Spending by category with drill-down (SPEC §8.1.8) — labelled bar list,
// breadcrumb trail, % of level total, leaf rows deep-link to Transactions.
//
// The drill-down level lives in the URL (`/reports?report=by-category&parent=
// <categoryId>`, see reportParams.ts), never in component state: descending a
// level is a real navigation, so the browser Back button walks back up the
// tree exactly as the breadcrumb does, and a drilled view can be bookmarked
// or shared. Every crumb and every drillable row is therefore an <a>.
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { spendingByCategory } from '../../reports/aggregate';
import { formatMinor } from '../../money/money';
import { Button, Card, EmptyState } from '../kit/kit';
import { IconChevronLeft, IconPie } from '../kit/icons';
import { goBack, href } from '../router';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { ancestorTrail, reportPath } from './reportParams';
import { BarList, MissingRateNote, ReportSkeleton, type BarListItem } from './common';

export default function CategoryReport({
  range,
  currency,
  parentId,
}: {
  range: DateRangeValue;
  currency: string;
  /** drilled-into category from the URL; null = all categories */
  parentId: string | null;
}) {
  const data = useLive(
    () => spendingByCategory({ from: range.from, to: range.to }, parentId),
    [range.from, range.to, parentId],
  );
  // Separate (cheap) query so the breadcrumb is on screen while the aggregate
  // is still running — a deep link lands on the trail, not on a bare page.
  const trail = useLive(
    async () => ancestorTrail(await db.categories.toArray(), parentId),
    [parentId],
  );

  /** Router path for this report at a given drill level. */
  const levelPath = (id: string | null) =>
    reportPath({ report: 'by-category', range, parentId: id });

  const crumbs = trail ?? [];
  // One level up: the fallback for Back when there is nothing to pop (i.e.
  // the user arrived here on a deep link rather than by drilling).
  const upPath = levelPath(crumbs.length > 1 ? crumbs[crumbs.length - 2].id : null);

  const breadcrumb = (
    <div className="flex min-w-0 flex-wrap items-center gap-1">
      {parentId !== null && (
        <Button
          size="sm"
          variant="ghost"
          className="-ml-1.5 gap-0.5 px-1.5 text-muted"
          onClick={() => goBack(upPath)}
        >
          <IconChevronLeft size={16} />
          Back
        </Button>
      )}
      <nav aria-label="Category drill-down" className="flex flex-wrap items-center gap-1 text-sm">
        {parentId === null ? (
          <span className="font-medium text-text">All categories</span>
        ) : (
          <a href={href(levelPath(null))} className="text-accent hover:underline">
            All categories
          </a>
        )}
        {crumbs.map((c, i) => (
          <span key={c.id} className="flex items-center gap-1">
            <span aria-hidden="true" className="text-faint">
              ›
            </span>
            {i === crumbs.length - 1 ? (
              <span aria-current="page" className="font-medium text-text">
                {c.name}
              </span>
            ) : (
              <a href={href(levelPath(c.id))} className="text-accent hover:underline">
                {c.name}
              </a>
            )}
          </span>
        ))}
      </nav>
    </div>
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
    const canDrill = r.hasChildren && r.categoryId !== null && !isSelfRow;
    return {
      key: r.categoryId ?? 'uncategorised',
      name: isSelfRow ? `${r.name} (directly)` : r.name,
      colour:
        r.colour ?? (r.categoryId === null ? 'var(--c-faint)' : 'var(--c-neg)'),
      amountMinor: r.spentMinor,
      pctOfTotal: totalMinor > 0 ? r.spentMinor / totalMinor : null,
      drillHref: canDrill ? href(levelPath(r.categoryId!)) : undefined,
      href: !canDrill && r.categoryId !== null ? txLink(r.categoryId) : undefined,
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
