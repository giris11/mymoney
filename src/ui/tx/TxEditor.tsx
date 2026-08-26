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
import { formatDate, todayISO } from '../../lib/util';
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
import { errMsg, isSaveableAmount, txSaveDisabled, type TxKind } from './txShared';
import {
  TransferFields,
  emptyTransferDraft,
  transferDraftToInput,
  type TransferDraft,
} from './TransferFields';
import {
  draftSign,
  draftToSaveInput,
  type SplitDraft,
  type TxDraft,
  type TxSaveDraft,
} from './duplicate';
import { IconCopy } from './IconCopy';

export default function TxEditor({
  open,
  onClose,
  tx,
  draft = null,
  onDuplicate,
}: {
  open: boolean;
  onClose: () => void;
  /** null = create new. A transfer leg loads the whole pair. */
  tx: Transaction | null;
  /**
   * Prefilled form for a NEW transaction (a duplicate). Only read when `tx` is
   * null — it is a starting point for a create, never an edit of anything.
   */
  draft?: TxDraft | null;
  /** Duplicate the transaction being edited (the page reopens this editor). */
  onDuplicate?: (tx: Transaction) => void;
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
  const sign = draftSign(mode, refund);
  const splitKind = mode === 'income' ? 'income' : 'expense';

  // Prefilled create = a duplicate. It is titled and annotated as one so a copy
  // can never be mistaken for the original being edited.
  const isCopy = !tx && !!draft;
  /** The original's date, when this copy is not dated the same day. */
  const copySourceDate = isCopy ? (draft?.sourceDate ?? null) : null;

  /** The form's fields as a plain draft — the shape a copy arrives in, and the
   *  single mapping both the edit path and the copy path save through. */
  const formDraft = (): TxSaveDraft => ({
    mode,
    amountMinor: amount,
    refund,
    categoryId,
    payeeName,
    accountId,
    date,
    tagNames,
    notes,
    pending,
    splits,
  });

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
        if (cancelled) return;
        // A duplicate: the form starts filled in, but it is still a CREATE —
        // no id, no groupId, no importBatchId, so Save can only insert.
        if (draft) {
          reset();
          setMode(draft.mode);
          setAmount(draft.amountMinor);
          setRefund(draft.refund);
          setCategoryId(draft.categoryId);
          // The copied category came from the user's own earlier transaction,
          // so it outranks any payee default (D17) — a later payee pick must
          // not quietly replace it.
          categoryWasAutoFilled.current = false;
          setPayeeName(draft.payeeName);
          setAccountId(draft.accountId);
          setDate(draft.date);
          setTagNames(draft.tagNames);
          setNotes(draft.notes);
          setPending(draft.pending);
          setSplits(draft.splits);
          nextKey.current = draft.splits.length;
          setTransfer(draft.transfer ?? emptyTransferDraft(allAccounts, draft.accountId));
          return;
        }
        const preferred =
          (s.lastUsedAccountId && usable.find((a) => a.id === s.lastUsedAccountId)?.id) ||
          usable[0]?.id ||
          '';
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
  }, [open, tx?.id, draft]);

  // Duplicating from the footer swaps the dialog's contents underneath the
  // button that was just clicked, which would drop focus onto <body>. Modal
  // only moves focus when it opens, so the copy re-runs the same step.
  const bodyRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open || !draft) return;
    const t = window.setTimeout(() => {
      bodyRef.current?.querySelector<HTMLElement>('input, select, textarea, button')?.focus();
    }, 0);
    return () => window.clearTimeout(t);
  }, [open, draft]);

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
      currency,
    );
  }, [mode, splits, amount, sign, currency]);

  const fromAcc = accounts.find((a) => a.id === transfer.fromAccountId);
  const toAcc = accounts.find((a) => a.id === transfer.toAccountId);
  const transferCross = !!fromAcc && !!toAcc && fromAcc.currency !== toAcc.currency;

  const saveDisabled = txSaveDisabled({
    mode,
    saving,
    amountMinor: amount,
    accountId,
    splitCount: splits.length,
    splitIssue,
    transfer: {
      hasFromAccount: !!fromAcc,
      hasToAccount: !!toAcc,
      amountFromMinor: transfer.amountFromMinor,
      amountToMinor: transfer.amountToMinor,
      crossCurrency: transferCross,
    },
  });

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
        // `groupId` is null for a copy, so saveTransfer mints a NEW pair
        // instead of rewriting the transfer that was copied.
        await saveTransfer(
          transferDraftToInput(accounts, transfer, date, notes, status, groupId ?? undefined),
        );
        toast(isCopy ? 'Copy saved as a new transfer' : 'Transfer saved', 'success');
      } else {
        // Belt and braces with the disabled Save button above (D4): the
        // editor and Quick Add agree that a zero-amount row is not a
        // transaction. (draftToSaveInput enforces the same rule.)
        if (!isSaveableAmount(amount)) throw new Error('Enter an amount');
        // `tx?.id` is the only thing that turns this into an update, and a
        // copy has no `tx` — so a copy can only ever insert a new row and can
        // never touch the transaction it was made from.
        await saveTransaction(draftToSaveInput(formDraft(), tx?.id));
        toast(isCopy ? 'Copy saved as a new transaction' : 'Transaction saved', 'success');
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
  const dialogTitle = tx
    ? isTransferEdit
      ? 'Edit transfer'
      : 'Edit transaction'
    : isCopy
      ? mode === 'transfer'
        ? 'New transfer (copy)'
        : 'New transaction (copy)'
      : 'Add transaction';

  // A copy is dated TODAY (see TxDraft.sourceDate for why). That trade is only
  // safe if the change announces itself, so whenever the copy's date differs
  // from the original's, the original date is named right next to the date
  // field — with one click to adopt it.
  const copyDateNote = copySourceDate !== null && copySourceDate !== date && (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-warn px-3 py-2 text-xs text-warn">
      <span>
        The {mode === 'transfer' ? 'transfer' : 'transaction'} you copied is dated{' '}
        {formatDate(copySourceDate)}; this copy is dated {formatDate(date)}.
      </span>
      <Button size="sm" variant="ghost" onClick={() => setDate(copySourceDate)}>
        Use {formatDate(copySourceDate)}
      </Button>
    </div>
  );

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        wide
        title={dialogTitle}
        footer={
          <>
            {tx && (
              <div className="mr-auto flex items-center gap-2">
                <Button variant="danger" onClick={() => setConfirmDelete(true)}>
                  <IconTrash size={16} />
                  Delete
                </Button>
                {onDuplicate && (
                  <Button onClick={() => onDuplicate(tx)}>
                    <IconCopy size={16} />
                    Duplicate
                  </Button>
                )}
              </div>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saveDisabled} onClick={handleSave}>
              {saving ? 'Saving…' : 'Save'}
            </Button>
          </>
        }
      >
        <div ref={bodyRef} className="flex flex-col gap-4">
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
              {copyDateNote}
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
            <>
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
              {copyDateNote}
            </>
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
