// Recent transactions: the last 8, compact rows (SPEC §8.1.7).
import dayjs from 'dayjs';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { queryTransactions } from '../../domain/transactions';
import type { Category, Payee, Transaction } from '../../db/types';
import { Amount, Card } from '../kit/kit';
import { CardHeader, EmptyHint, Skeleton } from './shared';

function rowLabel(t: Transaction, payees: Map<string, Payee>): string {
  if (t.payeeId !== null) {
    const p = payees.get(t.payeeId);
    if (p) return p.name;
  }
  if (t.notes.trim()) return t.notes.trim();
  if (t.transferGroupId !== null) return 'Transfer';
  return 'No payee';
}

function rowCategory(t: Transaction, cats: Map<string, Category>): string {
  if (t.transferGroupId !== null) return 'Transfer';
  if (t.splits.length > 0) return `Split (${t.splits.length})`;
  if (t.categoryId !== null) return cats.get(t.categoryId)?.name ?? 'Uncategorised';
  return 'Uncategorised';
}

export function RecentTransactionsCard({ className }: { className?: string }) {
  const data = useLive(async () => {
    const [txs, payees, cats] = await Promise.all([
      queryTransactions({ limit: 8 }),
      db.payees.toArray(),
      db.categories.toArray(),
    ]);
    return {
      txs,
      payees: new Map(payees.map((p) => [p.id, p] as const)),
      cats: new Map(cats.map((c) => [c.id, c] as const)),
    };
  }, []);

  return (
    <Card className={className}>
      <CardHeader title="Recent transactions" linkTo="/transactions" linkLabel="View all" />
      {data === undefined ? (
        <Skeleton className="h-40 w-full" />
      ) : data.txs.length === 0 ? (
        <EmptyHint>
          No transactions yet. Tap the <span aria-hidden="true">+</span>
          <span className="sr-only">plus</span> button to log your first one.
        </EmptyHint>
      ) : (
        <ul className="divide-y divide-border">
          {data.txs.map((t) => (
            <li key={t.id} className="flex items-center gap-3 py-2">
              <span className="tnum w-11 shrink-0 text-xs text-faint">
                {dayjs(t.date).format('DD/MM')}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-sm">{rowLabel(t, data.payees)}</span>
                <span className="block truncate text-xs text-muted">
                  {rowCategory(t, data.cats)}
                </span>
              </span>
              <Amount minor={t.amountMinor} currency={t.currency} signColour className="shrink-0 text-sm" />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
