// Shared Budgets UI fragments: period-window labels and the progress status
// line/chips used by both the list cards and the detail view.
import dayjs from 'dayjs';
import type { BudgetProgress, PeriodWindow } from '../../domain/budgets';
import { Amount, Chip } from '../kit/kit';
import { IconAlert } from '../kit/icons';

/** Spend fraction from which the "left" figure turns amber. */
export const NEAR_LIMIT = 0.85;

/**
 * en-GB label for an inclusive window: '1–31 Aug 2026', '28 Jul – 3 Aug 2026',
 * '28 Dec 2026 – 3 Jan 2027'.
 */
export function windowLabel(w: PeriodWindow): string {
  const s = dayjs(w.start);
  const e = dayjs(w.end);
  if (s.isSame(e, 'day')) return s.format('D MMM YYYY');
  if (s.isSame(e, 'month')) return `${s.format('D')}–${e.format('D MMM YYYY')}`;
  if (s.isSame(e, 'year')) return `${s.format('D MMM')} – ${e.format('D MMM YYYY')}`;
  return `${s.format('D MMM YYYY')} – ${e.format('D MMM YYYY')}`;
}

/** 'Spent X of Y · Z left' — or '· Z over' in danger when over budget. */
export function BudgetStatusLine({
  progress,
  currency,
}: {
  progress: BudgetProgress;
  currency: string;
}) {
  const { spentMinor, limitMinor, remainingMinor, pct, over } = progress;
  return (
    <p className="text-sm text-muted">
      Spent <Amount minor={spentMinor} currency={currency} className="font-medium text-text" /> of{' '}
      <Amount minor={limitMinor} currency={currency} />
      {' · '}
      {over ? (
        <span className="font-medium text-danger">
          <Amount minor={Math.abs(remainingMinor)} currency={currency} /> over
        </span>
      ) : (
        <span className={pct >= NEAR_LIMIT ? 'font-medium text-warn' : undefined}>
          <Amount minor={remainingMinor} currency={currency} /> left
        </span>
      )}
    </p>
  );
}

export function OverBadge() {
  return <Chip className="border border-danger font-medium text-danger">Over budget</Chip>;
}

/** Warn chip for transactions excluded from the total for lack of an FX rate. */
export function MissingRateChip({ count }: { count: number }) {
  if (count <= 0) return null;
  return (
    <Chip className="border border-warn text-warn">
      <IconAlert size={12} />
      {count} transaction{count === 1 ? '' : 's'} excluded — no rate
    </Chip>
  );
}
