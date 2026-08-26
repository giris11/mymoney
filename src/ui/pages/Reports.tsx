// Reports (SPEC §8.1.8) — all six Phase-1 reports behind one switcher.
//
// The whole view — report, shared date range, category drill-down — lives in
// the hash query (see ../reports/reportParams.ts), so every change is a real
// history entry: browser Back returns to the previous report, undoes a range
// change and walks back up the drill-down, and any view can be bookmarked or
// shared. Deep link `/reports?report=<key>` (CONTRACTS.md) still works on its
// own and is normalised into the full form on arrival.
import { useEffect, useRef } from 'react';
import { getSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { todayISO } from '../../lib/util';
import { useRoute, navigate } from '../router';
import { Segmented } from '../kit/kit';
import type { DateRangeValue } from '../kit/DateRangePicker';
import { ReportRangeBar, ReportSkeleton } from '../reports/common';
import {
  isCanonicalUrl,
  parseReportView,
  reportPath,
  REPORTS,
  type ReportKey,
  type ReportView,
} from '../reports/reportParams';
import NetWorthReport from '../reports/NetWorthReport';
import CategoryReport from '../reports/CategoryReport';
import IncomeExpenseReport from '../reports/IncomeExpenseReport';
import CashFlowReport from '../reports/CashFlowReport';
import PayeeReport from '../reports/PayeeReport';
import TagReport from '../reports/TagReport';

/** Default range when the URL carries none: this year. */
function thisYearRange(): DateRangeValue {
  const today = todayISO();
  return { from: `${today.slice(0, 4)}-01-01`, to: today };
}

export default function Reports() {
  const route = useRoute();
  // Frozen for the session: the fallback must not change identity underneath
  // the URL-normalising effect below.
  const fallback = useRef(thisYearRange()).current;
  const view = parseReportView(route.params, fallback);
  const settings = useLive(() => getSettings(), []);
  const currency = settings?.baseCurrency;

  // Spell the view out in the URL (dropping anything stale, e.g. a `parent`
  // left behind by a report switch). REPLACE — normalising is not a
  // navigation and must not cost the user a Back press.
  const canonical = reportPath(view);
  const needsCanonical = !isCanonicalUrl(route.params, view);
  useEffect(() => {
    if (needsCanonical) navigate(canonical, { replace: true });
  }, [needsCanonical, canonical]);

  /** Navigate to a modified view. Pushes unless told otherwise. */
  const go = (next: Partial<ReportView>, opts?: { replace?: boolean }) =>
    navigate(reportPath({ ...view, ...next }), opts);

  const { report, range, parentId } = view;

  return (
    <div className="flex flex-col gap-4 p-4 lg:p-6">
      <h1 className="text-xl font-semibold">Reports</h1>

      <div className="-mx-4 overflow-x-auto px-4 pb-1 lg:mx-0 lg:px-0">
        <Segmented<ReportKey>
          label="Report"
          value={report}
          // Push, so Back returns to the report you were reading. A drill-down
          // from another report is not carried across — `parent` belongs to
          // the view you left, and Back restores it.
          onChange={(key) => go({ report: key, parentId: null })}
          options={REPORTS.map((r) => ({
            value: r.key,
            label: <span className="whitespace-nowrap">{r.label}</span>,
          }))}
        />
      </div>

      <ReportRangeBar
        value={range}
        // Presets are deliberate jumps → push (Back undoes them). Typing or
        // dragging a custom date fires per keystroke → replace.
        onChange={(next, source) => go({ range: next }, { replace: source === 'custom' })}
      />

      {currency === undefined ? (
        <ReportSkeleton kind="chart" />
      ) : report === 'net-worth' ? (
        <NetWorthReport range={range} currency={currency} />
      ) : report === 'by-category' ? (
        <CategoryReport range={range} currency={currency} parentId={parentId} />
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
