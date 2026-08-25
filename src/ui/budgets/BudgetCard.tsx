// One budget in the list: name, current window, progress bar, status line.
// The whole card is a link to the detail view (/budgets?id=<id>).
import type { BudgetProgress } from '../../domain/budgets';
import { href } from '../router';
import { ProgressBar } from '../kit/kit';
import { IconChevronRight } from '../kit/icons';
import { BudgetStatusLine, MissingRateChip, OverBadge, windowLabel } from './budgetFormat';

export function BudgetCard({
  progress,
  currency,
}: {
  progress: BudgetProgress;
  currency: string;
}) {
  const b = progress.budget;
  return (
    <a
      href={href(`/budgets?id=${b.id}`)}
      className="block rounded-xl border border-border bg-surface p-4 transition-colors hover:border-accent"
    >
      <div className="flex items-center justify-between gap-2">
        <h3 className="truncate text-sm font-semibold text-text">{b.name}</h3>
        <span className="flex shrink-0 items-center gap-1 text-xs text-muted">
          {windowLabel(progress.window)}
          <IconChevronRight size={14} className="text-faint" />
        </span>
      </div>
      <ProgressBar value={progress.pct} over={progress.over} className="my-3" />
      <BudgetStatusLine progress={progress} currency={currency} />
      {(progress.over || progress.missingRateCount > 0) && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {progress.over && <OverBadge />}
          <MissingRateChip count={progress.missingRateCount} />
        </div>
      )}
    </a>
  );
}
