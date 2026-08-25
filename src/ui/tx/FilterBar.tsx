// Register filter panel (SPEC §8.1.2: date range, account, category, payee,
// tag, amount range, status). Behind the page's "Filters" disclosure on every
// breakpoint (an always-open panel starves the register of height on smaller
// windows), and capped at half the viewport so the list always has room.
// The search input itself lives in the page header.
import type { Account, Tag } from '../../db/types';
import { cn } from '../../lib/util';
import { Button, Field, MoneyInput, Segmented, Select } from '../kit/kit';
import { CategoryPicker } from '../kit/CategoryPicker';
import { PayeeInput } from '../kit/PayeeInput';
import { DateRangePicker } from '../kit/DateRangePicker';
import type { FilterState, StatusFilter } from './txShared';

export function FilterBar({
  value,
  onPatch,
  accounts,
  tags,
  baseCurrency,
  expanded,
  anyActive,
  onClearAll,
}: {
  value: FilterState;
  onPatch: (patch: Partial<FilterState>) => void;
  accounts: Account[];
  tags: Tag[];
  baseCurrency: string;
  /** Disclosure state (all breakpoints). */
  expanded: boolean;
  anyActive: boolean;
  onClearAll: () => void;
}) {
  return (
    <div
      className={cn(
        'max-h-[50dvh] flex-col gap-3 overflow-y-auto rounded-xl border border-border bg-surface p-3',
        expanded ? 'flex' : 'hidden',
      )}
    >
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
        <Field label="Account">
          {(id) => (
            <Select
              id={id}
              value={value.accountId}
              onChange={(e) => onPatch({ accountId: e.target.value })}
            >
              <option value="">All accounts</option>
              {accounts.map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name}
                  {a.archived ? ' — archived' : ''}
                </option>
              ))}
            </Select>
          )}
        </Field>
        <Field label="Category">
          {(id) => (
            <CategoryPicker
              id={id}
              value={value.categoryId}
              onChange={(categoryId) => onPatch({ categoryId })}
              placeholder="All categories"
            />
          )}
        </Field>
        <Field label="Payee">
          {(id) => (
            <PayeeInput
              id={id}
              value={value.payeeText}
              placeholder="All payees"
              onChange={(payeeText) => onPatch({ payeeText, payeeId: null })}
              onPick={(p) => onPatch({ payeeText: p.name, payeeId: p.id })}
            />
          )}
        </Field>
        <Field label="Tag">
          {(id) => (
            <Select id={id} value={value.tagId} onChange={(e) => onPatch({ tagId: e.target.value })}>
              <option value="">All tags</option>
              {[...tags]
                .sort((a, b) => a.name.localeCompare(b.name))
                .map((t) => (
                  <option key={t.id} value={t.id}>
                    {t.name}
                  </option>
                ))}
            </Select>
          )}
        </Field>
        <Field label="Min amount" hint="Ignores +/− sign">
          {(id) => (
            <MoneyInput
              id={id}
              valueMinor={value.minMinor}
              currency={baseCurrency}
              placeholder="Any"
              onValue={(minMinor) => onPatch({ minMinor })}
            />
          )}
        </Field>
        <Field label="Max amount" hint="Ignores +/− sign">
          {(id) => (
            <MoneyInput
              id={id}
              valueMinor={value.maxMinor}
              currency={baseCurrency}
              placeholder="Any"
              onValue={(maxMinor) => onPatch({ maxMinor })}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1 sm:col-span-2">
          <span className="text-sm font-medium text-text">Status</span>
          <Segmented<StatusFilter>
            label="Status filter"
            className="self-start"
            value={value.status}
            onChange={(status) => onPatch({ status })}
            options={[
              { value: 'all', label: 'All' },
              { value: 'cleared', label: 'Cleared' },
              { value: 'pending', label: 'Pending' },
            ]}
          />
        </div>
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-sm font-medium text-text">Date range</span>
        <DateRangePicker
          value={value.range ?? { from: '', to: '' }}
          onChange={(range) => onPatch({ range })}
        />
        {!value.range && (
          <p className="text-xs text-muted">Showing all dates — pick a preset or dates to narrow.</p>
        )}
      </div>
      <div className="flex justify-end">
        <Button size="sm" variant="ghost" onClick={onClearAll} disabled={!anyActive}>
          Clear all filters
        </Button>
      </div>
    </div>
  );
}
