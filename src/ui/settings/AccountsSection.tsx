// Accounts management (SPEC §8.1.1): grouped list with balances, create/edit,
// reorder, archive badge, group rename/delete (delete only when empty).
import { useMemo, useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { accountBalances, type AccountBalance } from '../../domain/balances';
import { deleteGroup, reorderAccount, saveGroup } from '../../domain/accounts';
import { ACCOUNT_TYPE_LABELS } from '../../db/seed';
import type { Account, AccountGroup } from '../../db/types';
import { cn } from '../../lib/util';
import {
  Amount,
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
} from '../kit/kit';
import { IconChevronDown, IconPencil, IconPlus, IconTrash, IconWallet } from '../kit/icons';
import { useToast } from '../kit/toast';
import { AccountModal } from './AccountModal';
import { errorMessage, SettingsPage } from './shared';

interface EditTarget {
  account: Account | null;
  txCount: number;
}

export default function AccountsSection() {
  const { toast } = useToast();
  const balances = useLive(() => accountBalances(), []);
  const groups = useLive(() => db.accountGroups.orderBy('sortOrder').toArray(), []);
  const settings = useLive(() => getSettings(), []);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [groupModal, setGroupModal] = useState<{ group: AccountGroup | null } | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<AccountGroup | null>(null);

  const byGroup = useMemo(() => {
    const m = new Map<string | null, AccountBalance[]>();
    for (const b of balances ?? []) {
      const key = b.account.groupId;
      const list = m.get(key) ?? [];
      list.push(b);
      m.set(key, list);
    }
    for (const list of m.values()) {
      list.sort(
        (a, b) =>
          a.account.sortOrder - b.account.sortOrder || a.account.name.localeCompare(b.account.name),
      );
    }
    return m;
  }, [balances]);

  const sections: { group: AccountGroup | null; rows: AccountBalance[] }[] = [
    ...(groups ?? []).map((g) => ({ group: g as AccountGroup | null, rows: byGroup.get(g.id) ?? [] })),
    ...(byGroup.has(null) ? [{ group: null, rows: byGroup.get(null)! }] : []),
  ];
  const hasAccounts = (balances ?? []).length > 0;

  const move = async (id: string, direction: 'up' | 'down') => {
    try {
      await reorderAccount(id, direction);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const removeGroup = async (group: AccountGroup) => {
    setGroupToDelete(null);
    const result = await deleteGroup(group.id);
    if (result.ok) toast('Group deleted', 'success');
    else toast(`Can’t delete “${group.name}”: ${result.reason}`, 'error');
  };

  return (
    <SettingsPage
      title="Accounts"
      description="Balances include pending transactions. Archived accounts keep their history but are hidden from the sidebar and pickers."
      actions={
        <>
          <Button size="sm" onClick={() => setGroupModal({ group: null })}>
            Add group
          </Button>
          <Button size="sm" variant="primary" onClick={() => setEditing({ account: null, txCount: 0 })}>
            <IconPlus size={16} /> Add account
          </Button>
        </>
      }
    >
      {balances && groups && !hasAccounts && sections.length === 0 && (
        <Card>
          <EmptyState
            icon={<IconWallet size={32} />}
            title="No accounts yet"
            message="Create your first account to start recording transactions."
            action={
              <Button variant="primary" onClick={() => setEditing({ account: null, txCount: 0 })}>
                Add account
              </Button>
            }
          />
        </Card>
      )}

      {sections.map(({ group, rows }) => (
        <Card key={group?.id ?? 'ungrouped'} className="p-0">
          <div className="flex items-center gap-1 border-b border-border px-4 py-2.5">
            <h2 className="min-w-0 flex-1 truncate text-xs font-semibold uppercase tracking-wide text-faint">
              {group ? group.name : sections.length > 1 || (groups ?? []).length > 0 ? 'Ungrouped' : 'Accounts'}
            </h2>
            {group && (
              <>
                <IconButton
                  label={`Rename group ${group.name}`}
                  className="p-1.5"
                  onClick={() => setGroupModal({ group })}
                >
                  <IconPencil size={15} />
                </IconButton>
                <IconButton
                  label={`Delete group ${group.name}`}
                  className="p-1.5"
                  onClick={() => setGroupToDelete(group)}
                >
                  <IconTrash size={15} />
                </IconButton>
              </>
            )}
          </div>
          {rows.length === 0 ? (
            <p className="px-4 py-3 text-sm text-faint">No accounts in this group.</p>
          ) : (
            <ul>
              {rows.map((b, i) => (
                <li
                  key={b.account.id}
                  className="flex items-center gap-3 border-b border-border px-4 py-2.5 last:border-0"
                >
                  <span
                    aria-hidden="true"
                    className="h-3 w-3 shrink-0 rounded-full"
                    style={{ backgroundColor: b.account.colour }}
                  />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="truncate text-sm font-medium text-text">{b.account.name}</span>
                      {b.account.archived && <Chip>Archived</Chip>}
                    </div>
                    <div className="text-xs text-muted">
                      {ACCOUNT_TYPE_LABELS[b.account.type]} · {b.txCount} transaction
                      {b.txCount === 1 ? '' : 's'}
                    </div>
                  </div>
                  <Amount
                    minor={b.balanceMinor}
                    currency={b.account.currency}
                    className={cn('text-sm', b.balanceMinor < 0 && 'text-neg')}
                  />
                  <div className="flex shrink-0 items-center">
                    <IconButton
                      label={`Move ${b.account.name} up`}
                      className="p-1.5"
                      disabled={i === 0}
                      onClick={() => void move(b.account.id, 'up')}
                    >
                      <IconChevronDown size={15} className="rotate-180" />
                    </IconButton>
                    <IconButton
                      label={`Move ${b.account.name} down`}
                      className="p-1.5"
                      disabled={i === rows.length - 1}
                      onClick={() => void move(b.account.id, 'down')}
                    >
                      <IconChevronDown size={15} />
                    </IconButton>
                    <IconButton
                      label={`Edit ${b.account.name}`}
                      className="p-1.5"
                      onClick={() => setEditing({ account: b.account, txCount: b.txCount })}
                    >
                      <IconPencil size={15} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      ))}

      {editing && (
        <AccountModal
          account={editing.account}
          txCount={editing.txCount}
          groups={groups ?? []}
          defaultCurrency={settings?.baseCurrency ?? 'GBP'}
          onClose={() => setEditing(null)}
        />
      )}
      {groupModal && (
        <GroupModal group={groupModal.group} onClose={() => setGroupModal(null)} />
      )}
      <ConfirmDialog
        open={groupToDelete !== null}
        title="Delete group"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete the group <strong>{groupToDelete?.name}</strong>? Accounts are never deleted —
            only empty groups can be removed.
          </>
        }
        onConfirm={() => groupToDelete && void removeGroup(groupToDelete)}
        onCancel={() => setGroupToDelete(null)}
      />
    </SettingsPage>
  );
}

function GroupModal({ group, onClose }: { group: AccountGroup | null; onClose: () => void }) {
  const { toast } = useToast();
  const [name, setName] = useState(group?.name ?? '');
  const save = async () => {
    try {
      await saveGroup({ id: group?.id, name });
      toast(group ? 'Group renamed' : 'Group created', 'success');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };
  return (
    <Modal
      open
      onClose={onClose}
      title={group ? 'Rename group' : 'New group'}
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <Field label="Group name">
        {(id) => (
          <Input
            id={id}
            value={name}
            autoComplete="off"
            placeholder="e.g. Everyday"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void save();
            }}
          />
        )}
      </Field>
    </Modal>
  );
}
