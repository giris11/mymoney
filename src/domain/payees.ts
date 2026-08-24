// Payees with learned default categories (SPEC §7.4, D17).
import { db } from '../db/db';
import type { Payee } from '../db/types';
import { nameKey, uid } from '../lib/util';

/** Case/whitespace-insensitive lookup by name; creates when missing. */
export async function getOrCreatePayee(name: string): Promise<Payee> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Payee name cannot be empty');
  const key = nameKey(clean);
  const existing = await db.payees.where('nameLower').equals(key).first();
  if (existing) return existing;
  const payee: Payee = { id: uid(), name: clean, nameLower: key, defaultCategoryId: null };
  await db.payees.add(payee);
  return payee;
}

/** Prefix matches ranked before substring matches, for autocomplete. */
export async function searchPayees(query: string, limit = 8): Promise<Payee[]> {
  const key = nameKey(query);
  const all = await db.payees.toArray();
  if (!key) return all.sort((a, b) => a.name.localeCompare(b.name)).slice(0, limit);
  const prefix: Payee[] = [];
  const substring: Payee[] = [];
  for (const p of all) {
    if (p.nameLower.startsWith(key)) prefix.push(p);
    else if (p.nameLower.includes(key)) substring.push(p);
  }
  prefix.sort((a, b) => a.name.localeCompare(b.name));
  substring.sort((a, b) => a.name.localeCompare(b.name));
  return [...prefix, ...substring].slice(0, limit);
}

/**
 * Recompute defaultCategoryId as the most frequent category across this
 * payee's transactions (split categories count too; ties → most recent date).
 */
export async function learnPayeeCategory(payeeId: string): Promise<void> {
  const txs = await db.transactions.where('payeeId').equals(payeeId).toArray();
  const freq = new Map<string, { count: number; latest: string }>();
  const bump = (categoryId: string | null, date: string) => {
    if (!categoryId) return;
    const cur = freq.get(categoryId) ?? { count: 0, latest: '' };
    cur.count += 1;
    if (date > cur.latest) cur.latest = date;
    freq.set(categoryId, cur);
  };
  for (const t of txs) {
    if (t.splits.length > 0) for (const s of t.splits) bump(s.categoryId, t.date);
    else bump(t.categoryId, t.date);
  }
  let best: string | null = null;
  let bestScore: { count: number; latest: string } | null = null;
  for (const [id, score] of freq) {
    if (
      !bestScore ||
      score.count > bestScore.count ||
      (score.count === bestScore.count && score.latest > bestScore.latest)
    ) {
      best = id;
      bestScore = score;
    }
  }
  await db.payees.update(payeeId, { defaultCategoryId: best });
}

/** Manual override from the Settings rules list. */
export async function setPayeeDefaultCategory(
  payeeId: string,
  categoryId: string | null,
): Promise<void> {
  await db.payees.update(payeeId, { defaultCategoryId: categoryId });
}

export async function renamePayee(payeeId: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Payee name cannot be empty');
  const key = nameKey(clean);
  const clash = await db.payees.where('nameLower').equals(key).first();
  if (clash && clash.id !== payeeId) {
    throw new Error(`A payee called “${clash.name}” already exists`);
  }
  await db.payees.update(payeeId, { name: clean, nameLower: key });
}

/** Delete only when unused; otherwise {ok:false, reason}. */
export async function deletePayee(payeeId: string): Promise<{ ok: boolean; reason?: string }> {
  const count = await db.transactions.where('payeeId').equals(payeeId).count();
  if (count > 0) {
    return { ok: false, reason: `Used by ${count} transaction${count === 1 ? '' : 's'}` };
  }
  await db.payees.delete(payeeId);
  return { ok: true };
}
