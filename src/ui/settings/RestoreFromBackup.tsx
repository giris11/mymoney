// The restore flow, shared by Settings → Backup and by Onboarding.
//
// It lives on its own because restore has to be reachable from BOTH places:
// backups are how data moves between devices until Phase 3's optional Drive
// sync (SPEC §13), and "Erase all data" drops the app back into onboarding —
// so a fresh install with a backup file in hand must not be forced to invent
// accounts just to reach Settings.
//
// Nothing is written until the typed confirmation (D21): the file is parsed and
// fully validated first, the user sees exactly what it contains, and the
// restore itself is one all-or-nothing transaction.
import { useRef, useState } from 'react';
import { ALL_TABLES } from '../../db/db';
import { restoreBackup, validateBackup, type BackupFile } from '../../backup/backup';
import { formatDate } from '../../lib/util';
import { Button, ConfirmDialog } from '../kit/kit';
import { IconUpload } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage } from './shared';

export function RestoreFromBackup({
  onDone,
  onCancel,
  /** Onboarding renders its own heading and needs a way back. */
  standalone = false,
}: {
  onDone: () => void;
  onCancel?: () => void;
  standalone?: boolean;
}) {
  const { toast } = useToast();
  const fileRef = useRef<HTMLInputElement>(null);
  const [pending, setPending] = useState<BackupFile | null>(null);
  const [busy, setBusy] = useState(false);

  const onFilePicked = async (file: File | undefined) => {
    if (!file) return;
    let parsed: unknown;
    try {
      parsed = JSON.parse(await file.text());
    } catch {
      toast('That file is not valid JSON — is it really a MyMoney backup?', 'error');
      return;
    }
    const validated = validateBackup(parsed);
    if (!validated.ok) {
      toast(validated.error, 'error');
      return;
    }
    setPending(validated.file);
  };

  const doRestore = async () => {
    if (!pending) return;
    setBusy(true);
    try {
      await restoreBackup(pending);
      setPending(null);
      toast('Backup restored', 'success');
      onDone();
    } catch (e) {
      setPending(null);
      toast(errorMessage(e), 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      {standalone && (
        <div className="flex flex-col gap-1">
          <h1 className="text-xl font-bold text-text">Restore from a backup</h1>
          <p className="text-sm text-muted">
            Choose the backup file you exported from MyMoney. You&rsquo;ll see what it contains
            before anything is written, and it replaces everything on this device.
          </p>
        </div>
      )}
      <div className={standalone ? 'mt-5 flex flex-wrap gap-2' : 'contents'}>
        <Button
          variant={standalone ? 'primary' : 'secondary'}
          disabled={busy}
          onClick={() => fileRef.current?.click()}
        >
          <IconUpload size={16} /> {standalone ? 'Choose backup file…' : 'Restore from file…'}
        </Button>
        {standalone && onCancel && (
          <Button disabled={busy} onClick={onCancel}>
            Back
          </Button>
        )}
        <input
          ref={fileRef}
          type="file"
          accept="application/json,.json"
          aria-label="Choose a backup file to restore"
          className="sr-only"
          onChange={(e) => {
            const f = e.target.files?.[0];
            e.target.value = ''; // let the same file be picked twice
            void onFilePicked(f);
          }}
        />
      </div>

      <ConfirmDialog
        open={pending !== null}
        title="Restore backup"
        danger
        confirmLabel="Restore"
        requireText="RESTORE"
        message={
          pending && (
            <div className="flex flex-col gap-2">
              <p>
                This replaces <strong>everything</strong> currently in the app with the
                backup&rsquo;s contents.
              </p>
              <p className="text-muted">Backup exported: {formatDate(pending.exportedAt)}</p>
              <div className="grid grid-cols-2 gap-x-6 gap-y-0.5 rounded-lg bg-surface2 p-3 text-xs">
                {ALL_TABLES.map((name) => (
                  <div key={name} className="flex justify-between gap-2">
                    <span className="text-muted">{name}</span>
                    <span className="tnum">{(pending.tables[name] ?? []).length}</span>
                  </div>
                ))}
              </div>
            </div>
          )
        }
        onConfirm={() => void doRestore()}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
