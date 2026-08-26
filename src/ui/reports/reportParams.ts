// URL ⇄ view mapping for the Reports page (SPEC §8.1.8).
//
// WHY this module exists: every piece of report view state — which report,
// the shared date range, and how deep you have drilled into the category
// tree — lives in the hash query, never in React state alone. That is what
// makes the browser Back button work: each drill / preset / report switch is
// a real history entry, so Back walks back up the tree instead of leaving the
// page, and any view can be bookmarked or shared.
//
// Deep-link contract (docs/CONTRACTS.md) is preserved: `/reports?report=<key>`
// still works on its own; `from`, `to` and `parent` are optional additions and
// every one of them is validated before use.
//
// Pure module: no React, no Dexie, no DOM — so the mapping is unit-testable.
import dayjs from 'dayjs';
import type { DateRangeValue } from '../kit/DateRangePicker';

export const REPORTS = [
  { key: 'net-worth', label: 'Net worth' },
  { key: 'by-category', label: 'By category' },
  { key: 'income-expense', label: 'Income vs expense' },
  { key: 'cash-flow', label: 'Cash flow' },
  { key: 'by-payee', label: 'By payee' },
  { key: 'by-tag', label: 'By tag' },
] as const;

export type ReportKey = (typeof REPORTS)[number]['key'];

export const isReportKey = (v: string | null | undefined): v is ReportKey =>
  REPORTS.some((r) => r.key === v);

/** Which report owns the `parent` param (only the drillable one). */
const DRILLABLE: ReportKey = 'by-category';

export interface ReportView {
  report: ReportKey;
  range: DateRangeValue;
  /** category being drilled into (`by-category` only); null = top level */
  parentId: string | null;
}

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** A 'YYYY-MM-DD' that is also a real calendar date, else null. */
export function validDate(v: string | null | undefined): string | null {
  if (!v || !ISO_DATE.test(v)) return null;
  // dayjs is lenient — '2026-02-30' silently rolls into March, so round-trip
  // the formatted date to reject days that do not exist.
  const d = dayjs(v);
  return d.isValid() && d.format('YYYY-MM-DD') === v ? v : null;
}

/**
 * Hash query → view. Anything missing or malformed falls back rather than
 * throwing: a hand-edited URL must never blank the page.
 * `fallback` supplies the range when the URL carries none.
 */
export function parseReportView(params: URLSearchParams, fallback: DateRangeValue): ReportView {
  const raw = params.get('report');
  const report: ReportKey = isReportKey(raw) ? raw : 'net-worth';

  let from = validDate(params.get('from')) ?? fallback.from;
  let to = validDate(params.get('to')) ?? fallback.to;
  if (from > to) [from, to] = [to, from]; // hand-typed URLs only

  const parent = params.get('parent');
  const parentId = report === DRILLABLE && parent ? parent : null;

  return { report, range: { from, to }, parentId };
}

/**
 * View → router path (no leading '#'; wrap with `href()` for an <a>).
 * Always writes report/from/to so the result is a complete, bookmarkable
 * description of what is on screen.
 */
export function reportPath(view: ReportView): string {
  const p = new URLSearchParams();
  p.set('report', view.report);
  p.set('from', view.range.from);
  p.set('to', view.range.to);
  if (view.report === DRILLABLE && view.parentId) p.set('parent', view.parentId);
  return `/reports?${p.toString()}`;
}

/** True when the URL does not yet spell the view out in full (needs a replace). */
export function isCanonicalUrl(params: URLSearchParams, view: ReportView): boolean {
  return (
    params.get('report') === view.report &&
    params.get('from') === view.range.from &&
    params.get('to') === view.range.to &&
    (params.get('parent') || null) === view.parentId
  );
}

// ------------------------------------------------------------------ presets

export type RangePreset =
  | 'this_month'
  | 'last_month'
  | 'last_3_months'
  | 'last_12_months'
  | 'this_year'
  | 'all_time';

const D = 'YYYY-MM-DD';

/**
 * Which preset chip a range corresponds to — the URL is the source of truth
 * for the range, so the lit chip has to be derived from it (the kit picker
 * only remembers the last chip *clicked*, which Back would leave stale).
 *
 * Mirrors `presetRange()` in src/ui/kit/DateRangePicker.tsx; keep in step.
 * 'all_time' is deliberately never returned: its start is the earliest
 * transaction date, which needs a DB read this pure helper does not do, so an
 * all-time range simply reads as 'custom'.
 */
export function matchPreset(range: DateRangeValue, today: string): RangePreset | 'custom' {
  const t = dayjs(today);
  const is = (from: string, to: string) => range.from === from && range.to === to;

  if (is(t.startOf('month').format(D), today)) return 'this_month';
  const lm = t.subtract(1, 'month');
  if (is(lm.startOf('month').format(D), lm.endOf('month').format(D))) return 'last_month';
  if (is(t.subtract(3, 'month').add(1, 'day').format(D), today)) return 'last_3_months';
  if (is(t.subtract(12, 'month').add(1, 'day').format(D), today)) return 'last_12_months';
  if (is(t.startOf('year').format(D), today)) return 'this_year';
  return 'custom';
}

// --------------------------------------------------------------- breadcrumb

export interface Crumb {
  id: string;
  name: string;
}

/**
 * Root → `id` chain of categories, for the drill-down breadcrumb. Rebuilt from
 * the category tree on every render because the URL carries only the deepest
 * id — which is what lets a bare `?parent=<id>` deep link show the full trail.
 * Unknown ids still produce a crumb (the view and the URL must never disagree)
 * and a cycle in the data cannot hang the walk.
 */
export function ancestorTrail(
  cats: readonly { id: string; name: string; parentId: string | null }[],
  id: string | null,
): Crumb[] {
  if (!id) return [];
  const byId = new Map(cats.map((c) => [c.id, c]));
  let cur = byId.get(id);
  if (!cur) return [{ id, name: 'Unknown category' }];

  const trail: Crumb[] = [];
  const seen = new Set<string>();
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    trail.unshift({ id: cur.id, name: cur.name });
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return trail;
}
