// Tags (SPEC §8.1.3). CONTRACT — implemented by the domain build agent.
import type { Tag } from '../db/types';

/** Case-insensitive lookup/create for each name; skips blanks; dedupes. */
export async function getOrCreateTags(names: string[]): Promise<Tag[]> {
  void names;
  throw new Error('not implemented');
}

export async function renameTag(tagId: string, name: string): Promise<void> {
  void tagId;
  void name;
  throw new Error('not implemented');
}

/** Deleting a tag also removes it from every transaction (UI confirms first). */
export async function deleteTag(tagId: string): Promise<void> {
  void tagId;
  throw new Error('not implemented');
}

export async function tagUsageCounts(): Promise<Map<string, number>> {
  throw new Error('not implemented');
}
