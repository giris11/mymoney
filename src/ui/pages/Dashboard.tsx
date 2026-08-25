// Dashboard (SPEC §8.1.7): net worth, this month's income vs spend, budget
// snapshot, recent transactions, top categories. Everything live via useLive;
// each card owns its own queries and its own empty state so a fresh install
// still looks intentional.
import { BudgetsCard } from '../dashboard/BudgetsCard';
import { NetWorthCard } from '../dashboard/NetWorthCard';
import { RecentTransactionsCard } from '../dashboard/RecentTransactionsCard';
import { ThisMonthCard } from '../dashboard/ThisMonthCard';
import { TopCategoriesCard } from '../dashboard/TopCategoriesCard';

export default function Dashboard() {
  return (
    <div className="p-4 lg:p-6">
      <h1 className="text-xl font-semibold">Dashboard</h1>
      <div className="mt-4 grid grid-cols-1 gap-4 lg:grid-cols-2">
        <NetWorthCard className="lg:col-span-2" />
        <ThisMonthCard />
        <BudgetsCard />
        <RecentTransactionsCard />
        <TopCategoriesCard />
      </div>
    </div>
  );
}
