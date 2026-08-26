// Backup nudge banner (SPEC §8.1.9): shows when there is data but no backup
// in 7+ days. Dismissible for the session only — data safety beats tidiness.
import { useState } from 'react';
import { useLive } from '../../db/useLive';
import { backupNudgeState, downloadBackup, markBackupSaved } from '../../backup/backup';
import { useToast } from '../kit/toast';
import { Button } from '../kit/kit';
import { IconAlert, IconX } from '../kit/icons';
import { IconButton } from '../kit/kit';
import { formatDate } from '../../lib/util';

export function BackupNudge() {
  const [dismissed, setDismissed] = useState(false);
  // The <a download> path gives no completion signal, so the banner stays up
  // and asks: the nudge must never clear on a download that never landed.
  const [awaitingConfirm, setAwaitingConfirm] = useState(false);
  const { toast } = useToast();
  const nudge = useLive(() => backupNudgeState(), []);

  const exportNow = async () => {
    try {
      const result = await downloadBackup();
      if (result === 'saved') {
        await markBackupSaved(); // the browser confirmed the write
        toast('Backup saved', 'success');
      } else if (result === 'cancelled') {
        setAwaitingConfirm(false);
        toast('Backup cancelled — nothing was saved', 'info');
      } else {
        setAwaitingConfirm(true);
      }
    } catch (e) {
      setAwaitingConfirm(false);
      toast(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const confirmSaved = async () => {
    try {
      await markBackupSaved();
      setAwaitingConfirm(false);
      toast('Backup recorded', 'success');
    } catch (e) {
      toast(`Could not record the backup: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  if (!nudge?.due || dismissed) return null;
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface2 px-4 py-2 text-sm">
      <IconAlert size={18} className="shrink-0 text-warn" />
      {awaitingConfirm ? (
        <>
          <span className="min-w-0 flex-1 text-text">
            Backup file sent to your browser — check it downloaded, then confirm.
          </span>
          <Button size="sm" variant="primary" onClick={() => void confirmSaved()}>
            I have the file
          </Button>
          <Button size="sm" onClick={() => setAwaitingConfirm(false)}>
            Try again
          </Button>
        </>
      ) : (
        <>
          <span className="min-w-0 flex-1 text-text">
            {nudge.lastBackupAt
              ? `Last backup ${formatDate(nudge.lastBackupAt.slice(0, 10))} — export a fresh one to keep your data safe.`
              : 'No backup yet — export one to keep your data safe.'}
          </span>
          <Button size="sm" variant="primary" onClick={() => void exportNow()}>
            Export backup
          </Button>
        </>
      )}
      <IconButton label="Dismiss for now" onClick={() => setDismissed(true)}>
        <IconX size={16} />
      </IconButton>
    </div>
  );
}
