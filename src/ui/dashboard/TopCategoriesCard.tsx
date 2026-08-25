// Top spending categories this month — labelled horizontal bar list (plain
// divs, per the CONTRACTS chart rules: every mark direct-labelled).
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { formatMinor } from '../../money/money';
import { spendingByCategory } from '../../reports/aggregate';
import { Card } from '../kit/kit';
import { CardHeader, EmptyHint, Skeleton, thisMonthRange, WarnNote } from './shared';

export function TopCategoriesCard({ className }: { className?: string }) {
  const data = useLive(() => spendingByCategory(thisMonthRange(), null), []);
  const base = useLive(async () => (await getSettings()).baseCurrency, []);

  const rows = (data?.rows ?? []).slice(0, 5);
  const maxSpent = rows.length > 0 ? Math.max(...rows.map((r) => r.spentMinor)) : 0;

  return (
    <Card className={className}>
      <CardHeader title="Top categories" linkTo="/reports?report=by-category" linkLabel="Reports" />
      {data === undefined || base === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : rows.length === 0 ? (
        <EmptyHint>No spending this month yet.</EmptyHint>
      ) : (
        <ul className="flex flex-col gap-3">
          {rows.map((r) => {
            const colour = r.colour ?? 'var(--c-faint)';
            const widthPct = maxSpent > 0 ? Math.max(0, (r.spentMinor / maxSpent) * 100) : 0;
            return (
              <li key={r.categoryId ?? 'uncategorised'}>
                <div className="mb-1 flex items-center gap-2">
                  <span
                    aria-hidden="true"
                    className="h-2.5 w-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: colour }}
                  />
                  <span className="min-w-0 flex-1 truncate text-sm">{r.name}</span>
                  <span className="tnum shrink-0 text-sm">{formatMinor(r.spentMinor, base)}</span>
                </div>
                <div aria-hidden="true" className="h-1.5 overflow-hidden rounded-full bg-surface2">
                  <div
                    className="h-full rounded-full"
                    style={{ width: `${widthPct}%`, backgroundColor: colour }}
                  />
                </div>
              </li>
            );
          })}
        </ul>
      )}
      {data !== undefined && data.missingRateCount > 0 && (
        <WarnNote>
          {data.missingRateCount} transaction{data.missingRateCount === 1 ? '' : 's'} excluded
          &mdash; no exchange rate set.
        </WarnNote>
      )}
    </Card>
  );
}
