// Create/edit budget modal. All writes go through saveBudget/deleteBudget;
// validation errors surface as toasts. Amounts are in the BASE currency (D22).
import { useEffect, useState } from 'react';
import dayjs from 'dayjs';
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import type { Budget, BudgetPeriod } from '../../db/types';
import { deleteBudget, saveBudget } from '../../domain/budgets';
import {
  Button,
  Checkbox,
  ConfirmDialog,
  Field,
  Input,
  Modal,
  MoneyInput,
  Segmented,
} from '../kit/kit';
import { CategoryMultiSelect } from '../kit/CategoryPicker';
import { useToast } from '../kit/toast';

const PERIOD_OPTIONS: { value: BudgetPeriod; label: string }[] = [
  { value: 'weekly', label: 'Weekly' },
  { value: 'monthly', label: 'Monthly' },
  { value: 'yearly', label: 'Yearly' },
];

export default function BudgetEditor({
  open,
  budget,
  onClose,
  onDeleted,
}: {
  open: boolean;
  budget: Budget | null; // null → create
  onClose: () => void;
  /** Called after a successful delete (e.g. to leave the detail view). */
  onDeleted?: () => void;
}) {
  const { toast } = useToast();
  const settings = useLive(() => getSettings(), []);
  const base = settings?.baseCurrency ?? 'GBP';

  const [name, setName] = useState('');
  const [amountMinor, setAmountMinor] = useState<number | null>(null);
  const [period, setPeriod] = useState<BudgetPeriod>('monthly');
  const [startDate, setStartDate] = useState('');
  const [categoryIds, setCategoryIds] = useState<string[]>([]);
  const [archived, setArchived] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [saving, setSaving] = useState(false);

  // Seed the form each time the modal opens (create defaults or the budget).
  useEffect(() => {
    if (!open) return;
    setName(budget?.name ?? '');
    setAmountMinor(budget?.amountMinor ?? null);
    setPeriod(budget?.period ?? 'monthly');
    setStartDate(budget?.startDate ?? dayjs().startOf('month').format('YYYY-MM-DD'));
    setCategoryIds(budget?.categoryIds ?? []);
    setArchived(budget?.archived ?? false);
    setConfirmDelete(false);
  }, [open, budget]);

  const save = async () => {
    setSaving(true);
    try {
      await saveBudget({
        id: budget?.id,
        name,
        categoryIds,
        amountMinor: amountMinor ?? 0, // 0 → domain's "must be positive" error
        period,
        startDate,
        archived,
      });
      toast('Budget saved', 'success');
      onClose();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not save budget', 'error');
    } finally {
      setSaving(false);
    }
  };

  const doDelete = async () => {
    if (!budget) return;
    try {
      await deleteBudget(budget.id);
      toast('Budget deleted', 'success');
      setConfirmDelete(false);
      onClose();
      onDeleted?.();
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete budget', 'error');
    }
  };

  return (
    <>
      <Modal
        open={open}
        onClose={onClose}
        title={budget ? 'Edit budget' : 'New budget'}
        footer={
          <>
            {budget && (
              <Button variant="danger" className="mr-auto" onClick={() => setConfirmDelete(true)}>
                Delete
              </Button>
            )}
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={saving} onClick={save}>
              Save
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-4">
          <Field label="Name">
            {(id) => (
              <Input
                id={id}
                value={name}
                placeholder="e.g. Groceries"
                onChange={(e) => setName(e.target.value)}
              />
            )}
          </Field>
          <Field
            label={`Amount (${base})`}
            hint="Budgets are set in your base currency; spending in other currencies is converted at your saved rates."
          >
            {(id) => (
              <MoneyInput id={id} valueMinor={amountMinor} currency={base} onValue={setAmountMinor} />
            )}
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text">Period</span>
            <Segmented
              label="Budget period"
              options={PERIOD_OPTIONS}
              value={period}
              onChange={setPeriod}
              className="self-start"
            />
          </div>
          <Field
            label="Start date"
            hint="Periods are counted from this date — e.g. a monthly budget starting on the 15th runs 15th to 14th."
          >
            {(id) => (
              <Input
                id={id}
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
              />
            )}
          </Field>
          <div className="flex flex-col gap-1">
            <span className="text-sm font-medium text-text">Categories</span>
            <CategoryMultiSelect kind="expense" value={categoryIds} onChange={setCategoryIds} />
            <p className="text-xs text-muted">Ticking a category includes all its subcategories.</p>
          </div>
          {budget && (
            <Checkbox
              label="Archived — hidden from the Budgets list"
              checked={archived}
              onChange={setArchived}
            />
          )}
        </div>
      </Modal>
      <ConfirmDialog
        open={confirmDelete}
        title="Delete budget"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <strong>{budget?.name}</strong>? Its transactions are not affected.
          </>
        }
        onConfirm={doDelete}
        onCancel={() => setConfirmDelete(false)}
      />
    </>
  );
}
