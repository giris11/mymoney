// Shared bits for the dashboard cards (SPEC §8.1.7). Dashboard-local only —
// anything generic enough for other pages belongs in the kit.
import dayjs from 'dayjs';
import type { CSSProperties, ReactNode } from 'react';
import type { DateRange } from '../../reports/aggregate';
import { href } from '../router';

/** The current calendar month, inclusive both ends ('YYYY-MM-DD'). */
export function thisMonthRange(): DateRange {
  const now = dayjs();
  return {
    from: now.startOf('month').format('YYYY-MM-DD'),
    to: now.endOf('month').format('YYYY-MM-DD'),
  };
}

/** Recharts tooltip surface — palette vars only (CONTRACTS chart rules). */
export const chartTooltipStyle: CSSProperties = {
  backgroundColor: 'var(--c-surface)',
  border: '1px solid var(--c-border)',
  borderRadius: 8,
  color: 'var(--c-text)',
  fontSize: 12,
  padding: '6px 10px',
};

/** Card heading with an optional trailing link ("View all →"). */
export function CardHeader({
  title,
  linkTo,
  linkLabel,
}: {
  title: string;
  linkTo?: string;
  linkLabel?: string;
}) {
  return (
    <div className="mb-3 flex items-baseline justify-between gap-3">
      <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">{title}</h2>
      {linkTo && linkLabel && (
        <a href={href(linkTo)} className="shrink-0 text-xs font-medium text-accent hover:underline">
          {linkLabel} &rarr;
        </a>
      )}
    </div>
  );
}

/** Amber footnote for excluded-because-no-rate figures (SPEC §6). */
export function WarnNote({ children }: { children: ReactNode }) {
  return <p className="mt-2 text-xs text-warn">{children}</p>;
}

/** Muted single-line hint used by compact empty states. */
export function EmptyHint({ children }: { children: ReactNode }) {
  return <p className="py-4 text-sm text-muted">{children}</p>;
}

/** Loading placeholder block. */
export function Skeleton({ className }: { className?: string }) {
  return <div aria-hidden="true" className={`animate-pulse rounded bg-surface2 ${className ?? ''}`} />;
}
