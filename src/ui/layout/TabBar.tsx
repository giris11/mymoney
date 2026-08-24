// Mobile bottom tab bar (SPEC §4) + floating quick-add button.
import { cn } from '../../lib/util';
import { href, useRoute } from '../router';
import { IconCoins, IconDots, IconHome, IconList, IconPie, IconPlus } from '../kit/icons';

const TABS = [
  { path: '/dashboard', label: 'Dashboard', icon: IconHome },
  { path: '/transactions', label: 'Transactions', icon: IconList },
  { path: '/budgets', label: 'Budgets', icon: IconCoins },
  { path: '/reports', label: 'Reports', icon: IconPie },
  { path: '/settings', label: 'More', icon: IconDots },
];

export function TabBar({ onQuickAdd }: { onQuickAdd: () => void }) {
  const route = useRoute();
  return (
    <>
      <button
        type="button"
        onClick={onQuickAdd}
        aria-label="Add transaction"
        className="fixed bottom-20 right-4 z-40 flex h-14 w-14 items-center justify-center rounded-full bg-accent text-on-accent shadow-lg lg:hidden cursor-pointer"
      >
        <IconPlus size={26} />
      </button>
      <nav
        aria-label="Main"
        className="fixed inset-x-0 bottom-0 z-40 border-t border-border bg-surface safe-bottom lg:hidden"
      >
        <ul className="flex">
          {TABS.map(({ path, label, icon: Icon }) => {
            const active = route.path === path || route.path.startsWith(path + '/');
            return (
              <li key={path} className="flex-1">
                <a
                  href={href(path)}
                  aria-current={active ? 'page' : undefined}
                  className={cn(
                    'flex flex-col items-center gap-0.5 py-2 text-[11px] font-medium',
                    active ? 'text-accent' : 'text-muted',
                  )}
                >
                  <Icon size={22} />
                  {label}
                </a>
              </li>
            );
          })}
        </ul>
      </nav>
    </>
  );
}
