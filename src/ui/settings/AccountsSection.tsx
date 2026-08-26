// Accounts management (SPEC §8.1.1): grouped list with balances, create/edit,
// reorder, archive badge, group rename/delete (delete only when empty).
//
// Designed for a freshly imported MoneyWiz ledger: ~58 accounts arriving flat,
// untyped and ungrouped. So the list carries its own filing tools —
// "Organise accounts" for the bulk pass, an inline group select on every row
// for the manual pass (one interaction per account, never a modal), a search
// box, and a flat view where regrouping a row doesn't make it jump away.
// Filing is organisational only: it never changes a balance or a transaction,
// and every move is reversible from this screen.
//
// This is also where an account is taken out of the net-worth total ("In net
// worth" on every row, and a bulk action on every group header). That is a
// scoping choice, not a data change: the account keeps its balance, keeps its
// transactions, keeps its place in this list, and every report that groups by
// category is untouched. See NetWorthCount.tsx for why the flag lives on the
// account and the group control is a bulk action rather than a second flag.
import { useMemo, useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { accountBalances, type AccountBalance } from '../../domain/balances';
import { deleteGroup, moveGroup, reorderAccount, saveGroup } from '../../domain/accounts';
import { ACCOUNT_TYPE_LABELS } from '../../db/seed';
import type { AccountGroup } from '../../db/types';
import { cn, nameKey } from '../../lib/util';
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
  Segmented,
} from '../kit/kit';
import {
  IconChevronDown,
  IconPencil,
  IconPlus,
  IconSearch,
  IconTrash,
  IconWallet,
} from '../kit/icons';
import { useToast } from '../kit/toast';
import { AccountGroupSelect } from './AccountGroupSelect';
import { AccountModal } from './AccountModal';
import {
  CountInNetWorthToggle,
  GroupNetWorthAction,
  NotCountedBadge,
} from './NetWorthCount';
import { OrganiseAccountsModal } from './OrganiseAccountsModal';
import { errorMessage, SettingsPage } from './shared';

interface EditTarget {
  account: AccountBalance['account'] | null;
  txCount: number;
}

type ListView = 'grouped' | 'flat';

/** Reorder wiring for a row; null in the flat view, where order isn't shown. */
interface RowReorder {
  upDisabled: boolean;
  downDisabled: boolean;
  /** Appended to the button labels when reordering is temporarily blocked. */
  hint?: string;
  onMove: (direction: 'up' | 'down') => void;
}

export default function AccountsSection() {
  const { toast } = useToast();
  const balances = useLive(() => accountBalances(), []);
  const groups = useLive(() => db.accountGroups.orderBy('sortOrder').toArray(), []);
  const settings = useLive(() => getSettings(), []);
  const [editing, setEditing] = useState<EditTarget | null>(null);
  const [groupModal, setGroupModal] = useState<{ group: AccountGroup | null } | null>(null);
  const [groupToDelete, setGroupToDelete] = useState<AccountGroup | null>(null);
  const [organising, setOrganising] = useState(false);
  const [view, setView] = useState<ListView>('grouped');
  const [query, setQuery] = useState('');

  // Same ordering moveGroup() uses, so the arrows on screen and the swap in the
  // domain always agree — even before a first move normalises sortOrder.
  const allGroups = useMemo(
    () =>
      [...(groups ?? [])].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [groups],
  );
  const allRows = useMemo(() => balances ?? [], [balances]);
  const q = nameKey(query);
  // While filtering, "up"/"down" would swap an account with a sibling that
  // isn't on screen — so reordering waits for the search to be cleared.
  const reorderBlocked = q !== '';

  const shown = useMemo(
    () => (q ? allRows.filter((b) => nameKey(b.account.name).includes(q)) : allRows),
    [allRows, q],
  );

  const byGroup = useMemo(() => {
    const known = new Set(allGroups.map((g) => g.id));
    const m = new Map<string | null, AccountBalance[]>();
    for (const b of shown) {
      // An id pointing at a group that no longer exists files the account under
      // "Ungrouped" rather than dropping it off the screen.
      const key = b.account.groupId && known.has(b.account.groupId) ? b.account.groupId : null;
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
  }, [shown, allGroups]);

  const sections: { group: AccountGroup | null; rows: AccountBalance[] }[] = [
    ...allGroups
      .map((g) => ({ group: g as AccountGroup | null, rows: byGroup.get(g.id) ?? [] }))
      // an empty group is worth showing (you can file into it) — unless the
      // list is filtered, where an empty section is just noise
      .filter((s) => !q || s.rows.length > 0),
    ...(byGroup.has(null) ? [{ group: null, rows: byGroup.get(null)! }] : []),
  ];

  const flatRows = useMemo(
    () => [...shown].sort((a, b) => a.account.name.localeCompare(b.account.name)),
    [shown],
  );

  // Net-worth counts per group, from ALL rows rather than the filtered ones:
  // the group action writes every account filed in the group, so the number it
  // promises to change must not depend on what the search box is showing.
  const netWorthByGroup = useMemo(() => {
    const known = new Set(allGroups.map((g) => g.id));
    const m = new Map<string | null, { total: number; excluded: number }>();
    for (const b of allRows) {
      const key = b.account.groupId && known.has(b.account.groupId) ? b.account.groupId : null;
      const s = m.get(key) ?? { total: 0, excluded: 0 };
      s.total += 1;
      if (b.excludedFromNetWorth) s.excluded += 1;
      m.set(key, s);
    }
    return m;
  }, [allRows, allGroups]);

  const hasAccounts = allRows.length > 0;
  const ungroupedCount = allRows.filter((b) => !b.account.groupId).length;

  const move = async (id: string, direction: 'up' | 'down') => {
    try {
      await reorderAccount(id, direction);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const shiftGroup = async (id: string, direction: 'up' | 'down') => {
    try {
      await moveGroup(id, direction);
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
      description="Balances include pending transactions. Archived accounts keep their history but are hidden from the sidebar and pickers. Groups and types are labels only — changing them never changes a balance. Clearing “In net worth” only stops an account being added into your net-worth total: it stays here and in the sidebar with its balance, and nothing about the money changes."
      actions={
        <div className="flex flex-wrap items-center justify-end gap-2">
          <Button size="sm" onClick={() => setOrganising(true)}>
            Organise accounts
          </Button>
          <Button size="sm" onClick={() => setGroupModal({ group: null })}>
            Add group
          </Button>
          <Button
            size="sm"
            variant="primary"
            onClick={() => setEditing({ account: null, txCount: 0 })}
          >
            <IconPlus size={16} /> Add account
          </Button>
        </div>
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

      {hasAccounts && (
        <div className="flex flex-col gap-2">
          <div className="flex flex-wrap items-center gap-2">
            <Segmented
              label="Account list layout"
              value={view}
              onChange={setView}
              options={[
                { value: 'grouped', label: 'By group' },
                { value: 'flat', label: 'All accounts' },
              ]}
            />
            <label className="relative block min-w-48 flex-1">
              <span className="sr-only">Search accounts</span>
              <IconSearch
                size={16}
                className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
              />
              <Input
                type="search"
                value={query}
                placeholder="Search accounts"
                className="pl-9"
                onChange={(e) => setQuery(e.target.value)}
              />
            </label>
          </div>
          <p className="text-xs text-muted">
            {q ? (
              <>
                <span className="tnum">{shown.length}</span> of{' '}
                <span className="tnum">{allRows.length}</span> accounts match
              </>
            ) : (
              <>
                <span className="tnum">{allRows.length}</span> account
                {allRows.length === 1 ? '' : 's'}
              </>
            )}
            {ungroupedCount > 0 && (
              <>
                {' · '}
                <span className="tnum">{ungroupedCount}</span> not in a group
              </>
            )}
            {view === 'flat'
              ? ' · reorder accounts in the “By group” view'
              : ' · filing several? “All accounts” keeps each row in place as you go'}
          </p>
        </div>
      )}

      {hasAccounts && shown.length === 0 && (
        <Card>
          <EmptyState title="No matching accounts" message="Try a different search." />
        </Card>
      )}

      {view === 'flat' && flatRows.length > 0 && (
        <Card className="p-0">
          <div className="flex items-baseline justify-between gap-3 border-b border-border px-4 py-2.5">
            <h2 className="text-xs font-semibold uppercase tracking-wide text-faint">
              All accounts
            </h2>
            <span className="text-xs text-muted">
              <span className="tnum">{flatRows.length}</span> shown
            </span>
          </div>
          <ul>
            {flatRows.map((b) => (
              <AccountRow
                key={b.account.id}
                row={b}
                groups={allGroups}
                reorder={null}
                onEdit={() => setEditing({ account: b.account, txCount: b.txCount })}
              />
            ))}
          </ul>
        </Card>
      )}

      {view === 'grouped' &&
        (shown.length > 0 || !q) &&
        sections.map(({ group, rows }) => {
          const groupIndex = group ? allGroups.findIndex((g) => g.id === group.id) : -1;
          const counts = netWorthByGroup.get(group?.id ?? null) ?? { total: 0, excluded: 0 };
          return (
            <Card key={group?.id ?? 'ungrouped'} className="p-0">
              <div className="flex flex-wrap items-center gap-x-2 gap-y-1 border-b border-border px-4 py-2.5">
                <h2 className="min-w-0 flex-1 basis-40 truncate text-xs font-semibold uppercase tracking-wide text-faint">
                  {group ? group.name : allGroups.length > 0 ? 'Ungrouped' : 'Accounts'}
                </h2>
                <span className="text-xs text-muted">
                  <span className="tnum">{rows.length}</span> account{rows.length === 1 ? '' : 's'}
                </span>
                {counts.excluded > 0 && (
                  <span className="text-xs text-muted">
                    <span className="tnum">{counts.excluded}</span> of{' '}
                    <span className="tnum">{counts.total}</span> not counted
                  </span>
                )}
                {group && (
                  <GroupNetWorthAction
                    groupId={group.id}
                    groupName={group.name}
                    total={counts.total}
                    excluded={counts.excluded}
                  />
                )}
                {group && (
                  <div className="flex shrink-0 items-center">
                    <IconButton
                      label={
                        reorderBlocked
                          ? `Move group ${group.name} up — clear the search first`
                          : `Move group ${group.name} up`
                      }
                      className="p-1.5"
                      disabled={reorderBlocked || groupIndex <= 0}
                      onClick={() => void shiftGroup(group.id, 'up')}
                    >
                      <IconChevronDown size={15} className="rotate-180" />
                    </IconButton>
                    <IconButton
                      label={
                        reorderBlocked
                          ? `Move group ${group.name} down — clear the search first`
                          : `Move group ${group.name} down`
                      }
                      className="p-1.5"
                      disabled={reorderBlocked || groupIndex === allGroups.length - 1}
                      onClick={() => void shiftGroup(group.id, 'down')}
                    >
                      <IconChevronDown size={15} />
                    </IconButton>
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
                  </div>
                )}
              </div>
              {rows.length === 0 ? (
                <p className="px-4 py-3 text-sm text-faint">
                  No accounts in this group yet — pick it in any account’s group menu to file one
                  here.
                </p>
              ) : (
                <ul>
                  {rows.map((b, i) => (
                    <AccountRow
                      key={b.account.id}
                      row={b}
                      groups={allGroups}
                      reorder={{
                        upDisabled: reorderBlocked || i === 0,
                        downDisabled: reorderBlocked || i === rows.length - 1,
                        hint: reorderBlocked ? ' — clear the search first' : undefined,
                        onMove: (direction) => void move(b.account.id, direction),
                      }}
                      onEdit={() => setEditing({ account: b.account, txCount: b.txCount })}
                    />
                  ))}
                </ul>
              )}
            </Card>
          );
        })}

      {editing && (
        <AccountModal
          account={editing.account}
          txCount={editing.txCount}
          groups={allGroups}
          defaultCurrency={settings?.baseCurrency ?? 'GBP'}
          onClose={() => setEditing(null)}
        />
      )}
      {organising && <OrganiseAccountsModal onClose={() => setOrganising(false)} />}
      {groupModal && <GroupModal group={groupModal.group} onClose={() => setGroupModal(null)} />}
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

/**
 * One account: colour, name/type/count, balance, whether it counts towards net
 * worth, its group, row actions. The net-worth switch is on the row rather than
 * behind the editor because with 58 imported accounts, deciding what counts is
 * a pass down the list, not 58 modals.
 */
function AccountRow({
  row,
  groups,
  reorder,
  onEdit,
}: {
  row: AccountBalance;
  groups: AccountGroup[];
  reorder: RowReorder | null;
  onEdit: () => void;
}) {
  const { account, balanceMinor, txCount, excludedFromNetWorth } = row;
  return (
    <li className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-4 py-2.5 last:border-0">
      <span
        aria-hidden="true"
        className="h-3 w-3 shrink-0 rounded-full"
        style={{ backgroundColor: account.colour }}
      />
      <div className="min-w-0 flex-1 basis-40">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium text-text">{account.name}</span>
          {account.archived && <Chip>Archived</Chip>}
          {excludedFromNetWorth && <NotCountedBadge />}
        </div>
        <div className="text-xs text-muted">
          {ACCOUNT_TYPE_LABELS[account.type]} · {txCount} transaction{txCount === 1 ? '' : 's'}
        </div>
      </div>
      {/* The balance never changes with the switch beside it — that is the
          whole point, so they sit next to each other. */}
      <Amount
        minor={balanceMinor}
        currency={account.currency}
        className={cn('text-sm', balanceMinor < 0 && 'text-neg')}
      />
      <CountInNetWorthToggle account={account} />
      <AccountGroupSelect account={account} groups={groups} className="sm:w-44" />
      <div className="flex shrink-0 items-center">
        {reorder && (
          <>
            <IconButton
              label={`Move ${account.name} up${reorder.hint ?? ''}`}
              className="p-1.5"
              disabled={reorder.upDisabled}
              onClick={() => reorder.onMove('up')}
            >
              <IconChevronDown size={15} className="rotate-180" />
            </IconButton>
            <IconButton
              label={`Move ${account.name} down${reorder.hint ?? ''}`}
              className="p-1.5"
              disabled={reorder.downDisabled}
              onClick={() => reorder.onMove('down')}
            >
              <IconChevronDown size={15} />
            </IconButton>
          </>
        )}
        <IconButton label={`Edit ${account.name}`} className="p-1.5" onClick={onEdit}>
          <IconPencil size={15} />
        </IconButton>
      </div>
    </li>
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
