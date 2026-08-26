// Settings landing page — the management hub index (and the mobile "More"
// page). One card per section with a one-line description.
import type { ComponentType } from 'react';
import { useLive } from '../../db/useLive';
import { backupNudgeState } from '../../backup/backup';
import { href } from '../router';
import {
  IconChevronRight,
  IconCoins,
  IconList,
  IconShield,
  IconSun,
  IconTag,
  IconUpload,
  IconWallet,
  type IconProps,
} from '../kit/icons';

/** Two-person silhouette for the payees card (kit has no people icon). */
const IconPayees = ({ size = 20, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    <circle cx="9" cy="8" r="3.2" />
    <path d="M3.5 19.5c0-3 2.5-5 5.5-5s5.5 2 5.5 5" />
    <path d="M15.5 5.2a3.2 3.2 0 0 1 0 5.6" />
    <path d="M17 14.8c2.1 .7 3.5 2.3 3.5 4.7" />
  </svg>
);

/** Cloud for the sync card (kit has no cloud icon). */
const IconCloud = ({ size = 20, ...rest }: IconProps) => (
  <svg
    width={size}
    height={size}
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth={1.8}
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    {...rest}
  >
    <path d="M7 18.5a4.2 4.2 0 0 1-.5-8.37 5.3 5.3 0 0 1 10.2-1.1A3.9 3.9 0 0 1 17.8 18.5z" />
    <path d="M12 21v-7" />
    <path d="m9.4 16.2 2.6-2.6 2.6 2.6" />
  </svg>
);

interface Section {
  path: string;
  title: string;
  description: string;
  icon: ComponentType<IconProps>;
}

const SECTIONS: Section[] = [
  { path: 'appearance', title: 'Appearance', description: 'Theme and base currency', icon: IconSun },
  { path: 'accounts', title: 'Accounts', description: 'Accounts, groups, colours, archive', icon: IconWallet },
  { path: 'categories', title: 'Categories', description: 'Your income and expense category tree', icon: IconList },
  { path: 'payees', title: 'Payees & rules', description: 'Rename payees, set default categories', icon: IconPayees },
  { path: 'tags', title: 'Tags', description: 'Rename or delete tags', icon: IconTag },
  { path: 'rates', title: 'Currency rates', description: 'Manual exchange rates for totals and reports', icon: IconCoins },
  { path: 'imports', title: 'Imports', description: 'Import CSV files, undo imports, sample data', icon: IconUpload },
  { path: 'backup', title: 'Backup & storage', description: 'Export, restore, storage protection, erase', icon: IconShield },
  { path: 'sync', title: 'Sync', description: 'Share this data with your other devices via your own Google Drive', icon: IconCloud },
];

export default function SectionIndex() {
  const nudge = useLive(() => backupNudgeState(), []);
  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <h1 className="text-xl font-semibold">Settings</h1>
      <div className="mt-4 grid gap-3 sm:grid-cols-2">
        {SECTIONS.map(({ path, title, description, icon: Icon }) => (
          <a
            key={path}
            href={href(`/settings/${path}`)}
            className="flex items-center gap-3 rounded-xl border border-border bg-surface p-4 transition-colors hover:bg-surface2"
          >
            <Icon size={20} className="shrink-0 text-muted" />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2 text-sm font-semibold text-text">
                {title}
                {path === 'backup' && nudge?.due && (
                  <span className="text-xs font-medium text-warn">Backup due</span>
                )}
              </span>
              <span className="block truncate text-xs text-muted">{description}</span>
            </span>
            <IconChevronRight size={16} className="shrink-0 text-faint" />
          </a>
        ))}
      </div>
    </div>
  );
}
