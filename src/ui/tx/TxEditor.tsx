// Full transaction editor (SPEC §8.1.2): expense/income with refund handling,
// splits with live remainder, transfers (incl. cross-currency with both
// amounts explicit), tags, notes, pending status, delete with confirmation.
// All writes go through domain functions; ValidationError messages are toasted.
import { useEffect, useMemo, useRef, useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import type { Payee, Tag, Transaction, TxStatus } from '../../db/types';
import {
  deleteTransaction,
  getTransferPair,
  saveTransaction,
  saveTransfer,
  validateSplits,
} from '../../domain/transactions';
import { todayISO } from '../../lib/util';
import { formatMinor } from '../../money/money';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  IconButton,
  Input,
  Modal,
  MoneyInput,
  Segmented,
  Select,
} from '../kit/kit';
import { CategoryPicker } from '../kit/CategoryPicker';
import { PayeeInput } from '../kit/PayeeInput';
import { TagsInput } from '../kit/TagsInput';
import { useToast } from '../kit/toast';
import { IconPlus, IconTrash, IconX } from '../kit/icons';
import { errMsg, type TxKind } from './txShared';
import {
  TransferFields,
  emptyTransferDraft,
  transferDraftToInput,
  type TransferDraft,
} from './TransferFields';

interface SplitDraft {
  key: number;
  categoryId: string | null;
  amountMinor: number | null; // positive magnitude; sign applied on save
  notes: string;
}

export default function TxEditor({
  open,
  onClose,
  tx,
}: {
  open: boolean;
  onClose: () => void;
  /** null = create new. A transfer leg loads the whole pair. */
  tx: Transaction | null;
}) {
  const { toast } = useToast();

  const [mode, setMode] = useState<TxKind>('expense');
  const [amount, setAmount] = useState<number | null>(null); // positive magnitude
  const [refund, setRefund] = useState(false);
  const [categoryId, setCategoryId] = useState<string | null>(null);
  // Whether the current categoryId came from a payee's learned default rather
  // than from the user. An auto-filled category belongs to the payee it came
  // from, so picking a different payee replaces it; a user's own choice never
  // gets overwritten (D17, same rule as Quick Add).
  const categoryWasAutoFilled = useRef(false);
  const [payeeName, setPayeeName] = useState('');
  const [accountId, setAccountId] = useState('');
  const [date, setDate] = useState(todayISO());
  const [tagNames, setTagNames] = useState<string[]>([]);
  const [notes, setNotes] = useState('');
  const [pending, setPending] = useState(false);
  const [splits, setSplits] = useState<SplitDraft[]>([]);
  const [transfer, setTransfer] = useState<TransferDraft>({
    fromAccountId: '',
    toAccountId: '',
    amountFromMinor: null,
    amountToMinor: null,
  });
  const [groupId, setGroupId] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);
  const nextKey = useRef(0);

  const accounts = useLive(() => db.accounts.toArray(), []) ?? [];
  const cats = useLive(() => db.categories.toArray(), []) ?? [];
  const settings = useLive(() => getSettings(), []);
  const catsById = useMemo(() => new Map(cats.map((c) => [c.id, c])), [cats]);
  const sortedAccounts = useMemo(
    () =>
      [...accounts].sort(
        (a, b) => a.sortOrder - b.sortOrder || a.name.localeCompare(b.name),
      ),
    [accounts],
  );
  // Hide archived accounts unless the record being edited references one.
  const selectableAccounts = useMemo(
    () =>
      sortedAccounts.filter(
        (a) =>
          !a.archived ||
          a.id === accountId ||
          a.id === transfer.fromAccountId ||
          a.id === transfer.toAccountId,
      ),
    [sortedAccounts, accountId, transfer.fromAccountId, transfer.toAccountId],
  );

  const isTransferEdit = !!tx && tx.transferGroupId !== null;
  const currency =
    accounts.find((a) => a.id === accountId)?.currency ?? settings?.baseCurrency ?? 'GBP';
  const sign = mode === 'income' || refund ? 1 : -1;
  const splitKind = mode === 'income' ? 'income' : 'expense';

  // ------------------------------------------------------------- init
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    (async () => {
      const [s, allAccounts] = await Promise.all([getSettings(), db.accounts.toArray()]);
      const usable = allAccounts.filter((a) => !a.archived);
      const reset = () => {
        setRefund(false);
        setAmount(null);
        setCategoryId(null);
        categoryWasAutoFilled.current = false;
        setPayeeName('');
        setDate(todayISO());
        setTagNames([]);
        setNotes('');
        setPending(false);
        setSplits([]);
        setGroupId(null);
        setConfirmDelete(false);
        nextKey.current = 0;
      };
      if (!tx) {
        const preferred =
          (s.lastUsedAccountId && usable.find((a) => a.id === s.lastUsedAccountId)?.id) ||
          usable[0]?.id ||
          '';
        if (cancelled) return;
        reset();
        setMode('expense');
        setAccountId(preferred);
        setTransfer(emptyTransferDraft(allAccounts, preferred));
        return;
      }
      if (tx.transferGroupId !== null) {
        const pair = await getTransferPair(tx.transferGroupId);
        if (cancelled) return;
        if (!pair) {
          toast('Could not load this transfer — its legs are missing', 'error');
          onClose();
          return;
        }
        const [fromLeg, toLeg] = pair;
        reset();
        setMode('transfer');
        setGroupId(tx.transferGroupId);
        setAccountId(fromLeg.accountId);
        setTransfer({
          fromAccountId: fromLeg.accountId,
          toAccountId: toLeg.accountId,
          amountFromMinor: Math.abs(fromLeg.amountMinor),
          amountToMinor: toLeg.amountMinor,
        });
        setDate(fromLeg.date);
        setNotes(fromLeg.notes);
        setPending(fromLeg.status === 'pending');
        return;
      }
      const firstSplitCatId = tx.splits.find((sp) => sp.categoryId)?.categoryId ?? null;
      const [payee, cat, splitCat, tagRecs] = await Promise.all([
        tx.payeeId ? db.payees.get(tx.payeeId) : Promise.resolve(undefined),
        tx.categoryId ? db.categories.get(tx.categoryId) : Promise.resolve(undefined),
        firstSplitCatId ? db.categories.get(firstSplitCatId) : Promise.resolve(undefined),
        db.tags.bulkGet(tx.tagIds),
      ]);
      if (cancelled) return;
      // Positive amount in an expense category = refund (D14).
      const kind = cat?.kind ?? splitCat?.kind;
      const isRefund = tx.amountMinor > 0 && kind === 'expense';
      reset();
      setMode(tx.amountMinor > 0 && !isRefund ? 'income' : 'expense');
      setRefund(isRefund);
      setAmount(Math.abs(tx.amountMinor));
      setCategoryId(tx.categoryId);
      categoryWasAutoFilled.current = false;
      setPayeeName(payee?.name ?? '');
      setAccountId(tx.accountId);
      setDate(tx.date);
      setTagNames(
        (tagRecs.filter(Boolean) as Tag[]).map((t) => t.name),
      );
      setNotes(tx.notes);
      setPending(tx.status === 'pending');
      setSplits(
        tx.splits.map((sp, i) => ({
          key: i,
          categoryId: sp.categoryId,
          amountMinor: Math.abs(sp.amountMinor),
          notes: sp.notes ?? '',
        })),
      );
      nextKey.current = tx.splits.length;
      setTransfer(emptyTransferDraft(allAccounts, tx.accountId));
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, tx?.id]);

  // ------------------------------------------------------------- derived
  const remainder =
    amount === null
      ? null
      : Math.abs(amount) - splits.reduce((acc, s) => acc + (s.amountMinor ?? 0), 0);

  const splitIssue = useMemo(() => {
    if (mode === 'transfer' || splits.length === 0) return null;
    if (amount === null) return 'Enter the transaction amount first';
    if (splits.some((s) => s.amountMinor === null)) return 'Every split needs an amount';
    return validateSplits(
      sign * Math.abs(amount),
      splits.map((s) => ({ categoryId: s.categoryId, amountMinor: sign * Math.abs(s.amountMinor!) })),
    );
  }, [mode, splits, amount, sign]);

  const fromAcc = accounts.find((a) => a.id === transfer.fromAccountId);
  const toAcc = accounts.find((a) => a.id === transfer.toAccountId);
  const transferCross = !!fromAcc && !!toAcc && fromAcc.currency !== toAcc.currency;

  const saveDisabled =
    saving ||
    (mode === 'transfer'
      ? !fromAcc ||
        !toAcc ||
        transfer.amountFromMinor === null ||
        (transferCross && transfer.amountToMinor === null)
      : amount === null || !accountId || (splits.length > 0 && splitIssue !== null));

  const typeOptions: { value: TxKind; label: string }[] = !tx
    ? [
        { value: 'expense', label: 'Expense' },
        { value: 'income', label: 'Income' },
        { value: 'transfer', label: 'Transfer' },
      ]
    : isTransferEdit
      ? []
      : [
          { value: 'expense', label: 'Expense' },
          { value: 'income', label: 'Income' },
        ];

  // ------------------------------------------------------------- handlers
  const switchMode = (m: TxKind) => {
    setMode(m);
    if (m !== 'expense') setRefund(false);
    if (m !== 'transfer') {
      const kind = m === 'income' ? 'income' : 'expense';
      setCategoryId((prev) => {
        const c = prev ? catsById.get(prev) : undefined;
        return c && c.kind === kind ? prev : null;
      });
      setSplits((prev) =>
        prev.map((s) => {
          const c = s.categoryId ? catsById.get(s.categoryId) : undefined;
          return c && c.kind === kind ? s : { ...s, categoryId: null };
        }),
      );
    }
  };

  const onPickPayee = (p: Payee) => {
    // Splits carry their own categories — never override them from a payee.
    if (splits.length > 0) return;
    if (categoryId && !categoryWasAutoFilled.current) return; // user's choice wins
    const c = p.defaultCategoryId ? catsById.get(p.defaultCategoryId) : undefined;
    const next = c && c.kind === splitKind && !c.archived ? p.defaultCategoryId : null;
    if (next === categoryId) return;
    setCategoryId(next);
    categoryWasAutoFilled.current = next !== null;
  };

  const addSplit = () => {
    setSplits((prev) => [
      ...prev,
      {
        key: nextKey.current++,
        categoryId: null,
        amountMinor: remainder !== null && remainder > 0 ? remainder : null,
        notes: '',
      },
    ]);
  };

  const patchSplit = (key: number, patch: Partial<SplitDraft>) =>
    setSplits((prev) => prev.map((s) => (s.key === key ? { ...s, ...patch } : s)));

  const handleSave = async () => {
    setSaving(true);
    try {
      const status: TxStatus = pending ? 'pending' : 'cleared';
      if (mode === 'transfer') {
        await saveTransfer(
          transferDraftToInput(accounts, transfer, date, notes, status, groupId ?? undefined),
        );
        toast('Transfer saved', 'success');
      } else {
        if (amount === null) throw new Error('Enter an amount');
        await saveTransaction({
          id: tx?.id,
          accountId,
          date,
          amountMinor: sign * Math.abs(amount),
          payeeName: payeeName || null,
          categoryId: splits.length > 0 ? null : categoryId,
          tagNames,
          notes,
          status,
          splits: splits.map((s) => ({
            categoryId: s.categoryId,
            amountMinor: sign * Math.abs(s.amountMinor ?? 0),
            ...(s.notes ? { notes: s.notes } : {}),
          })),
        });
        toast('Transaction saved', 'success');
      }
      onClose();
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async () => {
    if (!tx) return;
    try {
      await deleteTransaction(tx.id);
      toast(
        isTransferEdit ? 'Transfer deleted — both legs removed' : 'Transaction deleted',
        'success',
      );
      setConfirmDelete(false);
      onClose();
    } catch (e) {
      toast(errMsg(e), 'error');
    }
  };

  // ------------------------------------------------------------- render
  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        wide
        title={tx ? (isTransferEdit ? 'Edit transfer' : 'Edit transaction') : 'Add transaction'}
        footer={
          <>
            {tx && (
              <Button
                variant="danger"
                className="mr-auto"
                onClick={() => setConfirmDelete(true)}
              >
                <IconTrash size={16} />
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saveDisabled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          {accounts.length === 0 && (
            <p className="rounded-lg border border-warn px-3 py-2 text-sm text-warn">
              Create an account first — transactions need an account to live in.
            </p>
          )}
          {typeOptions.length > 0 && (
            <Segmented<TxKind>
              label="Transaction type"
              className="self-start"
              options={typeOptions}
              value={mode}
              onChange={switchMode}
            />
          )}

          {mode === 'transfer' ? (
            <TransferFields accounts={selectableAccounts} draft={transfer} onChange={setTransfer} />
          ) : (
            <>
              <Field label={`Amount (${currency})`}>
                {(id) => (
                  <MoneyInput
                    id={id}
                    valueMinor={amount}
                    currency={currency}
                    onValue={setAmount}
                  />
                )}
              </Field>
              {mode === 'expense' && (
                <div className="flex flex-col gap-1">
                  <Checkbox label="This is a refund" checked={refund} onChange={setRefund} />
                  {refund && (
                    <p className="text-xs text-muted">
                      Saved as money coming back into the expense category, so spending
                      reports show your net spend.
                    </p>
                  )}
                </div>
              )}
              {splits.length === 0 ? (
                <Field label="Category">
                  {(id) => (
                    <CategoryPicker
                      id={id}
                      kind={splitKind}
                      value={categoryId}
                      onChange={(id) => {
                        setCategoryId(id);
                        categoryWasAutoFilled.current = false;
                      }}
                    />
                  )}
                </Field>
              ) : (
                <p className="text-xs text-muted">
                  This transaction is split — its categories come from the splits below.
                </p>
              )}
              <Field label="Payee">
                {(id) => (
                  <PayeeInput
                    id={id}
                    value={payeeName}
                    onChange={setPayeeName}
                    onPick={onPickPayee}
                  />
                )}
              </Field>
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="Account">
                  {(id) => (
                    <Select
                      id={id}
                      value={accountId}
                      onChange={(e) => setAccountId(e.target.value)}
                    >
                      <option value="" disabled>
                        Choose account
                      </option>
                      {selectableAccounts.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name} ({a.currency}){a.archived ? ' — archived' : ''}
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
              <Field label="Tags">
                {(id) => <TagsInput id={id} value={tagNames} onChange={setTagNames} />}
              </Field>

              {/* Splits */}
              {splits.length === 0 ? (
                <Button variant="ghost" size="sm" className="self-start" onClick={addSplit}>
                  <IconPlus size={14} />
                  Split across categories…
                </Button>
              ) : (
                <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
                  <div className="flex items-center justify-between">
                    <h3 className="text-sm font-medium text-text">Splits</h3>
                    <Button size="sm" variant="ghost" onClick={addSplit}>
                      <IconPlus size={14} />
                      Add split
                    </Button>
                  </div>
                  {splits.map((s, i) => (
                    <div key={s.key} className="flex flex-wrap items-center gap-2">
                      <div className="min-w-40 flex-1 basis-40">
                        <label className="sr-only" htmlFor={`split-cat-${s.key}`}>
                          Split {i + 1} category
                        </label>
                        <CategoryPicker
                          id={`split-cat-${s.key}`}
                          kind={splitKind}
                          value={s.categoryId}
                          onChange={(cid) => patchSplit(s.key, { categoryId: cid })}
                        />
                      </div>
                      <div className="w-28 shrink-0">
                        <MoneyInput
                          aria-label={`Split ${i + 1} amount`}
                          valueMinor={s.amountMinor}
                          currency={currency}
                          onValue={(v) => patchSplit(s.key, { amountMinor: v })}
                        />
                      </div>
                      <div className="min-w-32 flex-1 basis-32">
                        <Input
                          aria-label={`Split ${i + 1} note`}
                          placeholder="Note (optional)"
                          value={s.notes}
                          onChange={(e) => patchSplit(s.key, { notes: e.target.value })}
                        />
                      </div>
                      <IconButton
                        label={`Remove split ${i + 1}`}
                        onClick={() => setSplits((prev) => prev.filter((x) => x.key !== s.key))}
                      >
                        <IconX size={16} />
                      </IconButton>
                    </div>
                  ))}
                  {remainder !== null && (
                    <div className="flex flex-wrap items-center gap-2 text-xs">
                      <span className={remainder === 0 ? 'text-pos' : 'text-warn'}>
                        {remainder === 0
                          ? 'Splits match the transaction amount.'
                          : `Remaining to assign: ${formatMinor(remainder, currency)}`}
                      </span>
                      {remainder > 0 && (
                        <Button size="sm" variant="ghost" onClick={addSplit}>
                          Assign remainder to new split
                        </Button>
                      )}
                    </div>
                  )}
                  {splitIssue && (
                    <p role="alert" className="text-xs text-danger">
                      {splitIssue}
                    </p>
                  )}
                </div>
              )}
            </>
          )}

          {mode === 'transfer' && (
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
          )}
          <Field label="Notes">
            {(id) => (
              <textarea
                id={id}
                rows={2}
                value={notes}
                onChange={(e) => setNotes(e.target.value)}
                className="w-full rounded-lg border border-border bg-surface px-3 py-2 text-sm text-text placeholder:text-faint"
              />
            )}
          </Field>
          <Checkbox label="Pending (not yet cleared)" checked={pending} onChange={setPending} />
        </div>
      </Modal>

      <ConfirmDialog
        open={confirmDelete}
        title={isTransferEdit ? 'Delete transfer' : 'Delete transaction'}
        danger
        confirmLabel="Delete"
        message={
          isTransferEdit
            ? 'This removes BOTH legs of the transfer — one from each account. This cannot be undone.'
            : 'This transaction will be permanently deleted. This cannot be undone.'
        }
        onCancel={() => setConfirmDelete(false)}
        onConfirm={handleDelete}
      />
    </>
  );
}
