// Income vs expense by month (SPEC §8.1.8) — grouped bars, pos/neg palette.
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Tooltip,
  XAxis,
  YAxis,
  type TooltipContentProps,
} from 'recharts';
import { useLive } from '../../db/useLive';
import { incomeVsExpenseByMonth, type MonthlyIncomeExpense } from '../../reports/aggregate';
import { formatMinor } from '../../money/money';
import { Card, EmptyState } from '../kit/kit';
import { IconCoins } from '../kit/icons';
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

export default function IncomeExpenseReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const data = useLive(
    () => incomeVsExpenseByMonth({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  if (data === undefined) return <ReportSkeleton kind="chart" />;

  const { rows, missingRateCount } = data;
  const empty = rows.every((r) => r.incomeMinor === 0 && r.expenseMinor === 0);
  if (rows.length === 0 || empty) {
    return (
      <Card>
        <EmptyState
          icon={<IconCoins size={32} />}
          title="No income or spending in this range"
          message="Add transactions or widen the date range to compare income and expense."
        />
      </Card>
    );
  }

  const renderTip = (props: TooltipContentProps) => {
    if (!props.active || !props.payload || props.payload.length === 0) return null;
    const row = (props.payload[0] as { payload?: unknown }).payload as
      | MonthlyIncomeExpense
      | undefined;
    if (!row) return null;
    const net = row.incomeMinor - row.expenseMinor;
    return (
      <TipBox
        title={monthLabel(row.month)}
        rows={[
          { label: 'Income', value: formatMinor(row.incomeMinor, currency) },
          { label: 'Expense', value: formatMinor(row.expenseMinor, currency) },
          {
            label: 'Net',
            value: formatMinor(net, currency),
            className: net >= 0 ? 'text-pos' : 'text-neg',
          },
        ]}
      />
    );
  };

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-sm font-medium text-muted">Income vs expense by month</h2>
        <div className="mt-4">
          <ChartBox>
            <BarChart data={rows} margin={{ top: 8, right: 8, bottom: 0, left: 0 }} barGap={2}>
              <CartesianGrid vertical={false} stroke="var(--c-border)" />
              <XAxis
                dataKey="month"
                tick={AXIS_TICK}
                axisLine={AXIS_LINE}
                tickLine={false}
                minTickGap={24}
                tickFormatter={monthLabel}
              />
              <YAxis
                tick={AXIS_TICK}
                axisLine={false}
                tickLine={false}
                width={56}
                tickFormatter={(v: number) => compactMinor(v, currency)}
              />
              <Tooltip content={renderTip} cursor={{ fill: 'var(--c-surface2)' }} />
              <Legend formatter={legendText} iconType="circle" iconSize={8} />
              <Bar
                dataKey="incomeMinor"
                name="Income"
                fill="var(--c-pos)"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
              <Bar
                dataKey="expenseMinor"
                name="Expense"
                fill="var(--c-neg)"
                radius={[4, 4, 0, 0]}
                maxBarSize={24}
                isAnimationActive={false}
              />
            </BarChart>
          </ChartBox>
        </div>
      </Card>
      <MissingRateNote count={missingRateCount} />
    </div>
  );
}
