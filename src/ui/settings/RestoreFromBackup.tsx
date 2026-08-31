// The restore flow, shared by Settings → Backup and by Onboarding.
//
// It lives on its own because restore has to be reachable from BOTH places:
// backups are how data moves between devices until Phase 3's optional Dropbox
// sync (SPEC §13), and "Erase all data" drops the app back into onboarding —
// so a fresh install with a backup file in hand must not be forced to invent
// accounts just to reach Settings.
//
// Nothing is written until the typed confirmation (D21): the file is parsed and
// fully validated first, the user sees exactly what it contains, and the
// restore itself is one all-or-nothing transaction.
import { useRef, useState } from 'react';
import { ALL_TABLES } from '../../db/db';
import { bookManifest, restoreBackup, validateBackup, type BackupFile } from '../../backup/backup';
import {
  isCheckableManifest,
  summariseManifest,
  type BackupManifest,
} from '../../backup/manifest';
import { formatDate } from '../../lib/util';
import { Button, ConfirmDialog } from '../kit/kit';
import { IconUpload } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage } from './shared';

/**
 * What this file can promise about itself, said BEFORE anything is written.
 *
 * A pure function, and tested as one (tests/backup.test.ts): the rendering is
 * JSX this project has no DOM environment for, but the sentence is the part
 * that can mislead someone about their own money.
 *
 * The two answers are deliberately different in kind. A file with a manifest
 * makes a checkable promise — and the restore will refuse itself if the promise
 * fails. A file without one is not suspect, it is simply older: it restores
 * exactly as it always did, and the app says so instead of implying a check it
 * cannot perform.
 */
export function selfCheckNote(manifest: unknown): string {
  if (!isCheckableManifest(manifest)) {
    return 'This backup was written before backups checked themselves, so it carries no figures to check against. It will restore exactly as it always has — with no self-check.';
  }
  return `This backup states what it contains: ${summariseManifest(manifest)}. Every one of those figures is recomputed from the restored data, and the restore is refused if any of them disagrees.`;
}

/** The same distinction after the fact, about the data now in the app. */
export function restoredNote(verified: boolean): string {
  return verified
    ? 'The backup’s own figures were recomputed from the restored data and every one of them agreed.'
    : 'This backup carried no figures to check, so nothing was verified — the figures above were recomputed from the data now in the app.';
}

/** What a finished restore hands back to whoever asked for it. */
export interface RestoreResult {
  /**
   * Recomputed from the database AFTER the restore committed — null only if
   * that recomputation itself failed, which says nothing about the restore.
   */
  manifest: BackupManifest | null;
  /** Did the file's own figures get checked, and agree? */
  verified: boolean;
}

export function RestoreFromBackup({
  onDone,
  onCancel,
  /** Onboarding renders its own heading and needs a way back. */
  standalone = false,
}: {
  /**
   * The restore finished — take over the screen. Called with what actually
   * landed, so a caller that stays mounted (Settings) can show the figures;
   * a caller that is about to be replaced by the app itself (Onboarding, the
   * moment the restored `onboarded` flag lands) can ignore them.
   *
   * Called IMMEDIATELY after the restore, exactly as it always was. Holding it
   * back until the user dismissed something would have stranded onboarding's
   * completeRestore() — and with it the persistent-storage request (SPEC §9) —
   * behind a dialog that React had already unmounted.
   */
  onDone: (result: RestoreResult) => void;
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
      const report = await restoreBackup(pending);
      setPending(null);
      // Read back out of the committed database, NOT taken from the restore's
      // own return value: an independent second opinion is worth more than the
      // word of the code that did the writing, and it costs one scan.
      //
      // In its own try, because by this line THE BOOK IS ALREADY REPLACED. A
      // failure to DESCRIBE what landed must never be reported as a failure to
      // restore it — that lie would send the owner hunting for data that is
      // sitting right there, or restoring a second time to get it back.
      let manifest: BackupManifest | null = null;
      try {
        manifest = await bookManifest();
      } catch {
        manifest = null;
      }
      toast(
        manifest ? `Backup restored — ${summariseManifest(manifest)}` : 'Backup restored',
        'success',
      );
      onDone({ manifest, verified: report.verified });
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
              {/* Said BEFORE the typed confirmation: whether this file can be
                  held to what it claims is part of deciding to restore it. */}
              <p className="text-muted">{selfCheckNote(pending.manifest)}</p>
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
