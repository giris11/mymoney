// Net worth over time (SPEC §8.1.8) — accent line sampled at month-ends.
//
// The series counts the same accounts the headline figure does, so accounts
// flagged out of net worth are named here too: one quiet line saying what is
// not in the chart, rather than a curve that silently means something else.
import dayjs from 'dayjs';
import {
  CartesianGrid,
  Line,
  LineChart,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useLive } from '../../db/useLive';
import { netWorth } from '../../domain/balances';
import { netWorthSeries, type NetWorthPoint } from '../../reports/aggregate';
import { formatMinor } from '../../money/money';
import { formatDate } from '../../lib/util';
import { Card, EmptyState } from '../kit/kit';
import { IconTrendUp } from '../kit/icons';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { NotCountedNote } from '../settings/NetWorthCount';
import {
  AXIS_LINE,
  AXIS_TICK,
  ChartBox,
  compactMinor,
  MissingRateNote,
  ReportSkeleton,
  TipBox,
} from './common';

export default function NetWorthReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const data = useLive(
    () => netWorthSeries({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  // Which accounts are out, and what they hold today — the series itself is a
  // history of totals and carries no per-account detail.
  const nw = useLive(() => netWorth(), []);
  if (data === undefined) return <ReportSkeleton kind="chart" />;

  const { points, missingRateCurrencies } = data;
  if (points.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconTrendUp size={32} />}
          title="No data in this range"
          message="Pick a wider date range to see your net worth over time."
        />
      </Card>
    );
  }

  const current = points[points.length - 1];
  const renderTip = (props: TooltipContentProps) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const p = (props.payload[0] as { payload?: unknown }).payload as NetWorthPoint | undefined;
    if (!p) return null;
    return (
      <TipBox
        title={formatDate(p.date)}
        rows={[{ label: 'Net worth', value: formatMinor(p.totalBaseMinor, currency) }]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-sm font-medium text-muted">Net worth over time</h2>
        <p className="mt-1 text-2xl font-semibold tnum">
          {formatMinor(current.totalBaseMinor, currency)}
        </p>
        <p className="text-xs text-muted">as at {formatDate(current.date)}</p>
        {nw !== undefined && (
          <NotCountedNote
            count={nw.excludedCount}
            baseMinor={nw.excludedBaseMinor}
            baseCurrency={nw.baseCurrency}
          />
        )}
        <div className="mt-4">
          <ChartBox>
            <LineChart data={points} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--c-border)" />
              <XAxis
                dataKey="date"
                tick={AXIS_TICK}
                axisLine={AXIS_LINE}
                tickLine={false}
                minTickGap={48}
                interval="preserveStartEnd"
                tickFormatter={(d: string) => dayjs(d).format('MMM YYYY')}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={56}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => compactMinor(v, currency)}
              />
              <Tooltip content={renderTip} cursor={{ stroke: 'var(--c-border)' }} />
              <Line
                type="monotone"
                dataKey="totalBaseMinor"
                stroke="var(--c-accent)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: 'var(--c-accent)', stroke: 'var(--c-surface)' }}
                isAnimationActive={false}
              />
            </LineChart>
          </ChartBox>
        </div>
      </Card>
      <MissingRateNote currencies={missingRateCurrencies} />
    </div>
  );
}
