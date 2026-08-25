// Spending by payee (SPEC §8.1.8) — top 20 as a labelled bar list.
import { useLive } from '../../db/useLive';
import { spendingByPayee } from '../../reports/aggregate';
import { Card, Chip, EmptyState } from '../kit/kit';
import { IconWallet } from '../kit/icons';
import { href } from '../router';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { BarList, MissingRateNote, ReportSkeleton, type BarListItem } from './common';

const LIMIT = 20;

export default function PayeeReport({
  range,
  currency,
}: {
  range: DateRangeValue;
  currency: string;
}) {
  const data = useLive(
    () => spendingByPayee({ from: range.from, to: range.to }, LIMIT),
    [range.from, range.to],
  );
  if (data === undefined) return <ReportSkeleton kind="list" />;

  const { rows, missingRateCount } = data;
  if (rows.length === 0) {
    return (
      <Card>
        <EmptyState
          icon={<IconWallet size={32} />}
          title="No spending in this range"
          message="Add transactions or widen the date range to see spending by payee."
        />
      </Card>
    );
  }

  const items: BarListItem[] = rows.map((r) => ({
    key: r.payeeId ?? 'no-payee',
    name: r.name,
    colour: r.payeeId === null ? 'var(--c-faint)' : 'var(--c-neg)',
    amountMinor: r.spentMinor,
    chip: (
      <Chip className="shrink-0">
        {r.txCount} tx
      </Chip>
    ),
    href:
      r.payeeId !== null
        ? href(
            `/transactions?payee=${encodeURIComponent(r.payeeId)}&from=${range.from}&to=${range.to}`,
          )
        : undefined,
  }));

  return (
    <div className="flex flex-col gap-3">
      <Card>
        <h2 className="text-sm font-medium text-muted">
          Spending by payee{rows.length === LIMIT ? ` — top ${LIMIT}` : ''}
        </h2>
        <div className="mt-3">
          <BarList items={items} currency={currency} label="Spending by payee" />
        </div>
      </Card>
      <MissingRateNote count={missingRateCount} />
    </div>
  );
}
