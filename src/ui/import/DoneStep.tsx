// Step 4 — success summary with 'View transactions', 'Undo this import'
// (ConfirmDialog → undoImport) and 'Done'.
import { useState } from 'react';
import type { ImportBatch } from '../../db/types';
import { undoImport } from '../../import/importer';
import type { ImportPlan } from '../../import/types';
import { navigate } from '../router';
import { IconCheck } from '../kit/icons';
import { Button, ConfirmDialog } from '../kit/kit';
import { useToast } from '../kit/toast';
import { errMsg, plural } from './bits';

export function DoneStep({
  plan,
  batch,
  onDone,
}: {
  plan: ImportPlan;
  batch: ImportBatch;
  onDone: () => void;
}) {
  const { toast } = useToast();
  const [confirmUndo, setConfirmUndo] = useState(false);
  const [undoing, setUndoing] = useState(false);

  const skippedNear = plan.rows.filter(
    (r) => r.action === 'needs_decision' && r.decision !== 'import',
  ).length;
  const skippedDuplicates = plan.exactDuplicateCount + skippedNear;

  const created: string[] = [];
  if (batch.createdAccountIds.length > 0)
    created.push(plural(batch.createdAccountIds.length, 'account'));
  if (batch.createdCategoryIds.length > 0)
    created.push(plural(batch.createdCategoryIds.length, 'category', 'categories'));
  if (batch.createdPayeeIds.length > 0)
    created.push(plural(batch.createdPayeeIds.length, 'payee'));
  if (batch.createdTagIds.length > 0) created.push(plural(batch.createdTagIds.length, 'tag'));

  return (
    <div className="flex flex-col items-center gap-4 py-6 text-center">
      <div
        aria-hidden="true"
        className="flex h-12 w-12 items-center justify-center rounded-full bg-surface2 text-pos"
      >
        <IconCheck size={26} />
      </div>
      <div>
        <h3 className="text-lg font-semibold text-text">
          Imported {plural(batch.rowCount, 'transaction')}
        </h3>
        <p className="mx-auto mt-1 max-w-sm text-sm text-muted">
          {skippedDuplicates > 0 && `${plural(skippedDuplicates, 'duplicate')} skipped. `}
          {created.length > 0
            ? `Created ${created.join(', ')}.`
            : 'No new accounts, categories, payees or tags were needed.'}
        </p>
      </div>
      <div className="flex flex-wrap justify-center gap-2">
        <Button
          variant="primary"
          onClick={() => {
            navigate('/transactions');
            onDone();
          }}
        >
          View transactions
        </Button>
        <Button disabled={undoing} onClick={() => setConfirmUndo(true)}>
          {undoing ? 'Undoing…' : 'Undo this import'}
        </Button>
        <Button variant="ghost" onClick={onDone}>
          Done
        </Button>
      </div>

      <ConfirmDialog
        open={confirmUndo}
        title="Undo this import?"
        danger
        confirmLabel="Undo import"
        message={`This removes the ${plural(batch.rowCount, 'imported transaction')} from “${batch.fileName}”, along with any accounts, categories, payees or tags that were created just for them.`}
        onCancel={() => setConfirmUndo(false)}
        onConfirm={async () => {
          setConfirmUndo(false);
          setUndoing(true);
          try {
            await undoImport(batch.id);
            toast('Import undone', 'success');
            onDone();
          } catch (e) {
            toast(errMsg(e), 'error');
            setUndoing(false);
          }
        }}
      />
    </div>
  );
}
