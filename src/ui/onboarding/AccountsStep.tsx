// Onboarding step: pick starter accounts (SPEC §4, D24).
// The four ACCOUNT_TEMPLATES arrive pre-ticked and editable; extra rows can be
// added. Rows keep `currency: null` = "follow the chosen base currency" so
// changing the base on the previous step updates untouched rows automatically.
//
// Opening balances are held as the TEXT the user typed, not as parsed minor
// units. That is deliberate: the parser refuses "12.345", "1e6" and 20-digit
// numbers, and a `number | null` row could not tell "left blank" (means zero)
// apart from "typed something the parser rejected" (must block) — so a rejected
// balance used to be stored as 0.00 while the user's text sat on screen, under
// the one figure every future balance of that account is built on.
import type { Account, AccountType } from '../../db/types';
import {
  ACCOUNT_TEMPLATES,
  ACCOUNT_TYPE_LABELS,
  COMMON_CURRENCIES,
  accountFromTemplate,
  type AccountTemplate,
} from '../../db/seed';
import { decimalsFor } from '../../money/money';
import { cn, uid } from '../../lib/util';
import { Button, Checkbox, IconButton, Input, Select, moneyTextToMinor } from '../kit/kit';
import { IconPlus, IconX } from '../kit/icons';

export interface AccountRowState {
  key: string; // stable React key
  template: AccountTemplate | null; // null ⇒ user-added row
  ticked: boolean;
  name: string;
  type: AccountType;
  currency: string | null; // null ⇒ follow the base currency
  openingText: string; // exactly what the user typed; '' ⇒ zero
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
    openingText: '',
  }));
}

/** An example amount in the shape this currency accepts ("1234.56", "1234"). */
function exampleAmount(currency: string): string {
  const decimals = decimalsFor(currency);
  return decimals === 0 ? '1234' : `1234.${'567'.slice(0, decimals)}`;
}

/**
 * Why this opening balance can't be used, in the importer's plain style, or
 * null when it can. Blank is always fine — it means zero. Anything the money
 * parser refuses must be reported, never quietly turned into 0.00.
 */
export function openingBalanceProblem(text: string, currency: string): string | null {
  const trimmed = text.trim();
  if (trimmed === '') return null;
  if (moneyTextToMinor(trimmed, currency) !== null) return null;

  // Classify the refusal so the message says what to change.
  const bare = trimmed.replace(/[£$€¥₹\s,]/g, '').replace(/^\((.*)\)$/, '-$1');
  const decimals = decimalsFor(currency);
  const numeric = /^[-+]?(\d*)(?:\.(\d*))?$/.exec(bare);
  if (numeric && (numeric[1] !== '' || (numeric[2] ?? '') !== '')) {
    const frac = numeric[2] ?? '';
    if (frac.length > decimals) {
      return decimals === 0
        ? `${currency} amounts don’t have decimal places.`
        : `${currency} amounts have at most ${decimals} decimal place${decimals === 1 ? '' : 's'}.`;
    }
    return 'That number is too large to store.';
  }
  return `“${trimmed}” isn’t an amount — try something like ${exampleAmount(currency)}.`;
}

/** The opening balance a row will create, or null if it can't be read. */
export function rowOpeningMinor(row: AccountRowState, baseCurrency: string): number | null {
  const currency = row.currency ?? baseCurrency;
  if (row.openingText.trim() === '') return 0;
  return moneyTextToMinor(row.openingText, currency);
}

/** Why the step can't continue yet, or null when it can. */
export function accountsStepError(
  rows: AccountRowState[],
  baseCurrency: string,
  opts: { hasExistingAccounts?: boolean } = {},
): string | null {
  // Accounts already on the device (an earlier, interrupted run of this very
  // wizard, or an import that created them) are kept as they are — this step
  // creates nothing, so it has nothing to validate.
  if (opts.hasExistingAccounts) return null;
  const ticked = rows.filter((r) => r.ticked);
  if (ticked.length === 0) return 'Tick at least one account to continue.';
  if (ticked.some((r) => !r.name.trim())) return 'Give every ticked account a name.';
  for (const row of ticked) {
    const problem = openingBalanceProblem(row.openingText, row.currency ?? baseCurrency);
    if (problem) return `Opening balance for ${row.name.trim()} — ${problem}`;
  }
  return null;
}

/**
 * Turn the ticked rows into Account records ready for db.accounts.bulkAdd.
 * Throws rather than defaulting an unreadable balance to zero: the UI blocks
 * this case already, so reaching here means the guard was bypassed, and a
 * wrong opening balance is worse than a visible error (SPEC §6).
 */
export function buildAccounts(rows: AccountRowState[], baseCurrency: string): Account[] {
  const out: Account[] = [];
  let sortOrder = 0;
  for (const row of rows) {
    if (!row.ticked) continue;
    const currency = row.currency ?? baseCurrency;
    const problem = openingBalanceProblem(row.openingText, currency);
    if (problem) {
      throw new Error(`Opening balance for ${row.name.trim() || 'this account'} — ${problem}`);
    }
    const openingBalanceMinor = rowOpeningMinor(row, baseCurrency) ?? 0;
    let account: Account;
    if (row.template) {
      // Template rows go through accountFromTemplate; edits override on top.
      account = accountFromTemplate(row.template, currency, sortOrder);
      account.name = row.name.trim();
      account.openingBalanceMinor = openingBalanceMinor;
    } else {
      account = {
        id: uid(),
        name: row.name.trim(),
        type: row.type,
        currency,
        openingBalanceMinor,
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
  existingAccounts = 0,
}: {
  rows: AccountRowState[];
  onRowsChange: (rows: AccountRowState[]) => void;
  baseCurrency: string;
  /** Accounts already on this device — see the note below. */
  existingAccounts?: number;
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
        openingText: '',
      },
    ]);

  const removeRow = (key: string) => onRowsChange(rows.filter((r) => r.key !== key));

  // Onboarding is retryable: `onboarded` is written last, so a reload or a
  // closed tab mid-way lands the user back here with the earlier run's accounts
  // already on disk. Those are kept untouched — offering the starter set again
  // is what used to double every opening balance.
  if (existingAccounts > 0) {
    return (
      <div className="rounded-xl border border-border bg-surface2 p-4">
        <p className="text-sm text-text">
          You already have {existingAccounts} account{existingAccounts === 1 ? '' : 's'} on this
          device, so there&rsquo;s nothing to set up here.
        </p>
        <p className="mt-2 text-sm text-muted">
          They&rsquo;re kept exactly as they are — nothing on this screen will change or duplicate
          them. You can add, rename or archive accounts any time in Settings.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2.5">
      {rows.map((row) => {
        const effectiveCurrency = row.currency ?? baseCurrency;
        const colour = row.template?.colour ?? TYPE_COLOURS[row.type];
        const rowName = row.name.trim() || 'this account';
        // Shown only once there is a digit to judge: a lone "-" on the way to
        // "-250.25" is someone typing, not a mistake. Continue stays disabled
        // either way — accountsStepError has the final say.
        const problem =
          row.ticked && /\d/.test(row.openingText)
            ? openingBalanceProblem(row.openingText, effectiveCurrency)
            : null;
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
                {/* Plain text field, not MoneyInput: the row keeps the typed
                    text so "blank" and "unreadable" stay distinguishable. */}
                <Input
                  inputMode="decimal"
                  className="tnum"
                  value={row.openingText}
                  onChange={(e) => patch(row.key, { openingText: e.target.value })}
                  placeholder="Balance (optional)"
                  aria-label={`Opening balance for ${rowName}`}
                  aria-invalid={problem ? true : undefined}
                  disabled={!row.ticked}
                />
              </div>
            </div>
            {problem && <p className="mt-1.5 pl-[26px] text-xs text-danger">{problem}</p>}
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
