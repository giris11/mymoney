// Oracle: import parsing and duplicate detection (src/import/*, SPEC §7).
//
// THREE THINGS AN IMPORTER GETS WRONG, all represented here:
//
//  1. THE DATE. 05/06/2026 is the 5th of June to a British bank and the 6th of
//     May to an American one, and NOTHING in the value says which. The rule is
//     per-FILE, never per-row: scan the whole column, and only if it stays
//     ambiguous fall back to en-GB dd/mm (D20) — with the caller able to
//     override, because an all-ambiguous US export is otherwise unfixable.
//  2. THE DECIMAL SEPARATOR. "1.234" is a thousand-two-hundred-and-thirty-four
//     in Germany and one-point-two-three-four in Britain — and in a 3-decimal
//     currency it is a valid amount either way. Detection is per-file and
//     depends on how many decimals the CURRENCY has.
//  3. THE DUPLICATE. Re-importing an overlapping statement must not double the
//     ledger, and must not silently drop a real second coffee on the same day.
//     Exact (identical dedupe key) auto-skips; NEAR (same account, same
//     amount, ±1 day, similar payee) is never decided automatically.
//
// The MoneyWiz Report layout gets its own cases because it is the shape the
// owner's real 58-account export arrives in, and because it is the only format
// that states each account's closing balance — from which the opening balance
// is derived as `balance − Σ(rows)`, ORDER-INDEPENDENTLY, so that the export's
// own (wrong) running-balance column can be ignored.
import { readFileSync } from 'node:fs';
import { checkDuplicate, levenshtein, makeDedupeHash, normalizeForHash, similarPayee } from '../../../src/import/dedupe';
import {
  detectDateFormat,
  detectDecimalStyle,
  guessMapping,
  parseCsv,
  parseDateString,
  parseImportAmount,
  parseWithMapping,
} from '../../../src/import/generic';
import { isMoneyWizCsv, parseMoneyWizCsv } from '../../../src/import/moneywiz';
import { isMoneyWizReportCsv, parseMoneyWizReportCsv } from '../../../src/import/moneywizReport';
import type { Transaction } from '../../../src/db/types';
import { Cases, ORACLE_VERSION, type OracleFile } from '../oracle';

const fixture = (name: string): string =>
  readFileSync(new URL(`../../../tests/fixtures/${name}`, import.meta.url), 'utf8');

/**
 * A miniature Report export: three accounts in three currencies (2-decimal,
 * 2-decimal, and 0-decimal JPY), '►' category paths, a transfer row, and a
 * running-balance column that is deliberately never read.
 */
const MINI_REPORT_CSV = [
  'sep=,',
  '"Name","Current balance","Account","Transfers","Description","Payee","Category","Date","Memo","Amount","Currency","Cheque N°","Tags","Balance"',
  '"Everyday","1,350.75","GBP","","","","","","","","","","",""',
  '"","","Everyday","","March salary","Payroll","Salary","15/03/2026","","2,400.00","GBP","","work;monthly","2,400.00"',
  '"","","Everyday","","Weekly shop","Grocer","Food & Drink ► Groceries","16/03/2026","","-85.40","GBP","","","2,314.60"',
  '"","","Everyday","Savings","To savings","","","17/03/2026","monthly","-1,000.00","GBP","","","1,314.60"',
  '"Travel Wallet","12,345.67","TRY","","","","","","","","","","",""',
  '"","","Travel Wallet","","Taxi","Taxi Co","Transport ► Taxi","21/03/2026","","-1,234.56","TRY","","travel","11,111.11"',
  '"Yen Pocket","5000","JPY","","","","","","","","","","",""',
  '"","","Yen Pocket","","Ramen","Ramen Shop","Food & Drink ► Dining","22/03/2026","","-1200","JPY","","","3800"',
  '',
].join('\n');

/** The same category cell with and without a '►' elsewhere in the column. */
const SLASH_PATH_CSV = [
  '"Name","Current balance","Account","Transfers","Description","Payee","Category","Date","Memo","Amount","Currency","Cheque N°","Tags","Balance"',
  '"Everyday","0.00","GBP","","","","","","","","","","",""',
  '"","","Everyday","","One","Shop","Home/Repairs","01/03/2026","","-10.00","GBP","","",""',
  '',
].join('\n');
/** The same file with one '►' row added, and nothing else changed. */
const ARROW_PATH_CSV = [
  '"Name","Current balance","Account","Transfers","Description","Payee","Category","Date","Memo","Amount","Currency","Cheque N°","Tags","Balance"',
  '"Everyday","0.00","GBP","","","","","","","","","","",""',
  '"","","Everyday","","One","Shop","Home/Repairs","01/03/2026","","-10.00","GBP","","",""',
  '"","","Everyday","","Two","Shop","Bills ► Water","02/03/2026","","-20.00","GBP","","",""',
  '',
].join('\n');

const txOf = (
  x: { id: string; accountId: string; date: string; amountMinor: number; payeeName: string },
): Transaction => ({
  id: x.id,
  accountId: x.accountId,
  date: x.date,
  amountMinor: x.amountMinor,
  currency: 'GBP',
  payeeId: null,
  categoryId: null,
  tagIds: [],
  notes: '',
  status: 'cleared',
  splits: [],
  transferGroupId: null,
  importBatchId: null,
  dedupeHash: makeDedupeHash(x.accountId, x.date, x.amountMinor, x.payeeName),
  createdAt: '2026-01-01T00:00:00.000Z',
  updatedAt: '2026-01-01T00:00:00.000Z',
});

export function importSuite(): OracleFile {
  const c = new Cases();

  // =========================================================== dedupe keys
  const normCases: [string, string, string, string][] = [
    ['punctuation', 'Tesco Extra #123 ', 'tesco extra 123', 'case folded, punctuation dropped, whitespace collapsed and trimmed'],
    ['spacing', '  CARD   PURCHASE  ', 'card purchase', 'runs of whitespace collapse to one space'],
    ['accents', 'Café Paris', 'café paris', 'letters keep their accents — only punctuation and symbols go'],
    ['symbols', 'AMZN Mktp UK*2K4L9', 'amzn mktp uk2k4l9', 'a reference code loses its symbols but keeps its digits'],
    ['digits-only', '12345', '12345', 'a purely numeric reference keeps every digit'],
    ['empty', '   ', '', 'whitespace normalises to the empty key'],
  ];
  for (const [slug, input, expected, describes] of normCases) {
    c.hand(`import.normalize.${slug}`, describes, 'import.normalizeForHash', { input }, { value: normalizeForHash(input) }, { value: expected });
  }
  c.hand(
    'import.dedupe-hash.shape',
    'the dedupe key is the readable string accountId|date|amountMinor|normalised-payee (D10) — not a digest, so a mismatch can be read by a human',
    'import.makeDedupeHash',
    { accountId: 'acc1', date: '2026-03-05', amountMinor: -4567, payeeOrDescription: 'Tesco Extra #123' },
    { value: makeDedupeHash('acc1', '2026-03-05', -4567, 'Tesco Extra #123') },
    { value: 'acc1|2026-03-05|-4567|tesco extra 123' },
  );
  c.hand(
    'import.dedupe-hash.sign-matters',
    'the sign is part of the key: a £45.67 refund is not a duplicate of a £45.67 charge',
    'import.makeDedupeHash',
    { accountId: 'acc1', date: '2026-03-05', amountMinor: 4567, payeeOrDescription: 'Tesco' },
    { value: makeDedupeHash('acc1', '2026-03-05', 4567, 'Tesco') },
    { value: 'acc1|2026-03-05|4567|tesco' },
  );
  c.hand(
    'import.dedupe-hash.no-payee',
    'with no payee the description takes its place, so a re-import matches a manual entry made the same way',
    'import.makeDedupeHash',
    { accountId: 'acc1', date: '2026-03-05', amountMinor: -1000, payeeOrDescription: '' },
    { value: makeDedupeHash('acc1', '2026-03-05', -1000, '') },
    { value: 'acc1|2026-03-05|-1000|' },
  );

  const levCases: [string, string, string, number, string][] = [
    ['classic', 'kitten', 'sitting', 3, 'the textbook kitten/sitting distance of three edits'],
    ['identical', 'tesco', 'tesco', 0, 'identical strings are distance 0'],
    ['empty-left', '', 'abc', 3, 'an empty string is its length away'],
    ['one-edit', 'amazon', 'amazn', 1, 'one deleted character is one edit away'],
    ['transposition', 'ab', 'ba', 2, 'a transposition costs TWO edits — this is Levenshtein, not Damerau-Levenshtein'],
  ];
  for (const [slug, a, b, expected, describes] of levCases) {
    c.hand(`import.levenshtein.${slug}`, describes, 'import.levenshtein', { a, b }, { value: levenshtein(a, b) }, { value: expected });
  }

  const simCases: [string, string, string, boolean, string][] = [
    ['case', 'Tesco', 'TESCO', true, 'normalised equality — case never distinguishes payees'],
    ['containment', 'Tesco Extra', 'Tesco', true, 'the shorter contained in the longer (minimum 3 characters)'],
    ['containment-too-short', 'AB Store', 'AB', false, 'containment needs at least 3 characters, and “ab” is six edits from “ab store” — well outside the 25% threshold, so these are different payees'],
    ['typo', 'Amazon', 'Amazn', true, 'within max(1, 25% of the longer length) edits'],
    ['different', 'Tesco', 'Sainsburys', false, 'plainly different payees do not match'],
    ['punctuation', 'AMZN Mktp UK*2K4L9', 'AMZN Mktp UK 2K4L9', true, 'the same payee written with and without symbols'],
    ['both-empty', '', '', true, 'two blank payees are “the same” — the date and amount then carry the decision'],
    ['one-empty', 'Tesco', '', false, 'a blank payee never matches a named one'],
  ];
  for (const [slug, a, b, expected, describes] of simCases) {
    c.hand(`import.similar.${slug}`, describes, 'import.similarPayee', { a, b }, { value: similarPayee(a, b) }, { value: expected });
  }

  // ====================================================== duplicate checks
  const existingRaw = [
    { id: 'e1', accountId: 'acc1', date: '2026-03-05', amountMinor: -4567, payeeName: 'Tesco' },
    { id: 'e2', accountId: 'acc1', date: '2026-03-06', amountMinor: -1200, payeeName: 'Costa Coffee' },
    { id: 'e3', accountId: 'acc1', date: '2026-03-07', amountMinor: -1200, payeeName: 'Costa Coffee' },
    { id: 'e4', accountId: 'acc2', date: '2026-03-05', amountMinor: -4567, payeeName: 'Tesco' },
  ];
  const existing = existingRaw.map(txOf);
  const payeeNameOf = (t: Transaction): string =>
    existingRaw.find((x) => x.id === t.id)?.payeeName ?? '';
  const dup = (
    slug: string,
    describes: string,
    candidate: { accountId: string; date: string; amountMinor: number; payeeOrDescription: string },
    expected: { exact: boolean; nearDuplicateOfId: string | null },
  ): void => {
    const r = checkDuplicate(candidate, existing, payeeNameOf);
    c.hand(
      `import.duplicate.${slug}`,
      describes,
      'import.checkDuplicate',
      { candidate, existing: existingRaw },
      { exact: r.exact, nearDuplicateOfId: r.nearDuplicateOf?.id ?? null },
      expected,
    );
  };
  dup('exact', 'an identical dedupe key is an EXACT duplicate — auto-skipped, with a count shown', { accountId: 'acc1', date: '2026-03-05', amountMinor: -4567, payeeOrDescription: 'Tesco' }, { exact: true, nearDuplicateOfId: null });
  dup('exact-differently-written', 'the key is normalised, so “TESCO!” on the same day for the same amount is still exact', { accountId: 'acc1', date: '2026-03-05', amountMinor: -4567, payeeOrDescription: 'TESCO!' }, { exact: true, nearDuplicateOfId: null });
  dup('near-next-day', 'same account, same amount, one day apart, similar payee ⇒ NEAR duplicate: flagged for a human, never dropped and never doubled', { accountId: 'acc1', date: '2026-03-04', amountMinor: -4567, payeeOrDescription: 'Tesco Extra' }, { exact: false, nearDuplicateOfId: 'e1' });
  dup('near-prefers-same-day', 'with both a same-day and a next-day candidate, the SAME-DAY one is reported', { accountId: 'acc1', date: '2026-03-07', amountMinor: -1200, payeeOrDescription: 'Costa' }, { exact: false, nearDuplicateOfId: 'e3' });
  dup('two-days-apart', 'two days apart is not a near duplicate — the window is ±1 day', { accountId: 'acc1', date: '2026-03-03', amountMinor: -4567, payeeOrDescription: 'Tesco' }, { exact: false, nearDuplicateOfId: null });
  dup('different-amount', 'a penny different is a different transaction', { accountId: 'acc1', date: '2026-03-05', amountMinor: -4568, payeeOrDescription: 'Tesco' }, { exact: false, nearDuplicateOfId: null });
  dup('opposite-sign', 'a refund of the same magnitude is not a duplicate of the charge', { accountId: 'acc1', date: '2026-03-05', amountMinor: 4567, payeeOrDescription: 'Tesco' }, { exact: false, nearDuplicateOfId: null });
  dup('other-account', 'the same purchase on a DIFFERENT account is not a duplicate — acc2 holds an identical row and is ignored', { accountId: 'acc1', date: '2026-03-08', amountMinor: -4567, payeeOrDescription: 'Tesco' }, { exact: false, nearDuplicateOfId: null });
  dup('dissimilar-payee', 'same day and same amount but an unrelated payee is a genuine second transaction', { accountId: 'acc1', date: '2026-03-05', amountMinor: -4567, payeeOrDescription: 'Sainsburys' }, { exact: false, nearDuplicateOfId: null });

  // ============================================================ date rules
  const dateCases: [string, string, 'auto' | 'DMY' | 'MDY' | 'YMD', string | null, string][] = [
    ['dmy-unambiguous', '25/06/2026', 'auto', '2026-06-25', 'a first component above 12 settles it as dd/mm'],
    ['mdy-unambiguous', '06/25/2026', 'auto', '2026-06-25', 'a middle component above 12 settles it as mm/dd'],
    ['ambiguous-defaults-dmy', '05/06/2026', 'auto', '2026-06-05', 'ambiguous ⇒ en-GB dd/mm (D20) — the 5th of June'],
    ['ambiguous-forced-mdy', '05/06/2026', 'MDY', '2026-05-06', 'the caller can override, because an all-ambiguous US export is otherwise unfixable — the 6th of May'],
    ['iso', '2026-06-25', 'auto', '2026-06-25', 'a 4-digit lead is ISO order'],
    ['slash-ymd', '2026/06/25', 'auto', '2026-06-25', 'a 4-digit lead means ISO order even with slash separators'],
    ['dots', '25.06.2026', 'auto', '2026-06-25', 'dot separators, as continental exports write them'],
    ['dashes', '25-06-2026', 'auto', '2026-06-25', 'dash separators in day-month-year order'],
    ['two-digit-year', '25/06/26', 'auto', '2026-06-25', 'a 2-digit year is expanded, not treated as year 26'],
    ['pivot-49', '01/01/49', 'DMY', '2049-01-01', 'the 2-digit-year pivot: 49 ⇒ 2049'],
    ['pivot-50', '01/01/50', 'DMY', '1950-01-01', 'and the other side of the pivot: 50 becomes 1950'],
    ['with-time', '25/06/2026 14:30', 'auto', '2026-06-25', 'a trailing time component is dropped — the calendar date is what is stored'],
    ['month-name-short', '3 Jun 2026', 'auto', '2026-06-03', 'a spelled-out short month between day and year'],
    ['month-name-long', '3 September 2026', 'auto', '2026-09-03', 'with the month spelled out'],
    ['month-name-first', 'Jun 3, 2026', 'auto', '2026-06-03', 'a US-style month-name-first date with a comma'],
    ['leap-day-valid', '29/02/2024', 'DMY', '2024-02-29', '29 February exists in a leap year'],
    ['leap-day-invalid', '29/02/2023', 'DMY', null, 'and does not in a common year — the row is refused, not shifted to 1 March'],
    ['impossible', '31/02/2026', 'DMY', null, 'an impossible date is refused'],
    ['three-digit-year', '25/06/226', 'auto', null, 'a 3-digit year is refused rather than guessed at'],
    ['rubbish', 'not a date', 'auto', null, 'text that is not a date at all yields no date'],
    ['empty', '', 'auto', null, 'an empty cell has no date, and the row becomes an error'],
  ];
  for (const [slug, value, format, expected, describes] of dateCases) {
    c.hand(`import.date.${slug}`, describes, 'import.parseDateString', { value, format }, { date: parseDateString(value, format) }, { date: expected });
  }

  const detectCases: [string, string[], 'DMY' | 'MDY' | 'YMD', string][] = [
    ['dmy', ['05/06/2026', '25/06/2026', '01/02/2026'], 'DMY', 'ONE value with a first component above 12 settles the WHOLE column as dd/mm'],
    ['mdy', ['05/06/2026', '06/25/2026', '01/02/2026'], 'MDY', 'and one with a middle component above 12 settles it as mm/dd'],
    ['ymd', ['05/06/2026', '2026-06-25'], 'YMD', 'a 4-digit lead ANYWHERE in the column wins outright'],
    ['ambiguous', ['05/06/2026', '07/08/2026'], 'DMY', 'a column that stays ambiguous falls back to en-GB dd/mm'],
    ['empty', [], 'DMY', 'an empty column falls back too'],
    ['ignores-unparseable', ['not a date', '25/06/2026'], 'DMY', 'unreadable values are ignored by the vote rather than derailing it'],
  ];
  for (const [slug, values, expected, describes] of detectCases) {
    c.hand(`import.detect-date.${slug}`, describes, 'import.detectDateFormat', { values }, { value: detectDateFormat(values) }, { value: expected });
  }

  // ========================================================= decimal rules
  const decCases: [string, string[], number, 'dot' | 'comma', string][] = [
    ['comma-file', ['-45,67', '1.234,56', '2.500,00'], 2, 'comma', 'dots group and the comma is the decimal'],
    ['dot-file', ['1,234.56', '45.67'], 2, 'dot', 'commas group and the dot is the decimal'],
    ['thousands-comma', ['1,234', '5,678'], 2, 'dot', '“1,234” with THREE trailing digits is grouping, not a decimal — so the file is dot style'],
    ['thousands-dot', ['1.234', '5.678'], 2, 'comma', 'and “1.234” with three trailing digits in a 2-decimal currency is dot-grouping ⇒ comma style'],
    ['three-decimal-currency', ['12.345'], 3, 'dot', 'the SAME string in a 3-decimal currency is a plain amount ⇒ dot style — the currency decides'],
    ['zero-decimal-currency', ['1.234'], 0, 'comma', 'in a 0-decimal currency (JPY) no separator can be a decimal point, so every one is grouping'],
    ['no-separators', ['500', '1200'], 2, 'dot', 'a column with no separators at all defaults to dot'],
    ['mixed-last-wins', ['1.234,56'], 2, 'comma', 'when both separators appear in one value, the LAST one is the decimal'],
  ];
  for (const [slug, values, decimals, expected, describes] of decCases) {
    c.hand(`import.detect-decimal.${slug}`, describes, 'import.detectDecimalStyle', { values, decimals }, { value: detectDecimalStyle(values, decimals) }, { value: expected });
  }

  const amtCases: [string, string, string, 'auto' | 'dot' | 'comma', number | null, string][] = [
    ['comma-decimal', '-45,67', 'EUR', 'comma', -4567, 'a decimal comma with no grouping separator'],
    ['comma-grouped', '1.234,56', 'EUR', 'comma', 123456, 'dot grouping with a decimal comma'],
    ['parens', '(45.00)', 'GBP', 'dot', -4500, 'accounting parentheses are negative'],
    ['symbol-grouped', '£1,234.56', 'GBP', 'dot', 123456, 'symbol and grouping stripped'],
    ['auto-thousands', '1,234', 'GBP', 'auto', 123400, 'auto: three trailing digits after a lone comma is GROUPING — £1,234.00, not £12.34'],
    ['auto-decimal-comma', '45,67', 'GBP', 'auto', 4567, 'auto: two trailing digits after a lone comma is a DECIMAL — £45.67'],
    ['jpy-whole', '1200', 'JPY', 'dot', 1200, 'a 0-decimal currency takes the digits as they stand'],
    ['jpy-fraction', '1200.50', 'JPY', 'dot', null, 'and refuses a fraction rather than rounding it away'],
    ['bhd-three', '12.345', 'BHD', 'dot', 12345, 'a 3-decimal currency keeps all three'],
    ['gbp-too-precise', '12.3456', 'GBP', 'dot', null, 'more precision than the currency has is refused, so the row surfaces as an error'],
    ['words', 'twelve pounds', 'GBP', 'auto', null, 'words in an amount column yield no amount, so the row errors'],
    ['empty', '', 'GBP', 'auto', null, 'an empty amount cell is refused rather than read as zero'],
    ['stray-sign', '1-2', 'GBP', 'auto', null, 'a sign inside the number is refused'],
    ['negative-zero', '-0.00', 'GBP', 'dot', 0, 'a negative zero amount is plain zero'],
    ['trailing-code', '45.67 GBP', 'GBP', 'dot', 4567, 'a trailing ISO code is stripped'],
  ];
  for (const [slug, value, currency, decimal, expected, describes] of amtCases) {
    c.hand(`import.amount.${slug}`, describes, 'import.parseImportAmount', { value, currency, decimal }, { minor: parseImportAmount(value, currency, decimal) }, { minor: expected });
  }

  // ==================================================== format detection
  const reportHeaders = parseCsv(MINI_REPORT_CSV).data[0]!.map((h) => h.trim());
  const flatHeaders = parseCsv(fixture('moneywiz.csv')).data[0]!.map((h) => h.trim());
  const bankHeaders = parseCsv(fixture('generic-bank.csv')).data[0]!.map((h) => h.trim());
  const detect = (headers: string[]) => {
    const isReport = isMoneyWizReportCsv(headers);
    const isFlat = isMoneyWizCsv(headers);
    return { isReport, isFlat, chosen: isReport ? 'moneywiz-report' : isFlat ? 'moneywiz-flat' : 'generic-csv' };
  };
  c.hand(
    'import.detect-format.report-overlaps-flat',
    'THE PRECEDENCE TRAP: a Report file answers YES to the flat MoneyWiz test as well, so the Report test MUST be asked first — read with the flat parser, every account header row becomes a dateless transaction and no opening balance is ever derived',
    'import.detectFormat',
    { headers: reportHeaders },
    detect(reportHeaders),
    { isReport: true, isFlat: true, chosen: 'moneywiz-report' },
  );
  c.hand(
    'import.detect-format.flat',
    'a flat MoneyWiz export has neither a Name nor a Current balance column, so the Report test cannot steal it',
    'import.detectFormat',
    { headers: flatHeaders },
    detect(flatHeaders),
    { isReport: false, isFlat: true, chosen: 'moneywiz-flat' },
  );
  c.hand(
    'import.detect-format.generic-bank',
    'an ordinary bank CSV is neither, and goes to the mapped generic importer',
    'import.detectFormat',
    { headers: bankHeaders },
    detect(bankHeaders),
    { isReport: false, isFlat: false, chosen: 'generic-csv' },
  );

  // ================================================= MoneyWiz Report parse
  const mini = parseMoneyWizReportCsv(MINI_REPORT_CSV);
  // Hand calculation — opening = stated current balance − Σ(that account's rows):
  //   Everyday      135075 − (240000 − 8540 − 100000 = 131460)          =    3615
  //   Travel Wallet 1234567 − (−123456)                                  = 1358023
  //   Yen Pocket    5000 − (−1200)   [JPY: 0 decimals, so 5000 IS ¥5000] =    6200
  c.hand(
    'import.report.opening-balances',
    'the reason this parser exists: opening balance = the file’s stated Current balance MINUS the sum of that account’s rows, which is order-independent and so immune to the export’s unreliable running-balance column',
    'import.reportOpeningBalances',
    { csv: MINI_REPORT_CSV },
    {
      accounts: mini.accounts.map((a) => ({
        name: a.name,
        currency: a.currency,
        currentBalanceMinor: a.currentBalanceMinor,
        openingBalanceMinor: a.openingBalanceMinor,
      })),
    },
    {
      accounts: [
        { name: 'Everyday', currency: 'GBP', currentBalanceMinor: 135_075, openingBalanceMinor: 3_615 },
        { name: 'Travel Wallet', currency: 'TRY', currentBalanceMinor: 1_234_567, openingBalanceMinor: 1_358_023 },
        { name: 'Yen Pocket', currency: 'JPY', currentBalanceMinor: 5_000, openingBalanceMinor: 6_200 },
      ],
    },
    { note: 'The account header row carries the account’s CURRENCY in the “Account” column — the trap this layout sets. Yen Pocket proves it: at 2 decimals its balance would be ¥50.00 and every figure a hundredfold wrong.' },
  );
  c.hand(
    'import.report.arrow-separator',
    'the Report export separates category levels with “►”, not “>” — a parser that splits on “/” instead mints a top-level category called “Food & Drink ► Groceries”',
    'import.reportCategoryPaths',
    { csv: MINI_REPORT_CSV },
    { paths: mini.rows.map((r) => r.categoryPath) },
    { paths: [['Salary'], ['Food & Drink', 'Groceries'], [], ['Transport', 'Taxi'], ['Food & Drink', 'Dining']] },
  );
  c.hand(
    'import.report.rows',
    'the rows themselves: dates read as dd/mm, amounts scaled at the ACCOUNT’s currency (¥1200 is 1200 minor units), the transfer row naming its counterpart, and tags split on “;”',
    'import.reportRows',
    { csv: MINI_REPORT_CSV },
    {
      rows: mini.rows.map((r) => ({
        index: r.index,
        date: r.date,
        amountMinor: r.amountMinor,
        currency: r.currency,
        accountName: r.accountName,
        payeeName: r.payeeName,
        tags: r.tags,
        transferAccountName: r.transferAccountName,
        error: r.error,
      })),
      warningCount: mini.warnings.length,
      detectedDateFormat: mini.detectedDateFormat,
    },
    {
      rows: [
        { index: 2, date: '2026-03-15', amountMinor: 240_000, currency: 'GBP', accountName: 'Everyday', payeeName: 'Payroll', tags: ['work', 'monthly'], transferAccountName: null, error: null },
        { index: 3, date: '2026-03-16', amountMinor: -8_540, currency: 'GBP', accountName: 'Everyday', payeeName: 'Grocer', tags: [], transferAccountName: null, error: null },
        { index: 4, date: '2026-03-17', amountMinor: -100_000, currency: 'GBP', accountName: 'Everyday', payeeName: null, tags: [], transferAccountName: 'Savings', error: null },
        { index: 6, date: '2026-03-21', amountMinor: -123_456, currency: 'TRY', accountName: 'Travel Wallet', payeeName: 'Taxi Co', tags: ['travel'], transferAccountName: null, error: null },
        { index: 8, date: '2026-03-22', amountMinor: -1_200, currency: 'JPY', accountName: 'Yen Pocket', payeeName: 'Ramen Shop', tags: [], transferAccountName: null, error: null },
      ],
      warningCount: 0,
      detectedDateFormat: 'DMY',
    },
    { note: '`index` counts DATA rows of the file including the account header rows, so the numbers a user is shown point at findable lines.' },
  );

  const slashOnly = parseMoneyWizReportCsv(SLASH_PATH_CSV);
  const withArrow = parseMoneyWizReportCsv(ARROW_PATH_CSV);
  c.hand(
    'import.report.slash-fallback',
    '“/” is a level separator ONLY when the column contains no “►” or “>” anywhere: “Home/Repairs” alone becomes two levels…',
    'import.reportCategoryPaths',
    { csv: SLASH_PATH_CSV },
    { paths: slashOnly.rows.map((r) => r.categoryPath) },
    { paths: [['Home', 'Repairs']] },
  );
  c.hand(
    'import.report.slash-not-split-when-arrow-present',
    '…and stays ONE category the moment any row in the column uses “►”, because a file that separates with “►” never means “/” as a level break',
    'import.reportCategoryPaths',
    { csv: ARROW_PATH_CSV },
    { paths: withArrow.rows.map((r) => r.categoryPath) },
    { paths: [['Home/Repairs'], ['Bills', 'Water']] },
  );

  const realReport = fixture('moneywiz-report.csv');
  const real = parseMoneyWizReportCsv(realReport);
  c.derived(
    'import.report.real-export',
    'the whole repository fixture — the shape the owner’s real 58-account export arrives in: multi-currency accounts, an unreadable amount, an impossible date, a balance-only account and an account named only by a transaction row',
    'import.parseMoneyWizReportCsv',
    { csv: realReport, dateFormat: 'auto' },
    {
      rows: real.rows,
      accounts: real.accounts,
      warnings: real.warnings,
      detectedDateFormat: real.detectedDateFormat,
    },
    {
      advisory: ['warnings'],
      note: 'The WARNING TEXT is English prose for a human and a port may word it differently; the COUNT and the conditions that raise one are the contract. Note the accounts whose openingBalanceMinor is null: an account with a row that will not import gets NO opening balance, because balance − Σ(the rows that did parse) is not an opening balance, it is that number plus the missing rows.',
    },
  );

  // ==================================================== flat MoneyWiz parse
  const flat = parseMoneyWizCsv(fixture('moneywiz.csv'));
  c.derived(
    'import.flat.real-export',
    'the flat MoneyWiz layout: “>” category paths, a Transfers column, and per-file date/decimal detection',
    'import.parseMoneyWizCsv',
    { csv: fixture('moneywiz.csv'), dateFormat: 'auto' },
    { rows: flat.rows, headers: flat.headers, warnings: flat.warnings, detectedDateFormat: flat.detectedDateFormat },
    { advisory: ['warnings'] },
  );

  // ======================================================= generic mapping
  const commaCsv = fixture('generic-decimal-comma.csv');
  const commaData = parseCsv(commaCsv).data;
  const commaMapping = guessMapping(commaData[0]!, commaData.slice(1, 6));
  const commaRows = parseWithMapping(commaData, commaMapping, 'EUR');
  c.hand(
    'import.generic.decimal-comma',
    'a German bank export: semicolon-delimited, dd.mm.yyyy dates and decimal commas — every one of those detected from the file, none of them configured',
    'import.parseWithMapping',
    { csv: commaCsv, mapping: commaMapping, fixedCurrency: 'EUR' },
    {
      rows: commaRows.map((r) => ({ index: r.index, date: r.date, amountMinor: r.amountMinor, payeeName: r.payeeName, error: r.error })),
    },
    {
      rows: [
        { index: 1, date: '2026-06-03', amountMinor: -4_567, payeeName: 'EDEKA Markt', error: null },
        { index: 2, date: '2026-06-15', amountMinor: -123_456, payeeName: 'Miete Juni', error: null },
        { index: 3, date: '2026-06-20', amountMinor: 250_000, payeeName: 'Gehalt Juni', error: null },
        { index: 4, date: '2026-06-28', amountMinor: -890, payeeName: 'Cafe Milano', error: null },
      ],
    },
    { note: '“1.234,56” is €1,234.56 here and would be €1.23 under dot-style parsing — a hundredfold error that no GBP test can catch.' },
  );
  c.derived(
    'import.generic.guess-mapping-comma',
    'the column mapping guessed for that file: a lone Description column becomes the PAYEE, since the payee is the primary label',
    'import.guessMapping',
    { headers: commaData[0], sampleRows: commaData.slice(1, 6) },
    { mapping: commaMapping },
  );

  const bankCsv = fixture('generic-bank.csv');
  const bankData = parseCsv(bankCsv).data;
  const bankMapping = guessMapping(bankData[0]!, bankData.slice(1, 6));
  const bankRows = parseWithMapping(bankData, bankMapping, 'GBP');
  c.hand(
    'import.generic.debit-credit',
    'a UK bank export with separate “Paid Out” / “Paid In” columns: money out is stored NEGATIVE and money in positive, from two columns only one of which is ever filled',
    'import.parseWithMapping',
    { csv: bankCsv, mapping: bankMapping, fixedCurrency: 'GBP' },
    { rows: bankRows.map((r) => ({ index: r.index, date: r.date, amountMinor: r.amountMinor, payeeName: r.payeeName, amountRule: r.amountRule, error: r.error })) },
    {
      rows: [
        { index: 1, date: '2026-07-01', amountMinor: -4_560, payeeName: 'TESCO STORES 3297', amountRule: 'debit', error: null },
        { index: 2, date: '2026-07-02', amountMinor: 265_000, payeeName: 'ACME LTD SALARY', amountRule: 'as-written', error: null },
        { index: 3, date: '2026-07-03', amountMinor: -320, payeeName: 'COSTA COFFEE, LEEDS', amountRule: 'debit', error: null },
        { index: 4, date: '2026-07-05', amountMinor: -840, payeeName: 'TFL TRAVEL CH', amountRule: 'debit', error: null },
        { index: 5, date: '2026-07-08', amountMinor: -1_099, payeeName: 'NETFLIX.COM', amountRule: 'debit', error: null },
        { index: 6, date: '2026-07-10', amountMinor: 5_500, payeeName: 'REFUND SPORTS DIRECT', amountRule: 'as-written', error: null },
      ],
    },
  );
  c.derived(
    'import.generic.guess-mapping-bank',
    'and the mapping guessed for it, including the debit/credit column pair',
    'import.guessMapping',
    { headers: bankData[0], sampleRows: bankData.slice(1, 6) },
    { mapping: bankMapping },
  );

  return {
    oracleVersion: ORACLE_VERSION,
    area: 'import',
    title: 'Import: dedupe keys, near-duplicate decisions, date and decimal detection, MoneyWiz layouts',
    generatedFrom: [
      'src/import/dedupe.ts',
      'src/import/generic.ts',
      'src/import/moneywiz.ts',
      'src/import/moneywizReport.ts',
    ],
    notes: [
      'Date format and decimal style are detected ONCE per file over the whole column — never per row, so one file can never mix interpretations.',
      'The dedupe key is a readable string, not a digest: accountId|date|amountMinor|normalised-payee-or-description (D10).',
      'An EXACT duplicate (identical key) is auto-skipped and counted. A NEAR duplicate (same account, same amount, ±1 day, similar payee) is always a human decision.',
      'An unparseable date or amount makes the ROW an error; it is never rounded, shifted or guessed into shape.',
      'MoneyWiz Report detection MUST be tested before flat MoneyWiz detection: a Report file passes both.',
      'In the Report layout the account header row carries the account CURRENCY in its “Account” column, and openingBalance = statedBalance − Σ(rows) — refused (null) when any of that account’s rows will not import.',
      'Ops named import.reportOpeningBalances / import.reportCategoryPaths / import.reportRows are PROJECTIONS of parseMoneyWizReportCsv’s single result, not separate functions.',
      'Warning text is English prose for a human; a re-implementation is bound by when a warning is raised, not by its wording.',
    ],
    cases: c.list,
  };
}
