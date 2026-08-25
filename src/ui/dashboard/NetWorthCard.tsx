// Net worth hero card: headline figure + 6-month sparkline (SPEC §8.1.7).
import dayjs from 'dayjs';
import { Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { netWorth } from '../../domain/balances';
import { formatDate, todayISO } from '../../lib/util';
import { formatMinor } from '../../money/money';
import { netWorthSeries, type DateRange } from '../../reports/aggregate';
import { Card } from '../kit/kit';
import { href } from '../router';
import { CardHeader, chartTooltipStyle, Skeleton, WarnNote } from './shared';

/** Last 6 calendar months up to today (month-end samples + today). */
function sparklineRange(): DateRange {
  return {
    from: dayjs().subtract(5, 'month').startOf('month').format('YYYY-MM-DD'),
    to: todayISO(),
  };
}

export function NetWorthCard({ className }: { className?: string }) {
  const nw = useLive(() => netWorth(), []);
  const series = useLive(() => netWorthSeries(sparklineRange()), []);
  const accountCount = useLive(() => db.accounts.filter((a) => !a.archived).count(), []);

  const base = nw?.baseCurrency ?? 'GBP';
  const points = series?.points ?? [];

  return (
    <Card className={className}>
      <CardHeader title="Net worth" />
      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <div className="min-w-0">
          {nw === undefined ? (
            <Skeleton className="h-10 w-44" />
          ) : (
            <div className="tnum text-3xl font-semibold lg:text-4xl">
              {formatMinor(nw.totalBaseMinor, base)}
            </div>
          )}
          {nw !== undefined && nw.missingRateCurrencies.length > 0 && (
            <WarnNote>
              Excludes {nw.missingRateCurrencies.join(', ')} balances &mdash; no exchange rate set.
            </WarnNote>
          )}
          {accountCount === 0 && (
            <p className="mt-2 text-sm text-muted">
              No accounts yet &mdash; add your first account in{' '}
              <a href={href('/settings')} className="font-medium text-accent hover:underline">
                Settings
              </a>
              .
            </p>
          )}
        </div>
        {points.length >= 2 && (
          <div
            role="img"
            aria-label="Net worth trend over the last 6 months"
            className="h-16 w-full lg:h-20 lg:max-w-md"
          >
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={points} margin={{ top: 4, right: 4, bottom: 4, left: 4 }}>
                <XAxis dataKey="date" hide />
                <YAxis hide domain={['dataMin', 'dataMax']} />
                <Tooltip
                  contentStyle={chartTooltipStyle}
                  labelStyle={{ color: 'var(--c-muted)' }}
                  itemStyle={{ color: 'var(--c-text)' }}
                  labelFormatter={(label) => formatDate(String(label))}
                  formatter={(value) => [formatMinor(Number(value ?? 0), base), 'Net worth']}
                />
                <Line
                  type="monotone"
                  dataKey="totalBaseMinor"
                  stroke="var(--c-accent)"
                  strokeWidth={2}
                  dot={false}
                  activeDot={{ r: 3, fill: 'var(--c-accent)', stroke: 'var(--c-surface)' }}
                  isAnimationActive={false}
                />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
      </div>
    </Card>
  );
}
