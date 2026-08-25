// Shared building blocks for the Reports page (SPEC §8.1.8).
// Chart rules from CONTRACTS.md: palette CSS vars only, compact £ ticks,
// months as 'MMM YYYY', labelled horizontal bar lists for entity spend.
import type { ReactElement, ReactNode } from 'react';
import dayjs from 'dayjs';
import { ResponsiveContainer } from 'recharts';
import { cn } from '../../lib/util';
import { formatMinor, minorToMajorNumber, formatMinorPlain } from '../../money/money';
import { IconAlert, IconChevronRight } from '../kit/icons';

// ---------------------------------------------------------------- formatters

/** Compact money tick for chart axes: minor units → '£1.2k'. */
export function compactMinor(minor: number, currency: string): string {
  const major = minorToMajorNumber(minor, currency);
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      notation: 'compact',
      maximumFractionDigits: 1,
    })
      .format(major)
      .replace(/K/g, 'k');
  } catch {
    return `${currency} ${formatMinorPlain(minor, currency)}`;
  }
}

/** 'YYYY-MM' → 'MMM YYYY' (contract display format for months). */
export const monthLabel = (month: string): string => dayjs(`${month}-01`).format('MMM YYYY');

/** 0..1 fraction → '42%' / '3.5%'. */
export function formatPct(fraction: number): string {
  const pct = fraction * 100;
  if (!Number.isFinite(pct)) return '';
  return `${Math.abs(pct) >= 10 ? Math.round(pct) : (Math.round(pct * 10) / 10).toFixed(1)}%`;
}

// ---------------------------------------------------------------- chart bits

/** Recessive axis text/lines — always palette vars, never series colour. */
export const AXIS_TICK = { fill: 'var(--c-muted)', fontSize: 11 } as const;
export const AXIS_LINE = { stroke: 'var(--c-border)' } as const;

/** Fixed-height responsive chart region. */
export function ChartBox({ children }: { children: ReactElement }) {
  return (
    <div className="h-64 w-full lg:h-80">
      <ResponsiveContainer width="100%" height="100%">
        {children}
      </ResponsiveContainer>
    </div>
  );
}

/** Tooltip panel styled with surface/border/text tokens (contract). */
export function TipBox({
  title,
  rows,
}: {
  title: string;
  rows: { label: string; value: string; className?: string }[];
}) {
  return (
    <div className="rounded-lg border border-border bg-surface px-3 py-2 text-xs shadow-lg">
      <div className="mb-1 font-medium text-text">{title}</div>
      <div className="flex flex-col gap-0.5">
        {rows.map((r) => (
          <div key={r.label} className="flex items-center justify-between gap-4">
            <span className="text-muted">{r.label}</span>
            <span className={cn('tnum', r.className ?? 'text-text')}>{r.value}</span>
          </div>
        ))}
      </div>
    </div>
  );
}

/** Legend labels use text tokens, never the series colour (contract). */
export const legendText = (value: unknown): ReactNode => (
  <span style={{ color: 'var(--c-text)', fontSize: 12 }}>{String(value)}</span>
);

// ---------------------------------------------------------------- notes

/** SPEC §6 — surfaced, never guessed: excluded-for-missing-rate notice. */
export function MissingRateNote({
  count,
  currencies,
}: {
  count?: number;
  currencies?: string[];
}) {
  const hasCurrencies = !!currencies && currencies.length > 0;
  if (!hasCurrencies && !count) return null;
  const message = hasCurrencies
    ? `Excludes ${currencies.join(', ')} balances — no exchange rate to the base currency. Add rates in Settings.`
    : `${count} transaction${count === 1 ? '' : 's'} excluded — no exchange rate to the base currency. Add rates in Settings.`;
  return (
    <p className="flex items-start gap-1.5 text-xs text-warn">
      <IconAlert size={14} className="mt-0.5 shrink-0" />
      <span>{message}</span>
    </p>
  );
}

// ---------------------------------------------------------------- skeleton

/** Subtle pulsing placeholder while a report's aggregate loads. */
export function ReportSkeleton({ kind = 'chart' }: { kind?: 'chart' | 'list' }) {
  return (
    <div className="animate-pulse flex flex-col gap-3" aria-hidden="true">
      {kind === 'chart' ? (
        <>
          <div className="h-7 w-44 rounded-md bg-surface2" />
          <div className="h-64 rounded-xl bg-surface2 lg:h-80" />
        </>
      ) : (
        [92, 78, 64, 51, 39, 28].map((w, i) => (
          <div key={i} className="h-10 rounded-lg bg-surface2" style={{ width: `${w}%` }} />
        ))
      )}
    </div>
  );
}

// ---------------------------------------------------------------- bar list

export interface BarListItem {
  key: string;
  name: string;
  /** css colour for the dot + proportional bar (entity colour or palette var) */
  colour: string;
  amountMinor: number;
  /** share of the level total (0..1); omitted → no % column */
  pctOfTotal?: number | null;
  chip?: ReactNode;
  /** drill-down rows: click descends a level (renders a chevron) */
  onDrill?: () => void;
  /** leaf rows: deep link (e.g. filtered Transactions register) */
  href?: string;
}

/**
 * Labelled horizontal bar list — the contract-mandated rendering for
 * category/payee/tag spend (name + value visible without hover, never an
 * unlabelled pie). Bars are proportional to the largest row.
 */
export function BarList({
  items,
  currency,
  label,
}: {
  items: BarListItem[];
  currency: string;
  label: string;
}) {
  const max = items.reduce((m, i) => Math.max(m, Math.abs(i.amountMinor)), 0) || 1;
  const rowClass = 'block w-full rounded-lg px-2 py-2 text-left';
  return (
    <ul aria-label={label} className="flex flex-col">
      {items.map((it) => {
        const inner = (
          <>
            <div className="flex min-w-0 items-center gap-2">
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ backgroundColor: it.colour }}
              />
              <span className="truncate text-sm text-text">{it.name}</span>
              {it.chip}
              <span className="min-w-2 flex-1" />
              {it.pctOfTotal != null && (
                <span className="tnum shrink-0 text-xs text-faint">{formatPct(it.pctOfTotal)}</span>
              )}
              <span className="tnum shrink-0 text-sm font-medium text-text">
                {formatMinor(it.amountMinor, currency)}
              </span>
              {it.onDrill && <IconChevronRight size={16} className="shrink-0 text-faint" />}
            </div>
            <div
              aria-hidden="true"
              className="mt-1.5 h-1.5 w-full overflow-hidden rounded-full bg-surface2"
            >
              <div
                className="h-full rounded-full"
                style={{
                  width: `${Math.max(0, (Math.abs(it.amountMinor) / max) * 100)}%`,
                  minWidth: it.amountMinor !== 0 ? 3 : 0,
                  backgroundColor: it.colour,
                }}
              />
            </div>
          </>
        );
        return (
          <li key={it.key}>
            {it.onDrill ? (
              <button
                type="button"
                onClick={it.onDrill}
                className={cn(rowClass, 'cursor-pointer transition-colors hover:bg-surface2')}
              >
                {inner}
              </button>
            ) : it.href ? (
              <a href={it.href} className={cn(rowClass, 'transition-colors hover:bg-surface2')}>
                {inner}
              </a>
            ) : (
              <div className={rowClass}>{inner}</div>
            )}
          </li>
        );
      })}
    </ul>
  );
}
