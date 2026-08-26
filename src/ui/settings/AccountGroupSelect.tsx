// Inline "which group is this account in?" control for a single row of the
// accounts list. This is the fast path: filing 58 imported accounts must not
// mean opening 58 editors — one select, one interaction, done.
//
// Grouping is ORGANISATIONAL ONLY. setAccountGroup writes accounts.groupId and
// nothing else: no balance, amount, transaction or net-worth figure can move as
// a result, and every choice here is reversible (including back to "No group").
import { useState } from 'react';
import type { Account, AccountGroup } from '../../db/types';
import { saveGroup, setAccountGroup } from '../../domain/accounts';
import { nameKey } from '../../lib/util';
import { Button, Field, Input, Modal, Select } from '../kit/kit';
import { useToast } from '../kit/toast';
import { errorMessage } from './shared';

const NEW_GROUP = '__new__';

export function AccountGroupSelect({
  account,
  groups,
  className,
}: {
  account: Account;
  groups: AccountGroup[];
  className?: string;
}) {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState('');
  const [busy, setBusy] = useState(false);

  const assign = async (groupId: string | null, groupName?: string) => {
    setBusy(true);
    try {
      await setAccountGroup(account.id, groupId);
      toast(
        groupId ? `“${account.name}” filed in ${groupName}` : `“${account.name}” has no group now`,
        'success',
      );
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const createAndAssign = async () => {
    const name = newName.trim();
    if (!name) return;
    setBusy(true);
    try {
      // Typing the name of a group that already exists should file the account
      // there rather than create a confusing duplicate.
      const existing = groups.find((g) => nameKey(g.name) === nameKey(name));
      const group = existing ?? (await saveGroup({ name }));
      await setAccountGroup(account.id, group.id);
      toast(`“${account.name}” filed in ${group.name}`, 'success');
      setCreating(false);
      setNewName('');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <Select
        aria-label={`Group for ${account.name}`}
        className={className}
        disabled={busy}
        value={account.groupId ?? ''}
        onChange={(e) => {
          const v = e.target.value;
          if (v === NEW_GROUP) {
            setNewName('');
            setCreating(true);
            return;
          }
          const picked = groups.find((g) => g.id === v);
          void assign(v === '' ? null : v, picked?.name);
        }}
      >
        <option value="">No group</option>
        {groups.map((g) => (
          <option key={g.id} value={g.id}>
            {g.name}
          </option>
        ))}
        <option value={NEW_GROUP}>New group…</option>
      </Select>

      {creating && (
        <Modal
          open
          onClose={() => setCreating(false)}
          title="New group"
          footer={
            <>
              <Button onClick={() => setCreating(false)}>Cancel</Button>
              <Button
                variant="primary"
                disabled={busy || newName.trim() === ''}
                onClick={() => void createAndAssign()}
              >
                Create and file here
              </Button>
            </>
          }
        >
          <Field
            label="Group name"
            hint={`“${account.name}” will be filed in this group. Nothing else about the account changes.`}
          >
            {(id) => (
              <Input
                id={id}
                value={newName}
                autoComplete="off"
                placeholder="e.g. Savings"
                onChange={(e) => setNewName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void createAndAssign();
                }}
              />
            )}
          </Field>
        </Modal>
      )}
    </>
  );
}
