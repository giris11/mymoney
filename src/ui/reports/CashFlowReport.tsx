// Cash flow (SPEC §8.1.8) — monthly net bars (sign-coloured) + cumulative
// accent line on ONE shared money axis (contract: one axis per chart).
import {
  Bar,
  CartesianGrid,
  Cell,
  ComposedChart,
  Legend,
  Line,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useLive } from '../../db/useLive';
import { cashFlowByMonth, type MonthlyCashFlow } from '../../reports/aggregate';
import { formatMinor } from '../../money/money';
import { Card, EmptyState } from '../kit/kit';
import { IconTrendUp } from '../kit/icons';
import type { DateRangeValue } from '../kit/DateRangePicker';
import {
  AXIS_LINE,
  AXIS_TICK,
  ChartBox,
  compactMinor,
  legendText,
  MissingRateNote,
  monthLabel,
  ReportSkeleton,
  TipBox,
} from './common';

export default function CashFlowReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const data = useLive(
    () => cashFlowByMonth({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  if (data === undefined) return <ReportSkeleton kind="chart" />;

  const { rows, missingRateCount } = data;
  if (rows.length === 0 || rows.every((r) => r.netMinor === 0)) {
    return (
      <Card>
        <EmptyState
          icon={<IconTrendUp size={32} />}
          title="No cash flow in this range"
          message="Add transactions or widen the date range to see monthly net and cumulative flow."
        />
      </Card>
    );
  }

  const renderTip = (props: TooltipContentProps) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const row = (props.payload[0] as { payload?: unknown }).payload as
      | MonthlyCashFlow
      | undefined;
    if (!row) return null;
    return (
      <TipBox
        title={monthLabel(row.month)}
        rows={[
          {
            label: 'Net',
            value: formatMinor(row.netMinor, currency),
            className: row.netMinor >= 0 ? 'text-pos' : 'text-neg',
          },
          { label: 'Cumulative', value: formatMinor(row.cumulativeMinor, currency) },
        ]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-sm font-medium text-muted">Cash flow by month</h2>
        <div className="mt-4">
          <ChartBox>
            <ComposedChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }}>
              <CartesianGrid vertical={false} stroke="var(--c-border)" />
              <XAxis
                dataKey="month"
                tick={AXIS_TICK}
                axisLine={AXIS_LINE}
                tickLine={false}
                minTickGap={24}
                tickFormatter={monthLabel}
              />
              {/* ONE shared money axis for both the bars and the line */}
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={56}
                domain={['auto', 'auto']}
                tickFormatter={(v: number) => compactMinor(v, currency)}
              />
              <Tooltip content={renderTip} cursor={{ fill: 'var(--c-surface2)' }} />
              <Legend formatter={legendText} iconType="circle" iconSize={8} />
              <Bar dataKey="netMinor" name="Monthly net" radius={4} maxBarSize={24} isAnimationActive={false}>
                {rows.map((r) => (
                  <Cell
                    key={r.month}
                    fill={r.netMinor < 0 ? 'var(--c-neg)' : 'var(--c-pos)'}
                  />
                ))}
              </Bar>
              <Line
                type="monotone"
                dataKey="cumulativeMinor"
                name="Cumulative"
                stroke="var(--c-accent)"
                strokeWidth={2}
                dot={false}
                activeDot={{ r: 4, fill: 'var(--c-accent)', stroke: 'var(--c-surface)' }}
                isAnimationActive={false}
              />
            </ComposedChart>
          </ChartBox>
        </div>
      </Card>
      <MissingRateNote count={missingRateCount} />
    </div>
  );
}
