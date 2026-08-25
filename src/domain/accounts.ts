// Account and account-group domain (SPEC §8.1.1: full CRUD, groups, colours,
// archive). Owned by the Settings area but domain-grade: no DOM, all writes in
// Dexie transactions, ValidationError for user mistakes (caught + toasted by
// the UI).
//
// Semantics:
//  * openingBalanceMinor is a signed integer in the ACCOUNT's currency minor
//    units (SPEC §6) — positive for assets, negative for debt.
//  * currency is IMMUTABLE once the account has transactions: every stored
//    transaction amount is in the account's currency, so changing it would
//    silently re-denominate history (SPEC §6 "protect the data").
//  * deleteAccount refuses while transactions reference the account —
//    archiving is the supported way to retire an account with history.
//  * deleteGroup refuses while any account references the group; deleting a
//    group never touches accounts.
import { db } from '../db/db';
import type { Account, AccountGroup, AccountType } from '../db/types';
import { uid } from '../lib/util';
import { ValidationError } from './transactions';

export const ACCOUNT_TYPES: readonly AccountType[] = [
  'current',
  'savings',
  'credit_card',
  'cash',
  'loan',
  'investment',
] as const;

export interface SaveAccountInput {
  id?: string; // present = update
  name: string;
  type: AccountType;
  currency: string; // 3-letter ISO code
  openingBalanceMinor: number;
  colour: string; // hex, e.g. '#2563eb'
  groupId: string | null;
  sortOrder?: number; // omitted: keep existing / append at the end
  archived?: boolean; // omitted: keep existing / false
}

/** Create or update an account. Throws ValidationError on bad input. */
export async function saveAccount(input: SaveAccountInput): Promise<Account> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Account name cannot be empty');
  if (!ACCOUNT_TYPES.includes(input.type)) {
    throw new ValidationError(`Unknown account type “${input.type}”`);
  }
  const currency = input.currency.trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    throw new ValidationError('Currency must be a 3-letter ISO code (e.g. GBP)');
  }
  if (!Number.isSafeInteger(input.openingBalanceMinor)) {
    throw new ValidationError('Opening balance must be a whole number of minor units');
  }
  const colour = input.colour.trim();
  if (!/^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(colour)) {
    throw new ValidationError('Colour must be a hex value like #2563eb');
  }

  return db.transaction('rw', db.accounts, db.accountGroups, db.transactions, async () => {
    const existing = input.id ? await db.accounts.get(input.id) : undefined;
    if (input.id && !existing) throw new ValidationError('Account not found');

    const groupId = input.groupId ?? null;
    if (groupId && !(await db.accountGroups.get(groupId))) {
      throw new ValidationError('Account group not found');
    }

    // Currency is immutable once transactions exist (see file header).
    if (existing && currency !== existing.currency) {
      const txCount = await db.transactions.where('accountId').equals(existing.id).count();
      if (txCount > 0) {
        throw new ValidationError(
          `Currency can't be changed: this account has ${txCount} transaction${
            txCount === 1 ? '' : 's'
          } recorded in ${existing.currency}. Create a new ${currency} account instead.`,
        );
      }
    }

    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const all = await db.accounts.toArray();
      sortOrder = all.reduce((m, a) => Math.max(m, a.sortOrder), -1) + 1;
    }

    const account: Account = {
      ...existing, // preserves optional loan fields on update
      id: existing?.id ?? uid(),
      name,
      type: input.type,
      currency,
      openingBalanceMinor: input.openingBalanceMinor,
      colour,
      groupId,
      sortOrder,
      archived: input.archived ?? existing?.archived ?? false,
    };
    await db.accounts.put(account);
    return account;
  });
}

/** Archive/unarchive without touching any other field. */
export async function setAccountArchived(id: string, archived: boolean): Promise<void> {
  const updated = await db.accounts.update(id, { archived });
  if (updated === 0) throw new ValidationError('Account not found');
}

/**
 * Delete an account. Blocked ({ok:false, reason}) while any transaction
 * references it — archive instead. Deleting an already-missing id is a no-op.
 */
export async function deleteAccount(id: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction('rw', db.accounts, db.transactions, async () => {
    const account = await db.accounts.get(id);
    if (!account) return { ok: true };
    const txCount = await db.transactions.where('accountId').equals(id).count();
    if (txCount > 0) {
      return {
        ok: false,
        reason: `it has ${txCount} transaction${txCount === 1 ? '' : 's'} — archive it instead`,
      };
    }
    await db.accounts.delete(id);
    return { ok: true };
  });
}

/**
 * Swap an account one place up/down among the accounts of the SAME group
 * (sidebar order). Sort orders of the whole sibling list are normalised to
 * 0..n-1 so duplicates from imports can't make reordering a no-op.
 */
export async function reorderAccount(id: string, direction: 'up' | 'down'): Promise<void> {
  await db.transaction('rw', db.accounts, async () => {
    const account = await db.accounts.get(id);
    if (!account) throw new ValidationError('Account not found');
    // groupId can be null — IndexedDB indexes never contain null, so filter().
    const siblings = (await db.accounts.toArray())
      .filter((a) => a.groupId === account.groupId)
      .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    const i = siblings.findIndex((a) => a.id === id);
    const j = direction === 'up' ? i - 1 : i + 1;
    if (i < 0 || j < 0 || j >= siblings.length) return; // already at the edge
    [siblings[i], siblings[j]] = [siblings[j], siblings[i]];
    for (let k = 0; k < siblings.length; k++) {
      if (siblings[k].sortOrder !== k) await db.accounts.update(siblings[k].id, { sortOrder: k });
    }
  });
}

export interface SaveGroupInput {
  id?: string; // present = rename
  name: string;
  sortOrder?: number;
}

/** Create or rename an account group. Throws ValidationError on bad input. */
export async function saveGroup(input: SaveGroupInput): Promise<AccountGroup> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new ValidationError('Group name cannot be empty');
  return db.transaction('rw', db.accountGroups, async () => {
    const existing = input.id ? await db.accountGroups.get(input.id) : undefined;
    if (input.id && !existing) throw new ValidationError('Group not found');
    let sortOrder = input.sortOrder ?? existing?.sortOrder;
    if (sortOrder === undefined) {
      const all = await db.accountGroups.toArray();
      sortOrder = all.reduce((m, g) => Math.max(m, g.sortOrder), -1) + 1;
    }
    const group: AccountGroup = { id: existing?.id ?? uid(), name, sortOrder };
    await db.accountGroups.put(group);
    return group;
  });
}

/**
 * Delete a group — only when no account references it ({ok:false, reason}
 * otherwise). Accounts are never deleted or moved by this call.
 */
export async function deleteGroup(id: string): Promise<{ ok: boolean; reason?: string }> {
  return db.transaction('rw', db.accountGroups, db.accounts, async () => {
    const used = await db.accounts.where('groupId').equals(id).count();
    if (used > 0) {
      return {
        ok: false,
        reason: `it still contains ${used} account${used === 1 ? '' : 's'}`,
      };
    }
    await db.accountGroups.delete(id);
    return { ok: true };
  });
}
