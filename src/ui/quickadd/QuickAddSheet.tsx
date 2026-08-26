// Quick add (SPEC §4: log an expense in ~3 seconds). Amount-first bottom
// sheet (mobile) / centred modal (desktop, via kit Modal). Mounted once in
// App; the FAB and sidebar "+" open it.
import { useEffect, useMemo, useRef, useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import type { Payee } from '../../db/types';
import { saveTransaction, saveTransfer } from '../../domain/transactions';
import { cn, todayISO } from '../../lib/util';
import { formatMinor } from '../../money/money';
import { Button, Field, Input, Modal, MoneyInput, Segmented, Select } from '../kit/kit';
import { CategoryPicker } from '../kit/CategoryPicker';
import { PayeeInput } from '../kit/PayeeInput';
import { useToast } from '../kit/toast';
import {
  TransferFields,
  emptyTransferDraft,
  transferDraftToInput,
  type TransferDraft,
} from '../tx/TransferFields';
import { errMsg, type TxKind } from '../tx/txShared';

export interface QuickAddSheetProps {
  open: boolean;
  onClose: () => void;
}

/** The chosen category plus where it came from (see `categoryAfterPayeePick`). */
export interface QuickAddCategory {
  id: string | null;
  /** true = auto-filled from a payee's learned default rather than chosen by the user. */
  auto: boolean;
}

/**
 * What a payee pick should do to the current category. Returns the next
 * category, or `null` for "leave it alone".
 *
 * "Save & add another" keeps the category so a run of same-category entries
 * stays fast, but that carried-over value must not silence auto-categorisation
 * (D17) for the next payee: a category the *user* picked outranks the payee's
 * default, while one that was itself auto-filled belongs to the payee it came
 * from, so a new pick replaces it — or clears it, when the new payee has no
 * usable default to offer.
 */
export function categoryAfterPayeePick(
  current: QuickAddCategory,
  payee: Pick<Payee, 'defaultCategoryId'>,
  usable: (categoryId: string) => boolean,
): QuickAddCategory | null {
  if (current.id !== null && !current.auto) return null;
  const id =
    payee.defaultCategoryId && usable(payee.defaultCategoryId) ? payee.defaultCategoryId : null;
  return id === current.id ? null : { id, auto: id !== null };
}

export default function QuickAddSheet({ open, onClose }: QuickAddSheetProps) {
  const { toast } = useToast();

  const [type, setType] = useState<TxKind>('expense');
  const [amount, setAmount] = useState<number | null>(null); // positive magnitude
  const [category, setCategory] = useState<QuickAddCategory>({ id: null, auto: false });
  const [payeeText, setPayeeText] = useState('');
  const [accountId, setAccountId] = useState(''); // '' = use preferred
  const [date, setDate] = useState(todayISO());
  const [transfer, setTransfer] = useState<TransferDraft>({
    fromAccountId: '',
    toAccountId: '',
    amountFromMinor: null,
    amountToMinor: null,
  });
  const [saving, setSaving] = useState(false);
  const [resetKey, setResetKey] = useState(0); // remounts the amount input to re-autofocus

  const settings = useLive(() => getSettings(), []);
  const accounts = useLive(() => db.accounts.toArray(), []);
  const cats = useLive(() => db.categories.toArray(), []);
  // Last 30 transactions (index-backed) → most-recently-used categories.
  const recentTxs = useLive(
    () => (open ? db.transactions.orderBy('date').reverse().limit(30).toArray() : []),
    [open],
  );

  const catsById = useMemo(() => new Map((cats ?? []).map((c) => [c.id, c])), [cats]);
  const usableAccounts = useMemo(
    () =>
      (accounts ?? [])
        .filter((a) => !a.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name)),
    [accounts],
  );
  const preferredId = useMemo(() => {
    const last = settings?.lastUsedAccountId;
    if (last && usableAccounts.some((a) => a.id === last)) return last;
    return usableAccounts[0]?.id ?? '';
  }, [settings, usableAccounts]);
  const effAccountId = accountId || preferredId;
  const effAccount = usableAccounts.find((a) => a.id === effAccountId);

  // Reset the form each time the sheet opens.
  const wasOpen = useRef(false);
  useEffect(() => {
    if (open && !wasOpen.current) {
      setType('expense');
      setAmount(null);
      setCategory({ id: null, auto: false });
      setPayeeText('');
      setAccountId('');
      setDate(todayISO());
      setTransfer({ fromAccountId: '', toAccountId: '', amountFromMinor: null, amountToMinor: null });
      setResetKey((k) => k + 1);
    }
    wasOpen.current = open;
  }, [open]);

  const qKind = type === 'income' ? 'income' : 'expense';

  // 8 most-recently-used categories of the right kind; falls back to
  // top-level categories when there's no history yet.
  const recentCats = useMemo(() => {
    const ids: string[] = [];
    const push = (id: string | null) => {
      if (!id || ids.includes(id)) return;
      const c = catsById.get(id);
      if (c && c.kind === qKind && !c.archived) ids.push(id);
    };
    for (const t of recentTxs ?? []) {
      if (t.splits.length > 0) for (const s of t.splits) push(s.categoryId);
      else push(t.categoryId);
    }
    let list = ids.slice(0, 8).map((id) => catsById.get(id)!);
    if (list.length === 0) {
      list = (cats ?? [])
        .filter((c) => c.parentId === null && c.kind === qKind && !c.archived)
        .sort((a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name))
        .slice(0, 8);
    }
    return list;
  }, [recentTxs, catsById, cats, qKind]);

  // The big amount-first input doubles as the transfer's "amount sent".
  const fromAccount = usableAccounts.find((a) => a.id === transfer.fromAccountId);
  const amountValue = type === 'transfer' ? transfer.amountFromMinor : amount;
  const amountCurrency =
    type === 'transfer'
      ? (fromAccount?.currency ?? settings?.baseCurrency ?? 'GBP')
      : (effAccount?.currency ?? settings?.baseCurrency ?? 'GBP');
  const onAmount = (v: number | null) => {
    if (type === 'transfer') setTransfer((d) => ({ ...d, amountFromMinor: v }));
    else setAmount(v);
  };

  const switchType = (t: TxKind) => {
    if (t === 'transfer' && type !== 'transfer') {
      setTransfer((d) => {
        const base = d.fromAccountId ? d : emptyTransferDraft(usableAccounts, effAccountId);
        return { ...base, amountFromMinor: amount };
      });
    } else if (t !== 'transfer' && type === 'transfer') {
      setAmount(transfer.amountFromMinor);
    }
    setType(t);
  };

  const categoryId = category.id;
  /** A category the picker itself would offer: right kind, not archived. */
  const usableCategory = (id: string) => {
    const c = catsById.get(id);
    return !!c && c.kind === qKind && !c.archived;
  };
  /** Anything the user chooses by hand outranks payee auto-fill from then on. */
  const pickCategory = (id: string | null) => setCategory({ id, auto: false });

  const onPickPayee = (p: Payee) => {
    const next = categoryAfterPayeePick(category, p, usableCategory);
    if (next) setCategory(next);
  };

  const toAccount = usableAccounts.find((a) => a.id === transfer.toAccountId);
  const cross = !!fromAccount && !!toAccount && fromAccount.currency !== toAccount.currency;
  const disabled =
    saving ||
    (type === 'transfer'
      ? !fromAccount ||
        !toAccount ||
        transfer.amountFromMinor === null ||
        (cross && transfer.amountToMinor === null)
      : amountValue === null || !effAccountId);

  const doSave = async (addAnother: boolean) => {
    setSaving(true);
    try {
      if (type === 'transfer') {
        await saveTransfer(transferDraftToInput(usableAccounts, transfer, date, '', 'cleared'));
        toast('Transfer saved', 'success');
      } else {
        if (amount === null || amount === 0) throw new Error('Enter an amount');
        if (!effAccountId) throw new Error('Create an account first');
        const sign = type === 'income' ? 1 : -1;
        await saveTransaction({
          accountId: effAccountId,
          date,
          amountMinor: sign * Math.abs(amount),
          payeeName: payeeText || null,
          categoryId,
        });
        toast(
          `${type === 'income' ? 'Income' : 'Expense'} of ${formatMinor(
            Math.abs(amount),
            amountCurrency,
          )} added`,
          'success',
        );
      }
      if (addAnother) {
        setAmount(null);
        setPayeeText('');
        if (type === 'transfer') {
          setTransfer((d) => ({ ...d, amountFromMinor: null, amountToMinor: null }));
        }
        setResetKey((k) => k + 1); // remount → re-focus the amount input
      } else {
        onClose();
      }
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal
      open={open}
      onClose={onClose}
      title="Quick add"
      footer={
        <>
          <Button onClick={() => doSave(true)} disabled={disabled}>
            Save &amp; add another
          </Button>
          <Button variant="primary" onClick={() => doSave(false)} disabled={disabled}>
            {saving ? 'Saving…' : 'Save'}
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {usableAccounts.length === 0 && (
          <p className="rounded-lg border border-warn px-3 py-2 text-sm text-warn">
            Create an account first — transactions need an account to live in.
          </p>
        )}
        <Field label={`Amount (${amountCurrency})`}>
          {(id) => (
            <MoneyInput
              key={`amt-${resetKey}`}
              id={id}
              autoFocus
              className="py-3 text-2xl font-semibold"
              valueMinor={amountValue}
              currency={amountCurrency}
              onValue={onAmount}
            />
          )}
        </Field>
        <Segmented<TxKind>
          label="Transaction type"
          className="self-start"
          value={type}
          onChange={switchType}
          options={[
            { value: 'expense', label: 'Expense' },
            { value: 'income', label: 'Income' },
            { value: 'transfer', label: 'Transfer' },
          ]}
        />

        {type === 'transfer' ? (
          <>
            <TransferFields
              accounts={usableAccounts}
              draft={transfer}
              onChange={setTransfer}
              hideFromAmount
            />
            <Field label="Date">
              {(id) => (
                <Input
                  id={id}
                  type="date"
                  value={date}
                  onChange={(e) => e.target.value && setDate(e.target.value)}
                />
              )}
            </Field>
          </>
        ) : (
          <>
            <div className="flex flex-col gap-1.5">
              <span className="text-sm font-medium text-text">Category</span>
              {recentCats.length > 0 && (
                <div
                  role="group"
                  aria-label="Recent categories"
                  className="grid grid-cols-2 gap-1.5 sm:grid-cols-4"
                >
                  {recentCats.map((c) => (
                    <button
                      key={c.id}
                      type="button"
                      aria-pressed={categoryId === c.id}
                      onClick={() => pickCategory(categoryId === c.id ? null : c.id)}
                      className={cn(
                        'flex cursor-pointer items-center gap-1.5 rounded-lg border px-2 py-1.5 text-xs transition-colors',
                        categoryId === c.id
                          ? 'border-accent bg-surface2 font-medium text-text'
                          : 'border-border bg-surface text-muted hover:text-text',
                      )}
                    >
                      {c.colour && (
                        <span
                          aria-hidden="true"
                          className="h-2 w-2 shrink-0 rounded-full"
                          style={{ backgroundColor: c.colour }}
                        />
                      )}
                      <span className="truncate">{c.name}</span>
                    </button>
                  ))}
                </div>
              )}
              <label className="sr-only" htmlFor="quickadd-category">
                Category
              </label>
              <CategoryPicker
                id="quickadd-category"
                kind={qKind}
                value={categoryId}
                onChange={pickCategory}
              />
            </div>
            <Field label="Payee">
              {(id) => (
                <PayeeInput
                  id={id}
                  value={payeeText}
                  onChange={setPayeeText}
                  onPick={onPickPayee}
                />
              )}
            </Field>
            <div className="grid grid-cols-2 gap-3">
              <Field label="Account">
                {(id) => (
                  <Select
                    id={id}
                    value={effAccountId}
                    onChange={(e) => setAccountId(e.target.value)}
                  >
                    <option value="" disabled>
                      Choose account
                    </option>
                    {usableAccounts.map((a) => (
                      <option key={a.id} value={a.id}>
                        {a.name} ({a.currency})
                      </option>
                    ))}
                  </Select>
                )}
              </Field>
              <Field label="Date">
                {(id) => (
                  <Input
                    id={id}
                    type="date"
                    value={date}
                    onChange={(e) => e.target.value && setDate(e.target.value)}
                  />
                )}
              </Field>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
}
