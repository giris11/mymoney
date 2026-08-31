// Oracle: money maths (src/money/money.ts, SPEC §6).
//
// This is the area where two implementations of "the same" rule most often
// disagree without anyone noticing, so the cases below deliberately crowd the
// boundaries rather than sampling the middle:
//  * .5 in BOTH signs (Swift's `rounded()` is half-away-from-zero, but
//    `Int(x + 0.5)`, `round()` on some platforms, and every banker's-rounding
//    helper are not — and only negative halves tell them apart);
//  * currencies whose minor unit is not 1/100 (JPY 0, BHD/KWD 3), where a
//    hard-coded ×100 survives every GBP test ever written;
//  * inputs that must FAIL (more precision than the currency has), because
//    silently rounding a user's typed amount is a data-loss bug that looks
//    like a feature.
import {
  decimalsFor,
  formatMinor,
  formatMinorPlain,
  minorFactor,
  parseAmountToMinor,
  roundHalfAwayFromZero,
  sumSplits,
} from '../../../src/money/money';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

export function moneySuite(): OracleFile {
  const c = new Cases();
  // Expectations copied verbatim from src/money/money.test.ts. Everything else
  // in this file is the same rules applied to inputs that test does not cover
  // — mostly the boundaries where a re-implementation is most likely to differ.
  const CARRIED = new Set([
    'money.decimals.gbp', 'money.decimals.jpy', 'money.decimals.bhd', 'money.decimals.unknown-code',
    'money.round.half-up-positive', 'money.round.half-up-negative', 'money.round.half-small-positive',
    'money.round.half-small-negative', 'money.round.below-half-positive', 'money.round.below-half-negative',
    'money.round.zero',
    'money.parse.plain', 'money.parse.no-decimals', 'money.parse.sub-unit', 'money.parse.grouped',
    'money.parse.negative', 'money.parse.parens-negative', 'money.parse.symbol', 'money.parse.jpy-whole',
    'money.parse.jpy-fraction-rejected', 'money.parse.bhd-three', 'money.parse.too-precise',
    'money.parse.comma-decimal', 'money.parse.comma-short', 'money.parse.empty', 'money.parse.letters',
    'money.parse.two-dots',
    'money.plain.penny', 'money.plain.negative-penny', 'money.plain.huge', 'money.plain.jpy', 'money.plain.bhd',
    'money.splits.sum-negative', 'money.splits.sum-empty',
  ]);
  const from = (id: string) => (CARRIED.has(id) ? { carriedFrom: 'src/money/money.test.ts' } : {});

  // ---------------------------------------------------------------- decimals
  const decimalCases: [string, string, number, string][] = [
    ['gbp', 'GBP', 2, 'the base currency: 2 decimals'],
    ['usd', 'USD', 2, 'an unlisted currency defaults to 2 decimals'],
    ['eur', 'EUR', 2, 'the euro is an ordinary 2-decimal currency'],
    ['jpy', 'JPY', 0, 'yen has NO minor unit — 500 minor units is ¥500, not ¥5.00'],
    ['krw', 'KRW', 0, 'the Korean won has no minor unit either'],
    ['isk', 'ISK', 0, 'Icelandic króna has no minor unit'],
    ['bhd', 'BHD', 3, 'Bahraini dinar has 3 decimals (1000 fils)'],
    ['kwd', 'KWD', 3, 'Kuwaiti dinar has 3 decimals'],
    ['tnd', 'TND', 3, 'Tunisian dinar has 3 decimals'],
    ['unknown-code', 'XYZ', 2, 'an unknown code falls back to 2 rather than throwing'],
    ['lowercase-code', 'jpy', 0, 'the lookup is case-insensitive — a lowercase code is the same currency'],
  ];
  for (const [slug, currency, expected, describes] of decimalCases) {
    c.hand(
      `money.decimals.${slug}`,
      describes,
      'money.decimalsFor',
      { currency },
      { value: decimalsFor(currency) },
      { value: expected },
      from(`money.decimals.${slug}`),
    );
  }
  for (const currency of ['GBP', 'JPY', 'BHD']) {
    c.hand(
      `money.minorFactor.${currency.toLowerCase()}`,
      `one whole ${currency} is ${10 ** decimalsFor(currency)} minor unit${decimalsFor(currency) === 0 ? '' : 's'} — the factor every conversion scales by`,
      'money.minorFactor',
      { currency },
      { value: minorFactor(currency) },
      { value: 10 ** decimalsFor(currency) },
    );
  }

  // ---------------------------------------------------------------- rounding
  // Hand-calculated: half-away-from-zero is a POLICY, not an observation.
  const roundCases: [string, number, number, string][] = [
    ['half-up-positive', 2.5, 3, '2.5 rounds AWAY from zero to 3'],
    ['half-up-negative', -2.5, -3, '-2.5 rounds AWAY from zero to -3 (not -2: this is where banker’s rounding and Int(x+0.5) both break)'],
    ['half-small-positive', 0.5, 1, '0.5 rounds up to 1 — the smallest positive half'],
    ['half-small-negative', -0.5, -1, '-0.5 rounds to -1, never to 0 and never to -0'],
    ['half-odd-positive', 1.5, 2, '1.5 → 2 (banker’s rounding would also say 2 — kept as the pair for 2.5)'],
    ['half-odd-negative', -1.5, -2, '-1.5 → -2 (banker’s rounding would say -2 as well; 2.5/-2.5 is the discriminating pair)'],
    ['below-half-positive', 2.4, 2, '2.4 is below the half and rounds down to 2'],
    ['below-half-negative', -2.4, -2, '-2.4 is below the half in magnitude and rounds to -2'],
    ['above-half-positive', 2.6, 3, '2.6 is above the half and rounds up to 3'],
    ['above-half-negative', -2.6, -3, '-2.6 is above the half in magnitude and rounds to -3'],
    ['zero', 0, 0, 'zero rounds to zero, with no sign attached to it'],
    ['just-below-half', 0.49999999999999994, 0, 'the largest double below 0.5 must round DOWN — the classic Math.round/Int(x+0.5) trap'],
    ['negative-just-below-half', -0.49999999999999994, 0, 'and its negative rounds to 0, never -1'],
    ['large-half', 2251799813685248.5, 2251799813685249, 'a half that is still exactly representable (2^51 + 0.5) rounds away from zero'],
    ['large-negative-half', -2251799813685248.5, -2251799813685249, 'and its negative — the sign must not be lost at scale'],
  ];
  for (const [slug, x, expected, describes] of roundCases) {
    c.hand(
      `money.round.${slug}`,
      describes,
      'money.roundHalfAwayFromZero',
      { x },
      { value: roundHalfAwayFromZero(x) },
      { value: expected },
      from(`money.round.${slug}`),
    );
  }

  // ----------------------------------------------------------------- parsing
  const parseCases: [string, string, string, 'dot' | 'comma', number | null, string][] = [
    ['plain', '12.34', 'GBP', 'dot', 1234, 'a plain decimal amount becomes minor units'],
    ['no-decimals', '12', 'GBP', 'dot', 1200, 'a whole number is scaled, not taken as minor units'],
    ['sub-unit', '0.05', 'GBP', 'dot', 5, 'a fraction below one unit: five pence is 5 minor units'],
    ['grouped', '1,234.56', 'GBP', 'dot', 123456, 'thousands separators are ignored in dot style'],
    ['negative', '-45.67', 'GBP', 'dot', -4567, 'a leading minus sign makes the amount negative'],
    ['parens-negative', '(45.67)', 'GBP', 'dot', -4567, 'accounting parentheses mean negative'],
    ['symbol', '£99.99', 'GBP', 'dot', 9999, 'a currency symbol is stripped'],
    ['leading-code', 'GBP 5.00', 'GBP', 'dot', 500, 'a leading ISO code is stripped'],
    ['trailing-code', '5.00 GBP', 'GBP', 'dot', 500, 'a trailing ISO code is stripped'],
    ['plus', '+5.00', 'GBP', 'dot', 500, 'an explicit plus is allowed'],
    ['short-fraction', '1.5', 'GBP', 'dot', 150, 'a one-digit fraction is padded, not truncated'],
    ['bare-fraction', '.5', 'GBP', 'dot', 50, 'a leading decimal point with no integer part is allowed'],
    ['zero', '0', 'GBP', 'dot', 0, 'the string "0" parses to exactly zero minor units'],
    ['negative-zero', '-0.00', 'GBP', 'dot', 0, 'a signed zero amount is just zero (the oracle normalises IEEE -0 to 0; nothing may ever display “-£0.00”)'],
    ['jpy-whole', '500', 'JPY', 'dot', 500, 'a 0-decimal currency: ¥500 IS 500 minor units'],
    ['jpy-fraction-rejected', '500.5', 'JPY', 'dot', null, 'yen has no minor unit, so a fraction is refused rather than rounded'],
    ['bhd-three', '1.234', 'BHD', 'dot', 1234, 'a 3-decimal currency scales by 1000'],
    ['bhd-short', '1.2', 'BHD', 'dot', 1200, 'a short fraction pads to the currency’s 3 decimals'],
    ['too-precise', '1.2345', 'GBP', 'dot', null, 'more precision than the currency has is REFUSED — never silently rounded'],
    ['comma-decimal', '1.234,56', 'EUR', 'comma', 123456, 'decimal-comma style: dots group, comma is the decimal'],
    ['comma-short', '12,5', 'EUR', 'comma', 1250, 'decimal-comma with one fractional digit'],
    ['empty', '', 'GBP', 'dot', null, 'an empty string is refused, because an empty field is not a zero amount'],
    ['whitespace', '   ', 'GBP', 'dot', null, 'whitespace alone is refused for the same reason'],
    ['letters', 'abc', 'GBP', 'dot', null, 'unparseable text yields null, never 0'],
    ['two-dots', '1.2.3', 'GBP', 'dot', null, 'two decimal separators are unparseable'],
    ['huge', '99999999999999999999', 'GBP', 'dot', null, 'an amount beyond exact integer range is refused, not silently mangled'],
  ];
  for (const [slug, input, currency, decimal, expected, describes] of parseCases) {
    c.hand(
      `money.parse.${slug}`,
      describes,
      'money.parseAmountToMinor',
      { input, currency, decimal },
      { minor: parseAmountToMinor(input, currency, decimal) },
      { minor: expected },
      from(`money.parse.${slug}`),
    );
  }

  // -------------------------------------------------------------- formatting
  const plainCases: [string, number, string, string, string][] = [
    ['penny', 1, 'GBP', '0.01', 'one penny is 0.01, not 0.010000000000000002'],
    ['negative-penny', -1, 'GBP', '-0.01', 'the sign leads the whole string'],
    ['whole', 123456, 'GBP', '1234.56', 'plain formatting has no group separators'],
    ['zero', 0, 'GBP', '0.00', 'zero shows the currency’s decimals'],
    ['huge', 100000000000000, 'GBP', '1000000000000.00', 'a trillion pounds is exact — string maths, never a float'],
    ['jpy', 5, 'JPY', '5', 'a 0-decimal currency has no decimal point at all'],
    ['jpy-negative', -5, 'JPY', '-5', 'and the same value negated keeps its sign in front'],
    ['bhd', 5, 'BHD', '0.005', 'a 3-decimal currency pads to three'],
    ['bhd-whole', 1234, 'BHD', '1.234', 'a whole unit of a 3-decimal currency is 1000 minor units'],
  ];
  for (const [slug, minor, currency, expected, describes] of plainCases) {
    c.hand(
      `money.plain.${slug}`,
      describes,
      'money.formatMinorPlain',
      { minor, currency },
      { text: formatMinorPlain(minor, currency) },
      { text: expected },
      from(`money.plain.${slug}`),
    );
  }

  // ADVISORY: formatMinor goes through Intl/ICU with the en-GB locale. The
  // NUMBER is a hard requirement; the exact glyphs and their placement are the
  // platform's (Foundation renders JPY as "¥500" where ICU-en-GB says
  // "JP¥500"). A Swift harness should compare these against its own
  // NumberFormatter output and treat a difference as a locale note, not a
  // money bug — which is precisely why formatMinorPlain above is exact.
  for (const [slug, minor, currency, describes] of [
    ['gbp', 123456, 'GBP', 'en-GB puts £ before the digits and groups thousands'],
    ['gbp-negative', -4567, 'GBP', 'a negative sign precedes the symbol'],
    ['jpy', 500, 'JPY', 'a 0-decimal currency renders with no decimals'],
    ['eur', 20000, 'EUR', 'euros formatted for an en-GB reader, symbol first'],
  ] as [string, number, string, string][]) {
    c.derived(
      `money.format.${slug}`,
      describes,
      'money.formatMinor',
      { minor, currency, locale: 'en-GB' },
      { text: formatMinor(minor, currency) },
      {
        advisory: ['text'],
        note: 'Locale-dependent display string (ICU en-GB). The minor-unit value is the contract; the glyphs are the platform’s.',
      },
    );
  }

  // ------------------------------------------------------------------ splits
  c.hand(
    'money.splits.sum-negative',
    'splits sum by plain integer addition — a split transaction is valid iff this equals the parent amount',
    'money.sumSplits',
    { amounts: [-300, -700] },
    { value: sumSplits([{ amountMinor: -300 }, { amountMinor: -700 }]) },
    { value: -1000 },
    from('money.splits.sum-negative'),
  );
  c.hand(
    'money.splits.sum-mixed',
    'a refund line inside a split subtracts',
    'money.sumSplits',
    { amounts: [-6000, -4000, 1000] },
    { value: sumSplits([{ amountMinor: -6000 }, { amountMinor: -4000 }, { amountMinor: 1000 }]) },
    { value: -9000 },
  );
  c.hand(
    'money.splits.sum-empty',
    'a transaction with no splits sums to zero, not to its own amount',
    'money.sumSplits',
    { amounts: [] },
    { value: sumSplits([]) },
    { value: 0 },
    from('money.splits.sum-empty'),
  );

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'money',
    title: 'Money: parsing, formatting, rounding and minor-unit scaling',
    generatedFrom: ['src/money/money.ts'],
    notes: [
      'Amounts are ALWAYS integers in the currency’s minor units. No case here has a fractional money value.',
      'Rounding is half away from zero and is applied exactly once, at the end of a conversion or display computation.',
      'A null result means "refused": the input could not be represented without changing the user’s number.',
      'money.formatMinor cases are advisory — see the note on each.',
    ],
    cases: c.list,
  };
}
