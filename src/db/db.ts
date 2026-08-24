// Dexie database. Every future schema change MUST ship as a new
// this.version(n) block with an upgrade function (SPEC §9 migrations),
// and SCHEMA_VERSION must be bumped to match.
import Dexie, { type Table } from 'dexie';
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
} from './types';

export const SCHEMA_VERSION = 1;

export class MyMoneyDB extends Dexie {
  accounts!: Table<Account, string>;
  accountGroups!: Table<AccountGroup, string>;
  transactions!: Table<Transaction, string>;
  categories!: Table<Category, string>;
  payees!: Table<Payee, string>;
  tags!: Table<Tag, string>;
  budgets!: Table<Budget, string>;
  fxRates!: Table<FxRate, string>;
  importBatches!: Table<ImportBatch, string>;
  settings!: Table<Settings, string>;

  constructor() {
    super('mymoney');
    this.version(SCHEMA_VERSION).stores({
      accounts: 'id, groupId, archived',
      accountGroups: 'id, sortOrder',
      transactions:
        'id, accountId, date, categoryId, payeeId, transferGroupId, importBatchId, dedupeHash, status, [accountId+date], *tagIds',
      categories: 'id, parentId, kind',
      payees: 'id, nameLower',
      tags: 'id, nameLower',
      budgets: 'id, archived',
      fxRates: 'id, base, quote',
      importBatches: 'id, importedAt',
      settings: 'id',
    });
  }
}

export const db = new MyMoneyDB();

/** Table names in a stable order — used by backup export/restore. */
export const ALL_TABLES = [
  'accounts',
  'accountGroups',
  'transactions',
  'categories',
  'payees',
  'tags',
  'budgets',
  'fxRates',
  'importBatches',
  'settings',
] as const;
export type TableName = (typeof ALL_TABLES)[number];

export function defaultSettings(): Settings {
  return {
    id: 'app',
    schemaVersion: SCHEMA_VERSION,
    baseCurrency: 'GBP',
    theme: 'system',
    lastBackupAt: null,
    onboarded: false,
    lastUsedAccountId: null,
    savedMappings: {},
    createdAt: new Date().toISOString(),
  };
}

export async function getSettings(): Promise<Settings> {
  return (await db.settings.get('app')) ?? defaultSettings();
}

export async function updateSettings(patch: Partial<Omit<Settings, 'id'>>): Promise<Settings> {
  const next = { ...(await getSettings()), ...patch };
  await db.settings.put(next);
  return next;
}
