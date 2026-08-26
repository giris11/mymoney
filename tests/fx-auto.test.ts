// Live exchange rates (D34, SPEC §2.3/§6/§8.2). The whole point of this file is
// that money must not silently change size: the sources publish "1 GBP = 130 INR"
// and this app stores "1 INR = 0.00768 GBP", so every fetched number is
// inverted. Getting that backwards would multiply an INR balance by ~130, so the
// inversion is asserted end to end — raw payload -> stored row -> makeRateLookup
// -> convertMinor — rather than just at the unit level.
//
// No test here touches the real network: fetch is stubbed in every case, and one
// test asserts that no host beyond the two verified sources is ever contacted.
import 'fake-indexeddb/auto';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { db, getSettings, updateSettings } from '../src/db/db';
import type { Account, FxRate } from '../src/db/types';
import { uid } from '../src/lib/util';
import { convertMinor, makeRateLookup } from '../src/money/money';
import { setManualRate } from '../src/domain/fx';
import {
  FX_REFRESH_INTERVAL_MS,
  FX_SOURCES,
  currenciesInUse,
  isStale,
  refreshLiveRates,
  refreshLiveRatesIfStale,
  switchPairToLive,
} from '../src/domain/fxAuto';

// --- payloads, copied from the shapes verified live at build time ------------

const PRIMARY_BODY = {
  result: 'success',
  provider: 'https://www.exchangerate-api.com',
  documentation: 'https://www.exchangerate-api.com/docs/free',
  base_code: 'GBP',
  time_last_update_utc: 'Wed, 26 Aug 2026 00:02:31 +0000',
  time_next_update_utc: 'Thu, 27 Aug 2026 00:25:02 +0000',
  rates: { GBP: 1, INR: 130.155516, LKR: 447.919196, EUR: 1.161234, USD: 1.271004 },
};
const PRIMARY_ASOF = new Date(Date.parse('Wed, 26 Aug 2026 00:02:31 +0000')).toISOString();

// Note the LOWERCASE keys — this source nests its table under the lowercase
// base code and names currencies in lowercase too.
const FALLBACK_BODY = {
  date: '2026-08-26',
  gbp: { gbp: 1, inr: 130.00569881, lkr: 447.81463557, eur: 1.16, usd: 1.2698 },
};
const FALLBACK_ASOF = '2026-08-26T00:00:00.000Z';

const isPrimary = (url: string) => url.includes('open.er-api.com');

const jsonResponse = (body: unknown, status = 200) =>
  ({ ok: status >= 200 && status < 300, status, json: async () => body }) as unknown as Response;

function stubFetch(handler: (url: string) => unknown) {
  const fn = vi.fn(async (input: unknown) => (await handler(String(input))) as Response);
  vi.stubGlobal('fetch', fn);
  return fn;
}

/** Both sources healthy. */
const healthy = () => stubFetch((url) => jsonResponse(isPrimary(url) ? PRIMARY_BODY : FALLBACK_BODY));

// --- fixtures ---------------------------------------------------------------

const clearAll = async () => {
  await Promise.all(db.tables.map((t) => t.clear()));
};

async function makeAccount(currency: string, over: Partial<Account> = {}): Promise<Account> {
  const acc: Account = {
    id: uid(),
    name: `${currency} account`,
    type: 'current',
    currency,
    openingBalanceMinor: 0,
    colour: '#336699',
    groupId: null,
    sortOrder: 0,
    archived: false,
    ...over,
  };
  await db.accounts.put(acc);
  return acc;
}

const putRate = (row: FxRate) => db.fxRates.put(row);

beforeEach(async () => {
  await clearAll();
  vi.stubGlobal('navigator', { onLine: true, userAgent: 'node' });
  await updateSettings({ baseCurrency: 'GBP', autoFxEnabled: true, lastFxSyncAt: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------

describe('sources', () => {
  it('builds the primary URL with an UPPERCASE base and the fallback with lowercase', () => {
    expect(FX_SOURCES.map((s) => s.id)).toEqual(['er-api', 'currency-api']);
    expect(FX_SOURCES[0].url('gbp')).toBe('https://open.er-api.com/v6/latest/GBP');
    expect(FX_SOURCES[1].url('GBP')).toBe(
      'https://latest.currency-api.pages.dev/v1/currencies/gbp.json',
    );
  });

  it('parses the primary shape, including its timestamp', () => {
    const parsed = FX_SOURCES[0].parse(PRIMARY_BODY, 'GBP');
    expect(parsed.rates.INR).toBeCloseTo(130.155516, 6);
    expect(parsed.rates.LKR).toBeCloseTo(447.919196, 6);
    expect(parsed.asOf).toBe(PRIMARY_ASOF);
    expect(parsed.sourceName).toBe('open.er-api.com');
  });

  it("parses the fallback shape and UPPERCASES its lowercase currency keys", () => {
    const parsed = FX_SOURCES[1].parse(FALLBACK_BODY, 'GBP');
    expect(parsed.rates.INR).toBeCloseTo(130.00569881, 6);
    expect(parsed.rates.LKR).toBeCloseTo(447.81463557, 6);
    expect(parsed.rates.inr).toBeUndefined();
    // A bare calendar date is a UTC day, so asOf is stable in any timezone.
    expect(parsed.asOf).toBe(FALLBACK_ASOF);
  });

  it('refuses a payload that answers in a different base currency', () => {
    expect(() => FX_SOURCES[0].parse({ ...PRIMARY_BODY, base_code: 'USD' }, 'GBP')).toThrow();
  });

  it('refuses an error payload, a wrong shape, and a table with nothing usable', () => {
    expect(() => FX_SOURCES[0].parse({ result: 'error', 'error-type': 'unsupported-code' }, 'GBP')).toThrow();
    expect(() => FX_SOURCES[0].parse('<!doctype html>', 'GBP')).toThrow();
    expect(() => FX_SOURCES[0].parse({ result: 'success', rates: { INR: 0, LKR: -3 } }, 'GBP')).toThrow();
    expect(() => FX_SOURCES[1].parse({ date: '2026-08-26' }, 'GBP')).toThrow(); // no table for the base
  });
});

describe('currenciesInUse', () => {
  it('returns distinct non-base currencies, sorted, including archived accounts', async () => {
    await makeAccount('GBP');
    await makeAccount('INR');
    await makeAccount('INR');
    await makeAccount('LKR', { archived: true });
    expect(await currenciesInUse()).toEqual(['INR', 'LKR']);
  });

  it('is empty when every account is already in the base currency', async () => {
    await makeAccount('GBP');
    expect(await currenciesInUse()).toEqual([]);
  });
});

describe('refreshLiveRates — the inversion (D11)', () => {
  it('stores 1/apiRate as {base: FOREIGN, quote: BASE} and converts INR correctly end to end', async () => {
    await makeAccount('GBP');
    await makeAccount('INR');
    const fetchFn = healthy();

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.updatedCount).toBe(1);
    expect(outcome.sourceName).toBe('open.er-api.com');
    expect(outcome.asOf).toBe(PRIMARY_ASOF);
    expect(fetchFn).toHaveBeenCalledTimes(1);

    const row = await db.fxRates.get('INR:GBP');
    expect(row).toBeDefined();
    expect(row!.base).toBe('INR');
    expect(row!.quote).toBe('GBP');
    expect(row!.source).toBe('auto');
    expect(row!.asOf).toBe(PRIMARY_ASOF);
    // NOT 130.155516 — the row says "1 INR = 0.00768 GBP".
    expect(row!.rate).toBeCloseTo(1 / 130.155516, 12);
    expect(row!.rate).toBeLessThan(1);

    // …and through the real lookup + converter: ₹130.15 is about £1.00.
    const lookup = makeRateLookup(await db.fxRates.toArray());
    expect(convertMinor(13015, 'INR', 'GBP', lookup)).toBe(100);
    // The reverse direction still works off the same single row.
    expect(convertMinor(100, 'GBP', 'INR', lookup)).toBe(13016);
  });

  it('converts LKR correctly end to end', async () => {
    await makeAccount('LKR');
    healthy();
    await refreshLiveRates();

    const row = await db.fxRates.get('LKR:GBP');
    expect(row!.rate).toBeCloseTo(1 / 447.919196, 12);
    const lookup = makeRateLookup(await db.fxRates.toArray());
    expect(convertMinor(44792, 'LKR', 'GBP', lookup)).toBe(100);
  });
});

describe('refreshLiveRates — manual rates are sacred', () => {
  it('never overwrites a manual row, reports it in keptManual, and still updates auto rows', async () => {
    await makeAccount('INR');
    await makeAccount('LKR');
    await setManualRate('INR', 'GBP', 0.0095); // the user's own statement
    await putRate({
      id: 'LKR:GBP',
      base: 'LKR',
      quote: 'GBP',
      rate: 0.005,
      asOf: '2020-01-01T00:00:00.000Z',
      source: 'auto',
    });
    healthy();

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.keptManual).toEqual(['INR']);
    expect(outcome.updatedCount).toBe(1);

    const manual = await db.fxRates.get('INR:GBP');
    expect(manual!.rate).toBe(0.0095);
    expect(manual!.source).toBe('manual');

    const auto = await db.fxRates.get('LKR:GBP');
    expect(auto!.source).toBe('auto');
    expect(auto!.rate).toBeCloseTo(1 / 447.919196, 12);
    expect(auto!.asOf).toBe(PRIMARY_ASOF);
  });

  it('respects a manual row stored in the REVERSE direction', async () => {
    await makeAccount('INR');
    // "1 GBP = 130 INR" — makeRateLookup answers INR->GBP from this row's
    // inverse, so writing an auto INR:GBP row would change what the user set.
    await setManualRate('GBP', 'INR', 130);
    healthy();

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.keptManual).toEqual(['INR']);
    expect(outcome.updatedCount).toBe(0);
    expect(await db.fxRates.get('INR:GBP')).toBeUndefined();
    expect((await db.fxRates.get('GBP:INR'))!.rate).toBe(130);
  });
});

describe('refreshLiveRates — missing currencies are never invented', () => {
  it('reports currencies the source does not carry and writes no row for them', async () => {
    await makeAccount('INR');
    await makeAccount('XPF'); // not in the stubbed payloads
    healthy();

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.missing).toEqual(['XPF']);
    expect(outcome.updatedCount).toBe(1);
    expect(await db.fxRates.get('XPF:GBP')).toBeUndefined();

    const lookup = makeRateLookup(await db.fxRates.toArray());
    expect(lookup('XPF', 'GBP')).toBeNull(); // ⇒ the UI shows "no rate"
  });

  it('treats a zero / negative / non-numeric published rate as missing', async () => {
    await makeAccount('INR');
    await makeAccount('LKR');
    await makeAccount('EUR');
    stubFetch(() =>
      jsonResponse({
        result: 'success',
        base_code: 'GBP',
        time_last_update_utc: PRIMARY_BODY.time_last_update_utc,
        rates: { INR: 0, LKR: -447.9, EUR: 'nonsense', USD: 1.27 },
      }),
    );

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.missing).toEqual(['EUR', 'INR', 'LKR']);
    expect(outcome.updatedCount).toBe(0);
    expect(await db.fxRates.count()).toBe(0);
  });
});

describe('refreshLiveRates — failure paths degrade quietly', () => {
  it('falls through to the fallback source when the primary throws', async () => {
    await makeAccount('INR');
    const fetchFn = stubFetch((url) => {
      if (isPrimary(url)) throw new TypeError('Failed to fetch');
      return jsonResponse(FALLBACK_BODY);
    });

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sourceName).toBe('currency-api.pages.dev');
    expect(outcome.asOf).toBe(FALLBACK_ASOF);
    expect(fetchFn).toHaveBeenCalledTimes(2);
    expect((await db.fxRates.get('INR:GBP'))!.rate).toBeCloseTo(1 / 130.00569881, 12);
  });

  it('falls through to the fallback source on a non-2xx response', async () => {
    await makeAccount('INR');
    stubFetch((url) => (isPrimary(url) ? jsonResponse({ error: 'nope' }, 503) : jsonResponse(FALLBACK_BODY)));

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.sourceName).toBe('currency-api.pages.dev');
  });

  it("returns 'unavailable' when every source fails, leaving existing rows untouched", async () => {
    await makeAccount('INR');
    const before: FxRate = {
      id: 'INR:GBP',
      base: 'INR',
      quote: 'GBP',
      rate: 0.0076,
      asOf: '2026-08-20T00:00:00.000Z',
      source: 'auto',
    };
    await putRate(before);
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    const outcome = await refreshLiveRates();
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await db.fxRates.get('INR:GBP')).toEqual(before);
    expect((await getSettings()).lastFxSyncAt).toBeNull(); // no sync ⇒ no stamp
  });

  it('a garbage payload from both sources corrupts nothing', async () => {
    await makeAccount('INR');
    const before: FxRate = {
      id: 'INR:GBP',
      base: 'INR',
      quote: 'GBP',
      rate: 0.0076,
      asOf: '2026-08-20T00:00:00.000Z',
      source: 'auto',
    };
    await putRate(before);
    stubFetch((url) =>
      jsonResponse(isPrimary(url) ? '<html>maintenance</html>' : { date: '2026-08-26', gbp: null }),
    );

    const outcome = await refreshLiveRates();
    expect(outcome).toMatchObject({ ok: false, reason: 'unavailable' });
    expect(await db.fxRates.get('INR:GBP')).toEqual(before);
    expect(await db.fxRates.count()).toBe(1);
  });

  it("returns 'offline' without attempting any fetch when the browser says so", async () => {
    await makeAccount('INR');
    vi.stubGlobal('navigator', { onLine: false, userAgent: 'node' });
    const fetchFn = healthy();

    const outcome = await refreshLiveRates();
    expect(outcome).toMatchObject({ ok: false, reason: 'offline' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it("returns 'disabled' when the feature is off, and force overrides it", async () => {
    await makeAccount('INR');
    await updateSettings({ autoFxEnabled: false });
    const fetchFn = healthy();

    expect(await refreshLiveRates()).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchFn).not.toHaveBeenCalled();

    const forced = await refreshLiveRates({ force: true });
    expect(forced.ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns 'nothing-to-do' with no fetch when no foreign currency is in use", async () => {
    await makeAccount('GBP');
    const fetchFn = healthy();

    expect(await refreshLiveRates()).toMatchObject({ ok: false, reason: 'nothing-to-do' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('only ever contacts the two verified rate hosts', async () => {
    await makeAccount('INR');
    const fetchFn = stubFetch((url) => {
      if (isPrimary(url)) throw new TypeError('Failed to fetch');
      return jsonResponse(FALLBACK_BODY);
    });
    await refreshLiveRates();

    for (const call of fetchFn.mock.calls) {
      expect(String(call[0])).toMatch(
        /^https:\/\/(open\.er-api\.com|latest\.currency-api\.pages\.dev)\//,
      );
    }
  });
});

describe('settings stamping', () => {
  it('records when and where the rates came from on success', async () => {
    await makeAccount('INR');
    healthy();
    const before = Date.now();
    await refreshLiveRates();

    const settings = await getSettings();
    expect(settings.lastFxSyncSource).toBe('open.er-api.com');
    expect(Date.parse(settings.lastFxSyncAt!)).toBeGreaterThanOrEqual(before - 1000);
  });

  it('stamps the sync even when every pair was kept manual (the source WAS reached)', async () => {
    await makeAccount('INR');
    await setManualRate('INR', 'GBP', 0.0095);
    healthy();

    const outcome = await refreshLiveRates();
    expect(outcome.ok).toBe(true);
    expect((await getSettings()).lastFxSyncAt).not.toBeNull();
  });

  it('does not clobber a setting changed while the fetch was in flight', async () => {
    await makeAccount('INR');
    stubFetch(async () => {
      // Simulates the user flipping the theme during an 8-second request.
      await updateSettings({ theme: 'dark' });
      return jsonResponse(PRIMARY_BODY);
    });

    await refreshLiveRates();
    expect((await getSettings()).theme).toBe('dark');
    expect((await getSettings()).lastFxSyncSource).toBe('open.er-api.com');
  });
});

describe('isStale', () => {
  const now = '2026-08-26T12:00:00.000Z';
  const at = (msAgo: number) => new Date(Date.parse(now) - msAgo).toISOString();

  it('is stale when never synced or when the stamp is unreadable', () => {
    expect(isStale(null, now)).toBe(true);
    expect(isStale('not a timestamp', now)).toBe(true);
    expect(isStale('', now)).toBe(true);
  });

  it('flips exactly at the six-hour interval', () => {
    expect(FX_REFRESH_INTERVAL_MS).toBe(6 * 60 * 60 * 1000);
    expect(isStale(at(FX_REFRESH_INTERVAL_MS - 1), now)).toBe(false);
    expect(isStale(at(FX_REFRESH_INTERVAL_MS), now)).toBe(true);
    expect(isStale(at(FX_REFRESH_INTERVAL_MS + 1), now)).toBe(true);
    expect(isStale(at(0), now)).toBe(false);
  });

  it('treats a future stamp (clock skew) as fresh rather than refreshing forever', () => {
    expect(isStale(at(-FX_REFRESH_INTERVAL_MS * 10), now)).toBe(false);
  });
});

describe('refreshLiveRatesIfStale — the start-up path', () => {
  it('does nothing when the last sync is recent', async () => {
    await makeAccount('INR');
    await updateSettings({ lastFxSyncAt: new Date().toISOString() });
    const fetchFn = healthy();

    expect(await refreshLiveRatesIfStale()).toMatchObject({ ok: false, reason: 'nothing-to-do' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('refreshes when the last sync has aged out', async () => {
    await makeAccount('INR');
    await updateSettings({
      lastFxSyncAt: new Date(Date.now() - FX_REFRESH_INTERVAL_MS - 1000).toISOString(),
    });
    const fetchFn = healthy();

    expect((await refreshLiveRatesIfStale()).ok).toBe(true);
    expect(fetchFn).toHaveBeenCalledTimes(1);
  });

  it("returns 'disabled' without a fetch when the feature is off", async () => {
    await makeAccount('INR');
    await updateSettings({ autoFxEnabled: false });
    const fetchFn = healthy();

    expect(await refreshLiveRatesIfStale()).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('resolves an outcome instead of throwing, whatever fetch does', async () => {
    await makeAccount('INR');
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.stubGlobal('fetch', () => {
      throw new Error('boom, synchronously');
    });

    await expect(refreshLiveRatesIfStale()).resolves.toMatchObject({ ok: false });
  });
});

describe('switchPairToLive', () => {
  it('replaces one manual rate with the live one and leaves other manual rates alone', async () => {
    await makeAccount('INR');
    await makeAccount('LKR');
    await setManualRate('INR', 'GBP', 0.0095);
    await setManualRate('LKR', 'GBP', 0.0031);
    healthy();

    const outcome = await switchPairToLive('inr');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.updatedCount).toBe(1);
    expect(outcome.keptManual).toEqual([]);

    const inr = await db.fxRates.get('INR:GBP');
    expect(inr!.source).toBe('auto');
    expect(inr!.rate).toBeCloseTo(1 / 130.155516, 12);

    const lkr = await db.fxRates.get('LKR:GBP');
    expect(lkr!.source).toBe('manual');
    expect(lkr!.rate).toBe(0.0031);
  });

  it('leaves the manual rate intact when the fetch fails', async () => {
    await makeAccount('INR');
    await setManualRate('INR', 'GBP', 0.0095);
    stubFetch(() => {
      throw new TypeError('Failed to fetch');
    });

    expect(await switchPairToLive('INR')).toMatchObject({ ok: false, reason: 'unavailable' });
    const row = await db.fxRates.get('INR:GBP');
    expect(row!.source).toBe('manual');
    expect(row!.rate).toBe(0.0095);
  });

  it('reports a pair the source does not carry as missing, writing nothing', async () => {
    await makeAccount('XPF');
    healthy();

    const outcome = await switchPairToLive('XPF');
    expect(outcome.ok).toBe(true);
    if (!outcome.ok) return;
    expect(outcome.missing).toEqual(['XPF']);
    expect(outcome.updatedCount).toBe(0);
  });

  it('refuses to reach the network when live rates are switched off', async () => {
    await makeAccount('INR');
    await updateSettings({ autoFxEnabled: false });
    const fetchFn = healthy();

    expect(await switchPairToLive('INR')).toMatchObject({ ok: false, reason: 'disabled' });
    expect(fetchFn).not.toHaveBeenCalled();
  });

  it('says there is nothing to do for the base currency itself', async () => {
    const fetchFn = healthy();
    expect(await switchPairToLive('GBP')).toMatchObject({ ok: false, reason: 'nothing-to-do' });
    expect(fetchFn).not.toHaveBeenCalled();
  });
});
