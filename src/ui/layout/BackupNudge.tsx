// Backup nudge banner (SPEC §8.1.9): shows when there is data but no backup
// in 7+ days. Dismissible for the session only — data safety beats tidiness.
import { useState } from 'react';
import { useLive } from '../../db/useLive';
import { backupNudgeState, downloadBackup } from '../../backup/backup';
import { useToast } from '../kit/toast';
import { Button } from '../kit/kit';
import { IconAlert, IconX } from '../kit/icons';
import { IconButton } from '../kit/kit';
import { formatDate } from '../../lib/util';

export function BackupNudge() {
  const [dismissed, setDismissed] = useState(false);
  const { toast } = useToast();
  const nudge = useLive(() => backupNudgeState(), []);
  if (!nudge?.due || dismissed) return null;
  return (
    <div className="flex items-center gap-3 border-b border-border bg-surface2 px-4 py-2 text-sm">
      <IconAlert size={18} className="shrink-0 text-warn" />
      <span className="min-w-0 flex-1 text-text">
        {nudge.lastBackupAt
          ? `Last backup ${formatDate(nudge.lastBackupAt.slice(0, 10))} — export a fresh one to keep your data safe.`
          : 'No backup yet — export one to keep your data safe.'}
      </span>
      <Button
        size="sm"
        variant="primary"
        onClick={async () => {
          try {
            await downloadBackup();
            toast('Backup exported', 'success');
          } catch (e) {
            toast(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
          }
        }}
      >
        Export backup
      </Button>
      <IconButton label="Dismiss for now" onClick={() => setDismissed(true)}>
        <IconX size={16} />
      </IconButton>
    </div>
  );
}
