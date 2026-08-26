// Live exchange rates — the app's ONE outbound request (SPEC §2.3, D34).
//
// SPEC §8.2 files auto-FX under Phase 2; it is pulled forward because Girish
// asked for live rates (and specifically for LKR and INR). Every constraint the
// spec puts around it still holds here:
//
//   * ZERO COST — free, no-key, no-account public sources only, forever.
//   * ONE MODULE, ONE HOST — nothing else in this app ever talks to a network.
//     No analytics, no telemetry, no second endpoint.
//   * OFFLINE-FIRST — every failure path is a non-event. A refresh that cannot
//     happen returns an outcome object; it never throws, never blocks start-up,
//     and never leaves the user an error to clear. The app is fully usable with
//     the radio off; live rates are a convenience laid on top.
//   * SPEC §6 STILL RULES — conversion happens only at display/report time.
//     Rates are data; stored transactions are never rewritten by a fetch. A
//     currency the source does not carry comes back in `missing` so the UI can
//     show the "no rate" marker. A rate is never invented.
//   * MANUAL RATES ARE SACRED — a rate the user typed is their explicit
//     statement about their own money, and the app's standing rule is that
//     user-entered data is never destroyed (D19, D33). A background refresh
//     never overwrites one: it reports it in `keptManual` and moves on. Only
//     switchPairToLive(), which a person has to click, replaces one.
//
// DIRECTION — the bug this module exists in order NOT to have:
//   An fxRates row {base, quote, rate} means "1 base = rate quote" (D11), and
//   this app converts FOREIGN -> BASE, so rows are stored as
//   {base: <foreign>, quote: <baseCurrency>}. Both sources publish the opposite
//   ("1 GBP = 130.155516 INR"), so every fetched number is INVERTED before it
//   is stored: rate = 1 / apiRate. Storing the raw API number would multiply an
//   INR balance by ~130 instead of dividing by it — a silently, wildly wrong
//   net worth. tests/fx-auto.test.ts proves the whole chain end to end, from
//   raw payload through makeRateLookup/convertMinor.
//
// CADENCE — both sources publish DAILY reference rates, not intraday ticks.
//   UI copy must say "daily rates, updated <when>", never imply live ticks.

import { db, getSettings } from '../db/db';
import type { FxRate } from '../db/types';
import { nowISO } from '../lib/util';

/**
 * How old the last successful sync may get before a start-up refresh is worth
 * making. The sources publish once a day, so 6h keeps a once-a-day app feeling
 * current (open it after breakfast, get today's rates) without hammering a free
 * service: at most four requests a day, and only when the app is actually
 * opened.
 */
export const FX_REFRESH_INTERVAL_MS = 6 * 60 * 60 * 1000;

/** A hung request must never wedge start-up, so every fetch is on a leash. */
export const FX_FETCH_TIMEOUT_MS = 8000;

// ---------------------------------------------------------------------------
// Sources
// ---------------------------------------------------------------------------

/** Rates exactly as the source publishes them: 1 <base> = rates[CUR] <CUR>. */
export interface FxSourceResult {
  /** UPPERCASE ISO code -> units of that currency per 1 unit of base. */
  rates: Record<string, number>;
  /** When the source says these rates were struck, as an ISO timestamp. */
  asOf: string;
  /** Human-readable, shown in Settings ("Rates from …"). */
  sourceName: string;
}

export interface FxSourceDef {
  id: string;
  name: string;
  url: (base: string) => string;
  /** Throws if the payload is not the shape we expect — the caller then falls
   *  through to the next source. Never returns a partially-trusted result. */
  parse: (json: unknown, base: string) => FxSourceResult;
}

function asRecord(json: unknown): Record<string, unknown> {
  if (typeof json !== 'object' || json === null || Array.isArray(json)) {
    throw new Error('Rate source returned an unexpected shape');
  }
  return json as Record<string, unknown>;
}

/**
 * Normalise a source's rate table: UPPERCASE keys, only finite positive
 * numbers. Anything else is dropped rather than trusted — a zero, a negative,
 * a null or a string would all become a nonsense inverted rate.
 */
function normaliseRates(table: unknown): Record<string, number> {
  const rec = asRecord(table);
  const out: Record<string, number> = {};
  for (const [code, value] of Object.entries(rec)) {
    if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0) continue;
    if (!/^[A-Za-z]{3}$/.test(code)) continue;
    out[code.toUpperCase()] = value;
  }
  if (Object.keys(out).length === 0) throw new Error('Rate source returned no usable rates');
  return out;
}

/** A timestamp we can defend, or `null` — never a guess dressed up as data. */
function toISO(value: unknown): string | null {
  if (typeof value === 'number' && Number.isFinite(value)) {
    // Unix seconds (open.er-api.com's time_last_update_unix).
    const ms = value * 1000;
    if (!Number.isFinite(ms)) return null;
    const d = new Date(ms);
    return Number.isNaN(d.getTime()) ? null : d.toISOString();
  }
  if (typeof value !== 'string' || !value.trim()) return null;
  // A bare 'YYYY-MM-DD' (the fallback's `date`) is a UTC calendar day, not a
  // local one — pinning it to midnight UTC keeps asOf stable across timezones.
  const raw = /^\d{4}-\d{2}-\d{2}$/.test(value.trim()) ? `${value.trim()}T00:00:00Z` : value;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? new Date(t).toISOString() : null;
}

/**
 * Verified live at build time (SPEC §8.2 requires checking availability):
 * both are free, key-less, account-less, send `access-control-allow-origin: *`
 * and carry LKR and INR. Primary first; the fallback exists so one CDN having a
 * bad afternoon is not visible to the user.
 *
 * NOT USED, deliberately: the jsDelivr `@latest` mirror of the fallback data —
 * it ships a 7-day browser cache, which would quietly serve week-old rates.
 */
export const FX_SOURCES: FxSourceDef[] = [
  {
    id: 'er-api',
    name: 'open.er-api.com',
    url: (base) => `https://open.er-api.com/v6/latest/${base.trim().toUpperCase()}`,
    parse: (json, base) => {
      const o = asRecord(json);
      if (typeof o.result === 'string' && o.result !== 'success') {
        throw new Error(`Rate source reported "${o.result}"`);
      }
      // If the source answered in a different base, every number would be
      // wrong in a way nothing downstream could detect. Refuse it.
      if (typeof o.base_code === 'string' && o.base_code.toUpperCase() !== base.toUpperCase()) {
        throw new Error(`Rate source answered in ${o.base_code}, not ${base}`);
      }
      const rates = normaliseRates(o.rates ?? o.conversion_rates);
      const asOf = toISO(o.time_last_update_unix) ?? toISO(o.time_last_update_utc) ?? nowISO();
      return { rates, asOf, sourceName: 'open.er-api.com' };
    },
  },
  {
    id: 'currency-api',
    name: 'currency-api.pages.dev',
    url: (base) =>
      `https://latest.currency-api.pages.dev/v1/currencies/${base.trim().toLowerCase()}.json`,
    parse: (json, base) => {
      const o = asRecord(json);
      // This source nests the table under the LOWERCASE base code, and its
      // currency keys are lowercase too.
      const table = o[base.trim().toLowerCase()];
      if (table === undefined) throw new Error(`Rate source has no table for ${base}`);
      const rates = normaliseRates(table);
      const asOf = toISO(o.date) ?? nowISO();
      return { rates, asOf, sourceName: 'currency-api.pages.dev' };
    },
  },
];

// ---------------------------------------------------------------------------
// Outcomes
// ---------------------------------------------------------------------------

export type FxRefreshOutcome =
  | {
      ok: true;
      updatedCount: number;
      keptManual: string[];
      asOf: string;
      sourceName: string;
      missing: string[];
    }
  | {
      ok: false;
      reason: 'disabled' | 'offline' | 'unavailable' | 'nothing-to-do';
      message: string;
    };

// Messages are written for a person glancing at Settings. None of them is an
// error the user has to act on — that is the whole point of this module.
const OUTCOME = {
  disabled: {
    ok: false as const,
    reason: 'disabled' as const,
    message: 'Live rates are switched off. Your manual rates are still in use.',
  },
  offline: {
    ok: false as const,
    reason: 'offline' as const,
    message: "You're offline, so rates were left as they are.",
  },
  unavailable: {
    ok: false as const,
    reason: 'unavailable' as const,
    message: "Couldn't reach the rate service just now. Your existing rates are unchanged.",
  },
};

const nothingToDo = (message: string): FxRefreshOutcome => ({
  ok: false,
  reason: 'nothing-to-do',
  message,
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const code = (c: string | null | undefined): string => (c ?? '').trim().toUpperCase();
const isCode = (c: string): boolean => /^[A-Z]{3}$/.test(c);

/**
 * Only `false` counts as offline: `navigator.onLine === true` is a weak signal
 * (it means "there is a network interface", not "the internet works"), and in a
 * non-DOM context navigator may not exist at all. We use it purely to skip a
 * fetch we know cannot succeed.
 */
function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

async function fetchJson(url: string): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), FX_FETCH_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      signal: controller.signal,
      // Nothing about the user goes out with this request: no cookies, no
      // referrer, no headers beyond Accept. The URL carries only the base
      // currency code.
      credentials: 'omit',
      referrerPolicy: 'no-referrer',
      // Revalidate rather than reuse: a long-lived CDN cache entry would serve
      // stale rates silently, and we only ask a few times a day anyway.
      cache: 'no-cache',
      headers: { accept: 'application/json' },
    });
    if (!res.ok) throw new Error(`Rate source returned HTTP ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

/** Try each source in order; `null` when none of them produced usable rates. */
async function fetchLatestRates(base: string): Promise<FxSourceResult | null> {
  for (const source of FX_SOURCES) {
    try {
      return source.parse(await fetchJson(source.url(base)), base);
    } catch {
      // Timeout, DNS failure, blocked by an extension, 500, HTML error page,
      // garbage JSON — all the same thing here: try the next source, then give
      // up quietly. None of it is worth interrupting the user.
    }
  }
  return null;
}

/**
 * Write the fetched rates for `wanted`, inverted into this app's direction, in
 * ONE transaction, and stamp the sync on settings.
 *
 * `overwriteManual` is false for every automatic path. A manual row in EITHER
 * direction blocks the write: makeRateLookup falls back to 1/reverse, so
 * writing an auto CUR:BASE row on top of a manual BASE:CUR row would change the
 * effective rate the user set — an overwrite in all but name.
 */
async function applyRates(
  base: string,
  result: FxSourceResult,
  wanted: string[],
  overwriteManual: boolean,
): Promise<{ updatedCount: number; keptManual: string[]; missing: string[] }> {
  const keptManual: string[] = [];
  const missing: string[] = [];
  let updatedCount = 0;

  await db.transaction('rw', db.fxRates, db.settings, async () => {
    for (const cur of wanted) {
      const apiRate = result.rates[cur];
      if (typeof apiRate !== 'number' || !Number.isFinite(apiRate) || apiRate <= 0) {
        missing.push(cur); // source does not carry it — show "no rate", never a guess
        continue;
      }
      // THE INVERSION (D11). Stored unrounded: convertMinor rounds exactly once
      // at display time, and rounding here would compound that error.
      const rate = 1 / apiRate;
      if (!Number.isFinite(rate) || rate <= 0) {
        missing.push(cur);
        continue;
      }

      if (!overwriteManual) {
        // Sequential awaits, not Promise.all: only Dexie's own promises keep
        // the transaction zone alive across an await.
        const forward = await db.fxRates.get(`${cur}:${base}`);
        const reverse = await db.fxRates.get(`${base}:${cur}`);
        if (forward?.source === 'manual' || reverse?.source === 'manual') {
          keptManual.push(cur);
          continue;
        }
      }

      const row: FxRate = {
        id: `${cur}:${base}`,
        base: cur,
        quote: base,
        rate,
        asOf: result.asOf,
        source: 'auto',
      };
      await db.fxRates.put(row);
      updatedCount += 1;
    }

    // Re-read inside the transaction: the fetch above took real wall-clock
    // time, and the user may have changed a setting while it was in flight.
    const fresh = await getSettings();
    await db.settings.put({
      ...fresh,
      lastFxSyncAt: nowISO(),
      lastFxSyncSource: result.sourceName,
    });
  });

  return { updatedCount, keptManual, missing };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Distinct non-base currencies that actually appear in the user's data.
 *
 * Derived from accounts, which is authoritative: every transaction is stored in
 * its account's currency and nothing may change an account's currency once it
 * has history (D30, src/domain/accounts.ts). That keeps this a handful-of-rows
 * read instead of a full scan of a 100k-row transactions table (SPEC §9) on
 * every app start. Archived accounts count — their history still appears in
 * reports and net-worth-over-time.
 */
export async function currenciesInUse(): Promise<string[]> {
  const base = code((await getSettings()).baseCurrency);
  const seen = new Set<string>();
  for (const account of await db.accounts.toArray()) {
    const c = code(account.currency);
    if (isCode(c) && c !== base) seen.add(c);
  }
  return [...seen].sort();
}

/**
 * Fetch once and upsert a row for every currency in use against the base.
 * `force: true` runs even when the feature is switched off (used by the
 * "try now" button that turns it on).
 */
export async function refreshLiveRates(
  opts: { force?: boolean } = {},
): Promise<FxRefreshOutcome> {
  try {
    const settings = await getSettings();
    if (!settings.autoFxEnabled && !opts.force) return OUTCOME.disabled;

    const base = code(settings.baseCurrency);
    if (!isCode(base)) return nothingToDo('No base currency is set yet.');

    const wanted = await currenciesInUse();
    if (wanted.length === 0) {
      return nothingToDo('Every account is already in your base currency, so there is nothing to convert.');
    }

    if (isOffline()) return OUTCOME.offline;

    const result = await fetchLatestRates(base);
    if (!result) return OUTCOME.unavailable;

    const applied = await applyRates(base, result, wanted, false);
    return { ok: true, ...applied, asOf: result.asOf, sourceName: result.sourceName };
  } catch (e) {
    // Belt and braces: a rate refresh must never surface as a crash.
    console.warn('live rate refresh failed', e);
    return OUTCOME.unavailable;
  }
}

/** True when the last sync is missing, unreadable, or older than the interval. */
export function isStale(lastSyncAt: string | null, nowISO: string): boolean {
  if (!lastSyncAt) return true;
  const last = Date.parse(lastSyncAt);
  if (!Number.isFinite(last)) return true; // unreadable stamp ⇒ treat as never synced
  const now = Date.parse(nowISO);
  if (!Number.isFinite(now)) return true;
  // A stamp in the future means a clock changed, not that rates are old — not
  // stale, so a skewed clock cannot turn into a refresh on every single start.
  return now - last >= FX_REFRESH_INTERVAL_MS;
}

/**
 * The start-up path. Refreshes only when the feature is on AND the last sync
 * has aged out. Never throws and never rejects — callers may `void` it.
 */
export async function refreshLiveRatesIfStale(): Promise<FxRefreshOutcome> {
  try {
    const settings = await getSettings();
    if (!settings.autoFxEnabled) return OUTCOME.disabled;
    if (!isStale(settings.lastFxSyncAt, nowISO())) {
      return nothingToDo('Rates were updated recently.');
    }
    return await refreshLiveRates();
  } catch (e) {
    console.warn('live rate refresh failed', e);
    return OUTCOME.unavailable;
  }
}

/**
 * User-initiated: take the live rate for ONE pair, replacing the manual rate
 * the user had set for it. This is the only path allowed to overwrite a manual
 * row, and it fetches fresh first — so a failed fetch leaves the manual rate
 * exactly where it was rather than clearing it and finding nothing to put back.
 */
export async function switchPairToLive(quote: string): Promise<FxRefreshOutcome> {
  try {
    const settings = await getSettings();
    if (!settings.autoFxEnabled) return OUTCOME.disabled;

    const base = code(settings.baseCurrency);
    const cur = code(quote);
    if (!isCode(base)) return nothingToDo('No base currency is set yet.');
    if (cur === base) return nothingToDo(`${base} is your base currency — it needs no rate.`);
    if (!isCode(cur)) return nothingToDo(`“${quote}” is not a three-letter currency code.`);

    if (isOffline()) return OUTCOME.offline;

    const result = await fetchLatestRates(base);
    if (!result) return OUTCOME.unavailable;

    const applied = await applyRates(base, result, [cur], true);
    return { ok: true, ...applied, asOf: result.asOf, sourceName: result.sourceName };
  } catch (e) {
    console.warn('live rate switch failed', e);
    return OUTCOME.unavailable;
  }
}
