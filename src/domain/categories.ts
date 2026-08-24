// Category tree domain (SPEC §8.1.3). CONTRACT — implemented by the domain
// build agent; signatures and documented semantics are fixed.
import type { Category, CategoryKind } from '../db/types';

export interface CategoryNode extends Category {
  children: CategoryNode[];
}

/** Pure, unit-tested: parentId links → sorted tree (sortOrder, then name). */
export function buildTree(cats: Category[]): CategoryNode[] {
  void cats;
  throw new Error('not implemented');
}

/** Set of the given ids plus ALL their descendants (D16). Pure. */
export function descendantIds(all: Category[], rootIds: Iterable<string>): Set<string> {
  void all;
  void rootIds;
  throw new Error('not implemented');
}

/** "Food & Drink › Groceries" — for register rows and pickers. */
export function categoryPathName(byId: Map<string, Category>, id: string): string {
  void byId;
  void id;
  throw new Error('not implemented');
}

export async function categoryTree(
  kind?: CategoryKind,
  includeArchived = false,
): Promise<CategoryNode[]> {
  void kind;
  void includeArchived;
  throw new Error('not implemented');
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
  void input;
  throw new Error('not implemented');
}

/**
 * Delete only when the category has no children and no transactions/splits/
 * budgets referencing it; otherwise return {ok:false, reason} (archive instead).
 */
export async function deleteCategory(id: string): Promise<{ ok: boolean; reason?: string }> {
  void id;
  throw new Error('not implemented');
}

/**
 * Resolve a path like ['Food & Drink','Groceries'] to a leaf category,
 * creating missing levels (used by imports). Case-insensitive matching.
 */
export async function findOrCreateByPath(path: string[], kind: CategoryKind): Promise<Category> {
  void path;
  void kind;
  throw new Error('not implemented');
}
