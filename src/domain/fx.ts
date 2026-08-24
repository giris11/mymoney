// Manual FX rates (SPEC §8.1.4). Conversion itself lives in src/money/money.ts
// and happens only at display/report time.
import { db } from '../db/db';
import { makeRateLookup, type RateLookup } from '../money/money';
import type { FxRate } from '../db/types';
import { nowISO } from '../lib/util';

export async function rateLookup(): Promise<RateLookup> {
  return makeRateLookup(await db.fxRates.toArray());
}

export async function listRates(): Promise<FxRate[]> {
  return db.fxRates.toArray();
}

/** Upsert a manual rate: 1 `base` = `rate` `quote` (D11). */
export async function setManualRate(base: string, quote: string, rate: number): Promise<void> {
  base = base.toUpperCase();
  quote = quote.toUpperCase();
  if (!(rate > 0) || !Number.isFinite(rate)) throw new Error('Rate must be a positive number');
  if (base === quote) throw new Error('Base and quote must differ');
  await db.fxRates.put({ id: `${base}:${quote}`, base, quote, rate, asOf: nowISO(), source: 'manual' });
}

export async function removeRate(id: string): Promise<void> {
  await db.fxRates.delete(id);
}
