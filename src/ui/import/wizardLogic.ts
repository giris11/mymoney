// Pure decision logic for the import wizard, deliberately kept out of the
// components: these rules (when unsaved work exists, how a date reading is
// described, which saved mapping applies) are the parts worth unit-testing,
// and the suite runs in a node environment with no DOM.
import dayjs from 'dayjs';
import type { ColumnMapping } from '../../db/types';
import { fileSignature, parseDateString } from '../../import/generic';

export type WizardStep = 'file' | 'map' | 'preview' | 'done';

/** The three orderings a numeric date column can be read in (SPEC §7.1, D20). */
export type ImportDateFormat = 'DMY' | 'MDY' | 'YMD';

/**
 * True once the wizard holds work a stray click would destroy: a file is
 * loaded and the user has moved past the File step, but nothing has been
 * written yet (Done means committed, so there is nothing left to lose).
 */
export function needsDiscardConfirm(step: WizardStep, fileLoaded: boolean): boolean {
  return fileLoaded && (step === 'map' || step === 'preview');
}

export const DATE_FORMAT_OPTIONS: { value: ImportDateFormat; label: string }[] = [
  { value: 'DMY', label: 'DD/MM/YYYY' },
  { value: 'MDY', label: 'MM/DD/YYYY' },
  { value: 'YMD', label: 'YYYY-MM-DD' },
];

export function dateFormatLabel(fmt: ImportDateFormat): string {
  return DATE_FORMAT_OPTIONS.find((o) => o.value === fmt)?.label ?? fmt;
}

/**
 * First non-empty cell of the file's Date column — shown back to the user as
 * a worked example so an ambiguous export (03/04 could be either) can be
 * checked at a glance before importing.
 */
export function firstDateCell(data: string[][], headers: string[]): string | null {
  const col = headers.findIndex((h) => h.trim().toLowerCase() === 'date');
  if (col < 0) return null;
  for (const row of data.slice(1)) {
    const v = (row[col] ?? '').trim();
    if (v) return v;
  }
  return null;
}

/**
 * That example date spelled out under one interpretation. Long month names on
 * purpose: rendering it as DD/MM/YYYY would look identical to the raw cell and
 * prove nothing.
 */
export function exampleDateUnder(raw: string | null, fmt: ImportDateFormat): string | null {
  if (!raw) return null;
  const iso = parseDateString(raw, fmt);
  return iso ? dayjs(iso).format('D MMMM YYYY') : null;
}

/**
 * Saved-mapping key for a file. headerRow is part of the signature: a
 * headerless CSV's first row is data, so its signature must not be keyed on
 * that row's text — otherwise a saved mapping can never be found again.
 */
export function savedMappingKey(headers: string[], mapping: ColumnMapping): string {
  return fileSignature(headers, mapping.headerRow);
}

/**
 * The saved mapping for this file, if one was stored. Looked up under the
 * signature of the *guessed* mapping, since headerRow is only known from the
 * guess before the user sees the Map step.
 */
export function findSavedMapping(
  savedMappings: Record<string, ColumnMapping>,
  headers: string[],
  guessed: ColumnMapping,
): ColumnMapping | null {
  return savedMappings[savedMappingKey(headers, guessed)] ?? null;
}

/**
 * Honest note when rows carry a currency their account does not use. The
 * import is not blocked — the engine converts nothing, it writes the row in
 * the account's currency, and the user deserves to know that up front.
 */
export function currencyMismatchNote(count: number): string | null {
  if (count <= 0) return null;
  return count === 1
    ? '1 row is in a different currency from its account — it’ll be imported in the account’s currency.'
    : `${count} rows are in a different currency from their account — they’ll be imported in the account’s currency.`;
}
