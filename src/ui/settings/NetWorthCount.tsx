// "Count this in net worth?" — the UI side of showing money without counting it.
//
// WHY THE FLAG LIVES ON THE ACCOUNT (restated here because this is where a
// person actually meets it): `Account.excludeFromNetWorth` is the single source
// of truth — see the long note on the field in src/db/types.ts. The group
// control below is a BULK ACTION: it writes that same field on every account
// currently in the group and then has no further existence. A second,
// group-level flag was rejected because un-excluding one account inside an
// excluded group has no obvious correct answer, and a finance app must never
// leave someone guessing which of two switches decided their net worth.
//
// What excluding does, and what it must never do:
//   * it changes ONLY what a total counts. No balance, no transaction, no
//     amount and no spending/income report moves — those group by CATEGORY,
//     not by account, so they never see this flag at all;
//   * an excluded account stays VISIBLE with its real balance. "Not counted"
//     is not "hidden": you must never be unable to find your money;
//   * every control here is one click, and one click back.
//
// This module also owns the WORDING of the not-counted line so the sidebar,
// the dashboard card and the net-worth report say exactly the same sentence
// about exactly the same number. It would live in src/ui/kit if the kit
// weren't foundation-owned and read-only to build agents.
import { useState } from 'react';
import type { Account } from '../../db/types';
import { setAccountExcluded, setGroupExcluded } from '../../domain/accounts';
import { cn } from '../../lib/util';
import { formatMinor } from '../../money/money';
import { Button, ConfirmDialog } from '../kit/kit';
import { IconAlert } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage } from './shared';

/**
 * The one sentence every surface uses. `baseMinor === null` means a rate is
 * missing, so the amount genuinely is not known — say so rather than printing
 * a number that quietly leaves an account out (SPEC §6: surfaced, never
 * guessed). Returns null when nothing is excluded, so callers render nothing.
 */
export function notCountedSummary(
  count: number,
  baseMinor: number | null,
  baseCurrency: string,
): string | null {
  if (count <= 0) return null;
  const accounts = `${count} account${count === 1 ? '' : 's'}`;
  return baseMinor === null
    ? `${accounts} not counted — no exchange rate, so the amount can’t be shown`
    : `${formatMinor(baseMinor, baseCurrency)} in ${accounts} not counted`;
}

/**
 * One quiet line under a net-worth figure. Amber with an icon when the amount
 * is unknown (that is a missing-rate warning, not a footnote); otherwise a
 * plain faint note — both palette colours clear AA in either theme.
 */
export function NotCountedNote({
  count,
  baseMinor,
  baseCurrency,
  className,
}: {
  count: number;
  baseMinor: number | null;
  baseCurrency: string;
  className?: string;
}) {
  const text = notCountedSummary(count, baseMinor, baseCurrency);
  if (text === null) return null;
  const unknown = baseMinor === null;
  return (
    <p
      className={cn(
        'tnum mt-1 flex items-start gap-1 text-xs',
        unknown ? 'text-warn' : 'text-faint',
        className,
      )}
    >
      {unknown && <IconAlert size={13} className="mt-px shrink-0" aria-hidden="true" />}
      <span>{text}</span>
    </p>
  );
}

/**
 * The words on an excluded account's own row, in one place so the sidebar and
 * the settings list mark it identically.
 */
export const NOT_COUNTED_LABEL = 'Not counted';

/**
 * The marker on an excluded account's own row. Text plus a border, never
 * colour alone — and never a strikethrough: the balance beside it is real.
 */
export function NotCountedBadge({ className }: { className?: string }) {
  return (
    <span
      className={cn(
        'shrink-0 rounded-full border border-border px-1.5 py-px text-[11px] font-medium text-muted',
        className,
      )}
    >
      {NOT_COUNTED_LABEL}
    </span>
  );
}

/**
 * Per-account switch, labelled POSITIVELY — checked means "this counts", which
 * is the direction people actually think in. Writes immediately (one click,
 * one click back) rather than waiting for a Save.
 */
export function CountInNetWorthToggle({
  account,
  className,
}: {
  account: Account;
  className?: string;
}) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  const counted = account.excludeFromNetWorth !== true;

  const apply = async (nextCounted: boolean) => {
    setBusy(true);
    try {
      await setAccountExcluded(account.id, !nextCounted);
      toast(
        nextCounted
          ? `“${account.name}” counts towards net worth`
          : `“${account.name}” is no longer counted — its balance is unchanged`,
        'success',
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <label
      className={cn(
        // Same disabled treatment as the kit's Checkbox, for the few
        // milliseconds the write is in flight.
        'flex shrink-0 items-center gap-1.5 text-xs',
        busy ? 'opacity-50' : 'cursor-pointer',
        className,
      )}
    >
      <input
        type="checkbox"
        checked={counted}
        disabled={busy}
        // Visible text is "In net worth"; the accessible name adds the account
        // it belongs to and still contains that text (WCAG 2.5.3).
        aria-label={`Count ${account.name} in net worth`}
        onChange={(e) => void apply(e.target.checked)}
        className="h-4 w-4 accent-(--c-accent)"
      />
      <span className="text-muted">In net worth</span>
    </label>
  );
}

/**
 * Group header bulk action. Direction is decided by the group as it stands: if
 * anything in it still counts, the offer is to stop counting the lot;
 * otherwise the offer is to count them all again. The confirmation names how
 * many accounts will actually change — never just "this group".
 *
 * `total`/`excluded` must describe EVERY account filed in the group, not the
 * rows a search happens to be showing, because setGroupExcluded writes them
 * all. Renders nothing for an empty group.
 */
export function GroupNetWorthAction({
  groupId,
  groupName,
  total,
  excluded,
}: {
  groupId: string;
  groupName: string;
  total: number;
  excluded: number;
}) {
  const { toast } = useToast();
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  if (total === 0) return null;

  const exclude = excluded < total; // something still counts ⇒ offer to stop
  const willChange = exclude ? total - excluded : excluded;
  const untouched = total - willChange; // already in the state being asked for
  const label = exclude ? 'Don’t count group' : 'Count group';
  const accounts = (k: number) => `${k} account${k === 1 ? '' : 's'}`;

  const run = async () => {
    setConfirming(false);
    setBusy(true);
    try {
      const { accountsChanged } = await setGroupExcluded(groupId, exclude);
      toast(
        exclude
          ? `${accountsChanged} account${accountsChanged === 1 ? '' : 's'} no longer counted — balances unchanged`
          : `${accountsChanged} account${accountsChanged === 1 ? '' : 's'} counted again`,
        'success',
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Button
        size="sm"
        disabled={busy}
        aria-label={`${label} ${groupName} in net worth`}
        onClick={() => setConfirming(true)}
      >
        {label}
      </Button>
      <ConfirmDialog
        open={confirming}
        title={exclude ? 'Stop counting this group' : 'Count this group'}
        confirmLabel={exclude ? 'Don’t count them' : 'Count them'}
        message={
          exclude ? (
            <>
              Stop counting {accounts(total)} in <strong>{groupName}</strong> towards net worth?{' '}
              <strong>{willChange} will change</strong>
              {untouched > 0 && <> — the other {untouched} already {untouched === 1 ? 'doesn’t' : 'don’t'} count</>}.
              They all stay visible with their balances: nothing about the money itself changes,
              and you can switch any of them back on its own row.
            </>
          ) : (
            <>
              Count {accounts(total)} in <strong>{groupName}</strong> towards net worth again?{' '}
              <strong>{willChange} will change</strong>
              {untouched > 0 && <> — the other {untouched} already {untouched === 1 ? 'does' : 'do'}</>}.
            </>
          )
        }
        onConfirm={() => void run()}
        onCancel={() => setConfirming(false)}
      />
    </>
  );
}
