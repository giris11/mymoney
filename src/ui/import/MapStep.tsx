// Step 2 (generic CSV only) — column mapping UI (SPEC §7.2). One row per CSV
// column with samples and a field select; advanced options for date format,
// decimal style and sign flipping. The mapping is saved per file signature
// when the user continues (done by the wizard, not here).
import { useMemo } from 'react';
import { db } from '../../db/db';
import type { ColumnMapping } from '../../db/types';
import { useLive } from '../../db/useLive';
import { Button, Checkbox, Field, Select } from '../kit/kit';
import { Disclosure, WizardFooter } from './bits';

const FIELDS = [
  'date', 'amount', 'debit', 'credit', 'payee', 'description',
  'category', 'account', 'currency', 'tags', 'notes',
] as const;
type FieldKey = (typeof FIELDS)[number];

const FIELD_OPTIONS: { value: FieldKey | 'ignore'; label: string }[] = [
  { value: 'ignore', label: 'Ignore' },
  { value: 'date', label: 'Date' },
  { value: 'amount', label: 'Amount' },
  { value: 'debit', label: 'Debit (money out)' },
  { value: 'credit', label: 'Credit (money in)' },
  { value: 'payee', label: 'Payee' },
  { value: 'description', label: 'Description' },
  { value: 'category', label: 'Category' },
  { value: 'account', label: 'Account' },
  { value: 'currency', label: 'Currency' },
  { value: 'tags', label: 'Tags' },
  { value: 'notes', label: 'Notes' },
];

export function MapStep({
  headers,
  data,
  parseErrors,
  savedMappingLoaded,
  baseCurrency,
  mapping,
  onMapping,
  fixedAccountId,
  onFixedAccount,
  busy,
  onBack,
  onContinue,
  onCancel,
}: {
  headers: string[];
  data: string[][]; // raw parsed rows, header row included
  parseErrors: string[];
  savedMappingLoaded: boolean;
  baseCurrency: string;
  mapping: ColumnMapping;
  onMapping: (m: ColumnMapping) => void;
  fixedAccountId: string;
  onFixedAccount: (id: string) => void;
  busy: boolean;
  onBack: () => void;
  onContinue: () => void;
  onCancel: () => void;
}) {
  const accounts = useLive(() => db.accounts.filter((a) => !a.archived).toArray(), []);
  const sortedAccounts = useMemo(
    () =>
      [...(accounts ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [accounts],
  );

  const colCount = useMemo(
    () => Math.max(headers.length, 0, ...data.slice(0, 25).map((r) => r.length)),
    [headers, data],
  );
  const sampleRows = mapping.headerRow ? data.slice(1, 3) : data.slice(0, 2);
  const dataRowCount = Math.max(0, mapping.headerRow ? data.length - 1 : data.length);

  const fieldFor = (col: number): FieldKey | 'ignore' =>
    FIELDS.find((f) => mapping[f] === col) ?? 'ignore';

  const assign = (col: number, value: FieldKey | 'ignore') => {
    const next: ColumnMapping = { ...mapping };
    for (const f of FIELDS) if (next[f] === col) next[f] = -1;
    if (value !== 'ignore') next[value] = col;
    onMapping(next);
  };

  const fixedAccount = sortedAccounts.find((a) => a.id === fixedAccountId);
  const effectiveCurrency = fixedAccount?.currency ?? baseCurrency;

  const missing: string[] = [];
  if (mapping.date < 0) missing.push('a Date column');
  if (mapping.amount < 0 && mapping.debit < 0 && mapping.credit < 0) {
    missing.push('an Amount (or Debit/Credit) column');
  }
  if (mapping.account < 0 && !fixedAccountId) {
    missing.push('an account (pick one above, or map an Account column)');
  }

  const colLabel = (c: number): string =>
    mapping.headerRow && (headers[c] ?? '').trim() !== '' ? headers[c] : `Column ${c + 1}`;

  return (
    <div className="flex flex-col gap-4">
      {savedMappingLoaded && (
        <p className="rounded-lg bg-surface2 px-3 py-2 text-sm text-accent">
          Loaded your saved mapping for this file layout.
        </p>
      )}

      <Field
        label="Import into account"
        hint={
          mapping.account >= 0
            ? 'Optional — if chosen, it overrides the mapped Account column for every row.'
            : `Required unless you map an Account column below. Amounts without a Currency column are treated as ${effectiveCurrency}.`
        }
      >
        {(id) => (
          <Select id={id} value={fixedAccountId} onChange={(e) => onFixedAccount(e.target.value)}>
            <option value="">
              {mapping.account >= 0 ? 'Use the mapped Account column' : 'Choose an account…'}
            </option>
            {sortedAccounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name} ({a.currency})
              </option>
            ))}
          </Select>
        )}
      </Field>

      <div>
        <div className="mb-1.5 flex items-baseline justify-between">
          <h3 className="text-sm font-semibold text-text">Columns</h3>
          <span className="text-xs text-muted">{dataRowCount} data rows</span>
        </div>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[540px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface2 text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2 font-medium">Column</th>
                <th scope="col" className="px-3 py-2 font-medium">Sample values</th>
                <th scope="col" className="px-3 py-2 font-medium">Import as</th>
              </tr>
            </thead>
            <tbody>
              {Array.from({ length: colCount }, (_, c) => (
                <tr key={c} className="border-b border-border last:border-b-0">
                  <td className="max-w-[160px] truncate px-3 py-2 font-medium text-text">
                    {colLabel(c)}
                  </td>
                  <td className="px-3 py-2 text-muted">
                    {sampleRows.length === 0 && <span className="text-faint">—</span>}
                    {sampleRows.map((r, i) => (
                      <div key={i} className="max-w-[200px] truncate">
                        {(r[c] ?? '').trim() || <span className="text-faint">—</span>}
                      </div>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    <Select
                      aria-label={`Field for ${colLabel(c)}`}
                      value={fieldFor(c)}
                      onChange={(e) => assign(c, e.target.value as FieldKey | 'ignore')}
                      className="min-w-[150px]"
                    >
                      {FIELD_OPTIONS.map((o) => (
                        <option key={o.value} value={o.value}>
                          {o.label}
                        </option>
                      ))}
                    </Select>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <Disclosure title="Advanced options">
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Date format">
            {(id) => (
              <Select
                id={id}
                value={mapping.dateFormat}
                onChange={(e) =>
                  onMapping({ ...mapping, dateFormat: e.target.value as ColumnMapping['dateFormat'] })
                }
              >
                <option value="auto">Auto-detect</option>
                <option value="DMY">Day / Month / Year</option>
                <option value="MDY">Month / Day / Year</option>
                <option value="YMD">Year / Month / Day</option>
              </Select>
            )}
          </Field>
          <Field label="Decimal style">
            {(id) => (
              <Select
                id={id}
                value={mapping.decimal}
                onChange={(e) =>
                  onMapping({ ...mapping, decimal: e.target.value as ColumnMapping['decimal'] })
                }
              >
                <option value="auto">Auto-detect</option>
                <option value="dot">1,234.56</option>
                <option value="comma">1.234,56</option>
              </Select>
            )}
          </Field>
        </div>
        <div className="mt-3 flex flex-col gap-2">
          <Checkbox
            label="First row is column headers"
            checked={mapping.headerRow}
            onChange={(v) => onMapping({ ...mapping, headerRow: v })}
          />
          <Checkbox
            label={
              <span>
                Flip amount signs{' '}
                <span className="text-xs text-muted">
                  — for bank exports where money out is shown as positive
                </span>
              </span>
            }
            checked={mapping.negate}
            disabled={mapping.debit >= 0 || mapping.credit >= 0}
            onChange={(v) => onMapping({ ...mapping, negate: v })}
          />
        </div>
      </Disclosure>

      {parseErrors.length > 0 && (
        <Disclosure title="File warnings" count={parseErrors.length}>
          <ul className="flex max-h-40 flex-col gap-0.5 overflow-y-auto text-sm text-warn">
            {parseErrors.map((e, i) => (
              <li key={i}>{e}</li>
            ))}
          </ul>
        </Disclosure>
      )}

      {missing.length > 0 && (
        <p className="text-xs text-warn">Still needed: {missing.join(', ')}.</p>
      )}

      <WizardFooter left={<Button onClick={onCancel}>Cancel</Button>}>
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={busy || missing.length > 0}
          onClick={onContinue}
        >
          {busy ? 'Preparing preview…' : 'Continue'}
        </Button>
      </WizardFooter>
    </div>
  );
}
