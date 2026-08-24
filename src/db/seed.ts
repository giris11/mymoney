// Default category tree (SPEC §5: "seed a sensible default tree; fully
// editable") and account templates for onboarding.
import { db } from './db';
import type { Account, AccountType, Category, CategoryKind } from './types';
import { uid } from '../lib/util';

type SeedNode = [name: string, colour: string, children?: string[]];

const EXPENSE_TREE: SeedNode[] = [
  ['Bills & Utilities', '#0e7490', ['Electricity', 'Gas', 'Water', 'Internet', 'Mobile', 'Council Tax']],
  ['Housing', '#7c3aed', ['Rent', 'Mortgage', 'Repairs & Maintenance', 'Furniture & Appliances']],
  ['Food & Drink', '#ea580c', ['Groceries', 'Restaurants', 'Takeaway', 'Coffee & Snacks']],
  ['Transport', '#2563eb', ['Fuel', 'Public Transport', 'Taxi & Ride-hailing', 'Parking', 'Car Maintenance', 'Car Insurance']],
  ['Shopping', '#db2777', ['Clothing', 'Electronics', 'Household', 'Gifts']],
  ['Health', '#dc2626', ['Pharmacy', 'Doctor & Dental', 'Fitness']],
  ['Entertainment', '#9333ea', ['Streaming & Subscriptions', 'Cinema & Events', 'Games', 'Books']],
  ['Personal', '#0891b2', ['Education', 'Personal Care', 'Charity']],
  ['Travel', '#059669', ['Flights', 'Accommodation', 'Holiday Spending']],
  ['Family', '#c2410c', ['Childcare', 'Pets']],
  ['Finance', '#4f46e5', ['Bank Fees', 'Interest Charges', 'Insurance', 'Taxes']],
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

/** Idempotent: only seeds when the table is empty. */
export async function seedCategoriesIfEmpty(): Promise<void> {
  const count = await db.categories.count();
  if (count === 0) await db.categories.bulkAdd(defaultCategories());
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

export const COMMON_CURRENCIES = [
  'GBP', 'EUR', 'USD', 'INR', 'JPY', 'AUD', 'CAD', 'CHF', 'CNY', 'SEK', 'NOK', 'DKK',
  'PLN', 'CZK', 'AED', 'SGD', 'HKD', 'NZD', 'ZAR', 'THB',
];
