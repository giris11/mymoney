// Category tree domain (SPEC §8.1.3).
import { db } from '../db/db';
import type { Category, CategoryKind } from '../db/types';
import { nameKey, uid } from '../lib/util';

export interface CategoryNode extends Category {
  children: CategoryNode[];
}

/**
 * Pure: parentId links → sorted tree (sortOrder, then name). Orphans (missing
 * parent) surface as roots so data is never invisible.
 */
export function buildTree(cats: Category[]): CategoryNode[] {
  const nodes = new Map<string, CategoryNode>();
  for (const c of cats) nodes.set(c.id, { ...c, children: [] });
  const roots: CategoryNode[] = [];
  for (const node of nodes.values()) {
    const parent = node.parentId ? nodes.get(node.parentId) : undefined;
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  const sortRec = (list: CategoryNode[]) => {
    list.sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name));
    for (const n of list) sortRec(n.children);
  };
  sortRec(roots);
  return roots;
}

/** Pure: the given ids plus ALL their descendants (D16). */
export function descendantIds(all: Category[], rootIds: Iterable<string>): Set<string> {
  const childrenOf = new Map<string, string[]>();
  for (const c of all) {
    if (!c.parentId) continue;
    const list = childrenOf.get(c.parentId) ?? [];
    list.push(c.id);
    childrenOf.set(c.parentId, list);
  }
  const out = new Set<string>();
  const queue = [...rootIds];
  while (queue.length) {
    const id = queue.pop()!;
    if (out.has(id)) continue;
    out.add(id);
    for (const child of childrenOf.get(id) ?? []) queue.push(child);
  }
  return out;
}

/** "Food & Drink › Groceries" — for register rows and pickers. */
export function categoryPathName(byId: Map<string, Category>, id: string): string {
  const parts: string[] = [];
  const seen = new Set<string>(); // cycle guard
  let cur = byId.get(id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(' › ');
}

/**
 * Tree of categories, optionally one kind only. Excluding archived prunes the
 * whole subtree beneath an archived category.
 */
export async function categoryTree(
  kind?: CategoryKind,
  includeArchived = false,
): Promise<CategoryNode[]> {
  let cats = await db.categories.toArray();
  if (kind) cats = cats.filter((c) => c.kind === kind);
  let tree = buildTree(cats);
  if (!includeArchived) {
    const prune = (list: CategoryNode[]): CategoryNode[] =>
      list.filter((n) => !n.archived).map((n) => ({ ...n, children: prune(n.children) }));
    tree = prune(tree);
  }
  return tree;
}

export interface SaveCategoryInput {
  id?: string;
  name: string;
  parentId?: string | null;
  kind: CategoryKind;
  colour?: string;
  archived?: boolean;
}

export async function saveCategory(input: SaveCategoryInput): Promise<Category> {
  const name = input.name.trim().replace(/\s+/g, ' ');
  if (!name) throw new Error('Category name cannot be empty');
  return db.transaction('rw', db.categories, async () => {
    const parentId = input.parentId ?? null;
    if (parentId) {
      const parent = await db.categories.get(parentId);
      if (!parent) throw new Error('Parent category not found');
      if (parent.kind !== input.kind) throw new Error('Parent has a different kind');
      // cycle guard: walk up from the parent; hitting self would loop
      if (input.id) {
        let cur: Category | undefined = parent;
        const seen = new Set<string>();
        while (cur) {
          if (cur.id === input.id) throw new Error('A category cannot be inside itself');
          if (seen.has(cur.id)) break;
          seen.add(cur.id);
          cur = cur.parentId ? await db.categories.get(cur.parentId) : undefined;
        }
      }
    }
    const existing = input.id ? await db.categories.get(input.id) : undefined;
    // NB: IndexedDB indexes never contain null — root-level lookups must filter.
    const siblings = parentId
      ? await db.categories.where('parentId').equals(parentId).toArray()
      : await db.categories.filter((c) => c.parentId === null).toArray();
    const maxSort = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1);
    const cat: Category = {
      id: existing?.id ?? uid(),
      name,
      parentId,
      kind: input.kind,
      colour: input.colour ?? existing?.colour,
      icon: existing?.icon,
      archived: input.archived ?? existing?.archived ?? false,
      sortOrder: existing && existing.parentId === parentId ? existing.sortOrder : maxSort + 1,
    };
    await db.categories.put(cat);
    return cat;
  });
}

/**
 * Delete only when the category has no children, no transactions/splits and no
 * budget references; payee default-category references are cleared, not
 * blocking. Otherwise {ok:false, reason} — archive instead.
 */
export async function deleteCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
  const children = await db.categories.where('parentId').equals(id).count();
  if (children > 0) return { ok: false, reason: 'Has subcategories' };
  const direct = await db.transactions.where('categoryId').equals(id).count();
  if (direct > 0) return { ok: false, reason: `Used by ${direct} transaction${direct === 1 ? '' : 's'}` };
  const inSplits = await db.transactions
    .filter((t) => t.splits.some((s) => s.categoryId === id))
    .count();
  if (inSplits > 0) return { ok: false, reason: `Used in ${inSplits} split${inSplits === 1 ? '' : 's'}` };
  const inBudgets = await db.budgets.filter((b) => b.categoryIds.includes(id)).count();
  if (inBudgets > 0) return { ok: false, reason: `Used by ${inBudgets} budget${inBudgets === 1 ? '' : 's'}` };
  await db.transaction('rw', db.categories, db.payees, async () => {
    const payees = await db.payees.filter((p) => p.defaultCategoryId === id).toArray();
    for (const p of payees) await db.payees.update(p.id, { defaultCategoryId: null });
    await db.categories.delete(id);
  });
  return { ok: true };
}

/**
 * Resolve a path like ['Food & Drink','Groceries'] to a leaf category,
 * creating missing levels (used by imports). Case-insensitive matching.
 * Safe to call inside a parent Dexie transaction that includes `categories`.
 */
export async function findOrCreateByPath(path: string[], kind: CategoryKind): Promise<Category> {
  const cleaned = path.map((p) => p.trim().replace(/\s+/g, ' ')).filter(Boolean);
  if (cleaned.length === 0) throw new Error('Empty category path');
  let parentId: string | null = null;
  let result: Category | null = null;
  for (const name of cleaned) {
    const key = nameKey(name);
    const siblings: Category[] = parentId
      ? await db.categories.where('parentId').equals(parentId).toArray()
      : await db.categories.filter((c) => c.parentId === null).toArray();
    let match = siblings.find((c) => nameKey(c.name) === key && c.kind === kind);
    if (!match) {
      const maxSort = siblings.reduce((m, s) => Math.max(m, s.sortOrder), -1);
      match = {
        id: uid(),
        name,
        parentId,
        kind,
        archived: false,
        sortOrder: maxSort + 1,
      };
      await db.categories.add(match);
    }
    result = match;
    parentId = match.id;
  }
  return result!;
}
