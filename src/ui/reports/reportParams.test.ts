// The /reports URL contract: what the hash query means, and what a view
// writes back into it. Guards the deep links other pages emit.
import { describe, it, expect } from 'vitest';
import {
  ancestorTrail,
  isCanonicalUrl,
  isReportKey,
  matchPreset,
  parseReportView,
  reportPath,
  validDate,
  type ReportView,
} from './reportParams';

const FALLBACK = { from: '2026-01-01', to: '2026-08-26' };
const q = (s: string) => new URLSearchParams(s);

describe('parseReportView', () => {
  it('honours the documented deep link /reports?report=<key> on its own', () => {
    const v = parseReportView(q('report=by-category'), FALLBACK);
    expect(v.report).toBe('by-category');
    expect(v.range).toEqual(FALLBACK); // no range in the URL → caller default
    expect(v.parentId).toBeNull();
  });

  it('falls back to net-worth for a missing or bogus report key', () => {
    expect(parseReportView(q(''), FALLBACK).report).toBe('net-worth');
    expect(parseReportView(q('report=nope'), FALLBACK).report).toBe('net-worth');
  });

  it('reads the shared date range', () => {
    const v = parseReportView(q('report=cash-flow&from=2025-03-01&to=2025-03-31'), FALLBACK);
    expect(v.range).toEqual({ from: '2025-03-01', to: '2025-03-31' });
  });

  it('ignores malformed dates instead of blanking the report', () => {
    const v = parseReportView(q('from=03/01/2025&to=2025-02-30'), FALLBACK);
    expect(v.range).toEqual(FALLBACK);
  });

  it('takes one valid endpoint and keeps the other from the fallback', () => {
    const v = parseReportView(q('from=2025-03-01'), FALLBACK);
    expect(v.range).toEqual({ from: '2025-03-01', to: FALLBACK.to });
  });

  it('swaps a backwards hand-typed range', () => {
    const v = parseReportView(q('from=2025-12-01&to=2025-01-01'), FALLBACK);
    expect(v.range).toEqual({ from: '2025-01-01', to: '2025-12-01' });
  });

  it('carries the drill-down parent for by-category', () => {
    expect(parseReportView(q('report=by-category&parent=cat_food'), FALLBACK).parentId).toBe(
      'cat_food',
    );
  });

  it('drops a stale parent on reports that cannot drill', () => {
    expect(parseReportView(q('report=by-payee&parent=cat_food'), FALLBACK).parentId).toBeNull();
    expect(parseReportView(q('report=by-category&parent='), FALLBACK).parentId).toBeNull();
  });
});

describe('reportPath', () => {
  const view: ReportView = {
    report: 'by-category',
    range: { from: '2026-01-01', to: '2026-08-26' },
    parentId: null,
  };

  it('always spells the view out in full so it can be bookmarked', () => {
    expect(reportPath(view)).toBe('/reports?report=by-category&from=2026-01-01&to=2026-08-26');
  });

  it('appends the drill-down parent', () => {
    expect(reportPath({ ...view, parentId: 'cat_food' })).toBe(
      '/reports?report=by-category&from=2026-01-01&to=2026-08-26&parent=cat_food',
    );
  });

  it('omits parent on non-drillable reports', () => {
    expect(reportPath({ ...view, report: 'net-worth', parentId: 'cat_food' })).not.toContain(
      'parent',
    );
  });

  it('round-trips through parseReportView', () => {
    const drilled: ReportView = { ...view, parentId: 'cat food & drink' };
    const path = reportPath(drilled);
    const parsed = parseReportView(q(path.split('?')[1]), FALLBACK);
    expect(parsed).toEqual(drilled);
  });
});

describe('isCanonicalUrl', () => {
  const view: ReportView = {
    report: 'by-category',
    range: { from: '2026-01-01', to: '2026-08-26' },
    parentId: null,
  };

  it('is false while the URL leaves the range implicit', () => {
    expect(isCanonicalUrl(q('report=by-category'), view)).toBe(false);
  });

  it('is true once the URL matches the view', () => {
    expect(isCanonicalUrl(q(reportPath(view).split('?')[1]), view)).toBe(true);
  });

  it('is false when the URL carries a parent the view dropped', () => {
    expect(
      isCanonicalUrl(q(`${reportPath(view).split('?')[1]}&parent=cat_food`), view),
    ).toBe(false);
  });
});

describe('matchPreset', () => {
  const today = '2026-08-26';

  it('recognises each preset the picker can produce', () => {
    expect(matchPreset({ from: '2026-08-01', to: today }, today)).toBe('this_month');
    expect(matchPreset({ from: '2026-07-01', to: '2026-07-31' }, today)).toBe('last_month');
    expect(matchPreset({ from: '2026-05-27', to: today }, today)).toBe('last_3_months');
    expect(matchPreset({ from: '2025-08-27', to: today }, today)).toBe('last_12_months');
    expect(matchPreset({ from: '2026-01-01', to: today }, today)).toBe('this_year');
  });

  it('reports anything else as custom (never lights the wrong chip)', () => {
    expect(matchPreset({ from: '2026-02-14', to: '2026-03-09' }, today)).toBe('custom');
    expect(matchPreset({ from: '2026-08-01', to: '2026-08-25' }, today)).toBe('custom');
  });
});

describe('ancestorTrail', () => {
  const cats = [
    { id: 'food', name: 'Food & Drink', parentId: null },
    { id: 'groceries', name: 'Groceries', parentId: 'food' },
    { id: 'organic', name: 'Organic', parentId: 'groceries' },
    { id: 'other', name: 'Other', parentId: null },
  ];

  it('is empty at the top level', () => {
    expect(ancestorTrail(cats, null)).toEqual([]);
  });

  it('rebuilds the whole root → leaf chain from the deepest id alone', () => {
    expect(ancestorTrail(cats, 'organic')).toEqual([
      { id: 'food', name: 'Food & Drink' },
      { id: 'groceries', name: 'Groceries' },
      { id: 'organic', name: 'Organic' },
    ]);
  });

  it('still shows a crumb for an id that no longer exists', () => {
    expect(ancestorTrail(cats, 'deleted')).toEqual([{ id: 'deleted', name: 'Unknown category' }]);
  });

  it('cannot hang on a cyclic parent chain', () => {
    const cyclic = [
      { id: 'a', name: 'A', parentId: 'b' },
      { id: 'b', name: 'B', parentId: 'a' },
    ];
    expect(ancestorTrail(cyclic, 'a').map((c) => c.id)).toEqual(['b', 'a']);
  });
});

describe('validDate / isReportKey', () => {
  it('accepts only real ISO dates', () => {
    expect(validDate('2026-08-26')).toBe('2026-08-26');
    expect(validDate('2026-02-30')).toBeNull();
    expect(validDate('2026-8-6')).toBeNull();
    expect(validDate(null)).toBeNull();
  });

  it('narrows report keys', () => {
    expect(isReportKey('by-tag')).toBe(true);
    expect(isReportKey('by-account')).toBe(false);
    expect(isReportKey(null)).toBe(false);
  });
});
