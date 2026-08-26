// Onboarding step: get your data in (SPEC §4, D24) — four ways to begin.
//
// 'restore' matters more than it looks: backups are how data moves between
// devices until Phase 3's optional Drive sync (SPEC §13), and after an
// "Erase all data" the app returns HERE. Without this option a fresh install —
// a new iPhone, or a restored laptop — would have to invent accounts it is
// about to throw away just to reach Settings → Backup.
import type { ReactNode } from 'react';
import { cn } from '../../lib/util';
import { IconCoins, IconDownload, IconPencil, IconUpload } from '../kit/icons';

export type DataChoice = 'import' | 'restore' | 'sample' | 'fresh';

function OptionCard({
  icon,
  title,
  description,
  recommended,
  disabled,
  onClick,
}: {
  icon: ReactNode;
  title: string;
  description: string;
  recommended?: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        'w-full rounded-xl border bg-surface p-4 text-left transition-colors cursor-pointer',
        'hover:bg-surface2 disabled:cursor-not-allowed disabled:opacity-60',
        recommended ? 'border-accent' : 'border-border',
      )}
    >
      <div className="flex items-start gap-3">
        <div
          className={cn(
            'mt-0.5 shrink-0 rounded-lg p-2',
            recommended ? 'bg-accent text-on-accent' : 'bg-surface2 text-muted',
          )}
        >
          {icon}
        </div>
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex flex-wrap items-center gap-2">
            <span className="text-sm font-semibold text-text">{title}</span>
            {recommended && (
              <span className="rounded-full border border-accent px-2 py-0.5 text-xs font-medium text-accent">
                Recommended
              </span>
            )}
          </div>
          <p className="text-sm text-muted">{description}</p>
        </div>
      </div>
    </button>
  );
}

export function DataStep({
  busyChoice,
  onChoose,
}: {
  busyChoice: DataChoice | null;
  onChoose: (choice: DataChoice) => void;
}) {
  const busy = busyChoice !== null;
  return (
    <div className="flex flex-col gap-3" aria-busy={busy}>
      <OptionCard
        icon={<IconUpload size={20} />}
        title={busyChoice === 'import' ? 'Preparing your import…' : 'Import from MoneyWiz'}
        description="Bring your history across from a MoneyWiz CSV export. You'll see a full preview before anything is saved, and any import can be undone."
        recommended
        disabled={busy}
        onClick={() => onChoose('import')}
      />
      <OptionCard
        icon={<IconDownload size={20} />}
        title={busyChoice === 'restore' ? 'Opening restore…' : 'Restore from a backup'}
        description="Already using MyMoney on another device, or starting over? Restore a backup file to bring everything back exactly as it was."
        disabled={busy}
        onClick={() => onChoose('restore')}
      />
      <OptionCard
        icon={<IconCoins size={20} />}
        title={busyChoice === 'sample' ? 'Loading sample data…' : 'Load sample data'}
        description="Look around with demo data first. It's clearly labelled as a sample and can be removed in one tap from Settings."
        disabled={busy}
        onClick={() => onChoose('sample')}
      />
      <OptionCard
        icon={<IconPencil size={20} />}
        title={busyChoice === 'fresh' ? 'Setting things up…' : 'Start fresh'}
        description="Begin with the accounts you've just set up and add transactions as you go."
        disabled={busy}
        onClick={() => onChoose('fresh')}
      />
    </div>
  );
}
