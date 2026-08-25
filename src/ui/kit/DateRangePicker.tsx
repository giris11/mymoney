// Shared date-range picker for reports/register: preset chips + custom dates.
import { useState } from 'react';
import dayjs from 'dayjs';
import { db } from '../../db/db';
import { todayISO, cn } from '../../lib/util';
import { Input } from './kit';

export interface DateRangeValue {
  from: string; // 'YYYY-MM-DD' inclusive
  to: string; // inclusive
}

type PresetKey =
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_12_months'
  | 'this_year'
  | 'all_time';

const PRESETS: { key: PresetKey; label: string }[] = [
  { key: 'this_month', label: 'This month' },
  { key: 'last_month', label: 'Last month' },
  { key: 'last_3_months', label: '3 months' },
  { key: 'last_12_months', label: '12 months' },
  { key: 'this_year', label: 'This year' },
  { key: 'all_time', label: 'All time' },
];

export async function presetRange(key: PresetKey): Promise<DateRangeValue> {
  const today = dayjs(todayISO());
  switch (key) {
    case 'this_month':
      return { from: today.startOf('month').format('YYYY-MM-DD'), to: todayISO() };
    case 'last_month': {
      const lm = today.subtract(1, 'month');
      return {
        from: lm.startOf('month').format('YYYY-MM-DD'),
        to: lm.endOf('month').format('YYYY-MM-DD'),
      };
    }
    case 'last_3_months':
      return { from: today.subtract(3, 'month').add(1, 'day').format('YYYY-MM-DD'), to: todayISO() };
    case 'last_12_months':
      return { from: today.subtract(12, 'month').add(1, 'day').format('YYYY-MM-DD'), to: todayISO() };
    case 'this_year':
      return { from: today.startOf('year').format('YYYY-MM-DD'), to: todayISO() };
    case 'all_time': {
      const earliest = await db.transactions.orderBy('date').first();
      return { from: earliest?.date ?? today.startOf('year').format('YYYY-MM-DD'), to: todayISO() };
    }
  }
}

export function defaultRange(): DateRangeValue {
  const today = dayjs(todayISO());
  return { from: today.startOf('month').format('YYYY-MM-DD'), to: todayISO() };
}

export function DateRangePicker({
  value,
  onChange,
  initialActive = null,
  className,
}: {
  value: DateRangeValue;
  onChange: (v: DateRangeValue) => void;
  /** Which preset chip starts highlighted (when the caller's initial value
   *  came from that preset). Default: none lit until the user picks one. */
  initialActive?: PresetKey | 'custom' | null;
  className?: string;
}) {
  const [active, setActive] = useState<PresetKey | 'custom' | null>(initialActive);
  return (
    <div className={cn('flex flex-wrap items-center gap-2', className)}>
      <div className="flex flex-wrap gap-1" role="group" aria-label="Date range presets">
        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            aria-pressed={active === p.key}
            onClick={async () => {
              setActive(p.key);
              onChange(await presetRange(p.key));
            }}
            className={cn(
              'rounded-full border px-3 py-1 text-xs font-medium cursor-pointer transition-colors',
              active === p.key
                ? 'border-accent bg-accent text-on-accent'
                : 'border-border bg-surface text-muted hover:text-text',
            )}
          >
            {p.label}
          </button>
        ))}
      </div>
      <div className="flex items-center gap-1.5">
        <label className="sr-only" htmlFor="range-from">
          From date
        </label>
        <Input
          id="range-from"
          type="date"
          className="w-auto py-1 text-xs"
          value={value.from}
          max={value.to}
          onChange={(e) => {
            if (!e.target.value) return;
            setActive('custom');
            onChange({ ...value, from: e.target.value });
          }}
        />
        <span className="text-xs text-faint">to</span>
        <label className="sr-only" htmlFor="range-to">
          To date
        </label>
        <Input
          id="range-to"
          type="date"
          className="w-auto py-1 text-xs"
          value={value.to}
          min={value.from}
          onChange={(e) => {
            if (!e.target.value) return;
            setActive('custom');
            onChange({ ...value, to: e.target.value });
          }}
        />
      </div>
    </div>
  );
}
