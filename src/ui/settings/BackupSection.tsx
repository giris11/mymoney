// Backup & storage (SPEC §8.1.9, §9 durability): export, validated restore
// with typed confirmation, persistent-storage state/request (result surfaced
// honestly), and the erase-all danger zone.
import { useEffect, useState } from 'react';
import { ALL_TABLES, db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import {
  backupNudgeState,
  clearRecoveryStore,
  deleteRecoveryRecord,
  downloadRecoveryBackup,
  downloadVerifiedBackup,
  listRecoveryRecords,
  markBackupSaved,
  restoreBackup,
  restoreRecoveryBackup,
  validateBackup,
  type RecoveryRecord,
} from '../../backup/backup';
import { summariseManifest } from '../../backup/manifest';
import {
  persistenceState,
  requestPersistence,
  storageEstimate,
  type PersistState,
} from '../../lib/storage';
import { formatDate, todayISO } from '../../lib/util';
import { navigate } from '../router';
import { Button, Card, ConfirmDialog } from '../kit/kit';
import { IconDownload, IconTrash } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, SettingsPage } from './shared';
import { restoredNote, RestoreFromBackup, type RestoreResult } from './RestoreFromBackup';

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

/** What each kept copy IS, in the words of the choice that produced it. */
const RECOVERY_REASON_TEXT: Record<RecoveryRecord['reason'], string> = {
  'conflict-keep-local':
    'The copy that was in Dropbox, kept when you chose this device’s copy instead.',
  'conflict-keep-remote':
    'Everything that was on this device, kept when you chose the copy from Dropbox instead.',
};

const PERSIST_TEXT: Record<PersistState, string> = {
  persisted: 'Protected — the browser has granted persistent storage.',
  'not-persisted':
    'Not protected — the browser may evict this app’s data under storage pressure. Regular backups are your safety net.',
  unsupported: 'This browser does not support the persistent-storage API.',
};

export default function BackupSection() {
  const { toast } = useToast();
  const settings = useLive(() => getSettings(), []);
  const nudge = useLive(() => backupNudgeState(), []);
  const [persist, setPersist] = useState<PersistState | null>(null);
  const [estimate, setEstimate] = useState<{ usage: number; quota: number } | null>(null);
  // Set when the file left the app but nothing can prove it reached storage:
  // 'delivered' = handed to the browser's downloader (no signal at all),
  // 'shared' = the OS share sheet completed (a real signal, but not proof the
  // destination kept it). Only the user can settle either, and until they do
  // we record nothing (D33).
  const [pending, setPending] = useState<'shared' | 'delivered' | null>(null);
  // What the last export actually wrote, in the owner's own terms, plus the
  // fingerprint of its contents. Kept on screen after the toast has gone: the
  // point of a self-verifying backup is that he can read the figures and
  // recognise them, not that the app says "done" (Task 4).
  const [written, setWritten] = useState<{ summary: string; hash: string } | null>(null);
  // …and the same after a restore, recomputed from the database once it had
  // committed. The screen deliberately does NOT bounce to the dashboard any
  // more: being told "restored" and shown a different page is exactly the
  // "take our word for it" this feature exists to end.
  const [restored, setRestored] = useState<RestoreResult | null>(null);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  // Copies of the whole book that a sync conflict replaced. Kept in their own
  // database (see backup.ts), so `useLive` over `db` would never see them.
  const [recovery, setRecovery] = useState<RecoveryRecord[] | null>(null);
  const [restoreRecoveryId, setRestoreRecoveryId] = useState<string | null>(null);

  const refreshRecovery = async () => {
    try {
      setRecovery(await listRecoveryRecords());
    } catch {
      // The recovery store is a safety net, not a dependency: if it cannot be
      // opened, the rest of this screen — including Export backup — must still
      // work. An empty list is the honest thing to show, and the section says
      // plainly when there is nothing in it.
      setRecovery([]);
    }
  };

  useEffect(() => {
    void persistenceState().then(setPersist);
    void storageEstimate().then(setEstimate);
    void refreshRecovery();
  }, []);

  const exportBackupNow = async () => {
    try {
      // Verified before it is offered: the bytes are parsed back and every
      // figure in the file's manifest is recomputed from them, so a file that
      // cannot prove itself throws here and is never handed over.
      const { result, manifest, contentHash } = await downloadVerifiedBackup();
      const summary = summariseManifest(manifest);
      setRestored(null); // a fresh export supersedes the last restore's figures
      if (result === 'cancelled') {
        setPending(null);
        setWritten(null);
        toast('Backup cancelled — nothing was saved', 'info');
        return;
      }
      setWritten({ summary, hash: contentHash });
      if (result === 'saved') {
        // The browser wrote the file where the user chose — observed, so it
        // can be recorded without asking.
        await markBackupSaved();
        setPending(null);
        toast(`Backup saved — ${summary}`, 'success');
      } else {
        setPending(result);
      }
    } catch (e) {
      setPending(null);
      setWritten(null);
      toast(errorMessage(e), 'error');
    }
  };

  const confirmSaved = async () => {
    try {
      await markBackupSaved();
      setPending(null);
      toast('Backup recorded', 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const askPersistence = async () => {
    const result = await requestPersistence();
    setPersist(result);
    if (result === 'persisted') toast('Persistent storage granted', 'success');
    else if (result === 'not-persisted')
      toast('The browser declined — data can still be evicted. Keep regular backups.', 'error');
    else toast('Persistent storage is not supported in this browser', 'info');
  };

  const downloadRecovery = async (id: string) => {
    try {
      const result = await downloadRecoveryBackup(id);
      if (result === 'cancelled') toast('Cancelled — nothing was saved', 'info');
      else if (result === 'saved') toast('Copy saved', 'success');
      // 'shared' / 'delivered' are handovers, not proof: say so rather than
      // congratulating the user on a file nobody has seen. No bookkeeping is
      // stamped either way — this is not the book's own backup.
      else toast('Handed over — check it really arrived before relying on it', 'info');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const restoreRecovery = async (id: string) => {
    setRestoreRecoveryId(null);
    setBusy(true);
    try {
      await restoreRecoveryBackup(id);
      window.location.hash = '/dashboard';
      window.location.reload();
    } catch (e) {
      setBusy(false);
      toast(errorMessage(e), 'error');
    }
  };

  const forgetRecovery = async (id: string) => {
    try {
      await deleteRecoveryRecord(id);
      await refreshRecovery();
      toast('Copy deleted', 'info');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const eraseAll = async () => {
    setEraseOpen(false);
    setBusy(true);
    try {
      // FIRST, and in its own database: the recovery store is not part of `db`
      // (deliberately — see backup.ts), so clearing db.tables never touched it,
      // and it holds up to three complete copies of the book about to be
      // erased. Leaving them behind made "Erase all data" false in the one
      // place a user is most entitled to believe it.
      //
      // Before the main clear, not after, because the two cannot share a
      // transaction and the order decides which failure the user is left with.
      // This way a failure here erases nothing at all and says so. The other
      // order can leave the book gone and three copies of it still on the
      // device — the exact state the wording denies.
      await clearRecoveryStore();
      await db.transaction('rw', db.tables, async () => {
        for (const table of db.tables) await table.clear();
      });
      window.location.hash = '/dashboard';
      window.location.reload();
    } catch (e) {
      setBusy(false);
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <SettingsPage
      title="Backup & storage"
      description="All data lives only on this device — backups are the safety net and the way to move between devices."
    >
      <Card>
        <h2 className="text-sm font-semibold text-text">Backup</h2>
        <p className="mt-1 text-sm text-muted">
          One file containing everything: accounts, transactions, budgets, rates and settings.
        </p>
        <p className="mt-1 text-sm">
          {settings &&
            (settings.lastBackupAt ? (
              <span className="text-muted">
                Last confirmed backup: {formatDate(settings.lastBackupAt)}
              </span>
            ) : (
              <span className="text-warn">Never backed up.</span>
            ))}
          {nudge?.due && settings?.lastBackupAt && (
            <span className="text-warn"> It’s been over 7 days — export a fresh one.</span>
          )}
        </p>
        <div className="mt-3 flex flex-wrap gap-2">
          <Button variant="primary" onClick={() => void exportBackupNow()}>
            <IconDownload size={16} /> Export backup
          </Button>
          <RestoreFromBackup
            onDone={(result) => {
              setRestored(result);
              setWritten(null); // that fingerprint described the previous book
            }}
          />
        </div>
        {/* What went into the file, checked against the file itself. Not a
            congratulation — a statement he can compare with what he expects,
            and a fingerprint he can compare with a future import's. */}
        {written && (
          <div className="mt-3 rounded-lg border border-border bg-surface2 p-3 text-sm">
            <p className="text-text">
              Written: <strong className="tnum">{written.summary}</strong> — verified.
            </p>
            <p className="mt-1 text-xs text-muted">
              Every figure above was recomputed from the finished file&rsquo;s own rows before it
              left the app. Fingerprint of the contents (the export time is excluded, so an
              unchanged book always fingerprints the same):
            </p>
            <code className="mt-1 block break-all text-xs text-faint">{written.hash}</code>
          </div>
        )}
        {/* After a restore: the same figures, recomputed from the database
            itself rather than read off the file that was just imported. */}
        {restored && (
          <div className="mt-3 rounded-lg border border-border bg-surface2 p-3 text-sm">
            {restored.manifest ? (
              <>
                <p className="text-text">
                  Restored: <strong className="tnum">{summariseManifest(restored.manifest)}</strong>
                  {restored.verified ? ' — verified.' : ' — not verified.'}
                </p>
                <p className="mt-1 text-xs text-muted">{restoredNote(restored.verified)}</p>
              </>
            ) : (
              // The restore itself succeeded; only the description of it did
              // not. Saying so beats implying the data is missing.
              <p className="text-text">
                Restored. The app could not recompute the figures just now — the data is in
                place; reopen this screen to see them.
              </p>
            )}
            <div className="mt-2">
              <Button size="sm" onClick={() => navigate('/dashboard')}>
                Go to the dashboard
              </Button>
            </div>
          </div>
        )}
        {pending && (
          <div className="mt-3 rounded-lg border border-warn bg-surface2 p-3 text-sm">
            {/* Deliberately demanding wording: confirming stamps this as the
                latest backup, and a backup you only THINK you have is the
                worst failure this app can have (SPEC §9). */}
            <p className="text-text">
              {pending === 'shared' ? (
                <>
                  <strong>mymoney-backup-{todayISO()}.json</strong> went to the share sheet. The
                  app can’t see where it ended up, so only confirm if you actually saved it —
                  in Files, iCloud Drive, or wherever you keep it.
                </>
              ) : (
                <>
                  Your browser was handed <strong>mymoney-backup-{todayISO()}.json</strong>. It
                  can’t tell the app whether that file was really saved, so go and look: open
                  your downloads and check the file is there, with a size, before you confirm.
                </>
              )}
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void confirmSaved()}>
                {pending === 'shared' ? 'I saved it' : 'I can see the file'}
              </Button>
              <Button size="sm" onClick={() => setPending(null)}>
                Not saved
              </Button>
            </div>
          </div>
        )}
      </Card>

      {/* ------------------------------------------- replaced copies ---- */}
      {/* Resolving a sync conflict destroys one of two copies of a real
          financial history. Before it does, the app keeps the losing side —
          writes it, then reads it back to prove it is really there, and only
          then allows the replacement. Until this card existed those copies were
          kept and were restorable, but nothing in the app could reach them, so
          the promise the conflict dialog makes was only half true. */}
      {recovery !== null && recovery.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold text-text">Replaced copies</h2>
          <p className="mt-1 text-sm text-muted">
            When you chose between this device and Dropbox, the copy you did not keep was
            saved here first. These are complete backups of the book as it stood at that moment —
            the app keeps the most recent few and drops the oldest.
          </p>
          <ul className="mt-3 flex flex-col gap-3">
            {recovery.map((r) => (
              <li key={r.id} className="rounded-lg border border-border bg-surface2/50 p-3">
                <p className="text-sm text-text">{RECOVERY_REASON_TEXT[r.reason]}</p>
                <p className="mt-1 text-xs text-muted">
                  Kept {formatDate(r.savedAt)} · {r.label}
                </p>
                <p className="mt-1 text-xs text-faint tnum">
                  {Object.entries(r.counts)
                    .filter(([, n]) => n > 0)
                    .sort((a, b) => b[1] - a[1])
                    .slice(0, 4)
                    .map(([table, n]) => `${n.toLocaleString('en-GB')} ${table}`)
                    .join(', ')}{' '}
                  · {formatBytes(r.bytes)}
                </p>
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button size="sm" onClick={() => void downloadRecovery(r.id)}>
                    <IconDownload size={16} /> Save as a file
                  </Button>
                  <Button
                    size="sm"
                    variant="danger"
                    disabled={busy}
                    onClick={() => setRestoreRecoveryId(r.id)}
                  >
                    Restore this copy
                  </Button>
                  <Button size="sm" variant="ghost" onClick={() => void forgetRecovery(r.id)}>
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
          <p className="mt-3 text-xs text-muted">
            “Restore this copy” replaces everything currently in the app with this one — it is the
            same operation as restoring a backup file, so export the current data first if you are
            not certain.
          </p>
        </Card>
      )}

      <Card>
        <h2 className="text-sm font-semibold text-text">Storage</h2>
        <p className="mt-1 text-sm text-muted">
          {persist ? PERSIST_TEXT[persist] : 'Checking storage status…'}
        </p>
        {estimate && estimate.quota > 0 && (
          <p className="mt-1 text-sm text-muted tnum">
            Using {formatBytes(estimate.usage)} of {formatBytes(estimate.quota)} available.
          </p>
        )}
        {persist !== 'persisted' && persist !== 'unsupported' && (
          <div className="mt-3">
            <Button onClick={() => void askPersistence()}>Request persistent storage</Button>
          </div>
        )}
      </Card>

      <Card className="border-danger">
        <h2 className="text-sm font-semibold text-danger">Danger zone</h2>
        <p className="mt-1 text-sm text-muted">
          Permanently deletes every account, transaction, budget and setting on this device —
          including any replaced copies kept above — then restarts the app at onboarding. Export a
          backup first if in doubt.
        </p>
        <div className="mt-3">
          <Button variant="danger" disabled={busy} onClick={() => setEraseOpen(true)}>
            <IconTrash size={16} /> Erase all data
          </Button>
        </div>
      </Card>


      <ConfirmDialog
        open={eraseOpen}
        title="Erase all data"
        danger
        confirmLabel="Erase everything"
        requireText="ERASE"
        message={
          <>
            This permanently deletes <strong>all data on this device</strong> — every account,
            transaction, budget, payee, tag, rate and setting, and every copy the app kept when a
            sync conflict was resolved. There is no undo. If you might ever need this data, export
            a backup first.
          </>
        }
        onConfirm={() => void eraseAll()}
        onCancel={() => setEraseOpen(false)}
      />

      {/* Same weight of confirmation as restoring a backup file, because it is
          literally the same operation: every table is cleared and rewritten. */}
      <ConfirmDialog
        open={restoreRecoveryId !== null}
        danger
        requireText="REPLACE"
        title="Restore this replaced copy"
        confirmLabel="Replace everything with this copy"
        message={
          <>
            <p>
              Everything currently in the app is replaced by this saved copy. Anything entered
              since it was kept will no longer be in the app.
            </p>
            <p className="mt-2">
              This device keeps its own name, theme and sync identity — only the book is replaced.
            </p>
          </>
        }
        onConfirm={() => {
          if (restoreRecoveryId) void restoreRecovery(restoreRecoveryId);
        }}
        onCancel={() => setRestoreRecoveryId(null)}
      />
    </SettingsPage>
  );
}
