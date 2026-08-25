// Budgets snapshot: top 4 budgets by percentage used (SPEC §8.1.7).
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { allBudgetProgress } from '../../domain/budgets';
import { formatMinor } from '../../money/money';
import { Card, ProgressBar } from '../kit/kit';
import { href } from '../router';
import { CardHeader, Skeleton, WarnNote } from './shared';

export function BudgetsCard({ className }: { className?: string }) {
  const progress = useLive(() => allBudgetProgress(), []);
  const base = useLive(async () => (await getSettings()).baseCurrency, []);

  if (progress === undefined || base === undefined) {
    return (
      <Card className={className}>
        <CardHeader title="Budgets" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  // No budgets yet → a small CTA instead of the snapshot (SPEC §8.1.7).
  if (progress.length === 0) {
    return (
      <Card className={className}>
        <CardHeader title="Budgets" />
        <p className="text-sm text-muted">
          Set spending limits per category and track how the month is going.
        </p>
        <a
          href={href('/budgets')}
          className="mt-3 inline-block text-sm font-medium text-accent hover:underline"
        >
          Create a budget &rarr;
        </a>
      </Card>
    );
  }

  const top = [...progress].sort((a, b) => b.pct - a.pct).slice(0, 4);
  const missingRates = progress.reduce((acc, p) => acc + p.missingRateCount, 0);

  return (
    <Card className={className}>
      <CardHeader title="Budgets" linkTo="/budgets" linkLabel="All budgets" />
      <ul className="flex flex-col gap-3.5">
        {top.map((p) => (
          <li key={p.budget.id}>
            <div className="mb-1 flex items-baseline justify-between gap-3">
              <span className="min-w-0 truncate text-sm font-medium">{p.budget.name}</span>
              {p.over && (
                <span className="shrink-0 rounded-full border border-danger px-2 py-0.5 text-[11px] font-medium text-danger">
                  Over
                </span>
              )}
            </div>
            <ProgressBar value={p.pct} over={p.over} />
            <p className="tnum mt-1 text-xs text-muted">
              {formatMinor(p.spentMinor, base)} of {formatMinor(p.limitMinor, base)}
            </p>
          </li>
        ))}
      </ul>
      {missingRates > 0 && (
        <WarnNote>
          {missingRates} amount{missingRates === 1 ? '' : 's'} excluded &mdash; no exchange rate
          set.
        </WarnNote>
      )}
    </Card>
  );
}
