// Reports (SPEC §8.1.8) — all six Phase-1 reports behind one switcher.
// Deep link: /reports?report=<net-worth|by-category|income-expense|cash-flow|
// by-payee|by-tag> (CONTRACTS.md). The date range is shared across reports.
import { useState } from 'react';
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { todayISO } from '../../lib/util';
import { useRoute, navigate } from '../router';
import { Segmented } from '../kit/kit';
import { DateRangePicker, type DateRangeValue } from '../kit/DateRangePicker';
import { ReportSkeleton } from '../reports/common';
import NetWorthReport from '../reports/NetWorthReport';
import CategoryReport from '../reports/CategoryReport';
import IncomeExpenseReport from '../reports/IncomeExpenseReport';
import CashFlowReport from '../reports/CashFlowReport';
import PayeeReport from '../reports/PayeeReport';
import TagReport from '../reports/TagReport';

const REPORTS = [
  { key: 'net-worth', label: 'Net worth' },
  { key: 'by-category', label: 'By category' },
  { key: 'income-expense', label: 'Income vs expense' },
  { key: 'cash-flow', label: 'Cash flow' },
  { key: 'by-payee', label: 'By payee' },
  { key: 'by-tag', label: 'By tag' },
] as const;
type ReportKey = (typeof REPORTS)[number]['key'];

const isReportKey = (v: string | null): v is ReportKey =>
  REPORTS.some((r) => r.key === v);

/** Default range: this year (task spec), computed synchronously. */
function thisYearRange(): DateRangeValue {
  const today = todayISO();
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

export default function Reports() {
  const route = useRoute();
  const raw = route.params.get('report');
  const report: ReportKey = isReportKey(raw) ? raw : 'net-worth';
  // Shared across report switches — switching tabs never resets the range.
  const [range, setRange] = useState<DateRangeValue>(thisYearRange);
  const settings = useLive(() => getSettings(), []);

  const select = (key: ReportKey) => {
    // build the href and set location.hash; useRoute picks it up via hashchange
    navigate(`/reports?report=${key}`);
  };

  const currency = settings?.baseCurrency;

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-xl font-semibold">Reports</h1>

      <div className="-mx-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
        <Segmented<ReportKey>
          label="Report"
          value={report}
          onChange={select}
          options={REPORTS.map((r) => ({
            value: r.key,
            label: <span className="whitespace-nowrap">{r.label}</span>,
          }))}
        />
      </div>

      <DateRangePicker value={range} onChange={setRange} />

      {currency === undefined ? (
        <ReportSkeleton kind="chart" />
      ) : report === 'net-worth' ? (
        <NetWorthReport range={range} currency={currency} />
      ) : report === 'by-category' ? (
        <CategoryReport range={range} currency={currency} />
      ) : report === 'income-expense' ? (
        <IncomeExpenseReport range={range} currency={currency} />
      ) : report === 'cash-flow' ? (
        <CashFlowReport range={range} currency={currency} />
      ) : report === 'by-payee' ? (
        <PayeeReport range={range} currency={currency} />
      ) : (
        <TagReport range={range} currency={currency} />
      )}
    </div>
  );
}
