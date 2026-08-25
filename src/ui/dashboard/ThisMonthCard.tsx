// This month: income vs spending for the current calendar month (SPEC §8.1.7).
import dayjs from 'dayjs';
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { cn } from '../../lib/util';
import { formatMinor } from '../../money/money';
import { incomeVsExpenseByMonth } from '../../reports/aggregate';
import { Card } from '../kit/kit';
import { CardHeader, Skeleton, thisMonthRange, WarnNote } from './shared';

export function ThisMonthCard({ className }: { className?: string }) {
  const data = useLive(async () => {
    const { rows, missingRateCount } = await incomeVsExpenseByMonth(thisMonthRange());
    // The range spans exactly one month, so exactly one (zero-filled) row.
    const row = rows[0] ?? { month: '', incomeMinor: 0, expenseMinor: 0 };
    return { row, missingRateCount };
  }, []);

  // Figures come from incomeVsExpenseByMonth, which reports in base currency.
  const base = useLive(async () => (await getSettings()).baseCurrency, []);

  if (data === undefined || base === undefined) {
    return (
      <Card className={className}>
        <CardHeader title="This month" />
        <Skeleton className="h-24 w-full" />
      </Card>
    );
  }

  const income = data.row.incomeMinor;
  const spending = data.row.expenseMinor;
  const net = income - spending;
  const flowTotal = income + spending;
  const incomePct = flowTotal > 0 ? (income / flowTotal) * 100 : 0;

  return (
    <Card className={className}>
      <CardHeader title="This month" />
      <p className="mb-3 text-sm text-muted">{dayjs().format('MMMM YYYY')}</p>
      <dl className="flex gap-8">
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-faint">Income</dt>
          <dd className="tnum mt-0.5 text-2xl font-semibold text-pos">
            {formatMinor(income, base)}
          </dd>
        </div>
        <div className="min-w-0">
          <dt className="text-xs uppercase tracking-wide text-faint">Spending</dt>
          <dd className="tnum mt-0.5 text-2xl font-semibold text-neg">
            {formatMinor(spending, base)}
          </dd>
        </div>
      </dl>
      <div aria-hidden="true" className="mt-4 flex h-2 overflow-hidden rounded-full bg-surface2">
        {flowTotal > 0 && (
          <>
            <div className="h-full rounded-l-full bg-pos" style={{ width: `${incomePct}%` }} />
            <div className="h-full rounded-r-full bg-neg" style={{ width: `${100 - incomePct}%` }} />
          </>
        )}
      </div>
      <p className="mt-3 text-sm">
        <span className="text-muted">Net </span>
        <span className={cn('tnum font-medium', net > 0 && 'text-pos', net < 0 && 'text-neg')}>
          {net > 0 ? '+' : ''}
          {formatMinor(net, base)}
        </span>
      </p>
      {flowTotal === 0 && (
        <p className="mt-2 text-sm text-muted">Nothing logged this month yet.</p>
      )}
      {data.missingRateCount > 0 && (
        <WarnNote>
          {data.missingRateCount} transaction{data.missingRateCount === 1 ? '' : 's'} excluded
          &mdash; no exchange rate set.
        </WarnNote>
      )}
    </Card>
  );
}
