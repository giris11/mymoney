// Imports (SPEC §7): launch the import wizard, list past imports with one-unit
// undo, and the clearly-labelled sample-data block (D19: one-tap removal).
import { lazy, Suspense, useState } from 'react';
import { useLive } from '../../db/useLive';
import { listImportBatches, undoImport } from '../../import/importer';
import { loadSampleData, removeSampleData, sampleDataBatchId } from '../../domain/sample';
import type { ImportBatch } from '../../db/types';
import { formatDate } from '../../lib/util';
import { Button, Card, ConfirmDialog, EmptyState, Modal } from '../kit/kit';
import { IconUndo, IconUpload } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, SettingsPage } from './shared';

// Lazy: the wizard (and its CSV parser) loads only when actually importing.
const ImportWizard = lazy(() => import('../import/ImportWizard'));

const SOURCE_LABELS: Record<ImportBatch['source'], string> = {
  moneywiz: 'MoneyWiz CSV',
  csv: 'CSV',
  sample: 'Sample data',
};

export default function ImportsSection() {
  const { toast } = useToast();
  const batches = useLive(() => listImportBatches(), []);
  const sampleBatch = useLive(() => sampleDataBatchId(), []);
  const [wizardOpen, setWizardOpen] = useState(false);
  // The wizard holds an unwritten import once a file is loaded; a backdrop
  // click must not silently throw that away (half-decided near-duplicates and
  // all). The wizard tells us when it has work worth protecting.
  const [wizardDirty, setWizardDirty] = useState(false);
  const [discardOpen, setDiscardOpen] = useState(false);
  const [undoTarget, setUndoTarget] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);

  const closeWizard = () => {
    setDiscardOpen(false);
    setWizardDirty(false);
    setWizardOpen(false);
  };
  const requestCloseWizard = () => {
    // Escape reaches both dialogs at once; while confirming, the wizard's own
    // dismissal is a no-op so the confirmation isn't immediately re-triggered.
    if (discardOpen) return;
    if (wizardDirty) setDiscardOpen(true);
    else closeWizard();
  };

  // The sample batch has its own block below — keep it out of the history list.
  const history = (batches ?? []).filter((b) => b.source !== 'sample');

  const doUndo = async (batch: ImportBatch) => {
    setUndoTarget(null);
    setBusy(true);
    try {
      await undoImport(batch.id);
      toast(`Import of “${batch.fileName}” undone`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const loadSample = async () => {
    setBusy(true);
    try {
      await loadSampleData();
      toast('Sample data loaded', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  const removeSample = async () => {
    setBusy(true);
    try {
      await removeSampleData();
      toast('Sample data removed', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <SettingsPage
      title="Imports"
      description="Every import is previewed before anything is written, deduplicated against existing data, and undoable as one unit."
      actions={
        <Button size="sm" variant="primary" onClick={() => setWizardOpen(true)}>
          <IconUpload size={16} /> Import from file…
        </Button>
      }
    >
      <Card className="p-0">
        <h2 className="border-b border-border px-4 py-2.5 text-xs font-semibold uppercase tracking-wide text-faint">
          Import history
        </h2>
        {batches && history.length === 0 ? (
          <EmptyState
            icon={<IconUpload size={32} />}
            title="No imports yet"
            message="Import a MoneyWiz export or any CSV — you’ll get a full preview first."
            action={
              <Button variant="primary" onClick={() => setWizardOpen(true)}>
                Import from file…
              </Button>
            }
          />
        ) : (
          <ul>
            {history.map((b) => (
              <li
                key={b.id}
                className="flex flex-wrap items-center gap-x-3 gap-y-1 border-b border-border px-4 py-2.5 last:border-0"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate text-sm font-medium text-text">{b.fileName}</div>
                  <div className="text-xs text-muted">
                    {SOURCE_LABELS[b.source]} · {b.rowCount} row{b.rowCount === 1 ? '' : 's'} ·
                    imported {formatDate(b.importedAt)}
                  </div>
                </div>
                <Button size="sm" disabled={busy} onClick={() => setUndoTarget(b)}>
                  <IconUndo size={15} /> Undo import
                </Button>
              </li>
            ))}
          </ul>
        )}
      </Card>

      <Card>
        <h2 className="text-sm font-semibold text-text">Sample data</h2>
        <p className="mt-1 text-sm text-muted">
          Demo accounts, transactions and budgets for exploring the app — clearly separate from your
          own data, and removed in one tap without touching anything else.
        </p>
        <div className="mt-3">
          {sampleBatch === undefined ? null : sampleBatch === null ? (
            <Button disabled={busy} onClick={() => void loadSample()}>
              Load sample data
            </Button>
          ) : (
            <Button disabled={busy} onClick={() => void removeSample()}>
              Remove sample data
            </Button>
          )}
        </div>
      </Card>

      <Modal open={wizardOpen} onClose={requestCloseWizard} title="Import transactions" wide>
        <Suspense
          fallback={<p className="py-10 text-center text-sm text-muted">Loading importer…</p>}
        >
          {wizardOpen && (
            <ImportWizard
              onDone={() => {
                closeWizard();
                toast('Import complete', 'success');
              }}
              onCancel={closeWizard}
              onDirtyChange={setWizardDirty}
            />
          )}
        </Suspense>
      </Modal>

      <ConfirmDialog
        open={discardOpen}
        title="Discard this import?"
        danger
        confirmLabel="Discard import"
        message="Nothing has been saved yet — closing now discards the file you loaded and every decision you have made about it."
        onConfirm={closeWizard}
        onCancel={() => setDiscardOpen(false)}
      />

      <ConfirmDialog
        open={undoTarget !== null}
        title="Undo import"
        danger
        confirmLabel="Undo import"
        message={
          <>
            Remove the {undoTarget?.rowCount} transaction{undoTarget?.rowCount === 1 ? '' : 's'}{' '}
            imported from <strong>{undoTarget?.fileName}</strong>? Accounts, categories, payees and
            tags created by this import are also removed if nothing else uses them.
          </>
        }
        onConfirm={() => undoTarget && void doUndo(undoTarget)}
        onCancel={() => setUndoTarget(null)}
      />
    </SettingsPage>
  );
}
