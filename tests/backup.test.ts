// Backup export/restore tests (SPEC §8.1.9, §10: backup round-trip equality).
import 'fake-indexeddb/auto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ALL_TABLES,
  BOOK_LEVEL_SETTING_KEYS,
  DATA_TABLES,
  DEVICE_LOCAL_SETTING_KEYS,
  db,
  getSettings,
  SCHEMA_VERSION,
  updateSettings,
  defaultSettings,
} from '../src/db/db';
import {
  backupNudgeState,
  clearRecoveryStore,
  CURRENT_SCHEMA_VERSION,
  deleteRecoveryRecord,
  downloadBackup,
  downloadBackupFile,
  downloadRecoveryBackup,
  exportBackup,
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

  it('serializeBackup is pretty-printed with 2-space indent', async () => {
    await seedAll();
    const json = serializeBackup(await exportBackup());
    expect(json.startsWith('{\n  "app": "MyMoney",\n  "schemaVersion"')).toBe(true);
    expect(json).toContain('\n    "accounts": [');
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

    const after = await getSettings();
    for (const key of BOOK_LEVEL_SETTING_KEYS) {
      expect({ [key]: after[key] }).toEqual({ [key]: incoming[key] });
    }
    for (const key of DEVICE_LOCAL_SETTING_KEYS) {
      expect({ [key]: after[key] }).toEqual({ [key]: thisDevice()[key] });
    }
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
