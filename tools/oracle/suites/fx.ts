// Oracle: currency conversion (src/money/money.ts — makeRateLookup /
// convertMinor, D11, SPEC §6).
//
// THE DIRECTION CONVENTION IS THE WHOLE GAME. A stored rate row
// {base, quote, rate} means **1 base = rate quote**. Get it backwards and
// every figure in the app is wrong by rate², which is a factor no test that
// only ever converts one way will catch. Every direction case below is
// hand-calculated from that sentence, and the pairs (X→Y and Y→X over the same
// row) are there so an inverted port fails immediately rather than plausibly.
//
// THE MISSING RATE IS AN OUTCOME, NOT AN ERROR AND NOT A ZERO. `expect.outcome`
// is 'converted' or 'missing-rate'; a harness that maps 'missing-rate' onto 0,
// onto the unconverted amount, or onto a thrown error has NOT implemented
// SPEC §6, which requires the gap be surfaced to the user.
import { convertMinor, makeRateLookup } from '../../../src/money/money';
import type { FxRate } from '../../../src/db/types';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

interface RateRow {
  base: string;
  quote: string;
  rate: number;
}

const asFxRates = (rows: RateRow[]): FxRate[] =>
  rows.map((r) => ({
    id: `${r.base}:${r.quote}`,
    base: r.base,
    quote: r.quote,
    rate: r.rate,
    asOf: '2026-01-01T00:00:00.000Z',
    source: 'manual',
  }));

/** The result shape the fixture states, so a null is never mistaken for 0. */
const outcome = (minor: number | null): Record<string, unknown> =>
  minor === null ? { outcome: 'missing-rate' } : { outcome: 'converted', minor };

export function fxSuite(): OracleFile {
  const c = new Cases();
  // Conversions copied verbatim from src/money/money.test.ts.
  const CARRIED = new Set([
    'identity.same-currency', 'direction.usd-to-gbp', 'direction.gbp-to-usd',
    'direction.gbp-to-jpy', 'direction.jpy-to-gbp',
    'rounding.sub-unit-positive', 'rounding.sub-unit-negative', 'missing.no-row',
  ]);

  // The standard table used by most cases below.
  const table: RateRow[] = [
    { base: 'EUR', quote: 'GBP', rate: 0.85 },
    { base: 'USD', quote: 'GBP', rate: 0.79 },
    { base: 'GBP', quote: 'JPY', rate: 190.5 },
  ];
  const lookup = makeRateLookup(asFxRates(table));
  const run = (minor: number, from: string, to: string) => convertMinor(minor, from, to, lookup);

  const conv = (
    slug: string,
    describes: string,
    minor: number,
    from: string,
    to: string,
    expected: number | null,
    rates: RateRow[] = table,
    hand = true,
  ): void => {
    const l = rates === table ? lookup : makeRateLookup(asFxRates(rates));
    const actual = outcome(convertMinor(minor, from, to, l));
    const input = { minor, from, to, rates };
    if (hand) {
      c.hand(
        `fx.${slug}`, describes, 'fx.convertMinor', input, actual, outcome(expected),
        CARRIED.has(slug) ? { carriedFrom: 'src/money/money.test.ts' } : {},
      );
    }
    else c.derived(`fx.${slug}`, describes, 'fx.convertMinor', input, actual);
  };

  // ------------------------------------------------------ direction (D11)
  conv(
    'direction.base-to-quote',
    'a row {EUR,GBP,0.85} means 1 EUR = 0.85 GBP: €200.00 → £170.00',
    20_000, 'EUR', 'GBP', 17_000,
  );
  conv(
    'direction.quote-to-base',
    'the same row read backwards: £170.00 → €200.00 via 1/0.85 — an inverted port gets €144.50 here',
    17_000, 'GBP', 'EUR', 20_000,
  );
  conv(
    'direction.usd-to-gbp',
    '$10.00 at 1 USD = 0.79 GBP is £7.90',
    1_000, 'USD', 'GBP', 790,
  );
  conv(
    'direction.gbp-to-usd',
    '£7.90 back to $10.00 through the inverse of the same row',
    790, 'GBP', 'USD', 1_000,
  );
  conv(
    'direction.gbp-to-jpy',
    'a row stored the other way round: {GBP,JPY,190.5} means 1 GBP = 190.5 JPY, so £10.00 → ¥1905',
    1_000, 'GBP', 'JPY', 1_905,
  );
  conv(
    'direction.jpy-to-gbp',
    '¥1905 → £10.00: the minor-unit factors (0 decimals ↔ 2) are part of the conversion, not of the rate',
    1_905, 'JPY', 'GBP', 1_000,
  );

  // ------------------------------------------------------------- identity
  conv(
    'identity.same-currency',
    'converting a currency to itself returns the amount untouched — no rate needed, no rounding applied',
    1_234, 'GBP', 'GBP', 1_234,
  );
  conv(
    'identity.same-currency-unknown',
    'and that holds for a currency with no rate rows at all',
    999, 'CHF', 'CHF', 999,
  );

  // ------------------------------------------------------------- rounding
  conv(
    'rounding.half-up',
    'the single rounding is half AWAY from zero: 1 cent × 0.5 = 0.5 minor units → 1',
    1, 'AAA', 'GBP', 1,
    [{ base: 'AAA', quote: 'GBP', rate: 0.5 }],
  );
  conv(
    'rounding.half-down-negative',
    'and −1 cent × 0.5 = −0.5 → −1, not 0 and not −0',
    -1, 'AAA', 'GBP', -1,
    [{ base: 'AAA', quote: 'GBP', rate: 0.5 }],
  );
  conv(
    'rounding.sub-unit-positive',
    '$0.01 at 0.79 is £0.0079, which rounds UP to a penny — small amounts never round to zero silently',
    1, 'USD', 'GBP', 1,
  );
  conv(
    'rounding.sub-unit-negative',
    'the same one cent as a refund: −£0.01',
    -1, 'USD', 'GBP', -1,
  );
  conv(
    'rounding.once-not-twice',
    '£100.00 at 190.5 is ¥19050 exactly; rounding twice (per unit, then per total) would not survive this',
    10_000, 'GBP', 'JPY', 19_050,
  );
  conv(
    'rounding.three-decimal-target',
    'converting into a 3-decimal currency scales by 1000: £1.00 at 2.0 is 2.000 BHD = 2000 fils',
    100, 'GBP', 'BHD', 2_000,
    [{ base: 'GBP', quote: 'BHD', rate: 2 }],
  );
  conv(
    'rounding.zero-amount',
    'zero converts to zero in any direction',
    0, 'EUR', 'GBP', 0,
  );

  // -------------------------------------------------------- missing rates
  conv(
    'missing.no-row',
    'a currency with no rate row is an explicit MISSING-RATE outcome — never 0, never the unconverted amount',
    1_000, 'CHF', 'GBP', null,
  );
  conv(
    'missing.no-triangulation',
    'EUR→USD is NOT derived from EUR→GBP and USD→GBP: the app never invents a cross rate, it asks for one',
    20_000, 'EUR', 'USD', null,
  );
  conv(
    'missing.zero-rate-ignored',
    'a stored rate of 0 is not a rate — the row is ignored and the outcome is missing, not a division by zero',
    1_000, 'AAA', 'GBP', null,
    [{ base: 'AAA', quote: 'GBP', rate: 0 }],
  );
  conv(
    'missing.negative-rate-ignored',
    'a negative stored rate is likewise ignored rather than flipping the sign of the money',
    1_000, 'AAA', 'GBP', null,
    [{ base: 'AAA', quote: 'GBP', rate: -2 }],
  );
  conv(
    'missing.empty-table',
    'with no rates at all, any cross-currency conversion is missing',
    1, 'EUR', 'GBP', null,
    [],
  );

  // ------------------------------------------------ lookup resolution order
  conv(
    'lookup.direct-beats-inverse',
    'when both directions are stored, the DIRECT row wins — the inverse is only a fallback, so a deliberately asymmetric pair cannot be silently averaged',
    10_000, 'EUR', 'GBP', 9_000,
    [
      { base: 'EUR', quote: 'GBP', rate: 0.9 },
      { base: 'GBP', quote: 'EUR', rate: 2 },
    ],
  );
  conv(
    'lookup.inverse-of-that-pair',
    'the same table read GBP→EUR takes the direct GBP→EUR row (rate 2), NOT 1/0.9',
    10_000, 'GBP', 'EUR', 20_000,
    [
      { base: 'EUR', quote: 'GBP', rate: 0.9 },
      { base: 'GBP', quote: 'EUR', rate: 2 },
    ],
  );
  conv(
    'lookup.last-row-wins',
    'two rows for the same pair: the later row replaces the earlier one',
    10_000, 'EUR', 'GBP', 8_000,
    [
      { base: 'EUR', quote: 'GBP', rate: 0.9 },
      { base: 'EUR', quote: 'GBP', rate: 0.8 },
    ],
  );

  // A worked pair that shows conversion is NOT distributive over a sum: the
  // app converts each contribution once, so a Swift port that converts totals
  // instead will disagree here by a penny.
  const parts = [333, 333, 333];
  const perPart = parts.map((p) => run(p, 'EUR', 'GBP')!);
  c.hand(
    'fx.rounding.per-contribution-not-per-total',
    'three €3.33 lines convert to £2.83 each (sum £8.49); converting their €9.99 total in one go gives £8.49 too, but the general rule is one rounding PER converted contribution — this pair pins both figures so a port cannot pick whichever it finds easier',
    'fx.convertEach',
    { minors: parts, from: 'EUR', to: 'GBP', rates: table },
    {
      each: perPart,
      sumOfConverted: perPart.reduce((a, b) => a + b, 0),
      convertedSum: run(999, 'EUR', 'GBP'),
    },
    { each: [283, 283, 283], sumOfConverted: 849, convertedSum: 849 },
  );

  // And a case where the two genuinely differ, so the rule has teeth: three
  // $0.07 lines are £0.06 each (0.0553 → 6) and sum to £0.18, while the $0.21
  // total converts to £0.17. The app's answer is EIGHTEEN — one rounding per
  // contribution — and a port that converts totals lands a penny out.
  const odd = [7, 7, 7];
  const oddEach = odd.map((p) => run(p, 'USD', 'GBP')!);
  c.hand(
    'fx.rounding.per-contribution-differs-from-total',
    'where per-line and per-total rounding actually disagree, the app rounds PER CONTRIBUTION: three $0.07 lines are £0.18 together, not the £0.17 you get by converting $0.21 in one go',
    'fx.convertEach',
    { minors: odd, from: 'USD', to: 'GBP', rates: table },
    {
      each: oddEach,
      sumOfConverted: oddEach.reduce((a, b) => a + b, 0),
      convertedSum: run(21, 'USD', 'GBP'),
    },
    { each: [6, 6, 6], sumOfConverted: 18, convertedSum: 17 },
  );

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'fx',
    title: 'FX: rate direction, conversion rounding, and the missing-rate outcome',
    generatedFrom: ['src/money/money.ts', 'src/domain/fx.ts'],
    notes: [
      'A rate row {base, quote, rate} means 1 base = rate quote (D11).',
      'A missing rate is an OUTCOME the user is shown, never a substituted number: expect.outcome is "converted" or "missing-rate".',
      'Cross rates are never triangulated and never averaged with their inverse.',
      'Conversion happens only at display/report time; stored amounts never change currency.',
      'op fx.convertEach converts each element of `minors` independently and is included to pin that rounding is per contribution, not per total.',
    ],
    cases: c.list,
  };
}
