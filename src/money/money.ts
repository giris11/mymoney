// Money maths. SPEC §6 — non-negotiable rules:
//  * every amount is an integer in the currency's minor units (pence, cents);
//  * no float arithmetic on stored amounts — floats appear ONLY transiently
//    inside a conversion, and are rounded back to an integer exactly once;
//  * rounding policy: HALF AWAY FROM ZERO (0.5 → 1, -0.5 → -1), applied once
//    at the final step of a conversion or display computation.

import type { FxRate } from '../db/types';

/** Currencies whose minor unit is not 10^-2. Everything else defaults to 2. */
const CURRENCY_DECIMALS: Record<string, number> = {
  BIF: 0, CLP: 0, DJF: 0, GNF: 0, ISK: 0, JPY: 0, KMF: 0, KRW: 0,
  PYG: 0, RWF: 0, UGX: 0, VND: 0, VUV: 0, XAF: 0, XOF: 0, XPF: 0,
  BHD: 3, IQD: 3, JOD: 3, KWD: 3, LYD: 3, OMR: 3, TND: 3,
};

export function decimalsFor(currency: string): number {
  return CURRENCY_DECIMALS[currency.toUpperCase()] ?? 2;
}

export function minorFactor(currency: string): number {
  return 10 ** decimalsFor(currency);
}

/** Round half away from zero: 2.5→3, -2.5→-3, 2.4→2, -2.4→-2. */
export function roundHalfAwayFromZero(x: number): number {
  return x < 0 ? -Math.round(-x) : Math.round(x);
}

/**
 * Parse a user-typed decimal amount ("12", "12.34", "1,234.56") into minor
 * units without float arithmetic. Returns null for unparseable input.
 * `decimal` forces the decimal separator; 'dot' is the en-GB UI default.
 */
export function parseAmountToMinor(
  input: string,
  currency: string,
  decimal: 'dot' | 'comma' = 'dot',
): number | null {
  let s = input.trim();
  if (!s) return null;
  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/[£$€¥₹\s]/g, '').replace(/[A-Za-z]{3}$/, '').replace(/^[A-Za-z]{3}/, '');
  if (s.startsWith('-')) {
    negative = !negative ? true : negative;
    s = s.slice(1);
  } else if (s.startsWith('+')) {
    s = s.slice(1);
  }
  const decSep = decimal === 'dot' ? '.' : ',';
  const groupSep = decimal === 'dot' ? ',' : '.';
  s = s.split(groupSep).join('');
  if (!s) return null;
  const parts = s.split(decSep);
  if (parts.length > 2) return null;
  const [intPart, fracRaw = ''] = parts;
  if (!/^\d*$/.test(intPart) || !/^\d*$/.test(fracRaw)) return null;
  if (intPart === '' && fracRaw === '') return null;
  const decimals = decimalsFor(currency);
  if (fracRaw.length > decimals) return null; // more precision than the currency has
  const frac = fracRaw.padEnd(decimals, '0');
  const minor = BigInt(intPart || '0') * BigInt(10 ** decimals) + BigInt(frac || '0');
  if (minor > BigInt(Number.MAX_SAFE_INTEGER)) return null;
  return negative ? -Number(minor) : Number(minor);
}

/** Format minor units for display, en-GB conventions ("£1,234.56", "-¥500"). */
export function formatMinor(minor: number, currency: string): string {
  const decimals = decimalsFor(currency);
  try {
    return new Intl.NumberFormat('en-GB', {
      style: 'currency',
      currency,
      minimumFractionDigits: decimals,
      maximumFractionDigits: decimals,
    }).format(minorToMajorNumber(minor, currency));
  } catch {
    // Unknown/invalid ISO code — never show a wrong number, fall back to plain.
    return `${currency} ${formatMinorPlain(minor, currency)}`;
  }
}

/** "1234.56"-style plain string, exact (string maths, no floats). */
export function formatMinorPlain(minor: number, currency: string): string {
  const decimals = decimalsFor(currency);
  const neg = minor < 0;
  const abs = Math.abs(minor).toString().padStart(decimals + 1, '0');
  const intPart = abs.slice(0, abs.length - decimals) || '0';
  const frac = decimals > 0 ? '.' + abs.slice(abs.length - decimals) : '';
  return `${neg ? '-' : ''}${intPart}${frac}`;
}

/** Only for handing to Intl/Recharts display — never for arithmetic. */
export function minorToMajorNumber(minor: number, currency: string): number {
  return minor / minorFactor(currency);
}

// ---------------------------------------------------------------------------
// Conversion (display/report time only — stored records never change, SPEC §6)
// ---------------------------------------------------------------------------

export type RateLookup = (from: string, to: string) => number | null;

/**
 * Build a lookup from fxRates rows. A row {base,quote,rate} means
 * 1 base = rate quote (D11). The inverse direction uses 1/rate.
 */
export function makeRateLookup(rates: FxRate[]): RateLookup {
  const direct = new Map<string, number>();
  for (const r of rates) {
    if (r.rate > 0) direct.set(`${r.base}:${r.quote}`, r.rate);
  }
  return (from, to) => {
    if (from === to) return 1;
    const d = direct.get(`${from}:${to}`);
    if (d !== undefined) return d;
    const inv = direct.get(`${to}:${from}`);
    if (inv !== undefined) return 1 / inv;
    return null;
  };
}

/**
 * Convert an amount between currencies. Returns null when no rate exists —
 * callers must then show the original currency with a "no rate" marker,
 * never a substitute number (SPEC §6).
 * Rounding half-away-from-zero happens exactly once, here.
 */
export function convertMinor(
  minor: number,
  from: string,
  to: string,
  lookup: RateLookup,
): number | null {
  if (from === to) return minor;
  const rate = lookup(from, to);
  if (rate === null) return null;
  return roundHalfAwayFromZero((minor * rate * minorFactor(to)) / minorFactor(from));
}

/** Sum splits; a transaction with splits is valid iff this equals its amount. */
export function sumSplits(splits: { amountMinor: number }[]): number {
  return splits.reduce((acc, s) => acc + s.amountMinor, 0);
}
