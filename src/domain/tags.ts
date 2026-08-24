// Tags (SPEC §8.1.3).
import { db } from '../db/db';
import type { Tag } from '../db/types';
import { nameKey, uid } from '../lib/util';

/** Case-insensitive lookup/create for each name; skips blanks; dedupes. */
export async function getOrCreateTags(names: string[]): Promise<Tag[]> {
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const raw of names) {
    const clean = raw.trim().replace(/\s+/g, ' ');
    if (!clean) continue;
    const key = nameKey(clean);
    if (seen.has(key)) continue;
    seen.add(key);
    const existing = await db.tags.where('nameLower').equals(key).first();
    if (existing) {
      out.push(existing);
    } else {
      const tag: Tag = { id: uid(), name: clean, nameLower: key };
      await db.tags.add(tag);
      out.push(tag);
    }
  }
  return out;
}

export async function renameTag(tagId: string, name: string): Promise<void> {
  const clean = name.trim().replace(/\s+/g, ' ');
  if (!clean) throw new Error('Tag name cannot be empty');
  const key = nameKey(clean);
  const clash = await db.tags.where('nameLower').equals(key).first();
  if (clash && clash.id !== tagId) throw new Error(`A tag called “${clash.name}” already exists`);
  await db.tags.update(tagId, { name: clean, nameLower: key });
}

/** Deleting a tag also removes it from every transaction (UI confirms first). */
export async function deleteTag(tagId: string): Promise<void> {
  await db.transaction('rw', db.tags, db.transactions, async () => {
    const affected = await db.transactions.where('tagIds').equals(tagId).toArray();
    for (const t of affected) {
      await db.transactions.update(t.id, { tagIds: t.tagIds.filter((id) => id !== tagId) });
    }
    await db.tags.delete(tagId);
  });
}

export async function tagUsageCounts(): Promise<Map<string, number>> {
  const tags = await db.tags.toArray();
  const counts = new Map<string, number>();
  for (const tag of tags) {
    counts.set(tag.id, await db.transactions.where('tagIds').equals(tag.id).count());
  }
  return counts;
}
