// Small shared pieces for the import wizard (local to src/ui/import only).
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/util';
import { IconCheck, IconChevronDown } from '../kit/icons';
import { Chip } from '../kit/kit';

export const errMsg = (e: unknown): string =>
  e instanceof Error ? e.message : String(e);

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export const plural = (n: number, singular: string, pluralForm?: string): string =>
  `${n} ${n === 1 ? singular : (pluralForm ?? `${singular}s`)}`;

// ---------------------------------------------------------------- Steps
export interface StepDef {
  key: string;
  label: string;
}

/** File → Map → Preview → Done indicator (Map dropped for MoneyWiz files). */
export function StepIndicator({ steps, current }: { steps: StepDef[]; current: string }) {
  const idx = steps.findIndex((s) => s.key === current);
  return (
    <nav aria-label="Import steps">
      <ol className="flex items-center gap-1.5 sm:gap-2">
        {steps.map((s, i) => {
          const state = i < idx ? 'done' : i === idx ? 'current' : 'todo';
          return (
            <li
              key={s.key}
              aria-current={state === 'current' ? 'step' : undefined}
              className="flex items-center gap-1.5 sm:gap-2"
            >
              {i > 0 && <span aria-hidden="true" className="h-px w-3 bg-border sm:w-6" />}
              <span
                aria-hidden="true"
                className={cn(
                  'flex h-5 w-5 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold',
                  state === 'done' && 'bg-accent text-on-accent',
                  state === 'current' && 'border border-accent text-accent',
                  state === 'todo' && 'border border-border text-faint',
                )}
              >
                {state === 'done' ? <IconCheck size={12} /> : i + 1}
              </span>
              <span
                className={cn(
                  'text-xs sm:text-sm',
                  state === 'current' && 'font-semibold text-text',
                  state === 'done' && 'text-muted',
                  state === 'todo' && 'text-faint',
                )}
              >
                {s.label}
              </span>
            </li>
          );
        })}
      </ol>
    </nav>
  );
}

// ---------------------------------------------------------------- Footer
/** Cancel on the left, Back/Continue on the right — same shape on every step. */
export function WizardFooter({ left, children }: { left?: ReactNode; children?: ReactNode }) {
  return (
    <div className="mt-1 flex items-center justify-between gap-2 border-t border-border pt-3">
      <div className="flex gap-2">{left}</div>
      <div className="flex gap-2">{children}</div>
    </div>
  );
}

// ---------------------------------------------------------------- Disclosure
export function Disclosure({
  title,
  count,
  defaultOpen = false,
  children,
}: {
  title: ReactNode;
  count?: number;
  defaultOpen?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(defaultOpen);
  return (
    <div className="rounded-lg border border-border bg-surface">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full cursor-pointer items-center justify-between gap-2 px-3 py-2 text-left text-sm font-medium text-text"
      >
        <span className="flex items-center gap-2">
          {title}
          {count !== undefined && <Chip>{count}</Chip>}
        </span>
        <IconChevronDown
          size={16}
          className={cn('shrink-0 text-faint transition-transform', open && 'rotate-180')}
        />
      </button>
      {open && <div className="border-t border-border px-3 py-2.5">{children}</div>}
    </div>
  );
}

// ---------------------------------------------------------------- StatChip
/** Chip with a meaningful colour — used for summary counts and row badges.
 *  (Local rather than styling kit Chip: overriding its text-muted via
 *  className would depend on utility order in the generated CSS.) */
export function StatChip({
  tone,
  children,
}: {
  tone?: 'pos' | 'warn' | 'danger' | 'accent';
  children: ReactNode;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1 whitespace-nowrap rounded-full bg-surface2 px-2.5 py-1 text-xs font-medium',
        tone === 'pos' && 'text-pos',
        tone === 'warn' && 'text-warn',
        tone === 'danger' && 'text-danger',
        tone === 'accent' && 'text-accent',
        !tone && 'text-muted',
      )}
    >
      {children}
    </span>
  );
}

export function ChipList({ items }: { items: string[] }) {
  return (
    <div className="flex max-h-40 flex-wrap gap-1.5 overflow-y-auto">
      {items.map((it) => (
        <Chip key={it}>{it}</Chip>
      ))}
    </div>
  );
}
