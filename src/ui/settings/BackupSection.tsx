// Backup & storage (SPEC §8.1.9, §9 durability): export, validated restore
// with typed confirmation, persistent-storage state/request (result surfaced
// honestly), and the erase-all danger zone.
import { useEffect, useState } from 'react';
import { ALL_TABLES, db, getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import {
  backupNudgeState,
  downloadBackup,
  markBackupSaved,
  restoreBackup,
  validateBackup,
} from '../../backup/backup';
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
import { RestoreFromBackup } from './RestoreFromBackup';

function formatBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  if (n >= 1024 ** 2) return `${(n / 1024 ** 2).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} kB`;
  return `${n} B`;
}

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
  // Set when the browser took the file but cannot tell us it reached the disk:
  // only the user can confirm that, and until they do we record nothing.
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const [eraseOpen, setEraseOpen] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void persistenceState().then(setPersist);
    void storageEstimate().then(setEstimate);
  }, []);

  const exportBackupNow = async () => {
    try {
      const result = await downloadBackup();
      if (result === 'saved') {
        // The browser wrote the file where the user chose — observed, so it
        // can be recorded without asking.
        await markBackupSaved();
        setAwaitingConfirm(false);
        toast('Backup saved', 'success');
      } else if (result === 'cancelled') {
        setAwaitingConfirm(false);
        toast('Backup cancelled — nothing was saved', 'info');
      } else {
        setAwaitingConfirm(true);
      }
    } catch (e) {
      setAwaitingConfirm(false);
      toast(errorMessage(e), 'error');
    }
  };

  const confirmSaved = async () => {
    try {
      await markBackupSaved();
      setAwaitingConfirm(false);
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

  const eraseAll = async () => {
    setEraseOpen(false);
    setBusy(true);
    try {
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
          <RestoreFromBackup onDone={() => navigate('/dashboard')} />
        </div>
        {awaitingConfirm && (
          <div className="mt-3 rounded-lg border border-warn bg-surface2 p-3 text-sm">
            <p className="text-text">
              Your browser was handed <strong>mymoney-backup-{todayISO()}.json</strong>. It
              can’t tell the app whether that file was really saved, so check your downloads —
              then confirm below and it counts as your latest backup.
            </p>
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="primary" onClick={() => void confirmSaved()}>
                Yes, I have the file
              </Button>
              <Button size="sm" onClick={() => setAwaitingConfirm(false)}>
                Not saved
              </Button>
            </div>
          </div>
        )}
      </Card>

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
          Permanently deletes every account, transaction, budget and setting on this device, then
          restarts the app at onboarding. Export a backup first if in doubt.
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
            transaction, budget, payee, tag, rate and setting. There is no undo. If you might ever
            need this data, export a backup first.
          </>
        }
        onConfirm={() => void eraseAll()}
        onCancel={() => setEraseOpen(false)}
      />
    </SettingsPage>
  );
}
