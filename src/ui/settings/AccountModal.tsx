// Create/edit account modal. Currency locks once the account has transactions
// (domain enforces it too); opening balance edits in the account's currency;
// groups can be created inline.
import { useState } from 'react';
import type { Account, AccountGroup, AccountType } from '../../db/types';
import { COMMON_CURRENCIES, ACCOUNT_TYPE_LABELS } from '../../db/seed';
import {
  ACCOUNT_TYPES,
  deleteAccount,
  saveAccount,
  saveGroup,
  setAccountArchived,
} from '../../domain/accounts';
import { Button, ConfirmDialog, Field, Input, Modal, MoneyInput, Select } from '../kit/kit';
import { useToast } from '../kit/toast';
import { ColourSwatches, ENTITY_COLOURS, errorMessage } from './shared';

const NEW_GROUP = '__new__';

export function AccountModal({
  account,
  txCount,
  groups,
  defaultCurrency,
  onClose,
}: {
  account: Account | null; // null = create
  txCount: number;
  groups: AccountGroup[];
  defaultCurrency: string;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const [name, setName] = useState(account?.name ?? '');
  const [type, setType] = useState<AccountType>(account?.type ?? 'current');
  const [currency, setCurrency] = useState(account?.currency ?? defaultCurrency);
  const [opening, setOpening] = useState<number | null>(account?.openingBalanceMinor ?? 0);
  const [colour, setColour] = useState(account?.colour ?? ENTITY_COLOURS[0]);
  const [groupChoice, setGroupChoice] = useState<string>(account?.groupId ?? '');
  const [newGroupName, setNewGroupName] = useState('');
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [busy, setBusy] = useState(false);

  const currencyLocked = !!account && txCount > 0;
  const currencies = COMMON_CURRENCIES.includes(currency)
    ? COMMON_CURRENCIES
    : [currency, ...COMMON_CURRENCIES];

  const save = async () => {
    setBusy(true);
    try {
      let groupId: string | null = groupChoice === '' ? null : groupChoice;
      if (groupChoice === NEW_GROUP) {
        groupId = (await saveGroup({ name: newGroupName })).id;
      }
      await saveAccount({
        id: account?.id,
        name,
        type,
        currency,
        openingBalanceMinor: opening ?? 0,
        colour,
        groupId,
      });
      toast(account ? 'Account saved' : 'Account created', 'success');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const toggleArchive = async () => {
    if (!account) return;
    try {
      await setAccountArchived(account.id, !account.archived);
      toast(account.archived ? 'Account unarchived' : 'Account archived', 'success');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const doDelete = async () => {
    if (!account) return;
    const result = await deleteAccount(account.id);
    setConfirmDelete(false);
    if (result.ok) {
      toast('Account deleted', 'success');
      onClose();
    } else {
      toast(`Can’t delete this account: ${result.reason}`, 'error');
    }
  };

  return (
    <>
      <Modal
        open
        onClose={onClose}
        title={account ? 'Edit account' : 'New account'}
        footer={
          <>
            {account && (
              <>
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  Delete
                </Button>
                <Button onClick={toggleArchive}>{account.archived ? 'Unarchive' : 'Archive'}</Button>
              </>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy} onClick={() => void save()}>
              {account ? 'Save' : 'Create account'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                autoComplete="off"
                placeholder="e.g. Current Account"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <div className="grid grid-cols-2 gap-3">
            <Field label="Type">
              {(id) => (
                <Select id={id} value={type} onChange={(e) => setType(e.target.value as AccountType)}>
                  {ACCOUNT_TYPES.map((t) => (
                    <option key={t} value={t}>
                      {ACCOUNT_TYPE_LABELS[t]}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
            <Field
              label="Currency"
              hint={
                currencyLocked
                  ? `Locked — this account already has ${txCount} transaction${
                      txCount === 1 ? '' : 's'
                    } recorded in ${currency}.`
                  : undefined
              }
            >
              {(id) => (
                <Select
                  id={id}
                  value={currency}
                  disabled={currencyLocked}
                  onChange={(e) => setCurrency(e.target.value)}
                >
                  {currencies.map((c) => (
                    <option key={c} value={c}>
                      {c}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
          <Field
            label={`Opening balance (${currency})`}
            hint="What the account held before its first recorded transaction. Negative for money owed (credit cards, loans)."
          >
            {(id) => (
              <MoneyInput id={id} valueMinor={opening} currency={currency} onValue={setOpening} />
            )}
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text">Colour</span>
            <ColourSwatches value={colour} onChange={setColour} label="Account colour" />
          </div>
          <Field label="Group">
            {(id) => (
              <Select id={id} value={groupChoice} onChange={(e) => setGroupChoice(e.target.value)}>
                <option value="">No group</option>
                {groups.map((g) => (
                  <option key={g.id} value={g.id}>
                    {g.name}
                  </option>
                ))}
                <option value={NEW_GROUP}>New group…</option>
              </Select>
            )}
          </Field>
          {groupChoice === NEW_GROUP && (
            <Field label="New group name">
              {(id) => (
                <Input
                  id={id}
                  value={newGroupName}
                  autoComplete="off"
                  placeholder="e.g. Everyday"
                  onChange={(e) => setNewGroupName(e.target.value)}
                />
              )}
            </Field>
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete account"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <strong>{account?.name}</strong>? Only accounts with no transactions can be
            deleted — accounts with history should be archived instead.
          </>
        }
        onConfirm={() => void doDelete()}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
