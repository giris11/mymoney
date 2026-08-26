// Default category tree (SPEC §5: "seed a sensible default tree; fully
// editable") and account templates for onboarding.
import { db } from './db';
import type { Account, AccountType, Category, CategoryKind } from './types';
import { uid } from '../lib/util';

type SeedNode = [name: string, colour: string, children?: string[]];

// Colours: hue-spread set checked with a palette validator on both theme
// surfaces; residual close pairs under colour-vision-deficiency simulation are
// unavoidable with 12 entity colours, so every chart ALSO direct-labels each
// mark (see docs/CONTRACTS.md charts section). 'Other' is deliberately grey.
const EXPENSE_TREE: SeedNode[] = [
  ['Food & Drink', '#ea580c', ['Groceries', 'Restaurants', 'Takeaway', 'Coffee & Snacks']],
  ['Bills & Utilities', '#0284c7', ['Electricity', 'Gas', 'Water', 'Internet', 'Mobile', 'Council Tax']],
  ['Transport', '#2563eb', ['Fuel', 'Public Transport', 'Taxi & Ride-hailing', 'Parking', 'Car Maintenance', 'Car Insurance']],
  ['Housing', '#7c3aed', ['Rent', 'Mortgage', 'Repairs & Maintenance', 'Furniture & Appliances']],
  ['Shopping', '#db2777', ['Clothing', 'Electronics', 'Household', 'Gifts']],
  ['Health', '#dc2626', ['Pharmacy', 'Doctor & Dental', 'Fitness']],
  ['Entertainment', '#c026d3', ['Streaming & Subscriptions', 'Cinema & Events', 'Games', 'Books']],
  ['Personal', '#a16207', ['Education', 'Personal Care', 'Charity']],
  ['Travel', '#059669', ['Flights', 'Accommodation', 'Holiday Spending']],
  ['Family', '#65a30d', ['Childcare', 'Pets']],
  ['Finance', '#0d9488', ['Bank Fees', 'Interest Charges', 'Insurance', 'Taxes']],
  ['Other', '#6b7280'],
];

const INCOME_TREE: SeedNode[] = [
  ['Salary', '#059669'],
  ['Freelance & Side Income', '#0d9488'],
  ['Interest & Dividends', '#2563eb'],
  ['Gifts Received', '#db2777'],
  ['Refunds & Reimbursements', '#7c3aed'],
  ['Other Income', '#6b7280'],
];

function buildCategories(tree: SeedNode[], kind: CategoryKind): Category[] {
  const out: Category[] = [];
  tree.forEach(([name, colour, children], i) => {
    const parent: Category = {
      id: uid(),
      name,
      parentId: null,
      kind,
      colour,
      archived: false,
      sortOrder: i,
    };
    out.push(parent);
    (children ?? []).forEach((childName, j) => {
      out.push({
        id: uid(),
        name: childName,
        parentId: parent.id,
        kind,
        colour,
        archived: false,
        sortOrder: j,
      });
    });
  });
  return out;
}

export function defaultCategories(): Category[] {
  return [...buildCategories(EXPENSE_TREE, 'expense'), ...buildCategories(INCOME_TREE, 'income')];
}

/**
 * Idempotent: only seeds when the table is empty.
 *
 * The check and the write are ONE `rw` transaction on purpose. This runs at
 * every app start (src/main.tsx), so two contexts can easily race — two tabs,
 * or a tab plus a restored iOS session. As a read-then-write both would see an
 * empty table and both would seed, leaving 122 categories instead of 61 and no
 * way to tell the copies apart. IndexedDB serialises readwrite transactions
 * that share an object store *across connections*, so wrapping it makes the
 * loser of the race see the winner's 61 rows and do nothing.
 */
export async function seedCategoriesIfEmpty(): Promise<void> {
  await db.transaction('rw', db.categories, async () => {
    if ((await db.categories.count()) === 0) {
      await db.categories.bulkAdd(defaultCategories());
    }
  });
}

export interface AccountTemplate {
  name: string;
  type: AccountType;
  colour: string;
}

export const ACCOUNT_TEMPLATES: AccountTemplate[] = [
  { name: 'Current Account', type: 'current', colour: '#2563eb' },
  { name: 'Savings', type: 'savings', colour: '#059669' },
  { name: 'Credit Card', type: 'credit_card', colour: '#db2777' },
  { name: 'Cash', type: 'cash', colour: '#b45309' },
];

export function accountFromTemplate(
  t: AccountTemplate,
  currency: string,
  sortOrder: number,
): Account {
  return {
    id: uid(),
    name: t.name,
    type: t.type,
    currency,
    openingBalanceMinor: 0,
    colour: t.colour,
    groupId: null,
    sortOrder,
    archived: false,
  };
}

export const ACCOUNT_TYPE_LABELS: Record<AccountType, string> = {
  current: 'Current account',
  savings: 'Savings',
  credit_card: 'Credit card',
  cash: 'Cash',
  loan: 'Loan',
  investment: 'Investment',
};

// Both rupees use 100 minor units (paise / cents), so the default 2 decimals in
// src/money/money.ts is correct for them — no special-casing needed.
export const COMMON_CURRENCIES = [
  'GBP', 'EUR', 'USD', 'INR', 'LKR', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SEK', 'NOK',
  'DKK', 'PLN', 'CZK', 'AED', 'SGD', 'HKD', 'NZD', 'ZAR', 'THB', 'MYR', 'PKR', 'BDT',
  'NPR', 'PHP', 'IDR', 'VND', 'SAR', 'QAR', 'KWD', 'BHD', 'OMR', 'TRY', 'MXN', 'BRL',
  'KRW', 'TWD', 'ILS', 'EGP', 'NGN', 'KES', 'GHS', 'MUR', 'MVR',
];
