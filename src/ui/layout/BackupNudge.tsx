// The app-wide notice slot, rendered once by App directly above the main area.
//
// Two notices live here:
//  * sample (E1) — while a sample batch exists, say so from EVERY screen. The
//    demo accounts are prefixed "Sample ·" (src/domain/sample.ts), but the
//    sidebar's net worth is one number and cannot be: ~£12k of demo money joins
//    the user's real balance there. This banner is what makes that state
//    visible, instead of something you only find in Settings → Imports.
//  * backup (SPEC §8.1.9) — no backup in 7+ days.
//
// Both dismiss for the session only: they describe a state that is still true
// after dismissal, so they return on the next launch and go for good only when
// the state does. Mobile keeps each to one tight line.
import { useState, type ReactNode } from 'react';
import { useLive } from '../../db/useLive';
import {
  backupNudgeState,
  downloadBackup,
  markBackupSaved,
  type BackupNudge as BackupNudgeState,
} from '../../backup/backup';
import { sampleDataBatchId } from '../../domain/sample';
import { useToast } from '../kit/toast';
import { Button, IconButton } from '../kit/kit';
import { IconAlert, IconX } from '../kit/icons';
import { formatDate, todayISO } from '../../lib/util';
import { navigate } from '../router';
import { removeSampleData } from '../../domain/sample';

export type Notice = 'sample' | 'backup';

export interface NoticeInput {
  /** From sampleDataBatchId(): a string while sample data is loaded, undefined while loading. */
  sampleBatchId: string | null | undefined;
  sampleDismissed: boolean;
  /** From backupNudgeState().due; undefined while loading. */
  backupDue: boolean | undefined;
  backupDismissed: boolean;
}

/**
 * Which notices the slot shows, in order. Kept as a pure function because the
 * app has no DOM test environment — this is the part worth protecting:
 * the sample notice never hides the backup nudge (or vice versa), and neither
 * flashes on before its query has answered.
 */
export function visibleNotices(s: NoticeInput): Notice[] {
  const out: Notice[] = [];
  if (typeof s.sampleBatchId === 'string' && !s.sampleDismissed) out.push('sample');
  if (s.backupDue === true && !s.backupDismissed) out.push('backup');
  return out;
}

/** Shared strip chrome so both notices sit identically in the layout. */
function Banner({
  tone,
  children,
  onDismiss,
  dismissLabel,
}: {
  tone: 'warn' | 'accent';
  children: ReactNode;
  onDismiss: () => void;
  dismissLabel: string;
}) {
  return (
    <div className="flex items-center gap-2 border-b border-border bg-surface2 px-3 py-1.5 text-sm lg:gap-3 lg:px-4 lg:py-2">
      <IconAlert
        size={18}
        className={tone === 'warn' ? 'shrink-0 text-warn' : 'shrink-0 text-accent'}
      />
      {children}
      <IconButton label={dismissLabel} onClick={onDismiss}>
        <IconX size={16} />
      </IconButton>
    </div>
  );
}

function SampleBanner({ onDismiss }: { onDismiss: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState(false);
  // The button REMOVES — it does not merely navigate to the page that removes.
  // SPEC §4 promises one-tap removal, and a control labelled "Remove" that only
  // changes route reads as broken when you are already on that route.
  // No confirmation: this is demo data by construction, it only ever deletes the
  // sample batch (removeSampleData is the import-undo path, D19), and it can be
  // loaded again from Settings.
  const remove = async () => {
    setBusy(true);
    try {
      await removeSampleData();
      toast('Sample data removed', 'success');
    } catch (e) {
      toast(e instanceof Error ? e.message : 'Could not remove the sample data', 'error');
    } finally {
      setBusy(false);
    }
  };
  return (
    <Banner tone="accent" dismissLabel="Hide this notice" onDismiss={onDismiss}>
      <span className="min-w-0 flex-1 truncate text-text">
        <strong className="font-semibold">Sample data is loaded.</strong>
        <span className="hidden text-muted lg:inline">
          {' '}
          It&rsquo;s demo money, kept separate from yours.
        </span>
      </span>
      <Button size="sm" disabled={busy} onClick={() => void remove()}>
        {busy ? 'Removing…' : 'Remove'}
      </Button>
    </Banner>
  );
}

/** What downloadBackup handed over when it cannot prove the file landed. */
type PendingSave = 'shared' | 'delivered';

function BackupDueBanner({
  nudge,
  onDismiss,
}: {
  nudge: BackupNudgeState;
  onDismiss: () => void;
}) {
  // Neither the share sheet nor the <a download> proves the file was KEPT, so
  // the banner stays up and asks: the nudge must never clear on a save that
  // never landed (D33).
  const [pending, setPending] = useState<PendingSave | null>(null);
  const { toast } = useToast();

  const exportNow = async () => {
    try {
      const result = await downloadBackup();
      if (result === 'saved') {
        await markBackupSaved(); // the browser confirmed the write
        setPending(null);
        toast('Backup saved', 'success');
      } else if (result === 'cancelled') {
        setPending(null);
        toast('Backup cancelled — nothing was saved', 'info');
      } else {
        setPending(result);
      }
    } catch (e) {
      setPending(null);
      toast(`Backup failed: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  const confirmSaved = async () => {
    try {
      await markBackupSaved();
      setPending(null);
      toast('Backup recorded', 'success');
    } catch (e) {
      toast(`Could not record the backup: ${e instanceof Error ? e.message : String(e)}`, 'error');
    }
  };

  return (
    <Banner tone="warn" dismissLabel="Dismiss for now" onDismiss={onDismiss}>
      {pending ? (
        <>
          <span className="min-w-0 flex-1 text-text">
            {pending === 'shared'
              ? `Shared as mymoney-backup-${todayISO()}.json — only confirm if you actually saved it, to Files, iCloud Drive or wherever you keep it.`
              : `Check that mymoney-backup-${todayISO()}.json really is in your downloads. Only confirm once you can see the file.`}
          </span>
          <Button size="sm" variant="primary" onClick={() => void confirmSaved()}>
            {pending === 'shared' ? 'I saved it' : 'I can see the file'}
          </Button>
          <Button size="sm" onClick={() => setPending(null)}>
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
    </Banner>
  );
}

/**
 * The slot itself (App renders this one component). Sample first: it explains
 * what the numbers behind it mean.
 */
export function BackupNudge() {
  const [sampleDismissed, setSampleDismissed] = useState(false);
  const [backupDismissed, setBackupDismissed] = useState(false);
  const sampleBatchId = useLive(() => sampleDataBatchId(), []);
  const nudge = useLive(() => backupNudgeState(), []);

  const notices = visibleNotices({
    sampleBatchId,
    sampleDismissed,
    backupDue: nudge?.due,
    backupDismissed,
  });
  if (notices.length === 0) return null;
  return (
    <>
      {notices.includes('sample') && <SampleBanner onDismiss={() => setSampleDismissed(true)} />}
      {notices.includes('backup') && nudge && (
        <BackupDueBanner nudge={nudge} onDismiss={() => setBackupDismissed(true)} />
      )}
    </>
  );
}
