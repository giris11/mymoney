// Transfer form pieces shared by the full editor and Quick Add.
// Cross-currency transfers store BOTH amounts explicitly (SPEC §5) — the
// received amount is a required second input, never derived from a rate.
import type { Account, TxStatus } from '../../db/types';
import { ValidationError, type SaveTransferInput } from '../../domain/transactions';
import { Field, MoneyInput, Select } from '../kit/kit';

export interface TransferDraft {
  fromAccountId: string;
  toAccountId: string;
  /** Positive magnitude in the from-account's currency. */
  amountFromMinor: number | null;
  /** Positive magnitude in the to-account's currency (cross-currency only). */
  amountToMinor: number | null;
}

export function emptyTransferDraft(
  accounts: Account[],
  preferredFromId?: string | null,
): TransferDraft {
  const usable = accounts.filter((a) => !a.archived);
  const from =
    (preferredFromId && usable.find((a) => a.id === preferredFromId)?.id) || usable[0]?.id || '';
  const to = usable.find((a) => a.id !== from)?.id ?? '';
  return { fromAccountId: from, toAccountId: to, amountFromMinor: null, amountToMinor: null };
}

export function isCrossCurrency(accounts: Account[], draft: TransferDraft): boolean {
  const from = accounts.find((a) => a.id === draft.fromAccountId);
  const to = accounts.find((a) => a.id === draft.toAccountId);
  return !!from && !!to && from.currency !== to.currency;
}

/** Validate a draft and shape it for saveTransfer. Throws ValidationError. */
export function transferDraftToInput(
  accounts: Account[],
  draft: TransferDraft,
  date: string,
  notes: string,
  status: TxStatus,
  transferGroupId?: string,
): SaveTransferInput {
  const from = accounts.find((a) => a.id === draft.fromAccountId);
  const to = accounts.find((a) => a.id === draft.toAccountId);
  if (!from) throw new ValidationError('Choose the account the money leaves');
  if (!to) throw new ValidationError('Choose the account the money arrives in');
  if (draft.amountFromMinor === null || draft.amountFromMinor === 0) {
    throw new ValidationError('Enter the amount to transfer');
  }
  const cross = from.currency !== to.currency;
  const amountTo = cross ? draft.amountToMinor : Math.abs(draft.amountFromMinor);
  if (amountTo === null || amountTo === 0) {
    throw new ValidationError(`Enter the amount received in ${to.currency}`);
  }
  const input: SaveTransferInput = {
    fromAccountId: from.id,
    toAccountId: to.id,
    date,
    amountFromMinor: Math.abs(draft.amountFromMinor),
    amountToMinor: Math.abs(amountTo),
    notes,
    status,
  };
  if (transferGroupId) input.transferGroupId = transferGroupId;
  return input;
}

export function TransferFields({
  accounts,
  draft,
  onChange,
  hideFromAmount,
}: {
  accounts: Account[];
  draft: TransferDraft;
  onChange: (d: TransferDraft) => void;
  /** Quick Add renders the sent amount itself (the big amount-first input). */
  hideFromAmount?: boolean;
}) {
  const from = accounts.find((a) => a.id === draft.fromAccountId);
  const to = accounts.find((a) => a.id === draft.toAccountId);
  const cross = !!from && !!to && from.currency !== to.currency;

  const accountOptions = accounts.map((a) => (
    <option key={a.id} value={a.id}>
      {a.name} ({a.currency}){a.archived ? ' — archived' : ''}
    </option>
  ));

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 sm:grid-cols-2">
        <Field label="From account">
          {(id) => (
            <Select
              id={id}
              value={draft.fromAccountId}
              onChange={(e) => onChange({ ...draft, fromAccountId: e.target.value })}
            >
              <option value="" disabled>
                Choose account
              </option>
              {accountOptions}
            </Select>
          )}
        </Field>
        <Field label="To account">
          {(id) => (
            <Select
              id={id}
              value={draft.toAccountId}
              onChange={(e) => onChange({ ...draft, toAccountId: e.target.value })}
            >
              <option value="" disabled>
                Choose account
              </option>
              {accountOptions}
            </Select>
          )}
        </Field>
      </div>
      {!hideFromAmount && (
        <Field label={`Amount sent${from ? ` (${from.currency})` : ''}`}>
          {(id) => (
            <MoneyInput
              id={id}
              valueMinor={draft.amountFromMinor}
              currency={from?.currency ?? 'GBP'}
              onValue={(v) => onChange({ ...draft, amountFromMinor: v })}
            />
          )}
        </Field>
      )}
      {cross && (
        <Field
          label={`Amount received (${to.currency})`}
          hint="Different currencies — enter the exact amount that arrived. Both amounts are stored as typed; no exchange rate is applied."
        >
          {(id) => (
            <MoneyInput
              id={id}
              valueMinor={draft.amountToMinor}
              currency={to.currency}
              onValue={(v) => onChange({ ...draft, amountToMinor: v })}
            />
          )}
        </Field>
      )}
      {!cross && from && to && (
        <p className="text-xs text-muted">
          Same currency — the received amount mirrors the amount sent.
        </p>
      )}
    </div>
  );
}
