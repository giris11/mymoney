// Desktop sidebar (SPEC §4): net worth on top, nav, account groups with
// per-account balances.
import { useLive } from '../../db/useLive';
import { db } from '../../db/db';
import { accountBalances, netWorth, type AccountBalance } from '../../domain/balances';
import { formatMinor } from '../../money/money';
import { cn } from '../../lib/util';
import { href, navigate, useRoute } from '../router';
import { APP_NAME } from '../../config';
import {
  IconCoins,
  IconGear,
  IconHome,
  IconList,
  IconPie,
  IconPlus,
} from '../kit/icons';
import { IconButton } from '../kit/kit';

const NAV = [
  { path: '/dashboard', label: 'Dashboard', icon: IconHome },
  { path: '/transactions', label: 'Transactions', icon: IconList },
  { path: '/budgets', label: 'Budgets', icon: IconCoins },
  { path: '/reports', label: 'Reports', icon: IconPie },
  { path: '/settings', label: 'Settings', icon: IconGear },
];

export function Sidebar({ onQuickAdd }: { onQuickAdd: () => void }) {
  const route = useRoute();
  const nw = useLive(() => netWorth(), []);
  const balances = useLive(() => accountBalances(), []);
  const groups = useLive(() => db.accountGroups.orderBy('sortOrder').toArray(), []);

  const visible = (balances ?? []).filter((b) => !b.account.archived);
  const grouped = new Map<string | null, AccountBalance[]>();
  for (const b of visible) {
    const key = b.account.groupId;
    if (!grouped.has(key)) grouped.set(key, []);
    grouped.get(key)!.push(b);
  }
  for (const list of grouped.values()) {
    list.sort((a, b) => a.account.sortOrder - b.account.sortOrder || a.account.name.localeCompare(b.account.name));
  }
  const orderedGroups = [
    ...(groups ?? []).filter((g) => grouped.has(g.id)).map((g) => ({ id: g.id as string | null, name: g.name })),
    ...(grouped.has(null) ? [{ id: null as string | null, name: (groups ?? []).length ? 'Other accounts' : 'Accounts' }] : []),
  ];

  return (
    <aside className="hidden lg:flex w-72 shrink-0 flex-col border-r border-border bg-surface">
      <div className="border-b border-border px-5 py-4">
        <div className="flex items-center justify-between">
          <span className="text-sm font-semibold tracking-wide text-muted">{APP_NAME}</span>
          <IconButton label="Add transaction" onClick={onQuickAdd}>
            <IconPlus size={18} />
          </IconButton>
        </div>
        <div className="mt-1">
          <div className="text-xs uppercase tracking-wide text-faint">Net worth</div>
          <div className="tnum text-2xl font-semibold">
            {nw ? formatMinor(nw.totalBaseMinor, nw.baseCurrency) : '—'}
          </div>
          {nw && nw.missingRateCurrencies.length > 0 && (
            <div className="mt-0.5 text-xs text-warn">
              excludes {nw.missingRateCurrencies.join(', ')} — no rate set
            </div>
          )}
        </div>
      </div>

      <nav aria-label="Main" className="px-3 py-3">
        {NAV.map(({ path, label, icon: Icon }) => {
          const active = route.path === path || route.path.startsWith(path + '/');
          return (
            <a
              key={path}
              href={href(path)}
              aria-current={active ? 'page' : undefined}
              className={cn(
                'flex items-center gap-3 rounded-lg px-3 py-2 text-sm font-medium',
                active ? 'bg-surface2 text-text' : 'text-muted hover:bg-surface2 hover:text-text',
              )}
            >
              <Icon size={18} />
              {label}
            </a>
          );
        })}
      </nav>

      <div className="flex-1 overflow-y-auto px-3 pb-4">
        {orderedGroups.map((g) => (
          <div key={g.id ?? 'ungrouped'} className="mt-3">
            <div className="px-3 text-xs font-semibold uppercase tracking-wide text-faint">
              {g.name}
            </div>
            <ul className="mt-1">
              {(grouped.get(g.id) ?? []).map((b) => (
                <li key={b.account.id}>
                  <button
                    type="button"
                    onClick={() => navigate(`/transactions?account=${b.account.id}`)}
                    className="flex w-full items-center gap-2.5 rounded-lg px-3 py-1.5 text-left text-sm hover:bg-surface2 cursor-pointer"
                  >
                    <span
                      aria-hidden="true"
                      className="h-2.5 w-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: b.account.colour }}
                    />
                    <span className="min-w-0 flex-1 truncate text-text">{b.account.name}</span>
                    <span className={cn('tnum text-xs', b.balanceMinor < 0 ? 'text-neg' : 'text-muted')}>
                      {formatMinor(b.balanceMinor, b.account.currency)}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </div>
        ))}
        {visible.length === 0 && (
          <p className="px-3 pt-4 text-xs text-faint">No accounts yet.</p>
        )}
      </div>
    </aside>
  );
}
