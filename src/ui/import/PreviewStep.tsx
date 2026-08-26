// Step 3 — the MANDATORY preview (SPEC §7.4). Nothing has been written yet:
// this screen edits the ImportPlan in place (decisions, account creation,
// per-row categories) and only commitImport — triggered from here — writes.
// Plan mutations go through refreshPlanCounts + a forced re-render so the
// summary chips stay live.
import { useMemo, useReducer, useState, type ReactNode } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { formatDate, nameKey } from '../../lib/util';
import { refreshPlanCounts } from '../../import/importer';
import type { ImportPlan, ImportPlanRow, NewAccountPlan } from '../../import/types';
import { CategoryPicker } from '../kit/CategoryPicker';
import { IconTransfer } from '../kit/icons';
import { Amount, Button, Card, Checkbox, Chip, Segmented } from '../kit/kit';
import { ChipList, Disclosure, StatChip, WizardFooter, plural } from './bits';
import {
  DATE_FORMAT_OPTIONS,
  currencyMismatchNote,
  dateFormatLabel,
  exampleDateUnder,
  type ImportDateFormat,
} from './wizardLogic';

const NEAR_DUP_DISPLAY_CAP = 50;
/** A file that failed wholesale (one misread date column) has an error per row.
 *  Rendering 30,000 list items locks the tab at the exact moment the errors
 *  need reading, so the list is capped like every other section here. */
const ERROR_DISPLAY_CAP = 50;
const ROW_DISPLAY_CAP = 200;

/** What one plan.unpairedTransferCount means, in the user's terms. */
export function unpairedTransferNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 transfer leg has no matching opposite row in this file, so it imports as an ' +
        'ordinary uncategorised transaction — it will show up in your income and spending ' +
        'reports until you pair it up or categorise it.'
    : `${count} transfer legs have no matching opposite row in this file, so they import as ` +
        'ordinary uncategorised transactions — they will show up in your income and spending ' +
        'reports until you pair them up or categorise them.';
}

export function PreviewStep({
  plan,
  mwWarnings,
  baseCurrency,
  dateFormat,
  sampleDate,
  onDateFormat,
  busy,
  onBack,
  onCommit,
  onCancel,
}: {
  plan: ImportPlan;
  /** MoneyWiz parse warnings (empty for generic CSV imports). */
  mwWarnings: string[];
  baseCurrency: string;
  /** MoneyWiz only: how the date column was read — MoneyWiz files skip the Map
   *  step, so this is the user's only chance to correct an ambiguous export
   *  (D20). null for generic CSV, which sets the format in the Map step. */
  dateFormat?: ImportDateFormat | null;
  /** A real date cell from the file, spelled out under `dateFormat`. */
  sampleDate?: string | null;
  onDateFormat?: (fmt: ImportDateFormat) => void;
  busy: boolean;
  onBack: () => void;
  onCommit: () => void;
  onCancel: () => void;
}) {
  // The plan object is mutated in place (engine contract); force() re-renders.
  const [, force] = useReducer((x: number) => x + 1, 0);
  const [dateFormatOpen, setDateFormatOpen] = useState(false);

  const accounts = useLive(() => db.accounts.toArray(), []);
  const payees = useLive(() => db.payees.toArray(), []);
  const categories = useLive(() => db.categories.toArray(), []);
  const accountById = useMemo(() => new Map((accounts ?? []).map((a) => [a.id, a])), [accounts]);
  const payeeNameById = useMemo(() => new Map((payees ?? []).map((p) => [p.id, p.name])), [payees]);
  const categoryNameById = useMemo(
    () => new Map((categories ?? []).map((c) => [c.id, c.name])),
    [categories],
  );

  const currencyOf = (pr: ImportPlanRow): string =>
    pr.row.currency ??
    (pr.accountId
      ? accountById.get(pr.accountId)?.currency
      : plan.newAccounts.find((n) => nameKey(n.name) === nameKey(pr.row.accountName ?? ''))
          ?.currency) ??
    baseCurrency;

  /** Display-only mirror of the engine's effective-import rule. */
  const willImport = (pr: ImportPlanRow): boolean => {
    if (pr.action === 'error' || pr.action === 'skip_exact_duplicate') return false;
    if (pr.action === 'needs_decision' && pr.decision !== 'import') return false;
    if (pr.accountId) return true;
    const na = plan.newAccounts.find((n) => nameKey(n.name) === nameKey(pr.row.accountName ?? ''));
    return na?.create === true;
  };

  const decide = (pr: ImportPlanRow, d: 'import' | 'skip') => {
    pr.decision = d;
    refreshPlanCounts(plan);
    force();
  };
  const decideAll = (d: 'import' | 'skip') => {
    for (const pr of plan.rows) if (pr.action === 'needs_decision') pr.decision = d;
    refreshPlanCounts(plan);
    force();
  };
  const toggleAccount = (na: NewAccountPlan, v: boolean) => {
    na.create = v;
    refreshPlanCounts(plan);
    force();
  };
  const setCategory = (pr: ImportPlanRow, id: string | null) => {
    pr.chosenCategoryId = id;
    force();
  };

  // One worked example of the file's own dates under the current reading, so
  // an ambiguous export (03/04 is either) can be checked at a glance.
  const dateExample = dateFormat ? exampleDateUnder(sampleDate ?? null, dateFormat) : null;
  const currencyNote = currencyMismatchNote(plan.currencyMismatchCount);
  const unpairedNote = unpairedTransferNote(plan.unpairedTransferCount);

  const nearRows = plan.rows.filter((pr) => pr.action === 'needs_decision');
  const errorRows = plan.rows.filter((pr) => pr.action === 'error');
  const newEntityCount =
    plan.newAccounts.length +
    plan.newCategoryPaths.length +
    plan.newPayees.length +
    plan.newTags.length;

  const statusChip = (pr: ImportPlanRow): ReactNode => {
    if (pr.action === 'error') return <StatChip tone="danger">error</StatChip>;
    if (pr.action === 'skip_exact_duplicate') return <StatChip>duplicate — skipped</StatChip>;
    if (pr.action === 'needs_decision') {
      return (
        <StatChip tone="warn">
          {pr.decision === 'import' ? 'near-dup — importing' : 'near-dup — skipped'}
        </StatChip>
      );
    }
    if (!willImport(pr)) return <StatChip>account not created</StatChip>;
    // Mirrors the engine's unpairedTransferCount rule, so the summary chip's
    // number can be traced to the actual rows — and they are exactly the rows
    // where setting a category in this table is the fix.
    if (pr.row.transferAccountName) {
      const partner =
        pr.transferPairIndex !== undefined ? plan.rows[pr.transferPairIndex] : undefined;
      if (partner === undefined || !willImport(partner)) {
        return <StatChip tone="warn">unpaired transfer</StatChip>;
      }
    }
    return null;
  };

  const categoryCell = (pr: ImportPlanRow): ReactNode => {
    if (pr.action === 'error') return <span className="text-faint">—</span>;
    if (pr.transferPairIndex !== undefined) {
      return (
        <StatChip tone="accent">
          <IconTransfer size={12} /> transfer
        </StatChip>
      );
    }
    const isNewPath = pr.chosenCategoryId == null && pr.row.categoryPath.length > 0;
    if (isNewPath) {
      return (
        <span className="flex items-center gap-1.5 text-sm text-text">
          <span className="truncate">{pr.row.categoryPath.join(' › ')}</span>
          <Chip>new</Chip>
        </span>
      );
    }
    if (pr.action === 'skip_exact_duplicate') {
      return (
        <span className="text-muted">
          {pr.chosenCategoryId
            ? (categoryNameById.get(pr.chosenCategoryId) ?? 'Unknown category')
            : '—'}
        </span>
      );
    }
    return (
      <div className="flex min-w-[190px] items-center gap-1.5">
        <div className="min-w-0 flex-1">
          <CategoryPicker
            value={pr.chosenCategoryId ?? null}
            onChange={(id) => setCategory(pr, id)}
            placeholder="No category"
          />
        </div>
        {pr.suggestedCategoryId != null && pr.chosenCategoryId === pr.suggestedCategoryId && (
          <StatChip tone="accent">suggested</StatChip>
        )}
      </div>
    );
  };

  return (
    <div className="flex flex-col gap-4">
      {plan.source === 'moneywiz' && (
        <Card className="p-3">
          <p className="text-sm font-medium text-text">
            MoneyWiz export detected{' '}
            <span className="font-normal text-muted">— {plural(plan.rows.length, 'row')}</span>
          </p>
          {dateFormat && onDateFormat && (
            <div className="mt-1.5">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm text-muted">
                <span>
                  Dates read as{' '}
                  <span className="font-medium text-text">{dateFormatLabel(dateFormat)}</span>
                  {dateExample && (
                    <>
                      {' '}— “{sampleDate}” is{' '}
                      <span className="text-text">{dateExample}</span>
                    </>
                  )}
                </span>
                <Button
                  size="sm"
                  aria-expanded={dateFormatOpen}
                  onClick={() => setDateFormatOpen((o) => !o)}
                >
                  {dateFormatOpen ? 'Done' : 'Change'}
                </Button>
              </div>
              {dateFormatOpen && (
                <div className="mt-1.5">
                  <Segmented<ImportDateFormat>
                    label="How dates in this file are read"
                    value={dateFormat}
                    onChange={(f) => {
                      if (!busy && f !== dateFormat) onDateFormat(f);
                    }}
                    options={DATE_FORMAT_OPTIONS.map((o) => ({
                      value: o.value,
                      label: o.label,
                    }))}
                  />
                  <p className="mt-1 text-xs text-muted">
                    Re-reads the whole file — near-duplicate decisions start over.
                  </p>
                </div>
              )}
            </div>
          )}
          {mwWarnings.length > 0 && (
            <ul className="mt-1.5 flex max-h-32 list-disc flex-col gap-0.5 overflow-y-auto pl-5 text-xs text-warn">
              {mwWarnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          )}
        </Card>
      )}

      <div>
        <p className="mb-1.5 text-xs text-muted">
          Previewing <span className="font-medium text-text">{plan.fileName}</span> — nothing has
          been written yet.
        </p>
        <div className="flex flex-wrap gap-1.5" role="status">
          <StatChip>{plural(plan.rows.length, 'row')} in file</StatChip>
          <StatChip tone="pos">will import {plan.importableCount}</StatChip>
          {plan.exactDuplicateCount > 0 && (
            <StatChip>
              {plural(plan.exactDuplicateCount, 'exact duplicate')} auto-skipped
            </StatChip>
          )}
          {plan.nearDuplicateCount > 0 && (
            <StatChip tone="warn">
              {plural(plan.nearDuplicateCount, 'near-duplicate')} need your decision
            </StatChip>
          )}
          {plan.unpairedTransferCount > 0 && (
            <StatChip tone="warn">
              {plural(plan.unpairedTransferCount, 'unpaired transfer leg')}
            </StatChip>
          )}
          {plan.errorCount > 0 && (
            <StatChip tone="danger">{plural(plan.errorCount, 'error')}</StatChip>
          )}
        </div>
        {unpairedNote && <p className="mt-1.5 text-sm text-warn">{unpairedNote}</p>}
        {currencyNote && <p className="mt-1.5 text-sm text-warn">{currencyNote}</p>}
      </div>

      {newEntityCount > 0 && (
        <section aria-label="New entities" className="flex flex-col gap-2">
          <h3 className="text-sm font-semibold text-text">Will be created</h3>
          {plan.newAccounts.length > 0 && (
            <Disclosure title="New accounts" count={plan.newAccounts.length} defaultOpen>
              <div className="flex flex-col gap-1.5">
                {plan.newAccounts.map((na) => (
                  <Checkbox
                    key={na.name}
                    checked={na.create}
                    onChange={(v) => toggleAccount(na, v)}
                    label={
                      <span className="flex items-center gap-1.5">
                        Create <span className="font-medium">{na.name}</span>
                        <Chip>{na.currency}</Chip>
                      </span>
                    }
                  />
                ))}
              </div>
              <p className="mt-2 text-xs text-muted">
                Unticked accounts are not created and their rows are not imported.
              </p>
            </Disclosure>
          )}
          {plan.newCategoryPaths.length > 0 && (
            <Disclosure title="New categories" count={plan.newCategoryPaths.length}>
              <ChipList items={plan.newCategoryPaths.map((p) => p.join(' › '))} />
            </Disclosure>
          )}
          {plan.newPayees.length > 0 && (
            <Disclosure title="New payees" count={plan.newPayees.length}>
              <ChipList items={plan.newPayees} />
            </Disclosure>
          )}
          {plan.newTags.length > 0 && (
            <Disclosure title="New tags" count={plan.newTags.length}>
              <ChipList items={plan.newTags} />
            </Disclosure>
          )}
        </section>
      )}

      {nearRows.length > 0 && (
        <section aria-label="Near-duplicates" className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="text-sm font-semibold text-text">Near-duplicates — your call</h3>
            <div className="flex gap-1.5">
              <Button size="sm" onClick={() => decideAll('skip')}>
                Skip all
              </Button>
              <Button size="sm" onClick={() => decideAll('import')}>
                Import all
              </Button>
            </div>
          </div>
          <p className="text-xs text-muted">
            These look like transactions you already have (same amount, date within a day, similar
            payee). Skipped unless you say otherwise.
          </p>
          {nearRows.slice(0, NEAR_DUP_DISPLAY_CAP).map((pr) => {
            const existing = pr.nearDuplicateOf;
            const existingAccount = existing ? accountById.get(existing.accountId) : undefined;
            const existingPayee =
              existing?.payeeId != null
                ? (payeeNameById.get(existing.payeeId) ?? null)
                : null;
            return (
              <Card key={pr.row.index} className="p-3">
                <div className="grid gap-3 sm:grid-cols-2">
                  <div>
                    <div className="text-xs uppercase tracking-wide text-faint">
                      Importing (row {pr.row.index})
                    </div>
                    <div className="mt-1 truncate text-sm text-text">
                      {pr.row.date ? formatDate(pr.row.date) : '—'} ·{' '}
                      {pr.row.payeeName ?? pr.row.description ?? '—'}
                    </div>
                    {pr.row.amountMinor !== null && (
                      <Amount
                        minor={pr.row.amountMinor}
                        currency={currencyOf(pr)}
                        signColour
                        className="text-sm font-medium"
                      />
                    )}
                  </div>
                  <div>
                    <div className="text-xs uppercase tracking-wide text-faint">Existing</div>
                    {existing ? (
                      <>
                        <div className="mt-1 truncate text-sm text-text">
                          {formatDate(existing.date)} ·{' '}
                          {existingPayee ?? existing.notes ?? '—'}
                        </div>
                        <div className="flex items-center gap-2">
                          <Amount
                            minor={existing.amountMinor}
                            currency={existing.currency}
                            signColour
                            className="text-sm font-medium"
                          />
                          {existingAccount && (
                            <span className="truncate text-xs text-muted">
                              {existingAccount.name}
                            </span>
                          )}
                        </div>
                      </>
                    ) : (
                      <div className="mt-1 text-sm text-faint">—</div>
                    )}
                  </div>
                </div>
                <div className="mt-2.5">
                  <Segmented<'skip' | 'import'>
                    label={`Decision for row ${pr.row.index}`}
                    value={pr.decision === 'import' ? 'import' : 'skip'}
                    onChange={(d) => decide(pr, d)}
                    options={[
                      { value: 'skip', label: 'Skip' },
                      { value: 'import', label: 'Import anyway' },
                    ]}
                  />
                </div>
              </Card>
            );
          })}
          {nearRows.length > NEAR_DUP_DISPLAY_CAP && (
            <p className="text-xs text-muted">
              …and {nearRows.length - NEAR_DUP_DISPLAY_CAP} more — use the buttons above to decide
              in bulk.
            </p>
          )}
        </section>
      )}

      {errorRows.length > 0 && (
        <Disclosure title="Rows with errors (not imported)" count={errorRows.length}>
          <ul className="flex max-h-48 flex-col gap-0.5 overflow-y-auto text-sm">
            {errorRows.slice(0, ERROR_DISPLAY_CAP).map((pr) => (
              <li key={pr.row.index}>
                <span className="text-muted">Row {pr.row.index}:</span>{' '}
                <span className="text-danger">{pr.row.error ?? 'Unparseable row'}</span>
              </li>
            ))}
          </ul>
          {errorRows.length > ERROR_DISPLAY_CAP && (
            <p className="mt-1.5 text-xs text-muted">
              …and {errorRows.length - ERROR_DISPLAY_CAP} more — they all failed the same way if
              the file's date or amount column was read wrongly.
            </p>
          )}
        </Disclosure>
      )}

      <section aria-label="Rows preview">
        <h3 className="mb-1.5 text-sm font-semibold text-text">Rows</h3>
        <div className="overflow-x-auto rounded-lg border border-border">
          <table className="w-full min-w-[640px] text-sm">
            <thead>
              <tr className="border-b border-border bg-surface2 text-left text-xs uppercase tracking-wide text-muted">
                <th scope="col" className="px-3 py-2 font-medium">#</th>
                <th scope="col" className="px-3 py-2 font-medium">Date</th>
                <th scope="col" className="px-3 py-2 font-medium">Payee</th>
                <th scope="col" className="px-3 py-2 font-medium">Category</th>
                <th scope="col" className="px-3 py-2 text-right font-medium">Amount</th>
                <th scope="col" className="px-3 py-2 font-medium">
                  <span className="sr-only">Status</span>
                </th>
              </tr>
            </thead>
            <tbody>
              {plan.rows.slice(0, ROW_DISPLAY_CAP).map((pr) => (
                <tr
                  key={pr.row.index}
                  className={`border-b border-border last:border-b-0 ${willImport(pr) ? '' : 'opacity-60'}`}
                >
                  <td className="tnum px-3 py-1.5 text-muted">{pr.row.index}</td>
                  <td className="whitespace-nowrap px-3 py-1.5 text-text">
                    {pr.row.date ? formatDate(pr.row.date) : <span className="text-faint">—</span>}
                  </td>
                  <td className="px-3 py-1.5">
                    <div className="max-w-[220px]">
                      <div className="truncate text-text">
                        {pr.row.payeeName ?? pr.row.description ?? (
                          <span className="text-faint">—</span>
                        )}
                      </div>
                      {pr.row.payeeName &&
                        pr.row.description &&
                        pr.row.description !== pr.row.payeeName && (
                          <div className="truncate text-xs text-muted">{pr.row.description}</div>
                        )}
                    </div>
                  </td>
                  <td className="px-3 py-1.5">{categoryCell(pr)}</td>
                  <td className="tnum whitespace-nowrap px-3 py-1.5 text-right">
                    {pr.row.amountMinor === null ? (
                      <span className="text-faint">—</span>
                    ) : (
                      <Amount minor={pr.row.amountMinor} currency={currencyOf(pr)} signColour />
                    )}
                  </td>
                  <td className="px-3 py-1.5">{statusChip(pr)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {plan.rows.length > ROW_DISPLAY_CAP && (
          <p className="mt-1.5 text-xs text-muted">
            …and {plan.rows.length - ROW_DISPLAY_CAP} more rows
          </p>
        )}
      </section>

      <WizardFooter left={<Button onClick={onCancel}>Cancel</Button>}>
        <Button onClick={onBack} disabled={busy}>
          Back
        </Button>
        <Button
          variant="primary"
          disabled={busy || plan.importableCount === 0}
          onClick={onCommit}
        >
          {busy
            ? 'Importing…'
            : `Import ${plural(plan.importableCount, 'transaction')}`}
        </Button>
      </WizardFooter>
    </div>
  );
}
