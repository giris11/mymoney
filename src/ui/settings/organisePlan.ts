// The arithmetic behind the "Organise accounts" preview, kept pure and free of
// Dexie so it can be unit-tested. Its one job is honesty: what this file counts
// must be exactly what autoGroupAccounts() will do, or the modal is promising
// changes that never happen.
//
// Two domain rules it mirrors (src/domain/accounts.ts):
//  * a group whose name matches case/whitespace-insensitively is REUSED, so
//    an account already in "savings" is already in "Savings";
//  * `onlyUngrouped` leaves every account that has a group completely alone —
//    including its type.
import type { GroupingSuggestion } from '../../domain/accounts';
import type { Account, AccountGroup } from '../../db/types';
import { nameKey } from '../../lib/util';

/** Only the fields the plan needs — keeps the test fixtures honest and small. */
export type AccountRef = Pick<Account, 'id' | 'groupId'>;
export type GroupRef = Pick<AccountGroup, 'id' | 'name'>;

export interface PlanOptions {
  applyTypes: boolean;
  onlyUngrouped: boolean;
}

export interface PlanRow {
  suggestion: GroupingSuggestion;
  /** Name of the group the account is in today, or null. */
  currentGroupName: string | null;
  /** Excluded by "only file accounts I haven't grouped yet". */
  leftAlone: boolean;
  /** Its group would change if applied with these options. */
  filing: boolean;
  /** Its type would change if applied with these options. */
  retyping: boolean;
}

export interface PlanSection {
  name: string;
  rows: PlanRow[];
  filing: number;
  unsure: number;
}

export interface PlanSummary {
  sections: PlanSection[];
  filing: number;
  retyping: number;
  unsure: number;
  /** Groups that would have to be created (not already there under any casing). */
  newGroups: number;
}

export function planRows(
  suggestions: GroupingSuggestion[],
  accounts: AccountRef[],
  groups: GroupRef[],
  opts: PlanOptions,
): PlanRow[] {
  const byId = new Map(accounts.map((a) => [a.id, a]));
  const groupName = new Map(groups.map((g) => [g.id, g.name]));
  return suggestions.map((suggestion) => {
    const account = byId.get(suggestion.accountId);
    const groupId = account?.groupId ?? null;
    const currentGroupName = groupId ? groupName.get(groupId) ?? null : null;
    const leftAlone = opts.onlyUngrouped && groupId !== null;
    const sameGroup =
      currentGroupName !== null &&
      nameKey(currentGroupName) === nameKey(suggestion.suggestedGroup);
    return {
      suggestion,
      currentGroupName,
      leftAlone,
      filing: !leftAlone && !sameGroup,
      retyping: !leftAlone && opts.applyTypes && suggestion.suggestedType !== suggestion.currentType,
    };
  });
}

/**
 * Sections in the order the rows arrive — previewAutoGrouping() already sorts
 * by canonical group order, which is the order the sidebar will end up in.
 */
export function summarisePlan(rows: PlanRow[], groups: GroupRef[]): PlanSummary {
  const m = new Map<string, PlanRow[]>();
  for (const r of rows) {
    const list = m.get(r.suggestion.suggestedGroup) ?? [];
    list.push(r);
    m.set(r.suggestion.suggestedGroup, list);
  }
  const existing = new Set(groups.map((g) => nameKey(g.name)));
  const sections = [...m.entries()].map(([name, list]) => ({
    name,
    rows: list,
    filing: list.filter((r) => r.filing).length,
    unsure: list.filter((r) => isUnsure(r)).length,
  }));
  return {
    sections,
    filing: rows.filter((r) => r.filing).length,
    retyping: rows.filter((r) => r.retyping).length,
    unsure: rows.filter((r) => isUnsure(r)).length,
    newGroups: sections.filter((s) => s.filing > 0 && !existing.has(nameKey(s.name))).length,
  };
}

/** A guess worth a second look — but only where it would actually be applied. */
function isUnsure(row: PlanRow): boolean {
  return !row.suggestion.confident && !row.leftAlone;
}
