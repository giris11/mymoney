// The accounts panel of the MANDATORY preview, shown for MoneyWiz *Report*
// imports (SPEC §7.4).
//
// This is the screen where the whole import is judged. A report export states
// a closing balance for every account; the engine derives each opening balance
// from it, and SPEC §6 says the account will then read
// opening + Σ(its transactions). So the honest thing to show is not a summary
// but the arithmetic itself, per account, with the file's own figure beside
// it: opening, what is being added, what the account will read afterwards, and
// what the file said it should read. If those last two differ, the difference
// is stated rather than rounded away — a preview that says "looks fine" and
// then lands 3p out is worse than one that says "3p out".
//
// Every account in the file appears, including ones with no transactions and
// ones that already exist here, because "my account is missing" is exactly the
// question this panel has to answer before he commits.
import { useState } from 'react';
import { formatMinor } from '../../money/money';
import { Amount, Card, Checkbox, Chip } from '../kit/kit';
import { IconAlert } from '../kit/icons';
import { StatChip, plural } from './bits';
import {
  existingAccountsNote,
  linesUp,
  needsAttention,
  reportAccountSummary,
  type ReportAccountLine,
} from './reportFormat';

/** Balance figures are never sign-coloured: a credit card sitting at −£420 is
 *  not an error, and painting it red on the one screen where balances are
 *  being checked reads as one. Movement (Σ of the rows) IS sign-coloured —
 *  there the sign is the information. */
function Balance({ minor, currency }: { minor: number | null; currency: string }) {
  if (minor === null) return <span className="text-faint">—</span>;
  return <span className="tnum text-text">{formatMinor(minor, currency)}</span>;
}

function statusChip(line: ReportAccountLine) {
  switch (line.status) {
    case 'existing':
      return <StatChip tone="warn">already exists — opening left alone</StatChip>;
    case 'not-created':
      return <StatChip>unticked — not being created</StatChip>;
    case 'not-planned':
      return <StatChip tone="warn">not being created</StatChip>;
    case 'new':
      if (line.fileOpeningMinor === null) {
        return <StatChip tone="warn">opening balance not worked out</StatChip>;
      }
      if (linesUp(line)) return <StatChip tone="pos">matches the file</StatChip>;
      return (
        <StatChip tone="warn">
          {line.differenceMinor === null
            ? 'no balance in the file'
            : `off by ${formatMinor(Math.abs(line.differenceMinor), line.currency)}`}
        </StatChip>
      );
  }
}

export function AccountBalancesPanel({
  lines,
  existingWithOpeningBalance,
}: {
  lines: ReportAccountLine[];
  /** plan.existingAccountsWithOpeningBalance — accounts already in the app. */
  existingWithOpeningBalance: string[];
}) {
  const [onlyAttention, setOnlyAttention] = useState(false);
  // `lines` is rebuilt on every render (the plan is mutated in place), so
  // there is nothing to memoise on — recompute, deliberately.
  const summary = reportAccountSummary(lines);
  // The filter checkbox only exists while something needs attention. If a
  // decision clears the last mismatch while it is ticked, honouring it would
  // hide every row AND remove the control to untick it — so it lapses.
  const filtering = onlyAttention && summary.attention > 0;
  const shown = filtering ? lines.filter(needsAttention) : lines;
  const unplannedCount = lines.filter((l) => l.status === 'not-planned').length;
  const balanceOnlyCount = lines.filter(
    (l) => l.status === 'new' && l.importedCount === 0,
  ).length;
  const existingNote = existingAccountsNote(existingWithOpeningBalance);

  if (lines.length === 0) return null;

  return (
    <section aria-label="Account balances" className="flex flex-col gap-2">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold text-text">Account balances</h3>
        <p className="text-xs text-muted">
          Opening balance + the rows below = the balance each account will show.
        </p>
      </div>

      <div className="flex flex-wrap gap-1.5" role="status">
        <StatChip>{plural(summary.total, 'account')} in this file</StatChip>
        <StatChip tone="accent">creating {summary.creating}</StatChip>
        {summary.matching > 0 && (
          <StatChip tone="pos">{summary.matching} match the file’s balance</StatChip>
        )}
        {summary.attention > 0 && (
          <StatChip tone="warn">{plural(summary.attention, 'account')} to check</StatChip>
        )}
      </div>

      {summary.missingOpening > 0 && (
        <Card className="flex items-start gap-2 p-3">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-warn">
            <IconAlert size={16} />
          </span>
          <p className="text-sm text-warn">
            {plural(summary.missingOpening, 'account has', 'accounts have')} no opening balance —
            the file didn’t give a closing balance for{' '}
            {summary.missingOpening === 1 ? 'it' : 'them'}, or an amount couldn’t be read, so one
            can’t be worked out safely. {summary.missingOpening === 1 ? 'It' : 'They'} will be
            created starting from zero and{' '}
            {summary.missingOpening === 1 ? 'its' : 'their'} balance will be out by whatever the
            real opening balance was. Set it in Settings › Accounts afterwards.
          </p>
        </Card>
      )}

      {existingNote && (
        <Card className="flex items-start gap-2 p-3">
          <span aria-hidden="true" className="mt-0.5 shrink-0 text-warn">
            <IconAlert size={16} />
          </span>
          <p className="text-sm text-warn">{existingNote}</p>
        </Card>
      )}

      {balanceOnlyCount > 0 && (
        <p className="text-xs text-muted">
          {plural(balanceOnlyCount, 'account')} in the file{' '}
          {balanceOnlyCount === 1 ? 'has' : 'have'} no transactions — just a balance.{' '}
          {balanceOnlyCount === 1 ? 'It is' : 'They are'} still created, holding exactly that
          balance, so {balanceOnlyCount === 1 ? 'its' : 'their'} money still counts towards your
          net worth.
        </p>
      )}

      {unplannedCount > 0 && (
        <p className="text-xs text-warn">
          {plural(unplannedCount, 'account')} in the file{' '}
          {unplannedCount === 1 ? 'is' : 'are'} not being created — the file didn’t give enough
          to create {unplannedCount === 1 ? 'it' : 'them'} (no readable currency, and no
          transactions to infer one from). Any money{' '}
          {unplannedCount === 1 ? 'it holds' : 'they hold'} will be missing from your net worth
          until you add {unplannedCount === 1 ? 'it' : 'them'} in Settings › Accounts.
        </p>
      )}

      {summary.attention > 0 && (
        <Checkbox
          checked={onlyAttention}
          onChange={setOnlyAttention}
          label={`Only show the ${plural(summary.attention, 'account')} to check`}
        />
      )}

      <div className="max-h-[28rem] overflow-auto rounded-lg border border-border">
        <table className="w-full min-w-[760px] text-sm">
          <caption className="sr-only">
            Every account in this file, with the opening balance being set, the transactions being
            imported, the resulting balance, and the balance the file states.
          </caption>
          <thead>
            <tr className="text-left text-xs uppercase tracking-wide text-muted [&>th]:sticky [&>th]:top-0 [&>th]:z-10 [&>th]:border-b [&>th]:border-border [&>th]:bg-surface2">
              <th scope="col" className="px-3 py-2 font-medium">
                Account
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Opening
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Importing
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                Final balance
              </th>
              <th scope="col" className="px-3 py-2 text-right font-medium">
                File says
              </th>
              <th scope="col" className="px-3 py-2 font-medium">
                <span className="sr-only">Status</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {shown.map((line, i) => (
              <tr
                key={`${line.name}-${i}`}
                className={`border-b border-border last:border-b-0 ${
                  line.status === 'new' ? '' : 'opacity-70'
                }`}
              >
                <th scope="row" className="px-3 py-1.5 text-left font-normal">
                  <div className="flex max-w-[260px] items-center gap-1.5">
                    <span className="truncate text-text">{line.name}</span>
                    <Chip>{line.currency}</Chip>
                  </div>
                </th>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  {line.fileOpeningMinor === null ? (
                    <span className="text-warn">not worked out</span>
                  ) : line.openingApplied ? (
                    <Balance minor={line.fileOpeningMinor} currency={line.currency} />
                  ) : (
                    // Still worth showing: it is what the file implies the
                    // account started at, even though we are not writing it.
                    <span className="tnum text-muted">
                      {formatMinor(line.fileOpeningMinor, line.currency)}{' '}
                      <span className="text-faint">(not applied)</span>
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  {line.importedCount > 0 && (
                    <Amount
                      minor={line.importedNetMinor}
                      currency={line.currency}
                      signColour
                      className="block"
                    />
                  )}
                  {/* Skipped rows are named even when NOTHING imports: they
                      are the whole explanation for a balance that is off. */}
                  {line.importedCount === 0 && line.skippedCount === 0 ? (
                    <span className="text-faint">no transactions</span>
                  ) : (
                    <span className="text-xs text-muted">
                      {line.importedCount > 0 && plural(line.importedCount, 'row')}
                      {line.importedCount > 0 && line.skippedCount > 0 && ', '}
                      {line.skippedCount > 0 && `${line.skippedCount} skipped`}
                    </span>
                  )}
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right font-medium">
                  <Balance minor={line.finalMinor} currency={line.currency} />
                </td>
                <td className="whitespace-nowrap px-3 py-1.5 text-right">
                  <span className="tnum text-muted">
                    {line.fileBalanceMinor === null
                      ? '—'
                      : formatMinor(line.fileBalanceMinor, line.currency)}
                  </span>
                </td>
                <td className="px-3 py-1.5">{statusChip(line)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {summary.attention === 0 && summary.creating > 0 && (
        <p className="text-sm text-pos">
          Every account lands on exactly the balance the file states.
        </p>
      )}

      {summary.attention > 0 && (
        <p className="text-xs text-muted">
          An account can be off when some of its rows were skipped as duplicates or had errors —
          check the row list below. Every skipped row moves the final balance away from the file’s
          figure by exactly that row’s amount.
        </p>
      )}
    </section>
  );
}
