// Onboarding step: pick starter accounts (SPEC §4, D24).
// The four ACCOUNT_TEMPLATES arrive pre-ticked and editable; extra rows can be
// added. Rows keep `currency: null` = "follow the chosen base currency" so
// changing the base on the previous step updates untouched rows automatically.
import type { Account, AccountType } from '../../db/types';
import {
  ACCOUNT_TEMPLATES,
  ACCOUNT_TYPE_LABELS,
  COMMON_CURRENCIES,
  accountFromTemplate,
  type AccountTemplate,
} from '../../db/seed';
import { cn, uid } from '../../lib/util';
import { Button, Checkbox, IconButton, Input, MoneyInput, Select } from '../kit/kit';
import { IconPlus, IconX } from '../kit/icons';

export interface AccountRowState {
  key: string; // stable React key
  template: AccountTemplate | null; // null ⇒ user-added row
  ticked: boolean;
  name: string;
  type: AccountType;
  currency: string | null; // null ⇒ follow the base currency
  openingMinor: number | null; // null ⇒ leave at 0
}

/** Entity colours for user-added accounts (same values seed.ts uses). */
const TYPE_COLOURS: Record<AccountType, string> = {
  current: '#2563eb',
  savings: '#059669',
  credit_card: '#db2777',
  cash: '#b45309',
  loan: '#dc2626',
  investment: '#7c3aed',
};

export function defaultAccountRows(): AccountRowState[] {
  return ACCOUNT_TEMPLATES.map((t, i) => ({
    key: `template-${i}`,
    template: t,
    ticked: true,
    name: t.name,
    type: t.type,
    currency: null,
    openingMinor: null,
  }));
}

/** Why the step can't continue yet, or null when it can. */
export function accountsStepError(rows: AccountRowState[]): string | null {
  const ticked = rows.filter((r) => r.ticked);
  if (ticked.length === 0) return 'Tick at least one account to continue.';
  if (ticked.some((r) => !r.name.trim())) return 'Give every ticked account a name.';
  return null;
}

/** Turn the ticked rows into Account records ready for db.accounts.bulkAdd. */
export function buildAccounts(rows: AccountRowState[], baseCurrency: string): Account[] {
  const out: Account[] = [];
  let sortOrder = 0;
  for (const row of rows) {
    if (!row.ticked) continue;
    const currency = row.currency ?? baseCurrency;
    let account: Account;
    if (row.template) {
      // Template rows go through accountFromTemplate; edits override on top.
      account = accountFromTemplate(row.template, currency, sortOrder);
      account.name = row.name.trim();
      account.openingBalanceMinor = row.openingMinor ?? 0;
    } else {
      account = {
        id: uid(),
        name: row.name.trim(),
        type: row.type,
        currency,
        openingBalanceMinor: row.openingMinor ?? 0,
        colour: TYPE_COLOURS[row.type],
        groupId: null,
        sortOrder,
        archived: false,
      };
    }
    out.push(account);
    sortOrder++;
  }
  return out;
}

export function AccountsStep({
  rows,
  onRowsChange,
  baseCurrency,
}: {
  rows: AccountRowState[];
  onRowsChange: (rows: AccountRowState[]) => void;
  baseCurrency: string;
}) {
  const patch = (key: string, changes: Partial<AccountRowState>) =>
    onRowsChange(rows.map((r) => (r.key === key ? { ...r, ...changes } : r)));

  const addRow = () =>
    onRowsChange([
      ...rows,
      {
        key: uid(),
        template: null,
        ticked: true,
        name: '',
        type: 'current',
        currency: null,
        openingMinor: null,
      },
    ]);

  const removeRow = (key: string) => onRowsChange(rows.filter((r) => r.key !== key));

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => {
        const effectiveCurrency = row.currency ?? baseCurrency;
        const colour = row.template?.colour ?? TYPE_COLOURS[row.type];
        const rowName = row.name.trim() || 'this account';
        return (
          <div
            key={row.key}
            className={cn(
              'rounded-xl border border-border bg-surface p-3 transition-opacity',
              !row.ticked && 'opacity-60',
            )}
          >
            <div className="flex items-center gap-2.5">
              <Checkbox
                label={<span className="sr-only">Include {rowName}</span>}
                checked={row.ticked}
                onChange={(v) => patch(row.key, { ticked: v })}
              />
              <span
                aria-hidden="true"
                className="h-2.5 w-2.5 shrink-0 rounded-full"
                style={{ background: colour }}
              />
              <div className="min-w-0 flex-1">
                <Input
                  value={row.name}
                  onChange={(e) => patch(row.key, { name: e.target.value })}
                  aria-label={row.template ? `Name for ${row.template.name}` : 'New account name'}
                  placeholder="Account name"
                  disabled={!row.ticked}
                  autoFocus={!row.template}
                />
              </div>
              {!row.template && (
                <IconButton label={`Remove ${rowName}`} onClick={() => removeRow(row.key)}>
                  <IconX size={16} />
                </IconButton>
              )}
            </div>
            <div className="mt-2 flex flex-wrap items-center gap-2 pl-[26px]">
              {row.template ? (
                <span className="min-w-24 flex-1 text-xs text-muted">
                  {ACCOUNT_TYPE_LABELS[row.type]}
                </span>
              ) : (
                <div className="min-w-24 flex-1">
                  <Select
                    value={row.type}
                    onChange={(e) => patch(row.key, { type: e.target.value as AccountType })}
                    aria-label={`Type for ${rowName}`}
                    disabled={!row.ticked}
                  >
                    {(Object.keys(ACCOUNT_TYPE_LABELS) as AccountType[]).map((t) => (
                      <option key={t} value={t}>
                        {ACCOUNT_TYPE_LABELS[t]}
                      </option>
                    ))}
                  </Select>
                </div>
              )}
              <div className="w-24 shrink-0">
                <Select
                  value={effectiveCurrency}
                  onChange={(e) => patch(row.key, { currency: e.target.value })}
                  aria-label={`Currency for ${rowName}`}
                  disabled={!row.ticked}
                >
                  {COMMON_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              </div>
              <div className="w-32 min-w-28 flex-1">
                <MoneyInput
                  valueMinor={row.openingMinor}
                  currency={effectiveCurrency}
                  onValue={(minor) => patch(row.key, { openingMinor: minor })}
                  placeholder="Balance (optional)"
                  aria-label={`Opening balance for ${rowName}`}
                />
              </div>
            </div>
          </div>
        );
      })}

      <Button variant="ghost" size="sm" className="self-start" onClick={addRow}>
        <IconPlus size={16} /> Add another account
      </Button>

      <p className="text-xs text-muted">
        Opening balance is what&rsquo;s in the account today — you can leave it blank. If you owe
        money on a card, enter a negative amount.
      </p>
    </div>
  );
}
