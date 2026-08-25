// One register row. Mobile: two-line layout; desktop: table-ish grid that
// shares its column template with the sticky header (REGISTER_GRID).
import { memo, type ReactNode } from 'react';
import dayjs from 'dayjs';
import type { Account, Category, Payee, Tag, Transaction } from '../../db/types';
import { categoryPathName } from '../../domain/categories';
import { cn, formatDate } from '../../lib/util';
import { Amount, Chip } from '../kit/kit';
import { IconTransfer } from '../kit/icons';
import { REGISTER_GRID } from './txShared';

export interface TxRowProps {
  tx: Transaction;
  accountsById: Map<string, Account>;
  categoriesById: Map<string, Category>;
  payeesById: Map<string, Payee>;
  tagsById: Map<string, Tag>;
  /** Name of the other leg's account when this row is a transfer leg. */
  otherAccountName: string | null;
  onOpen: (tx: Transaction) => void;
}

function firstLine(s: string): string {
  const i = s.indexOf('\n');
  return i === -1 ? s : s.slice(0, i);
}

function PendingBadge() {
  return (
    <span className="shrink-0 rounded-full border border-warn px-1.5 py-px text-[10px] font-medium text-warn">
      Pending
    </span>
  );
}

export const TxRow = memo(function TxRow({
  tx,
  accountsById,
  categoriesById,
  payeesById,
  tagsById,
  otherAccountName,
  onOpen,
}: TxRowProps) {
  const account = accountsById.get(tx.accountId);
  const payee = tx.payeeId ? payeesById.get(tx.payeeId) : undefined;
  const isTransfer = tx.transferGroupId !== null;

  const title =
    payee?.name || firstLine(tx.notes) || (isTransfer ? 'Transfer' : 'No payee');
  const titleFaint = !payee && !tx.notes && !isTransfer;

  let categoryNode: ReactNode;
  if (isTransfer) {
    categoryNode = (
      <>
        <IconTransfer size={14} className="shrink-0 text-faint" />
        <span className="truncate">
          {tx.amountMinor < 0
            ? `Transfer to ${otherAccountName ?? 'another account'}`
            : `Transfer from ${otherAccountName ?? 'another account'}`}
        </span>
      </>
    );
  } else if (tx.splits.length > 0) {
    const n = new Set(tx.splits.map((s) => s.categoryId).filter(Boolean)).size;
    categoryNode = (
      <span className="truncate">{`Split · ${n} categor${n === 1 ? 'y' : 'ies'}`}</span>
    );
  } else if (tx.categoryId) {
    categoryNode = (
      <span className="truncate">{categoryPathName(categoriesById, tx.categoryId)}</span>
    );
  } else {
    categoryNode = <span className="truncate text-faint">Uncategorised</span>;
  }

  const tagNames = tx.tagIds
    .map((id) => tagsById.get(id)?.name)
    .filter((n): n is string => !!n);
  const shownTags = tagNames.slice(0, 2);
  const extraTags = tagNames.length - shownTags.length;
  const tagChips = (
    <>
      {shownTags.map((n) => (
        <Chip key={n} className="max-w-24">
          <span className="truncate">{n}</span>
        </Chip>
      ))}
      {extraTags > 0 && <Chip>+{extraTags}</Chip>}
    </>
  );

  const accountDot = account && (
    <span
      aria-hidden="true"
      className="h-2 w-2 shrink-0 rounded-full"
      style={{ backgroundColor: account.colour }}
    />
  );

  return (
    <button
      type="button"
      onClick={() => onOpen(tx)}
      className="block w-full cursor-pointer border-b border-border px-3 py-2 text-left transition-colors hover:bg-surface2 lg:px-4"
    >
      {/* Mobile: two lines */}
      <div className="flex flex-col gap-0.5 lg:hidden">
        <div className="flex items-center gap-2">
          <span
            className={cn(
              'min-w-0 flex-1 truncate text-sm font-medium',
              titleFaint ? 'text-faint' : 'text-text',
            )}
          >
            {title}
          </span>
          {tx.status === 'pending' && <PendingBadge />}
          <Amount minor={tx.amountMinor} currency={tx.currency} signColour className="shrink-0 text-sm" />
        </div>
        <div className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
          <span className="tnum shrink-0">{dayjs(tx.date).format('DD/MM')}</span>
          <span aria-hidden="true">·</span>
          <span className="flex min-w-0 items-center gap-1">{categoryNode}</span>
          {account && (
            <>
              <span aria-hidden="true">·</span>
              {accountDot}
              <span className="max-w-24 truncate">{account.name}</span>
            </>
          )}
          {tagNames.length > 0 && <span className="flex shrink-0 items-center gap-1">{tagChips}</span>}
        </div>
      </div>

      {/* Desktop: grid aligned with the sticky header */}
      <div className={cn('hidden lg:grid lg:items-center lg:gap-3', REGISTER_GRID)}>
        <span className="tnum text-sm text-muted">{formatDate(tx.date)}</span>
        <span className="flex min-w-0 items-center gap-2">
          <span
            className={cn(
              'truncate text-sm font-medium',
              titleFaint ? 'text-faint' : 'text-text',
            )}
          >
            {title}
          </span>
          {tx.status === 'pending' && <PendingBadge />}
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-sm text-muted">{categoryNode}</span>
        <span className="flex min-w-0 items-center gap-2">
          {accountDot}
          <span className="truncate text-sm text-muted">{account?.name ?? '—'}</span>
        </span>
        <span className="flex min-w-0 items-center gap-1 overflow-hidden">{tagChips}</span>
        <Amount
          minor={tx.amountMinor}
          currency={tx.currency}
          signColour
          className="justify-self-end text-sm"
        />
      </div>
    </button>
  );
});
