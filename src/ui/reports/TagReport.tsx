// Spending by tag (SPEC §8.1.8) — labelled bar list, one row per tag.
import { useLive } from '../../db/useLive';
import { spendingByTag } from '../../reports/aggregate';
import { Card, Chip, EmptyState } from '../kit/kit';
import { IconTag } from '../kit/icons';
import { href } from '../router';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { BarList, MissingRateNote, ReportSkeleton, type BarListItem } from './common';

export default function TagReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const data = useLive(
    () => spendingByTag({ from: range.from, to: range.to }),
    [range.from, range.to],
  );
  if (data === undefined) return <ReportSkeleton kind="list" />;

  const { rows, missingRateCount } = data;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconTag size={32} />}
          title="No tagged spending in this range"
          message="Tag transactions (e.g. holidays, work) to see spending grouped by tag here."
        />
      </Card>
    );
  }

  const items: BarListItem[] = rows.map((r) => ({
    key: r.tagId,
    name: r.name,
    colour: 'var(--c-neg)',
    amountMinor: r.spentMinor,
    chip: <Chip className="shrink-0">{r.txCount} tx</Chip>,
    href: href(
      `/transactions?tag=${encodeURIComponent(r.tagId)}&from=${range.from}&to=${range.to}`,
    ),
  }));

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-sm font-medium text-muted">Spending by tag</h2>
        <div className="mt-3">
          <BarList items={items} currency={currency} label="Spending by tag" />
        </div>
      </Card>
      <MissingRateNote count={missingRateCount} />
    </div>
  );
}
