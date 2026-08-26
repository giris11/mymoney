// "I filtered, and now there is no way back."
//
// The complaint was not a missing button: it was that a narrowed register was
// not a PLACE. Filters lived in component state, so they created no history
// entry — the browser's Back button skipped straight past the filtered view to
// the previous page, and the view could not be reloaded, bookmarked or shared.
//
// Two things have to hold for that to be fixed, and both are pinned here:
//
//  1. THE SERIALISER (src/ui/tx/txShared.ts) — the register's whole filter
//     state survives a round trip through the hash query, exactly. It carries
//     the published deep-link contract (docs/CONTRACTS.md) and money, so it
//     gets the hardest tests in this file.
//  2. THE ROUTER (src/ui/router.ts) — a Back step must never strand the user
//     outside the app, and typing must not bury the view they want to return
//     to under one history entry per keystroke.
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import {
  defaultRegisterRange,
  emptyFilters,
  filtersFromParams,
  filtersToParams,
  filtersToPath,
  normaliseRange,
  toTxFilter,
  type FilterState,
} from '../src/ui/tx/txShared';

const params = (qs: string) => new URLSearchParams(qs);
const roundTrip = (f: FilterState) => filtersFromParams(filtersToParams(f));

// =============================================================== serialiser
describe('filter serialiser: URL <-> register state', () => {
  // The default window is relative to "today", so freeze it: these tests are
  // about the mapping, not about the calendar.
  beforeAll(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-08-26T09:00:00Z'));
  });
  afterAll(() => {
    vi.useRealTimers();
  });

  const full: FilterState = {
    text: 'tesco',
    accountId: 'acc-1',
    categoryId: 'cat-2',
    payeeId: 'pay-3',
    tagId: 'tag-4',
    range: { from: '2026-01-01', to: '2026-03-31' },
    minMinor: 1250,
    maxMinor: 999_00,
    status: 'pending',
  };

  it('writes every field, under the contract names, in a stable order', () => {
    expect(filtersToParams(full).toString()).toBe(
      'account=acc-1&category=cat-2&payee=pay-3&tag=tag-4' +
        '&from=2026-01-01&to=2026-03-31&q=tesco&status=pending&min=1250&max=99900',
    );
  });

  it('round-trips every field', () => {
    expect(roundTrip(full)).toEqual(full);
  });

  it('the default filter set produces an EMPTY query — no ?q=&status=all noise', () => {
    expect(filtersToParams(emptyFilters()).toString()).toBe('');
    expect(filtersToPath(emptyFilters())).toBe('/transactions');
    // …and an empty query gives the default set straight back, which is what
    // makes plain /transactions the register's resting state.
    expect(filtersFromParams(params(''))).toEqual(emptyFilters());
  });

  it('keeps the default date window out of the URL but still applies it', () => {
    const f = { ...emptyFilters(), accountId: 'acc-1' };
    expect(filtersToParams(f).toString()).toBe('account=acc-1');
    const back = filtersFromParams(params('account=acc-1'));
    expect(back.range).toEqual(defaultRegisterRange());
    // The window is what keeps a sidebar deep link on the indexed fast path
    // instead of reading the whole table (SPEC §9).
    expect(toTxFilter(back).dateFrom).toBe('2026-05-29');
  });

  it('distinguishes "all dates" from "no date params" with an empty from=', () => {
    const allDates = { ...emptyFilters(), range: null };
    expect(filtersToParams(allDates).toString()).toBe('from=');
    expect(filtersFromParams(params('from='))).toEqual(allDates);
    expect(roundTrip(allDates).range).toBeNull();
    // The difference is not cosmetic: one is a 90-day indexed window, the
    // other is a deliberate whole-ledger read.
    expect(toTxFilter(filtersFromParams(params('from='))).dateFrom).toBeUndefined();
    expect(toTxFilter(filtersFromParams(params(''))).dateFrom).toBe('2026-05-29');
  });

  it('round-trips half-open ranges', () => {
    const fromOnly = { ...emptyFilters(), range: { from: '2026-02-01', to: '' } };
    expect(filtersToParams(fromOnly).toString()).toBe('from=2026-02-01');
    expect(roundTrip(fromOnly)).toEqual(fromOnly);

    const toOnly = { ...emptyFilters(), range: { from: '', to: '2026-02-01' } };
    expect(filtersToParams(toOnly).toString()).toBe('to=2026-02-01');
    expect(roundTrip(toOnly)).toEqual(toOnly);
  });

  it('normalises the two spellings of "no dates at all" to one', () => {
    expect(normaliseRange({ from: '', to: '' })).toBeNull();
    expect(roundTrip({ ...emptyFilters(), range: { from: '', to: '' } }).range).toBeNull();
  });

  // -------------------------------------------------------------- money
  describe('money survives the URL exactly', () => {
    it('is integer minor units, never a formatted or float value', () => {
      const f = { ...emptyFilters(), minMinor: 1250, maxMinor: 2000 };
      const qs = filtersToParams(f).toString();
      expect(qs).toContain('min=1250');
      expect(qs).not.toContain('12.50');
      expect(qs).not.toContain('£');
      expect(roundTrip(f)).toEqual(f);
    });

    it('round-trips zero — 0 is a filter, not "unset"', () => {
      const f = { ...emptyFilters(), minMinor: 0, maxMinor: 0 };
      expect(filtersToParams(f).toString()).toBe('min=0&max=0');
      expect(roundTrip(f).minMinor).toBe(0);
      expect(roundTrip(f).maxMinor).toBe(0);
    });

    it('round-trips large amounts without losing a penny', () => {
      const big = 987_654_321_09; // £987,654,321.09
      const f = { ...emptyFilters(), maxMinor: big };
      expect(filtersToParams(f).toString()).toBe(`max=${big}`);
      expect(roundTrip(f).maxMinor).toBe(big);
      expect(filtersFromParams(params('min=9007199254740991')).minMinor).toBe(
        Number.MAX_SAFE_INTEGER,
      );
    });

    it('refuses anything that is not an exact integer, rather than rounding it', () => {
      for (const bad of ['12.50', '1e3', '1_000', ' 12', '12 ', 'abc', '', '0x10', 'NaN']) {
        expect(filtersFromParams(params(`min=${encodeURIComponent(bad)}`)).minMinor).toBeNull();
      }
      // Beyond exact integer precision: dropped, never silently mangled.
      expect(filtersFromParams(params('min=9007199254740993')).minMinor).toBeNull();
      // A float in state cannot be written down honestly, so it is not written.
      expect(filtersToParams({ ...emptyFilters(), minMinor: 12.5 }).toString()).toBe('');
    });

    it('accepts a negative bound and keeps the sign (magnitudes are applied later)', () => {
      const f = { ...emptyFilters(), minMinor: -500 };
      expect(filtersToParams(f).toString()).toBe('min=-500');
      expect(roundTrip(f)).toEqual(f);
      expect(toTxFilter(f).amountMinMinor).toBe(500);
    });
  });

  // -------------------------------------------------------------- garbage
  describe('a hand-edited URL is untrusted input', () => {
    it('ignores unknown params instead of throwing', () => {
      expect(() =>
        filtersFromParams(params('account=a1&nonsense=1&__proto__=x&q&&=&status')),
      ).not.toThrow();
      expect(filtersFromParams(params('account=a1&nonsense=1')).accountId).toBe('a1');
    });

    it('reads an unusable value as "that filter is off"', () => {
      const f = filtersFromParams(params('status=wat&min=abc&max=&from=yesterday&category='));
      expect(f.status).toBe('all');
      expect(f.minMinor).toBeNull();
      expect(f.maxMinor).toBeNull();
      expect(f.categoryId).toBeNull();
      // A typo'd date must not widen the register to the whole table.
      expect(f.range).toEqual(defaultRegisterRange());
    });

    it('keeps a valid end when the other end is garbage', () => {
      expect(filtersFromParams(params('from=nope&to=2026-02-01')).range).toEqual({
        from: '',
        to: '2026-02-01',
      });
    });

    it('never throws on any of a pile of malformed queries', () => {
      for (const qs of [
        '?????',
        'q=%E2%9C%93&min=%2D5',
        'from=2026-13-45',
        'status=cleared&status=pending',
        'min=-0',
        'account=%00',
      ]) {
        expect(() => filtersFromParams(params(qs))).not.toThrow();
      }
      expect(filtersFromParams(params('min=-0')).minMinor).toBe(0); // not -0
      // Repeated key: the first wins (URLSearchParams.get), not a crash.
      expect(filtersFromParams(params('status=cleared&status=pending')).status).toBe('cleared');
    });
  });

  // ------------------------------------------------------- legacy deep links
  describe('the published deep links (docs/CONTRACTS.md) still parse', () => {
    it('?account=<id> alone', () => {
      const f = filtersFromParams(params('account=acc-1'));
      expect(f.accountId).toBe('acc-1');
      expect(f.categoryId).toBeNull();
      expect(f.payeeId).toBeNull();
      expect(f.tagId).toBe('');
      expect(f.text).toBe('');
      expect(f.status).toBe('all');
      expect(f.range).toEqual(defaultRegisterRange());
    });

    it('?category=, ?payee=, ?tag= alone', () => {
      expect(filtersFromParams(params('category=c1')).categoryId).toBe('c1');
      expect(filtersFromParams(params('payee=p1')).payeeId).toBe('p1');
      expect(filtersFromParams(params('tag=t1')).tagId).toBe('t1');
    });

    it('?from=&to= alone, and combined with the rest', () => {
      expect(filtersFromParams(params('from=2026-01-01&to=2026-01-31')).range).toEqual({
        from: '2026-01-01',
        to: '2026-01-31',
      });
      const combined = filtersFromParams(
        params('account=a1&category=c1&payee=p1&tag=t1&from=2026-01-01&to=2026-01-31'),
      );
      expect(toTxFilter(combined)).toEqual({
        accountIds: ['a1'],
        categoryIds: ['c1'],
        payeeIds: ['p1'],
        tagIds: ['t1'],
        dateFrom: '2026-01-01',
        dateTo: '2026-01-31',
      });
    });

    it('a legacy link re-serialises to itself (no param drift on the next click)', () => {
      const legacy = 'account=a1&from=2026-01-01&to=2026-01-31';
      expect(filtersToParams(filtersFromParams(params(legacy))).toString()).toBe(legacy);
    });
  });

  // ----------------------------------------------------- the identity table
  it('filtersFromParams(filtersToParams(f)) === f for representative states', () => {
    const table: [name: string, f: FilterState][] = [
      ['nothing set', emptyFilters()],
      ['one account (the sidebar click)', { ...emptyFilters(), accountId: 'acc-1' }],
      ['a category drill-down', { ...emptyFilters(), categoryId: 'cat-1' }],
      ['a payee', { ...emptyFilters(), payeeId: 'pay-1' }],
      ['a tag', { ...emptyFilters(), tagId: 'tag-1' }],
      ['search text', { ...emptyFilters(), text: 'tesco' }],
      ['search text with spaces and symbols', { ...emptyFilters(), text: 'a & b ? c #d /e+f' }],
      ['search text that is only spaces', { ...emptyFilters(), text: '   ' }],
      ['unicode search text', { ...emptyFilters(), text: 'café — 日本' }],
      ['status cleared', { ...emptyFilters(), status: 'cleared' }],
      ['status pending', { ...emptyFilters(), status: 'pending' }],
      ['all dates', { ...emptyFilters(), range: null }],
      ['a chosen window', { ...emptyFilters(), range: { from: '2020-02-29', to: '2020-03-01' } }],
      ['open-ended window', { ...emptyFilters(), range: { from: '2026-05-01', to: '' } }],
      ['amounts', { ...emptyFilters(), minMinor: 1, maxMinor: 1_000_000_00 }],
      ['zero amounts', { ...emptyFilters(), minMinor: 0, maxMinor: 0 }],
      ['everything at once', full],
      [
        'everything at once, all dates',
        { ...full, range: null, text: 'weird & "quoted" %20', status: 'cleared' },
      ],
    ];
    for (const [name, f] of table) {
      expect(roundTrip(f), name).toEqual(f);
      // Idempotent: serialising the parsed state gives the same URL back, so
      // navigating to a filtered view twice cannot drift.
      const once = filtersToParams(f).toString();
      expect(filtersToParams(filtersFromParams(params(once))).toString(), name).toBe(once);
    }
  });

  it('builds the path the page navigates to', () => {
    expect(filtersToPath({ ...emptyFilters(), accountId: 'a1' })).toBe('/transactions?account=a1');
    expect(filtersToPath(emptyFilters())).toBe('/transactions');
  });
});

// =================================================================== router
/**
 * A fake session history: entries with a hash and a state object, an index,
 * and the two events a same-document navigation fires. `escaped` records the
 * one thing that must never happen — a Back step off the bottom of the stack,
 * i.e. out of the app and into whatever site the user came from.
 */
function fakeBrowser(initialHash = '#/transactions') {
  interface Entry {
    hash: string;
    state: unknown;
  }
  const entries: Entry[] = [{ hash: initialHash, state: null }];
  let index = 0;
  let escaped = false;
  const listeners: Record<string, Array<() => void>> = { hashchange: [], popstate: [] };
  const fire = (type: string) => {
    for (const fn of [...(listeners[type] ?? [])]) fn();
  };
  const asHash = (url: unknown) => {
    const s = String(url);
    return s.startsWith('#') ? s : `#${s}`;
  };
  const push = (hash: string, state: unknown) => {
    entries.length = index + 1; // a new entry drops the forward stack
    entries.push({ hash, state });
    index += 1;
  };
  const win = {
    location: {
      get hash() {
        return entries[index]!.hash;
      },
      set hash(v: string) {
        const next = asHash(v);
        if (entries[index]!.hash === next) return;
        push(next, null); // a raw hash assignment carries no state
        fire('hashchange');
      },
    },
    history: {
      get state() {
        return entries[index]!.state;
      },
      get length() {
        return entries.length;
      },
      pushState(state: unknown, _title: string, url?: string) {
        push(url === undefined ? entries[index]!.hash : asHash(url), state);
      },
      replaceState(state: unknown, _title: string, url?: string) {
        entries[index] = {
          hash: url === undefined ? entries[index]!.hash : asHash(url),
          state,
        };
      },
      back() {
        if (index === 0) {
          escaped = true; // left the app — the bug we are guarding against
          return;
        }
        index -= 1;
        // Browsers differ on whether one or both of these fire, and in which
        // order; firing both proves the router's handler is idempotent.
        fire('popstate');
        fire('hashchange');
      },
      forward() {
        if (index >= entries.length - 1) return;
        index += 1;
        fire('popstate');
        fire('hashchange');
      },
    },
    addEventListener(type: string, fn: () => void) {
      (listeners[type] ??= []).push(fn);
    },
    removeEventListener(type: string, fn: () => void) {
      listeners[type] = (listeners[type] ?? []).filter((f) => f !== fn);
    },
  };
  return {
    win,
    get hash() {
      return entries[index]!.hash;
    },
    get depthOfStack() {
      return entries.length;
    },
    get escaped() {
      return escaped;
    },
    entries,
  };
}

/** A fresh copy of the router module bound to `win` (its bookkeeping is module state). */
async function loadRouter(win: unknown) {
  vi.resetModules();
  vi.stubGlobal('window', win);
  return await import('../src/ui/router');
}

describe('goBack never strands the user outside the app', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('on a cold start (deep link / PWA launch) it navigates to the fallback, not out', async () => {
    const b = fakeBrowser('#/transactions?account=acc-1');
    const router = await loadRouter(b.win);

    expect(router.canGoBack()).toBe(false);
    router.goBack('/transactions');

    expect(b.escaped).toBe(false); // the whole point
    expect(b.hash).toBe('#/transactions');
    // Pushed, not replaced: the filtered view the user was sent is still there.
    expect(b.depthOfStack).toBe(2);
    b.win.history.back();
    expect(b.hash).toBe('#/transactions?account=acc-1');
  });

  it('with in-app history it is a real back step', async () => {
    const b = fakeBrowser('#/transactions');
    const router = await loadRouter(b.win);

    router.navigate('/transactions?account=acc-1');
    expect(b.hash).toBe('#/transactions?account=acc-1');
    expect(router.canGoBack()).toBe(true);

    router.goBack('/transactions');
    expect(b.hash).toBe('#/transactions');
    expect(b.escaped).toBe(false);
    // Back to the bottom of our own stack: no further in-app step exists.
    expect(router.canGoBack()).toBe(false);
  });

  it('stays honest when the user jumps back several entries at once', async () => {
    const b = fakeBrowser('#/dashboard');
    const router = await loadRouter(b.win);

    router.navigate('/transactions');
    router.navigate('/transactions?account=acc-1');
    router.navigate('/transactions?account=acc-1&status=pending');
    expect(router.canGoBack()).toBe(true);

    b.win.history.back();
    b.win.history.back();
    expect(router.canGoBack()).toBe(true);
    b.win.history.back();
    expect(b.hash).toBe('#/dashboard');
    expect(router.canGoBack()).toBe(false);

    router.goBack('/dashboard');
    expect(b.escaped).toBe(false);
  });

  it('does not trust history.length — entries from before the app do not count', async () => {
    const b = fakeBrowser('#/transactions?tag=t1');
    // The user arrived from somewhere else in the same tab: three earlier
    // entries the app knows nothing about.
    b.entries.unshift(
      { hash: '#a', state: null },
      { hash: '#b', state: null },
      { hash: '#c', state: null },
    );
    const router = await loadRouter(b.win);
    expect(b.win.history.length).toBe(4);
    expect(router.canGoBack()).toBe(false); // …and Back would leave the app
  });

  it('survives a reload three screens deep', async () => {
    const b = fakeBrowser('#/dashboard');
    const first = await loadRouter(b.win);
    first.navigate('/transactions');
    first.navigate('/transactions?account=acc-1');

    // Reload: same session history, brand-new module state.
    const reloaded = await loadRouter(b.win);
    expect(reloaded.canGoBack()).toBe(true);
    reloaded.goBack('/transactions');
    expect(b.hash).toBe('#/transactions');
    expect(b.escaped).toBe(false);
  });
});

describe('push vs replace: what Back has to step through', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.resetModules();
  });

  it('a discrete filter change adds exactly one entry', async () => {
    const b = fakeBrowser('#/transactions');
    const router = await loadRouter(b.win);
    router.navigate('/transactions?account=acc-1');
    router.navigate('/transactions?account=acc-1&category=cat-1');
    expect(b.depthOfStack).toBe(3);
  });

  it('typing (replace) leaves ONE entry, not one per keystroke', async () => {
    const b = fakeBrowser('#/transactions');
    const router = await loadRouter(b.win);
    router.navigate('/transactions?account=acc-1'); // the view to come back to

    for (const q of ['t', 'te', 'tes', 'tesc', 'tesco']) {
      router.navigate(`/transactions?account=acc-1&q=${q}`, { replace: true });
    }
    expect(b.hash).toBe('#/transactions?account=acc-1&q=tesco');
    expect(b.depthOfStack).toBe(2);

    router.goBack('/transactions');
    expect(b.hash).toBe('#/transactions'); // one Back, not five
  });

  it('navigating to the URL we are already on is a no-op (re-clicking the same account)', async () => {
    const b = fakeBrowser('#/transactions');
    const router = await loadRouter(b.win);
    router.navigate('/transactions?account=acc-1');
    const before = b.depthOfStack;

    router.navigate('/transactions?account=acc-1');
    router.navigate('/transactions?account=acc-1', { replace: true });

    expect(b.depthOfStack).toBe(before);
    expect(b.hash).toBe('#/transactions?account=acc-1'); // filter still applied
    expect(router.canGoBack()).toBe(true);
  });

  it('treats a decoded hash as the same view (browsers differ about encoding)', async () => {
    // Some browsers hand `location.hash` back with non-ASCII decoded, even
    // though we always write it encoded. That must not read as a new view.
    const b = fakeBrowser('#/transactions?q=café');
    const router = await loadRouter(b.win);
    const before = b.depthOfStack;
    router.navigate('/transactions?q=caf%C3%A9');
    expect(b.depthOfStack).toBe(before);
    // …while a genuinely different value still navigates.
    router.navigate('/transactions?q=caf%C3%A9s');
    expect(b.depthOfStack).toBe(before + 1);
  });

  it('adopts an entry it did not create (an <a href="#/x"> click)', async () => {
    const b = fakeBrowser('#/dashboard');
    const router = await loadRouter(b.win);
    expect(router.canGoBack()).toBe(false);

    b.win.location.hash = '#/transactions'; // what a plain link does
    expect(router.canGoBack()).toBe(true);

    router.goBack('/dashboard');
    expect(b.hash).toBe('#/dashboard');
    expect(b.escaped).toBe(false);
  });

  it('forward still works after a back step', async () => {
    const b = fakeBrowser('#/transactions');
    const router = await loadRouter(b.win);
    router.navigate('/transactions?account=acc-1');
    router.goBack('/transactions');
    expect(router.canGoBack()).toBe(false);

    b.win.history.forward();
    expect(b.hash).toBe('#/transactions?account=acc-1');
    expect(router.canGoBack()).toBe(true);
  });

  it('href() is unchanged for existing callers', async () => {
    const b = fakeBrowser('#/dashboard');
    const router = await loadRouter(b.win);
    expect(router.href('/reports')).toBe('#/reports');
  });
});
