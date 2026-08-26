// Import-wizard UI rules (SPEC §7.4). The wizard's components need a DOM the
// test suite does not have, so the decisions worth protecting live in
// src/ui/import/wizardLogic.ts and are tested here directly.
import { describe, expect, it, vi } from 'vitest';
import type { ColumnMapping } from '../src/db/types';

// fileSignature stays real — only spied on, to prove headerRow reaches it.
const sigSpy = vi.hoisted(() => vi.fn());
vi.mock('../src/import/generic', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/import/generic')>();
  return {
    ...actual,
    fileSignature: (headers: string[], headerRow?: boolean) => {
      sigSpy(headers, headerRow);
      return actual.fileSignature(headers, headerRow);
    },
  };
});

const {
  DATE_FORMAT_OPTIONS,
  currencyMismatchNote,
  dateFormatLabel,
  exampleDateUnder,
  findSavedMapping,
  firstDateCell,
  needsDiscardConfirm,
  savedMappingKey,
} = await import('../src/ui/import/wizardLogic');

const mapping = (headerRow: boolean): ColumnMapping => ({
  date: 0,
  amount: 1,
  debit: -1,
  credit: -1,
  payee: 2,
  description: -1,
  category: -1,
  account: -1,
  currency: -1,
  tags: -1,
  notes: -1,
  dateFormat: 'auto',
  decimal: 'auto',
  negate: false,
  headerRow,
});

describe('discard guard (B1)', () => {
  it('protects a loaded file once the user is past the File step', () => {
    expect(needsDiscardConfirm('map', true)).toBe(true);
    expect(needsDiscardConfirm('preview', true)).toBe(true);
  });

  it('does not nag before a file is loaded, or after the import is committed', () => {
    expect(needsDiscardConfirm('file', false)).toBe(false);
    expect(needsDiscardConfirm('file', true)).toBe(false);
    expect(needsDiscardConfirm('done', true)).toBe(false);
    expect(needsDiscardConfirm('preview', false)).toBe(false);
  });
});

describe('MoneyWiz date-format control (B2)', () => {
  it('offers all three orderings with unambiguous labels', () => {
    expect(DATE_FORMAT_OPTIONS.map((o) => o.value)).toEqual(['DMY', 'MDY', 'YMD']);
    expect(dateFormatLabel('DMY')).toBe('DD/MM/YYYY');
    expect(dateFormatLabel('MDY')).toBe('MM/DD/YYYY');
  });

  it('takes the example date from the file’s Date column, skipping blanks', () => {
    const headers = ['Account', 'Date', 'Amount'];
    const data = [headers, ['Current', '', '-4.20'], ['Current', '03/04/2026', '-4.20']];
    expect(firstDateCell(data, headers)).toBe('03/04/2026');
    expect(firstDateCell(data, ['Account', 'Amount'])).toBe(null);
  });

  it('spells the example out differently under each ordering', () => {
    expect(exampleDateUnder('03/04/2026', 'DMY')).toBe('3 April 2026');
    expect(exampleDateUnder('03/04/2026', 'MDY')).toBe('4 March 2026');
    // Not a plausible YMD reading (day 2026) — nothing to show rather than a lie.
    expect(exampleDateUnder('03/04/2026', 'YMD')).toBe(null);
    expect(exampleDateUnder(null, 'DMY')).toBe(null);
  });
});

describe('saved mappings key on headerRow (B3)', () => {
  it('passes headerRow to fileSignature when saving', () => {
    sigSpy.mockClear();
    savedMappingKey(['12/01/2026', '-4.20', 'Cafe'], mapping(false));
    expect(sigSpy).toHaveBeenCalledWith(['12/01/2026', '-4.20', 'Cafe'], false);
  });

  it('passes headerRow to fileSignature when looking one up, and finds it', () => {
    const headers = ['12/01/2026', '-4.20', 'Cafe'];
    const saved = mapping(false);
    const store: Record<string, ColumnMapping> = {
      [savedMappingKey(headers, saved)]: saved,
    };
    sigSpy.mockClear();
    expect(findSavedMapping(store, headers, mapping(false))).toBe(saved);
    expect(sigSpy).toHaveBeenCalledWith(headers, false);
    expect(findSavedMapping({}, headers, mapping(true))).toBe(null);
  });
});

describe('currency-mismatch honesty (B4)', () => {
  it('says nothing when every row matches its account', () => {
    expect(currencyMismatchNote(0)).toBe(null);
  });

  it('states plainly what happens to mismatched rows', () => {
    expect(currencyMismatchNote(1)).toMatch(/^1 row is in a different currency from its account/);
    const many = currencyMismatchNote(7) ?? '';
    expect(many).toMatch(/^7 rows are in a different currency from their account/);
    expect(many).toContain('account’s currency');
  });
});
