// "Organise accounts" — the bulk filing tool for a freshly imported ledger.
// MoneyWiz's Report export carries no account type and no grouping, so 58
// accounts can land as one flat list of "Current account". This previews what
// automatic filing would do, grouped BY the group it would create, and only
// then applies it.
//
// Two rules shape this screen:
//  * Organisational only — filing an account into a group (and correcting its
//    type) never changes a balance, an amount, a transaction or net worth, and
//    every change can be undone from the accounts list.
//  * Never present a guess as certainty — suggestions the domain isn't
//    confident about are marked "worth checking" in warn tone, in text, not
//    just colour.
import { useMemo, useState } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { autoGroupAccounts, previewAutoGrouping } from '../../domain/accounts';
import { ACCOUNT_TYPE_LABELS } from '../../db/seed';
import { cn } from '../../lib/util';
import { Button, Checkbox, EmptyState, Modal } from '../kit/kit';
import { IconAlert } from '../kit/icons';
import { useToast } from '../kit/toast';
import { planRows, summarisePlan } from './organisePlan';
import { errorMessage } from './shared';

export function OrganiseAccountsModal({ onClose }: { onClose: () => void }) {
  const { toast } = useToast();
  const suggestions = useLive(() => previewAutoGrouping(), []);
  const accounts = useLive(() => db.accounts.toArray(), []);
  const groups = useLive(() => db.accountGroups.toArray(), []);
  const [applyTypes, setApplyTypes] = useState(true);
  const [onlyUngrouped, setOnlyUngrouped] = useState(true);
  const [busy, setBusy] = useState(false);

  const loading = !suggestions || !accounts || !groups;

  // Sections come back in previewAutoGrouping()'s order — the canonical group
  // order, which is the order the sidebar will sit in afterwards. So this is
  // the shape he is about to get, not a rearrangement of it.
  const plan = useMemo(() => {
    if (!suggestions || !accounts || !groups) {
      return { sections: [], filing: 0, retyping: 0, unsure: 0, newGroups: 0 };
    }
    const rows = planRows(suggestions, accounts, groups, { applyTypes, onlyUngrouped });
    return summarisePlan(rows, groups);
  }, [suggestions, accounts, groups, applyTypes, onlyUngrouped]);

  const { sections } = plan;
  const filingCount = plan.filing;
  const retypeCount = plan.retyping;
  const unsureCount = plan.unsure;
  const newGroupCount = plan.newGroups;
  const nothingToDo = !loading && filingCount === 0 && retypeCount === 0;

  const apply = async () => {
    setBusy(true);
    try {
      const result = await autoGroupAccounts({ applyTypes, onlyUngrouped });
      const parts = [
        result.groupsCreated > 0 &&
          `${result.groupsCreated} group${result.groupsCreated === 1 ? '' : 's'} created`,
        result.accountsGrouped > 0 &&
          `${result.accountsGrouped} account${result.accountsGrouped === 1 ? '' : 's'} filed`,
        result.typesChanged > 0 &&
          `${result.typesChanged} type${result.typesChanged === 1 ? '' : 's'} corrected`,
      ].filter((p): p is string => typeof p === 'string');
      toast(parts.length ? parts.join(' · ') : 'Nothing needed changing', 'success');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      open
      wide
      onClose={onClose}
      title="Organise accounts"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button
            variant="primary"
            disabled={busy || loading || nothingToDo}
            onClick={() => void apply()}
          >
            {filingCount > 0
              ? `Apply to ${filingCount} account${filingCount === 1 ? '' : 's'}`
              : retypeCount > 0
                ? `Correct ${retypeCount} type${retypeCount === 1 ? '' : 's'}`
                : 'Apply'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="text-sm text-muted">
          This only files accounts into groups (and, if you let it, corrects the account type). No
          balance, amount, transaction or net-worth figure changes — and you can move any account
          back afterwards.
        </p>

        <div className="flex flex-col gap-2 rounded-lg border border-border bg-surface2 p-3">
          <Checkbox
            label="Also correct account types (e.g. a credit card filed as a current account)"
            checked={applyTypes}
            onChange={setApplyTypes}
          />
          <Checkbox
            label="Only file accounts I haven’t grouped yet"
            checked={onlyUngrouped}
            onChange={setOnlyUngrouped}
          />
        </div>

        {loading ? (
          <p className="py-6 text-center text-sm text-muted">Reading your accounts…</p>
        ) : sections.length === 0 ? (
          <EmptyState
            title="No accounts to organise"
            message="Add or import some accounts first."
          />
        ) : (
          <>
            <p className="text-sm text-text">
              <strong className="tnum">{filingCount}</strong> account
              {filingCount === 1 ? '' : 's'} would be filed
              {newGroupCount > 0 && (
                <>
                  {' '}
                  into <strong className="tnum">{newGroupCount}</strong> new group
                  {newGroupCount === 1 ? '' : 's'}
                </>
              )}
              {applyTypes && (
                <>
                  {' · '}
                  <strong className="tnum">{retypeCount}</strong> type
                  {retypeCount === 1 ? '' : 's'} corrected
                </>
              )}
              .
            </p>
            {unsureCount > 0 && (
              <p className="flex items-start gap-1.5 text-sm text-warn">
                <IconAlert size={16} className="mt-0.5 shrink-0" />
                <span>
                  {unsureCount} suggestion{unsureCount === 1 ? ' is a' : 's are'} guess
                  {unsureCount === 1 ? '' : 'es'} from the account name alone — they’re marked
                  “worth checking” below. Nothing is lost if one is wrong: change it in the accounts
                  list.
                </span>
              </p>
            )}

            <div className="flex flex-col gap-3">
              {sections.map((section) => (
                <section key={section.name} className="rounded-lg border border-border">
                  <div className="flex items-baseline justify-between gap-3 border-b border-border px-3 py-2">
                    <h3 className="min-w-0 truncate text-sm font-semibold text-text">
                      {section.name}
                    </h3>
                    <span className="shrink-0 text-xs text-muted">
                      <span className="tnum">{section.rows.length}</span> account
                      {section.rows.length === 1 ? '' : 's'}
                      {section.unsure > 0 && (
                        <span className="text-warn">
                          {' · '}
                          <span className="tnum">{section.unsure}</span> worth checking
                        </span>
                      )}
                    </span>
                  </div>
                  <ul>
                    {section.rows.map((r) => (
                      <li
                        key={r.suggestion.accountId}
                        className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-3 py-1.5 text-sm last:border-0"
                      >
                        <span
                          className={cn(
                            'min-w-0 flex-1 basis-40 truncate',
                            r.leftAlone ? 'text-muted' : 'text-text',
                          )}
                        >
                          {r.suggestion.name}
                        </span>
                        {r.leftAlone ? (
                          <span className="text-xs text-faint">
                            already in {r.currentGroupName} — left alone
                          </span>
                        ) : (
                          <>
                            {r.retyping && (
                              <span className="text-xs text-muted">
                                {ACCOUNT_TYPE_LABELS[r.suggestion.currentType]} →{' '}
                                <span className="text-text">
                                  {ACCOUNT_TYPE_LABELS[r.suggestion.suggestedType]}
                                </span>
                              </span>
                            )}
                            {!r.filing && !r.retyping && (
                              <span className="text-xs text-faint">already filed here</span>
                            )}
                            {!r.suggestion.confident && (
                              <span className="inline-flex shrink-0 items-center gap-1 rounded-full border border-warn px-2 py-0.5 text-xs text-warn">
                                <IconAlert size={12} />
                                worth checking
                              </span>
                            )}
                          </>
                        )}
                      </li>
                    ))}
                  </ul>
                </section>
              ))}
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
