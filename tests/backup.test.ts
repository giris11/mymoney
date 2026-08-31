// Backup export/restore tests (SPEC §8.1.9, §10: backup round-trip equality),
// and — from the manifest work — the three claims that turn a backup into an
// ORACLE the Swift port can be checked against:
//   1. the file SAYS what it contains, and a restore holds it to that;
//   2. the file is CANONICAL, so an unchanged book always produces the same
//      bytes and therefore the same fingerprint;
//   3. a file written before any of this still restores, unchanged.
import 'fake-indexeddb/auto';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TABLES,
  BOOK_LEVEL_SETTING_KEYS,
  DATA_TABLES,
  DEVICE_LOCAL_SETTING_KEYS,
  db,
  flushLocalRevision,
  getSettings,
  SCHEMA_VERSION,
  updateSettings,
  defaultSettings,
} from '../src/db/db';
import {
  backupNudgeState,
  bookManifest,
  clearRecoveryStore,
  CURRENT_SCHEMA_VERSION,
  deleteRecoveryRecord,
  downloadBackup,
  downloadBackupFile,
  downloadRecoveryBackup,
  downloadVerifiedBackup,
  exportBackup,
  exportVerifiedBackup,
  listRecoveryRecords,
  markBackupSaved,
  pinDeviceLocalSettings,
  PRETTY_PRINT_ROW_LIMIT,
  readRecoveryBackup,
  recoveryDb,
  RECOVERY_KEEP,
  restoreBackup,
  restoreRecoveryBackup,
  saveRecoverySnapshot,
  serializeBackup,
  validateBackup,
  type BackupFile,
  type BackupValidation,
} from '../src/backup/backup';
import {
  backupContentForHash,
  canonicalBackupHash,
  canonicalJson,
  sha256Hex,
} from '../src/backup/canonical';
import {
  compareManifests,
  computeManifest,
  manifestSourceFromTables,
  MANIFEST_VERSION,
  summariseManifest,
  validateManifestShape,
  type BackupManifest,
} from '../src/backup/manifest';
import { restoredNote, selfCheckNote } from '../src/ui/settings/RestoreFromBackup';
import { netWorth } from '../src/domain/balances';
import { makeDedupeHash } from '../src/import/dedupe';
import { sumSplits } from '../src/money/money';
import type {
  Account,
  AccountGroup,
  Budget,
  Category,
  FxRate,
  ImportBatch,
  Payee,
  Settings,
  Tag,
  Transaction,
} from '../src/db/types';

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};
beforeEach(async () => {
  await clearAll();
  // A database of its own (see backup.ts), so clearing db.tables misses it.
  await clearRecoveryStore();
  vi.restoreAllMocks();
});

const DAY_MS = 86_400_000;
const T0 = '2026-08-01T10:00:00.000Z';

// ---------------------------------------------------------------- seed data
// Every table gets at least one row so the round-trip proves full coverage.

const seedGroups: AccountGroup[] = [{ id: 'grp1', name: 'Everyday', sortOrder: 0 }];

const seedAccounts: Account[] = [
  {
    id: 'acc-gbp',
    name: 'Current',
    type: 'current',
    currency: 'GBP',
    openingBalanceMinor: 150_000, // £1,500.00
    colour: '#3b82f6',
    groupId: 'grp1',
    sortOrder: 0,
    archived: false,
  },
  {
    id: 'acc-usd',
    name: 'US Savings',
    type: 'savings',
    currency: 'USD',
    openingBalanceMinor: 0,
    colour: '#22c55e',
    groupId: null, // exercises the null-field case through the round trip
    sortOrder: 1,
    archived: false,
  },
];

const seedCategories: Category[] = [
  { id: 'cat-food', name: 'Food & Drink', parentId: null, kind: 'expense', archived: false, sortOrder: 0 },
  { id: 'cat-groc', name: 'Groceries', parentId: 'cat-food', kind: 'expense', archived: false, sortOrder: 0 },
  { id: 'cat-house', name: 'Household', parentId: null, kind: 'expense', archived: false, sortOrder: 1 },
  { id: 'cat-salary', name: 'Salary', parentId: null, kind: 'income', archived: false, sortOrder: 0 },
];

const seedPayees: Payee[] = [
  { id: 'pay-tesco', name: 'Tesco', nameLower: 'tesco', defaultCategoryId: 'cat-groc' },
];

const seedTags: Tag[] = [
  { id: 'tag-work', name: 'work', nameLower: 'work' },
  { id: 'tag-hol', name: 'holiday', nameLower: 'holiday' },
];

const tx = (over: Partial<Transaction> & Pick<Transaction, 'id' | 'accountId' | 'date' | 'amountMinor'>): Transaction => ({
  currency: 'GBP',
  payeeId: null,
  categoryId: null,
  tagIds: [],
  notes: '',
  status: 'cleared',
  splits: [],
  transferGroupId: null,
  importBatchId: null,
  dedupeHash: makeDedupeHash(over.accountId, over.date, over.amountMinor, over.notes ?? ''),
  createdAt: T0,
  updatedAt: T0,
  ...over,
});

const seedTransactions: Transaction[] = [
  // Simple expense: £45.67 at Tesco = -4567 minor.
  tx({
    id: 'tx-groc',
    accountId: 'acc-gbp',
    date: '2026-08-10',
    amountMinor: -4567,
    payeeId: 'pay-tesco',
    categoryId: 'cat-groc',
    tagIds: ['tag-work'],
    notes: 'weekly shop',
    dedupeHash: makeDedupeHash('acc-gbp', '2026-08-10', -4567, 'Tesco'),
  }),
  // Split transaction, pending. Hand-calc: parent -7845 (£78.45);
  // splits -5000 (£50.00 groceries) + -2845 (£28.45 household) = -7845 ✓.
  tx({
    id: 'tx-split',
    accountId: 'acc-gbp',
    date: '2026-08-12',
    amountMinor: -7845,
    payeeId: 'pay-tesco',
    status: 'pending',
    tagIds: ['tag-work', 'tag-hol'],
    splits: [
      { categoryId: 'cat-groc', amountMinor: -5000, notes: 'food' },
      { categoryId: 'cat-house', amountMinor: -2845, notes: 'cleaning stuff' },
    ],
    dedupeHash: makeDedupeHash('acc-gbp', '2026-08-12', -7845, 'Tesco'),
  }),
  // Income: £2,500.00 salary = +250000 minor.
  tx({
    id: 'tx-salary',
    accountId: 'acc-gbp',
    date: '2026-08-25',
    amountMinor: 250_000,
    categoryId: 'cat-salary',
    notes: 'August salary',
    dedupeHash: makeDedupeHash('acc-gbp', '2026-08-25', 250_000, 'August salary'),
  }),
  // Cross-currency transfer pair: both legs stored explicitly (SPEC §5),
  // -£100.00 out (=-10000 GBP minor) and +$127.00 in (=+12700 USD minor);
  // the USD amount is stored, never derived from the 1.27 rate.
  tx({
    id: 'tx-tr-out',
    accountId: 'acc-gbp',
    date: '2026-08-15',
    amountMinor: -10_000,
    transferGroupId: 'tg-1',
    notes: 'to US savings',
    dedupeHash: makeDedupeHash('acc-gbp', '2026-08-15', -10_000, 'to US savings'),
  }),
  tx({
    id: 'tx-tr-in',
    accountId: 'acc-usd',
    date: '2026-08-15',
    amountMinor: 12_700,
    currency: 'USD',
    transferGroupId: 'tg-1',
    notes: 'from Current',
    dedupeHash: makeDedupeHash('acc-usd', '2026-08-15', 12_700, 'from Current'),
  }),
  // Imported row tied to an importBatch.
  tx({
    id: 'tx-import',
    accountId: 'acc-gbp',
    date: '2026-07-01',
    amountMinor: -1250,
    payeeId: 'pay-tesco',
    categoryId: 'cat-groc',
    importBatchId: 'batch-1',
    dedupeHash: makeDedupeHash('acc-gbp', '2026-07-01', -1250, 'Tesco'),
  }),
];

const seedBudgets: Budget[] = [
  {
    id: 'bud-food',
    name: 'Food budget',
    categoryIds: ['cat-food'],
    amountMinor: 30_000, // £300.00/month
    period: 'monthly',
    startDate: '2026-01-01',
    rollover: false,
    archived: false,
  },
];

const seedFxRates: FxRate[] = [
  { id: 'GBP:USD', base: 'GBP', quote: 'USD', rate: 1.27, asOf: T0, source: 'manual' },
];

const seedBatches: ImportBatch[] = [
  {
    id: 'batch-1',
    source: 'moneywiz',
    fileName: 'moneywiz-export.csv',
    rowCount: 1,
    importedAt: T0,
    createdAccountIds: [],
    createdCategoryIds: ['cat-groc'],
    createdPayeeIds: ['pay-tesco'],
    createdTagIds: [],
    createdGroupIds: [],
  },
];

// Built over defaultSettings() so adding a setting never breaks this fixture —
// the same forward-compatibility getSettings() relies on.
const seedSettings: Settings = {
  ...defaultSettings(),
  id: 'app',
  schemaVersion: SCHEMA_VERSION,
  baseCurrency: 'GBP',
  theme: 'dark',
  lastBackupAt: null,
  onboarded: true,
  lastUsedAccountId: 'acc-gbp',
  savedMappings: {
    'sig-abc': {
      date: 0,
      amount: 1,
      debit: -1,
      credit: -1,
      payee: 2,
      description: 3,
      category: -1,
      account: -1,
      currency: -1,
      tags: -1,
      notes: -1,
      dateFormat: 'DMY',
      decimal: 'dot',
      negate: false,
      headerRow: true,
    },
  },
  // Deliberately ancient: the 7-day nudge now measures from createdAt while
  // lastBackupAt is null (E2), so a fixture install date must never drift into
  // the grace period as the calendar moves.
  createdAt: '2020-01-01T00:00:00.000Z',
};

async function seedAll(): Promise<void> {
  await db.accountGroups.bulkAdd(seedGroups);
  await db.accounts.bulkAdd(seedAccounts);
  await db.categories.bulkAdd(seedCategories);
  await db.payees.bulkAdd(seedPayees);
  await db.tags.bulkAdd(seedTags);
  await db.transactions.bulkAdd(seedTransactions);
  await db.budgets.bulkAdd(seedBudgets);
  await db.fxRates.bulkAdd(seedFxRates);
  await db.importBatches.bulkAdd(seedBatches);
  await db.settings.add(seedSettings);
}

const sortById = <T extends { id: string }>(rows: T[]): T[] =>
  [...rows].sort((a, b) => a.id.localeCompare(b.id));

const expectOk = (v: BackupValidation): BackupFile => {
  expect(v.ok, v.ok ? '' : (v as { error: string }).error).toBe(true);
  return (v as { ok: true; file: BackupFile }).file;
};

const expectError = (v: BackupValidation, re: RegExp): void => {
  expect(v.ok).toBe(false);
  expect((v as { ok: false; error: string }).error).toMatch(re);
};

/** A structurally valid, empty backup for validation tests. */
const minimalFile = (): Record<string, unknown> => ({
  app: 'MyMoney',
  schemaVersion: SCHEMA_VERSION,
  exportedAt: T0,
  tables: Object.fromEntries(ALL_TABLES.map((n) => [n, [] as unknown[]])),
});

// ---------------------------------------------------------------- round trip

describe('backup round trip', () => {
  it('seed sanity: split sums to parent', () => {
    const split = seedTransactions.find((t) => t.id === 'tx-split')!;
    // -5000 + -2845 = -7845 (hand-calculated above)
    expect(sumSplits(split.splits)).toBe(-7845);
    expect(sumSplits(split.splits)).toBe(split.amountMinor);
  });

  it('export → serialize → parse → validate → clear → restore restores every table identically', async () => {
    await seedAll();

    const file = await exportBackup();
    expect(file.app).toBe('MyMoney');
    expect(file.schemaVersion).toBe(SCHEMA_VERSION);
    expect(typeof file.exportedAt).toBe('string');
    expect(Object.keys(file.tables).sort()).toEqual([...ALL_TABLES].sort());

    const json = serializeBackup(file);
    const parsed = JSON.parse(json);
    const validated = expectOk(validateBackup(parsed));

    await clearAll();
    expect(await db.transactions.count()).toBe(0);
    expect(await db.settings.count()).toBe(0);
    // What this browser is, immediately before the restore. With no row of its
    // own that is the factory default — and it is what the restore must keep.
    const deviceBefore = await getSettings();

    await restoreBackup(validated);

    expect(sortById(await db.accounts.toArray())).toEqual(sortById(seedAccounts));
    expect(sortById(await db.accountGroups.toArray())).toEqual(sortById(seedGroups));
    expect(sortById(await db.transactions.toArray())).toEqual(sortById(seedTransactions));
    expect(sortById(await db.categories.toArray())).toEqual(sortById(seedCategories));
    expect(sortById(await db.payees.toArray())).toEqual(sortById(seedPayees));
    expect(sortById(await db.tags.toArray())).toEqual(sortById(seedTags));
    expect(sortById(await db.budgets.toArray())).toEqual(sortById(seedBudgets));
    expect(sortById(await db.fxRates.toArray())).toEqual(sortById(seedFxRates));
    expect(sortById(await db.importBatches.toArray())).toEqual(sortById(seedBatches));
    // The settings row is the ONE exception to "the file, verbatim" (C8): the
    // book-level half comes from the file, the device-local half stays this
    // browser's. Here the browser was wiped first, so its half is the factory
    // default: the file's 'dark' theme and its install date do not travel.
    const restored = (await db.settings.toArray())[0]!;
    for (const key of BOOK_LEVEL_SETTING_KEYS) {
      expect({ [key]: restored[key] }).toEqual({ [key]: seedSettings[key] });
    }
    for (const key of DEVICE_LOCAL_SETTING_KEYS) {
      // createdAt is the one device-local key a browser with no row of its own
      // mints fresh on every read (db.ts defaultSettings), so it cannot be
      // compared to a value read a moment earlier — only to what it must NOT
      // be, which is the writing device's install date.
      if (key === 'createdAt') continue;
      expect({ [key]: restored[key] }).toEqual({ [key]: deviceBefore[key] });
    }
    expect(restored.createdAt).not.toBe(seedSettings.createdAt);
    expect(Date.now() - Date.parse(restored.createdAt)).toBeLessThan(60_000);
  });

  it('serializeBackup is pretty-printed with 2-space indent, keys in canonical order', async () => {
    await seedAll();
    const json = serializeBackup(await exportBackup());
    // Top-level keys now come out sorted rather than in the order the object
    // literal happens to list them (src/backup/canonical.ts) — that is the
    // whole point: key order stops being an accident and becomes part of the
    // format, so a second implementation can reproduce the bytes.
    expect(json.startsWith('{\n  "app": "MyMoney",\n  "exportedAt"')).toBe(true);
    expect(json).toContain('\n    "accounts": [');
    expect(Object.keys(JSON.parse(json) as Record<string, unknown>)).toEqual([
      'app',
      'exportedAt',
      'manifest',
      'schemaVersion',
      'tables',
    ]);
  });

  // E3: pretty-printing costs ~45% of the file size, which matters when the
  // backup has to travel off a phone. Small files stay readable; big ones go
  // compact — and restore must accept either.
  it('a backup past the row threshold is compact and still round-trips', async () => {
    await seedAll();
    const bulk: Transaction[] = [];
    const extra = PRETTY_PRINT_ROW_LIMIT + 100 - seedTransactions.length;
    for (let i = 0; i < extra; i++) {
      bulk.push(
        tx({
          id: `bulk-${i}`,
          accountId: 'acc-gbp',
          date: '2026-06-01',
          amountMinor: -100 - i,
          dedupeHash: makeDedupeHash('acc-gbp', '2026-06-01', -100 - i, `bulk ${i}`),
          notes: `bulk ${i}`,
        }),
      );
    }
    await db.transactions.bulkAdd(bulk);
    const total = await db.transactions.count();
    expect(total).toBeGreaterThan(PRETTY_PRINT_ROW_LIMIT);

    const file = await exportBackup();
    const json = serializeBackup(file);
    expect(json.includes('\n')).toBe(false); // compact: not one line break
    expect(json.startsWith('{"app":"MyMoney"')).toBe(true);
    // Smaller than the pretty form by a wide margin (measured ~45% on real data).
    expect(json.length).toBeLessThan(JSON.stringify(file, null, 2).length * 0.8);

    // …and it is still a real backup: parse → validate → restore → identical.
    const validated = expectOk(validateBackup(JSON.parse(json)));
    await clearAll();
    await restoreBackup(validated);
    expect(await db.transactions.count()).toBe(total);
    expect(sortById(await db.accounts.toArray())).toEqual(sortById(seedAccounts));
    expect((await db.transactions.get('bulk-0'))!.amountMinor).toBe(-100);
  });

  it('exports empty arrays for empty tables and restores over existing data', async () => {
    const file = await exportBackup(); // empty db
    for (const name of ALL_TABLES) expect(file.tables[name]).toEqual([]);
    await seedAll();
    await restoreBackup(file); // restoring an empty backup wipes everything
    for (const name of DATA_TABLES) expect(await db.table(name).count()).toBe(0);
    // …everything except who this device is. A file with no settings row is
    // not a reason to forget the browser's own identity, install date and sync
    // bookkeeping: losing those is the same defect as importing someone
    // else's, pointed the other way (C8).
    expect(await db.settings.toArray()).toEqual([seedSettings]);
  });
});

// ---------------------------------------------------------------- validation

describe('validateBackup', () => {
  it('accepts a valid file and ignores unknown extra table keys', () => {
    const f = minimalFile();
    (f.tables as Record<string, unknown>).bogusFutureTable = [{ noId: true }];
    expectOk(validateBackup(f));
  });

  it('rejects non-objects with a clear message', () => {
    expectError(validateBackup(null), /JSON object/);
    expectError(validateBackup('hello'), /JSON object/);
    expectError(validateBackup(42), /JSON object/);
    expectError(validateBackup([]), /JSON object/);
  });

  it('rejects a wrong app marker', () => {
    const f = minimalFile();
    f.app = 'OtherApp';
    expectError(validateBackup(f), /MyMoney/);
    delete f.app;
    expectError(validateBackup(f), /"app"/);
  });

  it('rejects a backup from a newer schema version', () => {
    const f = minimalFile();
    f.schemaVersion = SCHEMA_VERSION + 1;
    expectError(validateBackup(f), /newer version/);
  });

  it('rejects non-positive-integer schemaVersions', () => {
    for (const bad of [0, -1, 1.5, '1', null, undefined]) {
      const f = minimalFile();
      f.schemaVersion = bad;
      expectError(validateBackup(f), /schemaVersion/);
    }
  });

  it('rejects a missing or non-string exportedAt', () => {
    const f = minimalFile();
    delete f.exportedAt;
    expectError(validateBackup(f), /exportedAt/);
  });

  it('rejects missing tables object', () => {
    const f = minimalFile();
    f.tables = 'nope';
    expectError(validateBackup(f), /"tables"/);
  });

  it('rejects a missing table, naming it', () => {
    const f = minimalFile();
    delete (f.tables as Record<string, unknown>).budgets;
    expectError(validateBackup(f), /"budgets".*missing|missing.*"budgets"/);
  });

  it('rejects a table that is not an array, naming it', () => {
    const f = minimalFile();
    (f.tables as Record<string, unknown>).accounts = { not: 'an array' };
    expectError(validateBackup(f), /"accounts".*array/);
  });

  it('rejects rows that are not objects or lack a string id', () => {
    let f = minimalFile();
    (f.tables as Record<string, unknown>).payees = ['just a string'];
    expectError(validateBackup(f), /payees\[0\].*not an object/);

    f = minimalFile();
    (f.tables as Record<string, unknown>).payees = [{ name: 'Tesco' }];
    expectError(validateBackup(f), /payees\[0\].*"id"/);

    f = minimalFile();
    (f.tables as Record<string, unknown>).transactions = [{ id: 123 }];
    expectError(validateBackup(f), /transactions\[0\].*"id"/);
  });

  it('rejects a settings row whose id is not "app"', () => {
    const f = minimalFile();
    (f.tables as Record<string, unknown>).settings = [{ id: 'wrong' }];
    expectError(validateBackup(f), /settings\[0\].*"app"/);
  });

  it('does not write anything while validating', async () => {
    await seedAll();
    const before = await db.transactions.count();
    validateBackup(minimalFile());
    validateBackup(null);
    expect(await db.transactions.count()).toBe(before);
  });
});

// ---------------------------------------------------------------- atomic restore

describe('restoreBackup atomicity', () => {
  it('a file that validates but has a duplicate primary key rejects AND changes nothing', async () => {
    await seedAll();
    const file = await exportBackup();
    const parsed = JSON.parse(serializeBackup(file)) as BackupFile;
    // Duplicate primary key: same transaction row twice. Both rows are objects
    // with string ids, so validation passes — only bulkAdd can catch this.
    const rows = parsed.tables.transactions as { id: string }[];
    rows.push({ ...rows[0] });
    expect(validateBackup(parsed).ok).toBe(true);

    await expect(restoreBackup(parsed)).rejects.toThrow();

    // The rw-transaction aborted: the clear was rolled back, previous data intact.
    expect(sortById(await db.transactions.toArray())).toEqual(sortById(seedTransactions));
    expect(sortById(await db.accounts.toArray())).toEqual(sortById(seedAccounts));
    expect(await db.settings.get('app')).toEqual(seedSettings);
    expect(await db.budgets.count()).toBe(seedBudgets.length);
    expect(await db.fxRates.count()).toBe(seedFxRates.length);
  });

  it('an invalid file rejects up front without touching the db', async () => {
    await seedAll();
    const bad = minimalFile();
    bad.app = 'NotMyMoney';
    await expect(restoreBackup(bad as unknown as BackupFile)).rejects.toThrow(/MyMoney/);
    expect(await db.transactions.count()).toBe(seedTransactions.length);
  });
});

// ---------------------------------------------------------------- download

/**
 * downloadBackup is browser-only, so these tests install the minimum browser
 * surface it touches on globalThis and always remove it again (the Node-guard
 * test below depends on `document` being absent).
 */
interface BrowserOpts {
  picker?: 'saved' | 'cancelled' | 'blocked' | 'write-fails';
  /** navigator.share behaviour; absent ⇒ no Web Share support at all. */
  share?: 'ok' | 'cancelled' | 'fails' | 'refuses';
  /** Touch device (phone/tablet)? Only there is the share sheet offered. */
  touch?: boolean;
}
interface Seen {
  clicks: number;
  written: string[];
  shared: { name: string; type: string; text: string }[];
}

async function withBrowser<T>(opts: BrowserOpts, fn: (seen: Seen) => Promise<T>): Promise<T> {
  const seen: Seen = { clicks: 0, written: [], shared: [] };
  const anchor = {
    href: '',
    download: '',
    rel: '',
    click: () => {
      seen.clicks += 1;
    },
    remove: () => {},
  };
  // The picker is looked up on globalThis (in a browser `window` IS
  // globalThis, and that spelling keeps the ladder usable from the sync
  // engine, which must stay importable without a `window`). `window` is still
  // installed because the app's own code reads it elsewhere.
  const win: Record<string, unknown> = {};
  if (opts.picker) {
    win.showSaveFilePicker = async () => {
      if (opts.picker === 'cancelled') {
        const err = new Error('The user aborted a request.');
        err.name = 'AbortError';
        throw err;
      }
      if (opts.picker === 'blocked') throw new Error('Blocked by permissions policy');
      return {
        createWritable: async () => ({
          write: async (data: string) => {
            if (opts.picker === 'write-fails') throw new Error('Disk full');
            seen.written.push(data);
          },
          close: async () => {},
        }),
      };
    };
  }
  const g = globalThis as unknown as Record<string, unknown>;
  g.window = win;
  if (opts.picker) g.showSaveFilePicker = win.showSaveFilePicker;
  g.document = { createElement: () => anchor, body: { appendChild: () => {} } };

  // navigator is a real global in Node, so save and restore the descriptor.
  const originalNav = Object.getOwnPropertyDescriptor(globalThis, 'navigator');
  if (opts.share || opts.touch !== undefined) {
    const nav: Record<string, unknown> = { maxTouchPoints: opts.touch === false ? 0 : 5 };
    if (opts.share) {
      nav.canShare = (data: { files?: unknown[] }) =>
        opts.share !== 'refuses' && Array.isArray(data.files) && data.files.length > 0;
      nav.share = async (data: { files?: File[] }) => {
        if (opts.share === 'cancelled') {
          const err = new Error('Share canceled');
          err.name = 'AbortError';
          throw err;
        }
        if (opts.share === 'fails') throw new Error('NotAllowedError: no user gesture');
        for (const f of data.files ?? []) {
          seen.shared.push({ name: f.name, type: f.type, text: await f.text() });
        }
      };
    }
    Object.defineProperty(globalThis, 'navigator', {
      value: nav,
      configurable: true,
      writable: true,
    });
  }
  try {
    return await fn(seen);
  } finally {
    delete g.window;
    delete g.showSaveFilePicker;
    delete g.document;
    if (opts.share || opts.touch !== undefined) {
      if (originalNav) Object.defineProperty(globalThis, 'navigator', originalNav);
      else delete g.navigator;
    }
  }
}

describe('downloadBackup', () => {
  it('refuses cleanly outside a browser and does not stamp lastBackupAt', async () => {
    await seedAll();
    await expect(downloadBackup()).rejects.toThrow(/browser/);
    expect((await getSettings()).lastBackupAt).toBe(null);
  });

  it('an <a download> is only "delivered": no lastBackupAt, nudge stays due', async () => {
    await seedAll();
    const result = await withBrowser({}, async (seen) => {
      const r = await downloadBackup();
      expect(seen.clicks).toBe(1); // the file was handed to the browser
      return r;
    });
    // The browser reports nothing back, so nothing may be recorded: a
    // cancelled "where to save?" dialog must not look like a backup.
    expect(result).toBe('delivered');
    expect((await getSettings()).lastBackupAt).toBe(null);
    expect((await backupNudgeState()).due).toBe(true);
  });

  it('a file-picker save is observed: reports "saved" with the real snapshot', async () => {
    await seedAll();
    const { result, written } = await withBrowser({ picker: 'saved' }, async (seen) => {
      const r = await downloadBackup();
      expect(seen.clicks).toBe(0); // no anchor fallback when the picker worked
      return { result: r, written: seen.written };
    });
    expect(result).toBe('saved');
    // The bytes handed over are a complete, restorable backup.
    const parsed: unknown = JSON.parse(written[0]);
    const check = validateBackup(parsed);
    expect(check.ok).toBe(true);
    expect((parsed as BackupFile).tables.transactions).toHaveLength(seedTransactions.length);
    // Even an observed save is recorded by the caller, never here.
    expect((await getSettings()).lastBackupAt).toBe(null);
  });

  it('a cancelled file picker reports "cancelled" and writes nothing', async () => {
    await seedAll();
    const result = await withBrowser({ picker: 'cancelled' }, async (seen) => {
      const r = await downloadBackup();
      expect(seen.clicks).toBe(0); // cancelling means cancelled — no silent retry
      return r;
    });
    expect(result).toBe('cancelled');
    expect((await getSettings()).lastBackupAt).toBe(null);
    expect((await backupNudgeState()).due).toBe(true);
  });

  it('falls back to the anchor when the file picker is blocked', async () => {
    await seedAll();
    const result = await withBrowser({ picker: 'blocked' }, async (seen) => {
      const r = await downloadBackup();
      expect(seen.clicks).toBe(1);
      return r;
    });
    expect(result).toBe('delivered');
  });

  it('a failed write surfaces as an error rather than a silent success', async () => {
    await seedAll();
    await withBrowser({ picker: 'write-fails' }, async () => {
      await expect(downloadBackup()).rejects.toThrow(/Disk full/);
    });
    expect((await getSettings()).lastBackupAt).toBe(null);
  });

  // E4: on a phone the <a download> is a dead end — no dialog, no destination,
  // no signal. The share sheet is the only path that reports anything real.
  it('on a touch device the backup goes to the share sheet, not a blind download', async () => {
    await seedAll();
    const { result, shared, clicks } = await withBrowser(
      { share: 'ok', touch: true },
      async (seen) => ({ result: await downloadBackup(), shared: seen.shared, clicks: seen.clicks }),
    );
    expect(result).toBe('shared');
    expect(clicks).toBe(0); // no invisible download behind the share sheet
    expect(shared).toHaveLength(1);
    expect(shared[0].name).toMatch(/^mymoney-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(shared[0].type).toBe('application/json');
    // The shared bytes are a complete, restorable backup — not a stub.
    const parsed: unknown = JSON.parse(shared[0].text);
    expect(validateBackup(parsed).ok).toBe(true);
    expect((parsed as BackupFile).tables.transactions).toHaveLength(seedTransactions.length);
    // Sharing is still not proof the file was KEPT: the caller must confirm.
    expect((await getSettings()).lastBackupAt).toBe(null);
    expect((await backupNudgeState()).due).toBe(true);
  });

  it('a cancelled share is "cancelled" — a real signal, and nothing is recorded', async () => {
    await seedAll();
    const { result, clicks } = await withBrowser({ share: 'cancelled', touch: true }, async (seen) => ({
      result: await downloadBackup(),
      clicks: seen.clicks,
    }));
    expect(result).toBe('cancelled');
    expect(clicks).toBe(0); // a cancel must not turn into a silent download
    expect((await getSettings()).lastBackupAt).toBe(null);
  });

  it('a share that errors falls back to the anchor rather than failing the export', async () => {
    await seedAll();
    const { result, clicks } = await withBrowser({ share: 'fails', touch: true }, async (seen) => ({
      result: await downloadBackup(),
      clicks: seen.clicks,
    }));
    expect(result).toBe('delivered');
    expect(clicks).toBe(1);
  });

  it('a browser that refuses to share files falls back to the anchor', async () => {
    await seedAll();
    const result = await withBrowser({ share: 'refuses', touch: true }, () => downloadBackup());
    expect(result).toBe('delivered');
  });

  it('desktop keeps the familiar download: no share sheet without touch', async () => {
    await seedAll();
    const { result, shared, clicks } = await withBrowser(
      { share: 'ok', touch: false },
      async (seen) => ({ result: await downloadBackup(), shared: seen.shared, clicks: seen.clicks }),
    );
    expect(result).toBe('delivered');
    expect(shared).toHaveLength(0);
    expect(clicks).toBe(1);
  });

  it('an observed file-picker save still wins over the share sheet', async () => {
    await seedAll();
    const { result, shared } = await withBrowser(
      { picker: 'saved', share: 'ok', touch: true },
      async (seen) => ({ result: await downloadBackup(), shared: seen.shared }),
    );
    expect(result).toBe('saved');
    expect(shared).toHaveLength(0);
  });
});

describe('markBackupSaved', () => {
  it('is what records a backup, and clears the nudge', async () => {
    await seedAll();
    expect((await backupNudgeState()).due).toBe(true);
    await markBackupSaved();
    const settings = await getSettings();
    expect(settings.lastBackupAt).not.toBe(null);
    expect(Date.now() - Date.parse(settings.lastBackupAt!)).toBeLessThan(60_000);
    expect((await backupNudgeState()).due).toBe(false);
  });

  it('accepts an explicit timestamp', async () => {
    await seedAll();
    await markBackupSaved('2026-08-20T09:00:00.000Z');
    expect((await getSettings()).lastBackupAt).toBe('2026-08-20T09:00:00.000Z');
  });
});

// ---------------------------------------------------------------- nudge

describe('backupNudgeState', () => {
  const daysAgo = (n: number): string => new Date(Date.now() - n * DAY_MS).toISOString();

  it('not due with zero transactions, even with no backup ever', async () => {
    const s = await backupNudgeState();
    expect(s).toEqual({ due: false, lastBackupAt: null, txCount: 0, realTxCount: 0 });
  });

  it('due when transactions exist on an install older than 7 days and no backup', async () => {
    await seedAll(); // seedSettings.lastBackupAt is null
    await updateSettings({ createdAt: daysAgo(30) });
    const s = await backupNudgeState();
    expect(s.due).toBe(true);
    expect(s.txCount).toBe(seedTransactions.length);
    expect(s.realTxCount).toBe(seedTransactions.length);
    expect(s.lastBackupAt).toBe(null);
  });

  // E2: "no backup in 7+ days" (SPEC §8.1.9) is not "no backup yet". Day one
  // must not nag — the install date is the clock while lastBackupAt is null.
  it('NOT due on a fresh install that already has transactions', async () => {
    await seedAll();
    await updateSettings({ createdAt: new Date().toISOString() });
    const s = await backupNudgeState();
    expect(s.lastBackupAt).toBe(null);
    expect(s.txCount).toBeGreaterThan(0);
    expect(s.due).toBe(false);
  });

  it('not due at 6 days old, due at 8 days old, with no backup ever', async () => {
    await seedAll();
    await updateSettings({ createdAt: daysAgo(6) });
    expect((await backupNudgeState()).due).toBe(false);
    await updateSettings({ createdAt: daysAgo(8) });
    expect((await backupNudgeState()).due).toBe(true);
  });

  it('an unparseable createdAt counts as stale — never assume a grace period', async () => {
    await seedAll();
    await updateSettings({ createdAt: 'not a date' });
    expect((await backupNudgeState()).due).toBe(true);
  });

  // E2: demo money is not worth backing up, and one tap deletes it anyway.
  it('never due when every transaction belongs to the sample batch', async () => {
    await db.settings.add({ ...seedSettings, createdAt: daysAgo(90) });
    await db.importBatches.add({ ...seedBatches[0], id: 'batch-sample', source: 'sample' });
    await db.accounts.bulkAdd(seedAccounts);
    await db.transactions.bulkAdd(
      seedTransactions.map((t) => ({ ...t, id: `s-${t.id}`, importBatchId: 'batch-sample' })),
    );
    const s = await backupNudgeState();
    expect(s.txCount).toBe(seedTransactions.length);
    expect(s.realTxCount).toBe(0);
    expect(s.due).toBe(false);
  });

  it('is due again as soon as ONE real transaction sits alongside the sample', async () => {
    await db.settings.add({ ...seedSettings, createdAt: daysAgo(90) });
    await db.importBatches.add({ ...seedBatches[0], id: 'batch-sample', source: 'sample' });
    await db.accounts.bulkAdd(seedAccounts);
    await db.transactions.bulkAdd(
      seedTransactions.map((t) => ({ ...t, id: `s-${t.id}`, importBatchId: 'batch-sample' })),
    );
    await db.transactions.add(
      tx({ id: 'mine', accountId: 'acc-gbp', date: '2026-08-20', amountMinor: -350 }),
    );
    const s = await backupNudgeState();
    expect(s.realTxCount).toBe(1);
    expect(s.due).toBe(true);
  });

  it('due when the last backup is 8 days old', async () => {
    await seedAll();
    const eightDaysAgo = new Date(Date.now() - 8 * DAY_MS).toISOString();
    await updateSettings({ lastBackupAt: eightDaysAgo });
    const s = await backupNudgeState();
    expect(s.due).toBe(true);
    expect(s.lastBackupAt).toBe(eightDaysAgo);
  });

  it('not due when the last backup is 2 days old', async () => {
    await seedAll();
    const twoDaysAgo = new Date(Date.now() - 2 * DAY_MS).toISOString();
    await updateSettings({ lastBackupAt: twoDaysAgo });
    const s = await backupNudgeState();
    expect(s.due).toBe(false);
    expect(s.lastBackupAt).toBe(twoDaysAgo);
  });
});

// ---------------------------------------------------------------- misc

describe('exports', () => {
  it('CURRENT_SCHEMA_VERSION mirrors the db schema version', () => {
    expect(CURRENT_SCHEMA_VERSION).toBe(SCHEMA_VERSION);
  });
});


// ------------------------------------------------ device identity on restore
//
// A backup — and a sync snapshot, which is the same file — carries the whole
// settings row of the device that wrote it. The sync APPLY path has always
// pinned the device-local half back (mergeSettingsRow); restore did not, and
// restore is the path the sync feature's own conflict safety copy is fed
// through. Restoring one therefore handed this browser the other device's
// identity, OAuth client id and sync bookkeeping, after which both devices
// call themselves "iMac" in the dialog that asks which copy of the book to
// destroy (C8).

describe('restoreBackup keeps this device (C8)', () => {
  /** This browser, with a real identity and real sync bookkeeping. */
  const thisDevice = (): Settings => ({
    ...defaultSettings(),
    baseCurrency: 'GBP',
    onboarded: true,
    savedMappings: seedSettings.savedMappings,
    autoFxEnabled: true,
    lastFxSyncAt: '2026-08-27T06:00:00.000Z',
    lastFxSyncSource: 'exchangerate.host',
    theme: 'dark',
    lastBackupAt: '2026-08-20T08:00:00.000Z',
    createdAt: '2026-01-02T00:00:00.000Z',
    lastUsedAccountId: 'acc-gbp',
    syncEnabled: true,
    syncDeviceId: 'phone-uuid',
    syncDeviceName: 'iPhone',
    syncClientId: 'phone-client-id',
    syncLastSyncedAt: '2026-08-27T07:00:00.000Z',
    syncLastPulledRevision: 12,
    syncLastPulledSnapshotId: 'snap-phone',
    syncAncestry: ['snap-phone-0'],
    syncLocalRevision: 5,
    syncSyncedLocalRevision: 5,
  });

  /** The row inside a file the OTHER device wrote — every field different. */
  const otherDevice = (): Settings => ({
    ...defaultSettings(),
    baseCurrency: 'EUR',
    onboarded: true,
    savedMappings: {},
    autoFxEnabled: false,
    lastFxSyncAt: '2026-08-26T09:00:00.000Z',
    lastFxSyncSource: 'ecb',
    theme: 'light',
    lastBackupAt: '2026-08-26T08:00:00.000Z',
    createdAt: '2025-05-05T00:00:00.000Z',
    lastUsedAccountId: 'acc-usd',
    syncEnabled: true,
    syncDeviceId: 'imac-uuid',
    syncDeviceName: 'iMac',
    syncClientId: 'imac-client-id',
    syncLastSyncedAt: '2026-08-26T08:30:00.000Z',
    syncLastPulledRevision: 11,
    syncLastPulledSnapshotId: 'snap-imac',
    syncAncestry: ['snap-imac-0'],
    syncLocalRevision: 2,
    syncSyncedLocalRevision: 1,
  });

  const fileWith = (settingsRows: unknown[]): BackupFile =>
    ({
      app: 'MyMoney',
      schemaVersion: SCHEMA_VERSION,
      exportedAt: T0,
      tables: { ...Object.fromEntries(ALL_TABLES.map((n) => [n, []])), settings: settingsRows },
    }) as BackupFile;

  it('takes the book from the file and the device from this browser', async () => {
    await db.settings.add(thisDevice());
    const incoming = otherDevice();

    await restoreBackup(fileWith([incoming]));
    // A restore IS a local change, so the tracker's debounced bump is in
    // flight. Settle it before reading, or what this test observes depends on
    // whether a timer happened to fire — which is exactly how it passed here
    // and failed on CI (expected 5, got 6). Never assert on a counter that is
    // still moving.
    await flushLocalRevision();

    const after = await getSettings();
    for (const key of BOOK_LEVEL_SETTING_KEYS) {
      expect({ [key]: after[key] }).toEqual({ [key]: incoming[key] });
    }
    for (const key of DEVICE_LOCAL_SETTING_KEYS) {
      // syncLocalRevision is device-local but it is a COUNTER, not an
      // identity: replacing the book is a change this device now owes the
      // remote, so it is SUPPOSED to advance. What matters is that it did not
      // come from the file. Checked explicitly below.
      if (key === 'syncLocalRevision') continue;
      expect({ [key]: after[key] }).toEqual({ [key]: thisDevice()[key] });
    }
    // Not the other device's 2, and strictly ahead of where this device was —
    // a restored book is unsynced work, and a device that looked clean here
    // would let the next pull quietly overwrite what was just restored.
    expect(after.syncLocalRevision).toBeGreaterThan(thisDevice().syncLocalRevision);
    expect(after.syncLocalRevision).not.toBe(incoming.syncLocalRevision);
    expect(after.syncSyncedLocalRevision).toBe(thisDevice().syncSyncedLocalRevision);
    // Spelled out, because these are the ones that corrupt the conflict dialog
    // and the sync decision table rather than merely annoying the user.
    expect(after.syncDeviceName).toBe('iPhone');
    expect(after.syncDeviceId).toBe('phone-uuid');
    expect(after.syncClientId).toBe('phone-client-id');
    expect(after.syncLastPulledRevision).toBe(12);
    expect(after.syncLastPulledSnapshotId).toBe('snap-phone');
    // …and the 7-day backup nudge is not silenced by a backup this device
    // never made (backup.ts: markBackupSaved is the only writer of it).
    expect(after.lastBackupAt).toBe('2026-08-20T08:00:00.000Z');
  });

  it('a file with no settings row leaves this device with its own', async () => {
    await db.settings.add(thisDevice());
    await restoreBackup(fileWith([]));
    expect(await db.settings.toArray()).toEqual([thisDevice()]);
  });

  it('two settings rows are still corruption, not something to merge away', async () => {
    await db.settings.add(thisDevice());
    const twice = fileWith([otherDevice(), otherDevice()]);
    // Both have id 'app', so only bulkAdd can catch it — and it must still be
    // reached: pinning must not quietly collapse a corrupt file into one row.
    await expect(restoreBackup(twice)).rejects.toThrow();
    expect(await db.settings.toArray()).toEqual([thisDevice()]);
  });

  it('pinDeviceLocalSettings is defined for a missing/rubbish incoming row', () => {
    const local = thisDevice();
    for (const junk of [undefined, null, 42, 'nope', []]) {
      expect(pinDeviceLocalSettings(local, junk)).toEqual(local);
    }
  });
});

// ---------------------------------------------------------- recovery store
//
// The one save in this file whose success can be OBSERVED (C4). Everything
// else here hands bytes to a browser API that reports nothing; this writes
// them to IndexedDB and then reads them back, which is why the sync engine is
// allowed to destroy a book once this — and only this — has succeeded.

describe('recovery store', () => {
  const keep = async (over: Partial<Parameters<typeof saveRecoverySnapshot>[1]> = {}) => {
    const file = await exportBackup();
    return saveRecoverySnapshot(file, {
      reason: 'conflict-keep-remote',
      label: "This device's copy",
      fileName: 'mymoney-conflict-local-rev1-2026-08-27.json',
      ...over,
    });
  };

  it('keeps a copy that can be listed, read back and restored', async () => {
    await seedAll();
    const record = await keep({ delivery: 'delivered' });

    expect(record.counts.transactions).toBe(seedTransactions.length);
    expect(record.bytes).toBeGreaterThan(0);
    expect(record.delivery).toBe('delivered');

    const listed = await listRecoveryRecords();
    expect(listed).toEqual([record]);

    // A NORMAL backup file: the same thing the Restore screen takes.
    const file = await readRecoveryBackup(record.id);
    expect(validateBackup(file).ok).toBe(true);

    await clearAll();
    expect(await db.transactions.count()).toBe(0);
    await restoreRecoveryBackup(record.id);
    expect(sortById(await db.transactions.toArray())).toEqual(sortById(seedTransactions));
    expect(sortById(await db.accounts.toArray())).toEqual(sortById(seedAccounts));
  });

  // THE POINT OF THE MODULE. A save that reports success while storing nothing
  // is exactly what the <a download> did, and it is what destroyed books.
  it('a write that stores nothing is a failure, not a success', async () => {
    await seedAll();
    // The write is accepted and keeps nothing — a driver that lies, a quota
    // failure that surfaced as a no-op. Only reading it back can tell.
    vi.spyOn(recoveryDb.bodies, 'put').mockResolvedValue('' as never);

    await expect(keep()).rejects.toThrow(/read back/i);
  });

  it('a write that fails is reported, and nothing is left listed', async () => {
    await seedAll();
    vi.spyOn(recoveryDb.bodies, 'put').mockRejectedValue(new Error('QuotaExceededError'));

    await expect(keep()).rejects.toThrow(/Quota/);
    expect(await listRecoveryRecords()).toEqual([]);
  });

  it('a full store makes room and tries again rather than refusing forever', async () => {
    await seedAll();
    for (let i = 0; i < RECOVERY_KEEP; i++) await keep({ label: `old ${i}` });
    const oldest = (await listRecoveryRecords()).at(-1)!;

    // The first attempt fails on space; the retry, after the oldest copy has
    // been given up, succeeds.
    const put = vi.spyOn(recoveryDb.bodies, 'put');
    put.mockRejectedValueOnce(new Error('QuotaExceededError'));
    const record = await keep({ label: 'the new one' });

    const listed = await listRecoveryRecords();
    expect(listed[0]!.id).toBe(record.id);
    expect(listed.map((r) => r.id)).not.toContain(oldest.id);
    expect(listed).toHaveLength(RECOVERY_KEEP);
  });

  it(`keeps the newest ${RECOVERY_KEEP} and never drops the one just written`, async () => {
    await seedAll();
    const written: string[] = [];
    for (let i = 0; i < RECOVERY_KEEP + 2; i++) {
      const r = await keep({ label: `copy ${i}` });
      written.push(r.id);
      // The copy just written is present after every single save — never
      // pruned by its own save (which is the one deletion that would matter).
      expect((await listRecoveryRecords()).map((x) => x.id)).toContain(r.id);
    }
    const listed = await listRecoveryRecords();
    expect(listed).toHaveLength(RECOVERY_KEEP);
    expect(listed.map((r) => r.id)).toEqual(written.slice(-RECOVERY_KEEP).reverse());
    // Bodies go with them: no orphaned megabytes left behind.
    expect(await recoveryDb.bodies.count()).toBe(RECOVERY_KEEP);
  });

  it('ordering survives copies written inside the same millisecond', async () => {
    await seedAll();
    const a = await keep({ label: 'first' });
    const b = await keep({ label: 'second' });
    expect(a.savedAt <= b.savedAt).toBe(true);
    expect(b.seq).toBeGreaterThan(a.seq);
    expect((await listRecoveryRecords()).map((r) => r.label)).toEqual(['second', 'first']);
  });

  it('refuses to keep something that is not a valid backup', async () => {
    const notABackup = { app: 'Nope', schemaVersion: 1, exportedAt: T0, tables: {} };
    await expect(
      saveRecoverySnapshot(notABackup as unknown as BackupFile, {
        reason: 'conflict-keep-local',
        label: 'rubbish',
        fileName: 'x.json',
      }),
    ).rejects.toThrow(/unusable recovery copy/);
    expect(await listRecoveryRecords()).toEqual([]);
  });

  it('a kept copy can be handed to the user as a file, by the normal ladder', async () => {
    await seedAll();
    const record = await keep();
    const { result, written } = await withBrowser({ picker: 'saved' }, async (seen) => ({
      result: await downloadRecoveryBackup(record.id),
      written: seen.written,
    }));
    expect(result).toBe('saved');
    expect(written).toHaveLength(1);
    const parsed = JSON.parse(written[0]!) as BackupFile;
    expect(sortById(parsed.tables.transactions as { id: string }[])).toEqual(
      sortById(seedTransactions),
    );
  });

  it('downloadBackupFile writes the file it is handed, not the current book', async () => {
    await seedAll();
    const handed = await exportBackup();
    await clearAll(); // the book is gone; the file is not
    const { result, written } = await withBrowser({ picker: 'saved' }, async (seen) => ({
      result: await downloadBackupFile(handed, 'handed.json'),
      written: seen.written,
    }));
    expect(result).toBe('saved');
    expect((JSON.parse(written[0]!) as BackupFile).tables.transactions).toHaveLength(
      seedTransactions.length,
    );
  });

  it('copies can be deleted, one or all', async () => {
    await seedAll();
    const a = await keep({ label: 'a' });
    const b = await keep({ label: 'b' });
    await deleteRecoveryRecord(a.id);
    expect((await listRecoveryRecords()).map((r) => r.id)).toEqual([b.id]);
    expect(await recoveryDb.bodies.get(a.id)).toBeUndefined();
    await clearRecoveryStore();
    expect(await listRecoveryRecords()).toEqual([]);
    expect(await recoveryDb.bodies.count()).toBe(0);
  });

  it('reading a copy that is gone says so instead of returning nothing', async () => {
    await expect(readRecoveryBackup('never-existed')).rejects.toThrow(/no longer on this device/);
    await expect(downloadRecoveryBackup('never-existed')).rejects.toThrow(/no longer/);
  });

  it('a corrupted body is refused rather than half-restored', async () => {
    await seedAll();
    const record = await keep();
    await recoveryDb.bodies.put({ id: record.id, json: '{not json' });
    await expect(readRecoveryBackup(record.id)).rejects.toThrow(/unreadable/);
    // The book is untouched: nothing was cleared on the way to finding out.
    expect(await db.transactions.count()).toBe(seedTransactions.length);
  });
});

// ===========================================================================
// Canonical serialisation (src/backup/canonical.ts)
// ===========================================================================
//
// The format is the promise here: sorted keys, JSON.stringify's escaping and
// indentation, a real SHA-256. All three have to be reproducible by a second
// implementation in another language, so all three are pinned against
// something outside this codebase — FIPS test vectors, Node's own crypto, and
// JSON.stringify itself.

const nodeSha = (s: string): string => createHash('sha256').update(s, 'utf8').digest('hex');

describe('sha256Hex', () => {
  it('matches the published FIPS 180-4 vectors', () => {
    expect(sha256Hex('')).toBe(
      'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855',
    );
    expect(sha256Hex('abc')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(sha256Hex('abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq')).toBe(
      '248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1',
    );
  });

  it('agrees with node:crypto across the block boundaries and beyond ASCII', () => {
    // 55/56 and 119/120 are where the 64-byte padding block splits in two —
    // the one place a hand-written SHA-256 goes wrong and still looks fine on
    // "abc". 100_000 chars is well past anything a single block hides.
    const cases = [
      '',
      'a',
      'x'.repeat(55),
      'x'.repeat(56),
      'x'.repeat(63),
      'x'.repeat(64),
      'x'.repeat(65),
      'x'.repeat(119),
      'x'.repeat(120),
      'x'.repeat(128),
      '£429,327.86 — Tesco • café',
      '𝄞 clef and an emoji 🧾',
      JSON.stringify({ a: 1, b: [1, 2, 3] }),
      'y'.repeat(20_000),
    ];
    for (const s of cases) {
      expect(sha256Hex(s), `length ${s.length}`).toBe(nodeSha(s));
    }
  });
});

describe('canonicalJson', () => {
  it('sorts object keys at every depth, and leaves array order alone', () => {
    const value = { b: 1, a: { z: [3, 1, 2], y: 'x' }, A: true };
    expect(canonicalJson(value)).toBe('{"A":true,"a":{"y":"x","z":[3,1,2]},"b":1}');
  });

  it('is byte-identical to JSON.stringify once the keys are already in order', () => {
    // Everything except the ordering must stay JSON.stringify's behaviour:
    // escaping, number formatting, empty containers, indentation.
    const sorted = {
      a: 'quote " backslash \\ newline \n tab \t unicode   £',
      b: [1, -0, 1e21, 0.1 + 0.2, null, true],
      c: {},
      d: [],
      e: '',
    };
    expect(canonicalJson(sorted)).toBe(JSON.stringify(sorted));
    expect(canonicalJson(sorted, 2)).toBe(JSON.stringify(sorted, null, 2));
  });

  it('drops undefined from objects and writes it as null in arrays, like JSON.stringify', () => {
    const value = { keep: 1, gone: undefined, list: [1, undefined, 3] };
    expect(canonicalJson(value)).toBe('{"keep":1,"list":[1,null,3]}');
    expect(JSON.parse(canonicalJson(value))).toEqual(JSON.parse(JSON.stringify(value)));
  });

  it('sorts all-digit keys as strings, which a JS object cannot', () => {
    // The reason this module has its own emitter. A JS object puts
    // integer-like keys first in NUMERIC order whatever order they went in, so
    // "rebuild the object with sorted keys, then JSON.stringify it" produces
    // 2,10,b — an order no other language would reproduce by sorting keys.
    // savedMappings is keyed by CSV file signature, so all-digit keys are real.
    const value = { '10': 'ten', '2': 'two', b: 'bee' };
    expect(canonicalJson(value)).toBe('{"10":"ten","2":"two","b":"bee"}');
    expect(JSON.stringify({ ...value })).toBe('{"2":"two","10":"ten","b":"bee"}');
  });

  it('round-trips a whole backup unchanged apart from key order', async () => {
    await seedAll();
    const file = await exportBackup();
    expect(JSON.parse(canonicalJson(file))).toEqual(JSON.parse(JSON.stringify(file)));
  });
});

// ===========================================================================
// TASK 2 — an unchanged book is the same bytes, and can be fingerprinted
// ===========================================================================

/** Parse a serialised backup back into a file (deep copy for tamper tests). */
const reparse = (file: BackupFile): BackupFile => JSON.parse(serializeBackup(file)) as BackupFile;

/**
 * Wipe the BOOK but leave this device's settings row in place — the state a
 * real "restore over the top" starts from, and the only state in which two
 * exports can be compared byte for byte (see the round-trip test below).
 */
const clearBook = async () => {
  await Promise.all(DATA_TABLES.map((name) => db.table(name).clear()));
};

describe('canonical exports', () => {
  it('two exports of an unchanged database differ only in the timestamp', async () => {
    await seedAll();
    const first = await exportBackup();
    // Far enough apart that the clock really moves — otherwise the two files
    // are trivially identical and the test proves nothing.
    await new Promise((r) => setTimeout(r, 2));
    const second = await exportBackup();

    expect(second.exportedAt).not.toBe(first.exportedAt); // different moments…
    const a = serializeBackup(first);
    const b = serializeBackup(second);
    expect(a).not.toBe(b);
    // …and that is the ONLY difference: putting the first timestamp back into
    // the second file makes the two files the same bytes, everywhere.
    expect(b.split(second.exportedAt).join(first.exportedAt)).toBe(a);
    expect(canonicalBackupHash(second)).toBe(canonicalBackupHash(first));
  });

  it('the fingerprint ignores the timestamp and nothing else', async () => {
    await seedAll();
    const file = await exportBackup();
    const content = backupContentForHash(file) as Record<string, unknown>;
    expect('exportedAt' in content).toBe(false);
    expect('exportedAt' in (content.manifest as Record<string, unknown>)).toBe(false);
    // Everything else is still there to be hashed — including the manifest,
    // so a file whose claims were edited fingerprints differently.
    expect(Object.keys(content).sort()).toEqual(['app', 'manifest', 'schemaVersion', 'tables']);
  });

  it('changes when one penny changes', async () => {
    await seedAll();
    const before = canonicalBackupHash(await exportBackup());
    await db.transactions.update('tx-groc', { amountMinor: -4568 });
    expect(canonicalBackupHash(await exportBackup())).not.toBe(before);
  });

  it('is the same whether the file was written pretty or compact', async () => {
    await seedAll();
    const file = await exportBackup();
    const pretty = JSON.parse(canonicalJson(file, 2)) as BackupFile;
    const compact = JSON.parse(canonicalJson(file, 0)) as BackupFile;
    expect(canonicalBackupHash(pretty)).toBe(canonicalBackupHash(compact));
  });

  it('survives a full round trip: export → restore → export is the same content', async () => {
    await seedAll();
    const first = await exportBackup();
    const hash = canonicalBackupHash(first);

    // The BOOK is wiped, the device is not. A restore deliberately keeps this
    // browser's own half of the settings row (C8) — its theme, its install
    // date, its sync bookkeeping — so a device that wiped its settings row too
    // would come back with a different `createdAt` and a different fingerprint,
    // and would be right to. Byte-for-byte reproduction is a claim about the
    // book, made by the same device.
    await clearBook();
    await restoreBackup(reparse(first));
    const second = await exportBackup();

    expect(canonicalBackupHash(second)).toBe(hash);
    expect(serializeBackup(second).split(second.exportedAt).join(first.exportedAt)).toBe(
      serializeBackup(first),
    );
  });

  it('puts the rows in order itself rather than trusting the source', async () => {
    // Row order is DATA in JSON, so it cannot be left to whatever the storage
    // engine happens to hand back. IndexedDB does return rows in primary-key
    // order today — which means only forcing a different order proves the
    // exporter is deciding rather than getting lucky.
    await seedAll();
    const original = await exportBackup();
    const tableProto = Object.getPrototypeOf(db.table('accounts')) as {
      toArray: () => Promise<unknown[]>;
    };
    const realToArray = tableProto.toArray;
    const spy = vi
      .spyOn(tableProto, 'toArray')
      .mockImplementation(async function (this: unknown) {
        return (await realToArray.call(this)).reverse();
      });
    const backwards = await exportBackup();
    spy.mockRestore();

    expect(backwards.tables.transactions).toEqual(original.tables.transactions);
    expect(canonicalBackupHash(backwards)).toBe(canonicalBackupHash(original));
  });

  it('does not depend on the order the rows arrived in', async () => {
    // …and the same holds coming back the other way: a hand-shuffled file
    // restores to the same book, which exports to the same bytes.
    await seedAll();
    const original = await exportBackup();
    const shuffled = reparse(original);
    shuffled.tables.transactions = [...shuffled.tables.transactions].reverse();
    shuffled.tables.accounts = [...shuffled.tables.accounts].reverse();

    await clearBook();
    await restoreBackup(shuffled);
    expect(canonicalBackupHash(await exportBackup())).toBe(canonicalBackupHash(original));
  });
});

// ===========================================================================
// TASK 1 — the manifest, computed from the rows being written
// ===========================================================================

/** Hand-calculated from the seed data at the top of this file.
 *
 *  acc-gbp (GBP): opening 150,000
 *      -4,567 (Tesco) -7,845 (split) +250,000 (salary) -10,000 (transfer out)
 *      -1,250 (imported)          = +226,338  ⇒ closing 376,338  (£3,763.38)
 *  acc-usd (USD): opening 0, +12,700 (transfer in) ⇒ closing 12,700 ($127.00)
 *
 *  Rate row is GBP:USD 1.27, so USD→GBP is its inverse, 1/1.27:
 *      12,700 × (1/1.27) = 10,000 exactly  (£100.00)
 *  Net worth = 376,338 + 10,000 = 386,338  (£3,863.38)
 */
const SEED_GBP_CLOSING = 376_338;
const SEED_USD_CLOSING = 12_700;
const SEED_NET_WORTH = 386_338;

describe('the manifest states what the file contains', () => {
  it('counts every table and states every account balance in minor units', async () => {
    await seedAll();
    const { manifest } = await exportBackup();
    expect(manifest).toBeDefined();
    const m = manifest!;

    expect(m.manifestVersion).toBe(MANIFEST_VERSION);
    expect(m.schemaVersion).toBe(SCHEMA_VERSION);
    expect(m.rowCounts).toEqual({
      accounts: 2,
      accountGroups: 1,
      transactions: 6,
      categories: 4,
      payees: 1,
      tags: 2,
      budgets: 1,
      fxRates: 1,
      importBatches: 1,
      settings: 1,
    });
    expect(m.accounts).toEqual([
      {
        id: 'acc-gbp',
        name: 'Current',
        currency: 'GBP',
        closingBalanceMinor: SEED_GBP_CLOSING,
        txCount: 5,
        counted: true,
      },
      {
        id: 'acc-usd',
        name: 'US Savings',
        currency: 'USD',
        closingBalanceMinor: SEED_USD_CLOSING,
        txCount: 1,
        counted: true,
      },
    ]);
  });

  it('states net worth with the base currency named and the rate it used', async () => {
    await seedAll();
    const m = (await exportBackup()).manifest!;
    expect(m.netWorth.baseCurrency).toBe('GBP');
    expect(m.netWorth.totalMinor).toBe(SEED_NET_WORTH);
    expect(m.netWorth.missingRateCurrencies).toEqual([]);
    // The rate AS APPLIED — the inverse of the stored GBP:USD row — so the
    // figure can be recomputed by hand rather than taken on trust.
    expect(m.netWorth.rates).toEqual([{ from: 'USD', to: 'GBP', rate: 1 / 1.27 }]);
    // …and it is genuinely recomputable: balance × rate, rounded once.
    const rate = m.netWorth.rates[0]!.rate;
    expect(SEED_GBP_CLOSING + Math.round(SEED_USD_CLOSING * rate)).toBe(m.netWorth.totalMinor);
  });

  it('states the same number the app itself shows', async () => {
    // The oracle is worthless if it is a second opinion. Same accounts, same
    // exclusions, same conversion, same rounding — netWorth() and the manifest
    // must agree by construction, not by coincidence.
    await seedAll();
    const m = (await exportBackup()).manifest!;
    expect(m.netWorth.totalMinor).toBe((await netWorth()).totalBaseMinor);
  });

  it('is computed from the rows being written, not from a second query', async () => {
    await seedAll();
    // A count() taken beside the row arrays describes a DIFFERENT MOMENT: a
    // write landing between the two makes the manifest describe a book that
    // never existed. So the export must read each table exactly once and ask
    // the database nothing else.
    //
    // Spied on Dexie's Table PROTOTYPE, not on db.accounts: `db.table(name)`
    // hands back a different Table object than the `db.accounts` accessor
    // does, and a spy on one of them watches a door the code does not use.
    const tableProto = Object.getPrototypeOf(db.table('accounts')) as {
      count: () => Promise<number>;
      toArray: () => Promise<unknown[]>;
    };
    const count = vi.spyOn(tableProto, 'count');
    const toArray = vi.spyOn(tableProto, 'toArray');
    const file = await exportBackup();
    expect(count).not.toHaveBeenCalled();
    expect(toArray).toHaveBeenCalledTimes(ALL_TABLES.length); // one read per table
    count.mockRestore();
    toArray.mockRestore();
    // And what it says is exactly the rows in the file.
    for (const name of ALL_TABLES) {
      expect({ [name]: file.manifest!.rowCounts[name] }).toEqual({
        [name]: file.tables[name]!.length,
      });
    }
  });

  it('keeps an archived or excluded account out of the total but still states its balance', async () => {
    await seedAll();
    await db.accounts.update('acc-usd', { excludeFromNetWorth: true });
    const m = (await exportBackup()).manifest!;
    const usd = m.accounts.find((a) => a.id === 'acc-usd')!;
    expect(usd.counted).toBe(false);
    expect(usd.closingBalanceMinor).toBe(SEED_USD_CLOSING); // the balance is a fact
    expect(m.netWorth.totalMinor).toBe(SEED_GBP_CLOSING); // …the total is a choice
    expect(m.netWorth.rates).toEqual([]); // no USD in the total, no rate needed
    expect(m.netWorth.totalMinor).toBe((await netWorth()).totalBaseMinor);
  });

  it('says which currency it could not convert rather than guessing it', async () => {
    await seedAll();
    await db.fxRates.clear(); // the USD account can no longer be converted
    const m = (await exportBackup()).manifest!;
    expect(m.netWorth.missingRateCurrencies).toEqual(['USD']);
    expect(m.netWorth.totalMinor).toBe(SEED_GBP_CLOSING);
    expect(m.netWorth.rates).toEqual([]);
    expect(summariseManifest(m)).toContain('USD not counted — no exchange rate');
  });

  it('describes an empty book without inventing one', async () => {
    const m = (await exportBackup()).manifest!;
    expect(m.accounts).toEqual([]);
    expect(m.netWorth).toEqual({
      baseCurrency: 'GBP',
      totalMinor: 0,
      rates: [],
      missingRateCurrencies: [],
    });
  });
});

describe('summariseManifest', () => {
  const base = (over: Partial<BackupManifest> = {}): BackupManifest => ({
    manifestVersion: MANIFEST_VERSION,
    schemaVersion: SCHEMA_VERSION,
    exportedAt: T0,
    rowCounts: { accounts: 58, transactions: 5127 },
    accounts: [],
    netWorth: { baseCurrency: 'GBP', totalMinor: 42_932_786, rates: [], missingRateCurrencies: [] },
    ...over,
  });

  it('says it in the owner’s own terms', () => {
    // The sentence Girish should recognise without opening anything.
    expect(summariseManifest(base())).toBe(
      '58 accounts, 5,127 transactions, net worth £429,327.86',
    );
  });

  it('uses the singular for one of a thing', () => {
    expect(summariseManifest(base({ rowCounts: { accounts: 1, transactions: 1 } }))).toBe(
      '1 account, 1 transaction, net worth £429,327.86',
    );
  });

  it('never hides a currency it could not include', () => {
    const text = summariseManifest(
      base({
        netWorth: {
          baseCurrency: 'GBP',
          totalMinor: 100,
          rates: [],
          missingRateCurrencies: ['JPY', 'USD'],
        },
      }),
    );
    expect(text).toBe('58 accounts, 5,127 transactions, net worth £1.00 (JPY, USD not counted — no exchange rate)');
  });
});

// ===========================================================================
// TASK 1 — a restore holds the file to what it says
// ===========================================================================

/** Everything currently in the database, for "nothing changed" assertions. */
const snapshotAll = async (): Promise<string> => {
  const out: Record<string, unknown[]> = {};
  for (const name of ALL_TABLES) out[name] = sortById((await db.table(name).toArray()) as { id: string }[]);
  return canonicalJson(out);
};

/**
 * The message a refused restore gave. A helper rather than `.catch(e => …)` at
 * every call site so that a restore which SUCCEEDS when it was supposed to be
 * refused fails the test loudly, instead of quietly returning a report object
 * nobody looks at.
 */
const restoreFailure = async (file: BackupFile): Promise<string> => {
  try {
    await restoreBackup(file);
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error('expected this restore to be refused, but it went through');
};

describe('restore refuses a file that does not describe its own contents', () => {
  it('catches an edited amount, names the account, and changes nothing', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    // The seeded book is still in the database — that is what there is to lose.
    const before = await snapshotAll();

    // One penny off one transaction — the smallest possible lie.
    const rows = file.tables.transactions as { id: string; amountMinor: number }[];
    rows.find((r) => r.id === 'tx-groc')!.amountMinor = -4568;

    await expect(restoreBackup(file)).rejects.toThrow(/Current/);
    await expect(restoreBackup(file)).rejects.toThrow(/£3,763.37.*£3,763.38/s);
    expect(await snapshotAll()).toBe(before);
  });

  it('catches a missing row by both its table and its account', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    file.tables.transactions = (file.tables.transactions as { id: string }[]).filter(
      (r) => r.id !== 'tx-salary',
    );
    const before = await snapshotAll();

    const failure = await restoreFailure(file);
    expect(failure).toContain('table “transactions”: 5 rows, but the backup says 6');
    expect(failure).toContain('account “Current”: 4 transactions, but the backup says 5');
    expect(failure).toContain('Nothing was changed.');
    expect(await snapshotAll()).toBe(before);
  });

  it('catches an edited opening balance through the net-worth total', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    (file.tables.accounts as { id: string; openingBalanceMinor: number }[]).find(
      (a) => a.id === 'acc-gbp',
    )!.openingBalanceMinor = 999_999;

    const failure = await restoreFailure(file);
    expect(failure).toContain('account “Current”: closing balance is');
    expect(failure).toContain('net worth is');
  });

  it('catches a swapped base currency', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    (file.tables.settings as { baseCurrency: string }[])[0]!.baseCurrency = 'EUR';
    const failure = await restoreFailure(file);
    expect(failure).toContain('base currency is EUR, but the backup says GBP');
  });

  it('catches a deleted exchange rate', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    file.tables.fxRates = [];
    const failure = await restoreFailure(file);
    expect(failure).toContain('table “fxRates”');
    expect(failure).toContain('currencies with no rate: USD');
  });

  it('catches an account that was quietly excluded from the total', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    (file.tables.accounts as { id: string; excludeFromNetWorth?: boolean }[]).find(
      (a) => a.id === 'acc-usd',
    )!.excludeFromNetWorth = true;
    const failure = await restoreFailure(file);
    expect(failure).toContain('no longer counts toward net worth');
  });

  it('reports at most a handful of problems and says how many more there are', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    // Wipe the lot: every table count, both accounts and the total all differ.
    for (const name of DATA_TABLES) file.tables[name] = [];
    const failure = await restoreFailure(file);
    expect(failure).toMatch(/…and \d+ more/);
    expect(failure.split('\n').length).toBeLessThanOrEqual(11);
  });

  it('accepts the untouched file and reports what it verified', async () => {
    await seedAll();
    const file = reparse(await exportBackup());
    await clearAll();

    const report = await restoreBackup(file);
    expect(report.verified).toBe(true);
    expect(report.claimed).toEqual(file.manifest);
    // Recomputed from the rows that landed — same figures, arrived at again.
    expect(report.recomputed!.accounts).toEqual(file.manifest!.accounts);
    expect(report.recomputed!.netWorth).toEqual(file.manifest!.netWorth);
    expect(report.recomputed!.rowCounts).toEqual(file.manifest!.rowCounts);
  });

  it('recomputes from what LANDED, not from the arrays it was handed', async () => {
    // "bulkAdd resolved" and "the rows are in the database" are different
    // claims, and only the second one is a backup. So the check re-reads the
    // table; here the read comes back one row short — a write that reported
    // success and did not keep everything — and that has to be caught even
    // though the FILE is perfectly consistent with itself.
    await seedAll();
    const file = reparse(await exportBackup());
    const realOrderBy = db.transactions.orderBy.bind(db.transactions);
    vi.spyOn(db.transactions, 'orderBy').mockImplementation((index: string | string[]) => {
      const collection = realOrderBy(index as string);
      const realToArray = collection.toArray.bind(collection);
      collection.toArray = (async () => (await realToArray()).slice(1)) as never;
      return collection;
    });

    await expect(restoreBackup(file)).rejects.toThrow(/table “transactions”: 5 rows/);
  });

  it('does not go looking at all when the file makes no claim', async () => {
    // The read-back costs a pass over the transactions table, so it happens
    // only when there is something to check. Every sync pull restores a
    // manifest-less file through here (src/sync/syncEngine.ts applyRemote) and
    // must not pay for a verification it cannot perform.
    await seedAll();
    const { manifest: _none, ...file } = await exportBackup();
    const orderBy = vi.spyOn(db.transactions, 'orderBy');
    await clearBook();
    expect((await restoreBackup(file as BackupFile)).verified).toBe(false);
    expect(orderBy).not.toHaveBeenCalled();
  });
});

// ===========================================================================
// Validation of the manifest itself, before a single row is written
// ===========================================================================

describe('validateBackup and the manifest', () => {
  const withManifest = async (edit: (m: Record<string, unknown>) => void): Promise<BackupFile> => {
    const file = reparse(await exportBackup());
    edit(file.manifest as unknown as Record<string, unknown>);
    return file;
  };

  it('rejects a manifest that describes a different moment than its own file', async () => {
    await seedAll();
    const file = await withManifest((m) => {
      m.exportedAt = '2001-01-01T00:00:00.000Z';
    });
    expectError(validateBackup(file), /different time/);
    await expect(restoreBackup(file)).rejects.toThrow(/different time/);
  });

  it('rejects a manifest that claims a different schema version', async () => {
    await seedAll();
    expectError(
      validateBackup(await withManifest((m) => (m.schemaVersion = SCHEMA_VERSION + 1))),
      /manifest describes schema/,
    );
  });

  it('rejects a manifest with a broken shape rather than half-reading it', async () => {
    await seedAll();
    expectError(validateBackup(await withManifest((m) => (m.rowCounts = 'lots'))), /row counts/);
    expectError(
      validateBackup(await withManifest((m) => ((m.accounts as unknown[])[0] = { id: 'x' }))),
      /account entry 0 is incomplete/,
    );
    expectError(
      validateBackup(await withManifest((m) => (m.netWorth = { baseCurrency: 'GBP' }))),
      /net-worth figure/,
    );
    expectError(
      validateBackup(
        await withManifest((m) => {
          (m.netWorth as { rates: unknown[] }).rates = [{ from: 'USD', to: 'GBP', rate: 0 }];
        }),
      ),
      /unusable exchange rate/,
    );
    expectError(validateBackup(await withManifest((m) => (m.manifestVersion = 0))), /version/);
  });

  it('does not write anything while rejecting one', async () => {
    await seedAll();
    const before = await snapshotAll();
    const file = await withManifest((m) => (m.rowCounts = null));
    await expect(restoreBackup(file)).rejects.toThrow();
    expect(await snapshotAll()).toBe(before);
  });

  it('restores a manifest from a FUTURE build without checking it, and says so', async () => {
    // Forward compatibility beats verification here: refusing would make an
    // older build unable to restore a file a newer one wrote, and the rows are
    // still fully validated. The report admits nothing was checked.
    await seedAll();
    const file = await withManifest((m) => (m.manifestVersion = MANIFEST_VERSION + 1));
    expect(validateBackup(file).ok).toBe(true);
    await clearAll();
    const report = await restoreBackup(file);
    expect(report.verified).toBe(false);
    expect(report.recomputed).toBeNull();
    expect(await db.transactions.count()).toBe(seedTransactions.length);
  });
});

describe('validateManifestShape', () => {
  it('passes a manifest this build wrote', async () => {
    await seedAll();
    const file = await exportBackup();
    expect(
      validateManifestShape(file.manifest, {
        schemaVersion: file.schemaVersion,
        exportedAt: file.exportedAt,
      }),
    ).toBeNull();
  });

  it('says nothing about a version it does not know', () => {
    expect(
      validateManifestShape(
        { manifestVersion: 99, whatever: true },
        { schemaVersion: SCHEMA_VERSION, exportedAt: T0 },
      ),
    ).toBeNull();
  });
});

describe('compareManifests', () => {
  const manifest = (over: Partial<BackupManifest> = {}): BackupManifest =>
    computeManifest(
      manifestSourceFromTables({
        accounts: [seedAccounts[0]!],
        transactions: [seedTransactions[0]!],
      }),
      { schemaVersion: SCHEMA_VERSION, exportedAt: T0, baseCurrency: 'GBP' },
    ) && {
      ...computeManifest(
        manifestSourceFromTables({
          accounts: [seedAccounts[0]!],
          transactions: [seedTransactions[0]!],
        }),
        { schemaVersion: SCHEMA_VERSION, exportedAt: T0, baseCurrency: 'GBP' },
      ),
      ...over,
    };

  it('finds nothing to say about two identical manifests', () => {
    expect(compareManifests(manifest(), manifest())).toEqual([]);
  });

  it('ignores the file-level claims it is not there to check', () => {
    // manifestVersion/schemaVersion/exportedAt are tied to the file by
    // validateManifestShape before any write; comparing them here would
    // report the same problem twice and mask the arithmetic.
    const other = manifest({ exportedAt: 'much later', schemaVersion: 99 });
    expect(compareManifests(manifest(), other)).toEqual([]);
  });

  it('allows exactly one extra settings row when the restore minted this device’s own', () => {
    const claimed = manifest({ rowCounts: { ...manifest().rowCounts, settings: 0 } });
    const landed = manifest({ rowCounts: { ...manifest().rowCounts, settings: 1 } });
    expect(compareManifests(claimed, landed)).toEqual([
      'table “settings”: 1 rows, but the backup says 0',
    ]);
    expect(compareManifests(claimed, landed, { settingsRowMintedLocally: true })).toEqual([]);
  });

  it('names an account that appears from nowhere and one that vanishes', () => {
    const extra = manifest({
      accounts: [
        ...manifest().accounts,
        { id: 'ghost', name: 'Ghost', currency: 'GBP', closingBalanceMinor: 1, txCount: 0, counted: true },
      ],
    });
    expect(compareManifests(manifest(), extra)[0]).toContain('“Ghost” is in the restored data');
    expect(compareManifests(extra, manifest())[0]).toContain('“Ghost” is in the backup’s manifest');
  });
});

// ===========================================================================
// TASK 3 — a file the previous build wrote still restores, unchanged
// ===========================================================================
//
// The fixture was WRITTEN BY THE PREVIOUS BUILD, not hand-typed here: it was
// generated by running that build's exportBackup() (git HEAD before this
// change) against a seeded database. It has no manifest, its keys are in
// insertion order rather than sorted, and every row in it is the shape that
// build wrote. If any of the new validation ever rejects it, the change is
// wrong, not the fixture.

const LEGACY_FIXTURE = readFileSync(
  fileURLToPath(new URL('./fixtures/backup-v1-no-manifest.json', import.meta.url)),
  'utf8',
);

/*  Hand-calculated from that fixture:
 *    acc-gbp  150,000 − 4,567 + 250,000        = 395,433   (£3,954.33)
 *    acc-usd        0 + 12,700                 =  12,700   ($127.00 → £100.00)
 *    acc-old   25,000 − 5,000 = 20,000, ARCHIVED ⇒ not counted
 *    net worth 395,433 + 10,000                = 405,433   (£4,054.33)
 */
const LEGACY_NET_WORTH = 405_433;

describe('a backup written before manifests existed', () => {
  const legacy = (): BackupFile => JSON.parse(LEGACY_FIXTURE) as BackupFile;

  it('has no manifest and its keys are in the old order — this is the old format', () => {
    const parsed = legacy() as unknown as Record<string, unknown>;
    expect('manifest' in parsed).toBe(false);
    expect(Object.keys(parsed)).toEqual(['app', 'schemaVersion', 'exportedAt', 'tables']);
  });

  it('is still accepted by validation', () => {
    expectOk(validateBackup(legacy()));
  });

  it('restores every row exactly, and says it carried no self-check', async () => {
    await seedAll(); // there is data here to be replaced
    const file = legacy();
    const report = await restoreBackup(file);

    expect(report.verified).toBe(false);
    expect(report.claimed).toBeNull();
    expect(report.recomputed).toBeNull();

    // Every table matches the file's OWN rows, field for field.
    for (const name of DATA_TABLES) {
      expect({ [name]: sortById((await db.table(name).toArray()) as { id: string }[]) }).toEqual({
        [name]: sortById(file.tables[name] as { id: string }[]),
      });
    }
    // The settings row keeps its one documented exception (C8): the book-level
    // half comes from the file, the device-local half stays this browser's.
    expect((await getSettings()).baseCurrency).toBe('GBP');
  });

  it('can still be described afterwards, recomputed from the restored data', async () => {
    await restoreBackup(legacy());
    const m = await bookManifest();
    expect(m.rowCounts.accounts).toBe(3);
    expect(m.rowCounts.transactions).toBe(4);
    expect(m.netWorth.totalMinor).toBe(LEGACY_NET_WORTH);
    expect(m.netWorth.totalMinor).toBe((await netWorth()).totalBaseMinor);
    expect(m.accounts.find((a) => a.id === 'acc-old')!.counted).toBe(false);
    expect(summariseManifest(m)).toBe('3 accounts, 4 transactions, net worth £4,054.33');
  });

  it('gains a manifest the moment it is exported again', async () => {
    await restoreBackup(legacy());
    const file = await exportBackup();
    expect(file.manifest!.netWorth.totalMinor).toBe(LEGACY_NET_WORTH);
    // …and that file verifies on the way back in.
    await clearAll();
    expect((await restoreBackup(reparse(file))).verified).toBe(true);
  });

  it('a file with no manifest is exactly as restorable as it ever was', async () => {
    // The sync engine builds one of these on every pull (it carries no
    // manifest by construction), so this is not only about old files.
    await seedAll();
    const { manifest: _dropped, ...noManifest } = await exportBackup();
    await clearAll();
    const report = await restoreBackup(noManifest as BackupFile);
    expect(report.verified).toBe(false);
    expect(await db.transactions.count()).toBe(seedTransactions.length);
  });
});

// ===========================================================================
// TASK 4 — what the screen says after an export and after a restore
// ===========================================================================

describe('exportVerifiedBackup', () => {
  it('proves the bytes it is about to hand over', async () => {
    await seedAll();
    const { file, json, manifest, contentHash } = await exportVerifiedBackup();
    expect(json).toBe(serializeBackup(file));
    expect(manifest.netWorth.totalMinor).toBe(SEED_NET_WORTH);
    expect(contentHash).toBe(canonicalBackupHash(JSON.parse(json) as BackupFile));
    expect(contentHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('refuses to hand over a file whose own figures do not add up', async () => {
    await seedAll();
    // Simulate serialisation losing a row: the manifest is computed from the
    // rows in memory, the check is done on the parsed bytes, so the two
    // disagree exactly as they would if the write had truncated.
    const good = await exportBackup();
    const parse = vi.spyOn(JSON, 'parse').mockImplementationOnce((text: string) => {
      const f = JSON.parse(text) as BackupFile;
      f.tables.transactions = (f.tables.transactions as unknown[]).slice(1);
      return f;
    });
    await expect(exportVerifiedBackup()).rejects.toThrow(/does not describe its own contents/);
    parse.mockRestore();
    expect(good.manifest).toBeDefined(); // …and the untouched path still works
  });

  it('downloadVerifiedBackup reports the figures alongside the outcome', async () => {
    await seedAll();
    const { result, manifest, contentHash, fileName, written } = await withBrowser(
      { picker: 'saved' },
      async (seen) => ({ ...(await downloadVerifiedBackup()), written: seen.written }),
    );
    expect(result).toBe('saved');
    expect(fileName).toMatch(/^mymoney-backup-\d{4}-\d{2}-\d{2}\.json$/);
    expect(summariseManifest(manifest)).toBe('2 accounts, 6 transactions, net worth £3,863.38');
    const delivered = JSON.parse(written[0]!) as BackupFile;
    expect(delivered.manifest).toEqual(manifest);
    expect(canonicalBackupHash(delivered)).toBe(contentHash);
  });
});

describe('bookManifest', () => {
  it('describes the live database, independently of any file', async () => {
    await seedAll();
    const m = await bookManifest();
    expect(m.netWorth.totalMinor).toBe(SEED_NET_WORTH);
    expect(m.rowCounts.transactions).toBe(seedTransactions.length);
    // It is a fresh read, so it moves when the book moves.
    await db.transactions.delete('tx-groc');
    expect((await bookManifest()).rowCounts.transactions).toBe(seedTransactions.length - 1);
  });
});

describe('what the restore screen says', () => {
  it('promises a check only when the file can be held to one', async () => {
    await seedAll();
    const file = await exportBackup();
    const said = selfCheckNote(file.manifest);
    expect(said).toContain('2 accounts, 6 transactions, net worth £3,863.38');
    expect(said).toContain('refused');
  });

  it('says plainly when a file carries nothing to check', () => {
    const said = selfCheckNote(undefined);
    expect(said).toContain('no figures to check against');
    expect(said).toContain('restore exactly as it always has');
    // Nothing in it may read as a promise that the data was checked.
    expect(said).not.toMatch(/verified|checked out|proved/i);
  });

  it('does not call an unchecked restore verified', () => {
    expect(restoredNote(true)).toContain('every one of them agreed');
    expect(restoredNote(false)).toContain('nothing was verified');
  });
});

// The wiring itself (no DOM in this suite — the same source-reading approach
// tests/onboarding.test.ts uses).
describe('the Settings screen is wired to the verified paths', () => {
  const source = (name: string): string =>
    readFileSync(fileURLToPath(new URL(`../src/ui/settings/${name}`, import.meta.url)), 'utf8');

  it('exports through the path that verifies the bytes', () => {
    const text = source('BackupSection.tsx');
    expect(text).toContain('downloadVerifiedBackup');
    expect(text).not.toMatch(/\bdownloadBackup\b\(/);
    // …and states what was written, plus the fingerprint of it.
    expect(text).toContain('summariseManifest(manifest)');
    expect(text).toContain('written.hash');
  });

  it('states the recomputed figures after a restore instead of navigating away', () => {
    const text = source('BackupSection.tsx');
    expect(text).toContain('summariseManifest(restored.manifest)');
    expect(text).toContain('restoredNote(restored.verified)');
  });

  it('warns before restoring a file that cannot check itself', () => {
    expect(source('RestoreFromBackup.tsx')).toContain('selfCheckNote(pending.manifest)');
  });

  it('recomputes from the database rather than reporting the file back', () => {
    expect(source('RestoreFromBackup.tsx')).toContain('await bookManifest()');
  });
});
