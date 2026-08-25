// Budgets page (SPEC §8.1.6): card list with progress → detail view via
// /budgets?id=<id> deep link. All maths comes from src/domain/budgets.ts.
import { useState } from 'react';
import { db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { allBudgetProgress, deleteBudget, saveBudget } from '../../domain/budgets';
import type { Budget } from '../../db/types';
import { useRoute } from '../router';
import { Button, Card, ConfirmDialog, EmptyState, IconButton } from '../kit/kit';
import { IconCoins, IconPlus, IconTrash } from '../kit/icons';
import { useToast } from '../kit/toast';
import { BudgetCard } from '../budgets/BudgetCard';
import BudgetDetail from '../budgets/BudgetDetail';
import BudgetEditor from '../budgets/BudgetEditor';

export default function Budgets() {
  const route = useRoute();
  const id = route.params.get('id');
  if (id) return <BudgetDetail key={id} id={id} />;
  return <BudgetList />;
}

function BudgetList() {
  const { toast } = useToast();
  const [creating, setCreating] = useState(false);
  const [deleting, setDeleting] = useState<Budget | null>(null);

  const progress = useLive(() => allBudgetProgress(), []);
  const settings = useLive(() => getSettings(), []);
  const archived = useLive(
    async () =>
      (await db.budgets.filter((b) => b.archived).toArray()).sort((a, b) =>
        a.name.localeCompare(b.name),
      ),
    [],
  );
  const base = settings?.baseCurrency ?? 'GBP';

  const unarchive = async (b: Budget) => {
    try {
      await saveBudget({
        id: b.id,
        name: b.name,
        categoryIds: b.categoryIds,
        amountMinor: b.amountMinor,
        period: b.period,
        startDate: b.startDate,
        archived: false,
      });
      toast('Budget restored', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not restore budget', 'error');
    }
  };

  const doDelete = async () => {
    if (!deleting) return;
    try {
      await deleteBudget(deleting.id);
      toast('Budget deleted', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not delete budget', 'error');
    }
    setDeleting(null);
  };

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">Budgets</h1>
        {progress !== undefined && progress.length > 0 && (
          <Button variant="primary" onClick={() => setCreating(true)}>
            <IconPlus size={16} />
            New budget
          </Button>
        )}
      </div>

      {progress !== undefined &&
        (progress.length === 0 ? (
          <EmptyState
            icon={<IconCoins size={40} />}
            title="No budgets yet"
            message="A budget sets a spending limit for chosen categories each week, month or year, and tracks how you're doing against it."
            action={
              <Button variant="primary" onClick={() => setCreating(true)}>
                <IconPlus size={16} />
                Create your first budget
              </Button>
            }
          />
        ) : (
          <div className="grid gap-3 md:grid-cols-2 2xl:grid-cols-3">
            {progress.map((p) => (
              <BudgetCard key={p.budget.id} progress={p} currency={base} />
            ))}
          </div>
        ))}

      {archived !== undefined && archived.length > 0 && (
        <section className="flex flex-col gap-2">
          <h2 className="text-sm font-semibold text-muted">Archived</h2>
          <Card className="p-0">
            <ul className="divide-y divide-border">
              {archived.map((b) => (
                <li key={b.id} className="flex items-center justify-between gap-3 px-4 py-2">
                  <span className="truncate text-sm text-muted">{b.name}</span>
                  <span className="flex shrink-0 items-center gap-1">
                    <Button size="sm" onClick={() => unarchive(b)}>
                      Unarchive
                    </Button>
                    <IconButton label={`Delete budget ${b.name}`} onClick={() => setDeleting(b)}>
                      <IconTrash size={16} />
                    </IconButton>
                  </span>
                </li>
              ))}
            </ul>
          </Card>
        </section>
      )}

      <BudgetEditor open={creating} budget={null} onClose={() => setCreating(false)} />
      <ConfirmDialog
        open={deleting !== null}
        title="Delete budget"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <strong>{deleting?.name}</strong>? Its transactions are not affected.
          </>
        }
        onConfirm={doDelete}
        onCancel={() => setDeleting(null)}
      />
    </div>
  );
}
