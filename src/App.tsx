import { lazy, Suspense, useState } from 'react';
import { getSettings } from './db/db';
import { useLive } from './db/useLive';
import { useRoute } from './ui/router';
import { useThemeSync } from './ui/theme';
import { ToastProvider } from './ui/kit/toast';
import { Sidebar } from './ui/layout/Sidebar';
import { TabBar } from './ui/layout/TabBar';
import { BackupNudge } from './ui/layout/BackupNudge';
import QuickAddSheet from './ui/quickadd/QuickAddSheet';
import Onboarding from './ui/pages/Onboarding';

const Dashboard = lazy(() => import('./ui/pages/Dashboard'));
const Transactions = lazy(() => import('./ui/pages/Transactions'));
const Budgets = lazy(() => import('./ui/pages/Budgets'));
const Reports = lazy(() => import('./ui/pages/Reports'));
const Settings = lazy(() => import('./ui/pages/Settings'));

function Page({ path }: { path: string }) {
  if (path.startsWith('/transactions')) return <Transactions />;
  if (path.startsWith('/budgets')) return <Budgets />;
  if (path.startsWith('/reports')) return <Reports />;
  if (path.startsWith('/settings')) return <Settings />;
  return <Dashboard />;
}

export default function App() {
  useThemeSync();
  const route = useRoute();
  const [quickAddOpen, setQuickAddOpen] = useState(false);
  const settings = useLive(() => getSettings(), []);

  if (settings === undefined) return null; // first paint: don't flash onboarding
  if (!settings.onboarded) {
    return (
      <ToastProvider>
        <Onboarding />
      </ToastProvider>
    );
  }

  return (
    <ToastProvider>
      <div className="flex h-dvh overflow-hidden">
        <Sidebar onQuickAdd={() => setQuickAddOpen(true)} />
        <div className="flex min-w-0 flex-1 flex-col">
          <BackupNudge />
          <main className="min-h-0 flex-1 overflow-y-auto pb-24 lg:pb-0">
            <Suspense fallback={null}>
              <Page path={route.path} />
            </Suspense>
          </main>
        </div>
      </div>
      <TabBar onQuickAdd={() => setQuickAddOpen(true)} />
      <QuickAddSheet open={quickAddOpen} onClose={() => setQuickAddOpen(false)} />
    </ToastProvider>
  );
}
