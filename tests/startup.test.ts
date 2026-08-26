// Startup robustness — the two things that must survive a cold start on a
// device that is NOT a secure context and a browser with two tabs open.
//
//  * `uid()` must work over plain http on the LAN. SPEC §11.6 promises "open
//    it on my iPhone (same wifi)", i.e. http://192.168.x.x, which is NOT a
//    secure context; `crypto.randomUUID` is specified as secure-context-only
//    and is simply absent there. Every id in the app comes from `uid()`, so a
//    throw here kills the startup seed and onboarding with it.
//  * `seedCategoriesIfEmpty()` runs at every app start (src/main.tsx). Two
//    contexts starting at once (two tabs, or a tab plus a restored session)
//    must not both seed the tree.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { uid } from '../src/lib/util';
import { db } from '../src/db/db';
import { defaultCategories, seedCategoriesIfEmpty } from '../src/db/seed';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

/** Fill every byte with the same value — pins the version/variant bit maths. */
const constantBytes = (value: number) => ({
  getRandomValues: <T extends ArrayBufferView>(a: T): T => {
    new Uint8Array(a.buffer, a.byteOffset, a.byteLength).fill(value);
    return a;
  },
});

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('uid() — id generation outside a secure context (SPEC §11.6)', () => {
  it('uses crypto.randomUUID when the platform has it', () => {
    const randomUUID = vi.fn(() => '11111111-2222-4333-8444-555555555555');
    vi.stubGlobal('crypto', { randomUUID, ...constantBytes(0xab) });
    expect(uid()).toBe('11111111-2222-4333-8444-555555555555');
    expect(randomUUID).toHaveBeenCalledTimes(1);
  });

  it('falls back to crypto.getRandomValues when randomUUID is absent (http://192.168.x.x)', () => {
    // getRandomValues is NOT secure-context gated, so this is the branch an
    // iPhone on the LAN actually takes.
    vi.stubGlobal('crypto', constantBytes(0xff));
    expect(uid()).toBe('ffffffff-ffff-4fff-bfff-ffffffffffff');
    vi.stubGlobal('crypto', constantBytes(0x00));
    expect(uid()).toBe('00000000-0000-4000-8000-000000000000');
  });

  it('sets version 4 and the RFC 4122 variant on the getRandomValues path', () => {
    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    const ids = Array.from({ length: 500 }, () => uid());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(500);
  });

  it('still produces unique ids when there is no crypto object at all', () => {
    vi.stubGlobal('crypto', undefined);
    const ids = Array.from({ length: 2000 }, () => uid());
    for (const id of ids) expect(id).toMatch(UUID_V4);
    expect(new Set(ids).size).toBe(2000);
  });

  it('does not throw when crypto exists but is empty', () => {
    vi.stubGlobal('crypto', {});
    expect(() => uid()).not.toThrow();
    expect(uid()).toMatch(UUID_V4);
  });
});

describe('startup seed on a non-secure context', () => {
  beforeEach(clearAll);

  it('seeds the whole category tree with no crypto.randomUUID available', async () => {
    vi.stubGlobal('crypto', constantBytes(0)); // deliberately worst-case
    const expected = defaultCategories().length;
    vi.unstubAllGlobals();
    expect(expected).toBe(61);

    const real = globalThis.crypto;
    vi.stubGlobal('crypto', { getRandomValues: real.getRandomValues.bind(real) });
    await seedCategoriesIfEmpty();
    const rows = await db.categories.toArray();
    expect(rows).toHaveLength(expected);
    expect(new Set(rows.map((c) => c.id)).size).toBe(expected);
  });
});

describe('seedCategoriesIfEmpty() is atomic', () => {
  beforeEach(clearAll);

  it('seeds exactly once when two contexts start at the same time', async () => {
    const expected = defaultCategories().length;
    await Promise.all([seedCategoriesIfEmpty(), seedCategoriesIfEmpty()]);
    expect(await db.categories.count()).toBe(expected);
  });

  it('seeds exactly once under a burst of concurrent starts', async () => {
    const expected = defaultCategories().length;
    await Promise.all(Array.from({ length: 5 }, () => seedCategoriesIfEmpty()));
    expect(await db.categories.count()).toBe(expected);
  });

  it('is a no-op when categories already exist (never duplicates a real tree)', async () => {
    await seedCategoriesIfEmpty();
    const before = await db.categories.toArray();
    await seedCategoriesIfEmpty();
    const after = await db.categories.toArray();
    expect(after.map((c) => c.id).sort()).toEqual(before.map((c) => c.id).sort());
  });
});
