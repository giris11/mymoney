import { describe, expect, it } from 'vitest';
import {
  convertMinor,
  decimalsFor,
  formatMinor,
  formatMinorPlain,
  makeRateLookup,
  parseAmountToMinor,
  roundHalfAwayFromZero,
  sumSplits,
} from './money';
import type { FxRate } from '../db/types';

describe('currency decimals', () => {
  it('defaults to 2, JPY 0, BHD 3', () => {
    expect(decimalsFor('GBP')).toBe(2);
    expect(decimalsFor('JPY')).toBe(0);
    expect(decimalsFor('BHD')).toBe(3);
    expect(decimalsFor('XYZ')).toBe(2);
  });
});

describe('roundHalfAwayFromZero', () => {
  it('rounds .5 away from zero in both signs', () => {
    expect(roundHalfAwayFromZero(2.5)).toBe(3);
    expect(roundHalfAwayFromZero(-2.5)).toBe(-3);
    expect(roundHalfAwayFromZero(0.5)).toBe(1);
    expect(roundHalfAwayFromZero(-0.5)).toBe(-1);
    expect(roundHalfAwayFromZero(2.4)).toBe(2);
    expect(roundHalfAwayFromZero(-2.4)).toBe(-2);
    expect(roundHalfAwayFromZero(0)).toBe(0);
  });
});

describe('parseAmountToMinor', () => {
  it('parses plain and grouped en-GB amounts', () => {
    expect(parseAmountToMinor('12.34', 'GBP')).toBe(1234);
    expect(parseAmountToMinor('12', 'GBP')).toBe(1200);
    expect(parseAmountToMinor('0.05', 'GBP')).toBe(5);
    expect(parseAmountToMinor('1,234.56', 'GBP')).toBe(123456);
    expect(parseAmountToMinor('-45.67', 'GBP')).toBe(-4567);
    expect(parseAmountToMinor('(45.67)', 'GBP')).toBe(-4567);
    expect(parseAmountToMinor('£99.99', 'GBP')).toBe(9999);
  });
  it('respects currency precision', () => {
    expect(parseAmountToMinor('500', 'JPY')).toBe(500);
    expect(parseAmountToMinor('500.5', 'JPY')).toBe(null); // JPY has no minor unit
    expect(parseAmountToMinor('1.234', 'BHD')).toBe(1234);
    expect(parseAmountToMinor('1.2345', 'GBP')).toBe(null);
  });
  it('parses decimal-comma style', () => {
    expect(parseAmountToMinor('1.234,56', 'EUR', 'comma')).toBe(123456);
    expect(parseAmountToMinor('12,5', 'EUR', 'comma')).toBe(1250);
  });
  it('rejects rubbish', () => {
    expect(parseAmountToMinor('', 'GBP')).toBe(null);
    expect(parseAmountToMinor('abc', 'GBP')).toBe(null);
    expect(parseAmountToMinor('1.2.3', 'GBP')).toBe(null);
  });
});

describe('formatMinor', () => {
  it('formats GBP with the £ in front', () => {
    expect(formatMinor(123456, 'GBP')).toBe('£1,234.56');
    expect(formatMinor(-4567, 'GBP')).toBe('-£45.67');
  });
  it('formats zero-decimal currencies without decimals', () => {
    // en-GB renders JPY as "JP¥" to disambiguate from other yen/yuan signs
    expect(formatMinor(500, 'JPY')).toBe('JP¥500');
    expect(formatMinor(-500, 'JPY')).toBe('-JP¥500');
  });
  it('never floats: plain formatting is exact string maths', () => {
    expect(formatMinorPlain(1, 'GBP')).toBe('0.01');
    expect(formatMinorPlain(-1, 'GBP')).toBe('-0.01');
    expect(formatMinorPlain(100000000000000, 'GBP')).toBe('1000000000000.00');
    expect(formatMinorPlain(5, 'JPY')).toBe('5');
    expect(formatMinorPlain(5, 'BHD')).toBe('0.005');
  });
});

const rates: FxRate[] = [
  { id: 'USD:GBP', base: 'USD', quote: 'GBP', rate: 0.79, asOf: '2026-01-01T00:00:00Z', source: 'manual' },
  { id: 'GBP:JPY', base: 'GBP', quote: 'JPY', rate: 190.5, asOf: '2026-01-01T00:00:00Z', source: 'manual' },
];

describe('convertMinor', () => {
  const lookup = makeRateLookup(rates);
  it('identity for same currency', () => {
    expect(convertMinor(1234, 'GBP', 'GBP', lookup)).toBe(1234);
  });
  it('uses direct rate, rounding once half-away-from-zero', () => {
    // $10.00 → £7.90
    expect(convertMinor(1000, 'USD', 'GBP', lookup)).toBe(790);
    // $0.01 → £0.0079 → £0.01
    expect(convertMinor(1, 'USD', 'GBP', lookup)).toBe(1);
    expect(convertMinor(-1, 'USD', 'GBP', lookup)).toBe(-1);
  });
  it('uses inverse of the reverse row', () => {
    // £7.90 → $10.00 via 1/0.79
    expect(convertMinor(790, 'GBP', 'USD', lookup)).toBe(1000);
  });
  it('handles different minor-unit factors', () => {
    // £10.00 → ¥1905 (0 decimals)
    expect(convertMinor(1000, 'GBP', 'JPY', lookup)).toBe(1905);
    // ¥1905 → £10.00
    expect(convertMinor(1905, 'JPY', 'GBP', lookup)).toBe(1000);
  });
  it('returns null when no rate exists — never a wrong number', () => {
    expect(convertMinor(1000, 'CHF', 'GBP', lookup)).toBe(null);
  });
});

describe('sumSplits', () => {
  it('sums signed split amounts', () => {
    expect(sumSplits([{ amountMinor: -300 }, { amountMinor: -700 }])).toBe(-1000);
    expect(sumSplits([])).toBe(0);
  });
});
