// Assemble every oracle fixture. Deterministic: the same code produces the
// same bytes, which is what lets tests/oracle.test.ts prove the committed
// files still describe the committed engine.
//
// Ordering discipline: files are built in a fixed order, and the db-backed
// suites run SEQUENTIALLY because they share one database — each loads its own
// book over the last one. Running them concurrently would interleave the
// writes and produce fixtures that look right individually and are nonsense
// together.
import { balancesSuite } from './suites/balances';
import { budgetsSuite } from './suites/budgets';
import { fxSuite } from './suites/fx';
import { importSuite } from './suites/import';
import { moneySuite } from './suites/money';
import { reportsSuite } from './suites/reports';
import { ORACLE_VERSION, renderOracleFile, type OracleFile } from './oracle';

/** Filename → JSON text, index.json included. */
export type OracleOutput = Map<string, string>;

export const CASES_DIR = 'tools/oracle/cases';

/** Every fixture file, in the order the index lists them. */
export async function buildOracleFiles(): Promise<OracleFile[]> {
  const files: OracleFile[] = [];
  files.push(moneySuite());
  files.push(fxSuite());
  // Book-backed suites share the database; keep them sequential and in order.
  files.push(await balancesSuite());
  files.push(await budgetsSuite());
  files.push(await reportsSuite());
  files.push(importSuite());
  return files;
}

/**
 * Cross-file checks that must hold before anything is written. An oracle with
 * a duplicate id is worse than no oracle: two cases would report the same
 * failure and a harness keyed on id would silently drop one.
 */
function validate(files: OracleFile[]): void {
  const seenId = new Set<string>();
  const seenArea = new Set<string>();
  for (const f of files) {
    if (seenArea.has(f.area)) throw new Error(`Two oracle files claim area "${f.area}"`);
    seenArea.add(f.area);
    if (f.cases.length === 0) throw new Error(`Oracle area "${f.area}" has no cases`);
    for (const c of f.cases) {
      if (seenId.has(c.id)) throw new Error(`Duplicate oracle case id "${c.id}"`);
      seenId.add(c.id);
      if (!c.describes.trim()) throw new Error(`Oracle case ${c.id} has no description`);
      if (!c.op.includes('.')) throw new Error(`Oracle case ${c.id} has a malformed op "${c.op}"`);
      // Every book-backed case must name a book the file actually carries.
      const book = (c.input as { book?: unknown }).book;
      if (typeof book === 'string' && !(f.books && book in f.books)) {
        throw new Error(`Oracle case ${c.id} names book "${book}", which ${f.area}.json does not carry`);
      }
    }
  }
}

/** The index: what exists, how much of it, and how much is hand-calculated. */
function indexFile(files: OracleFile[]): unknown {
  let handCalculated = 0;
  let derived = 0;
  let carriedFromTests = 0;
  const entries = files.map((f) => {
    const ops = [...new Set(f.cases.map((c) => c.op))].sort();
    const hand = f.cases.filter((c) => c.provenance === 'hand-calculated').length;
    const carried = f.cases.filter((c) => c.carriedFrom !== undefined).length;
    handCalculated += hand;
    derived += f.cases.length - hand;
    carriedFromTests += carried;
    return {
      file: `${f.area}.json`,
      area: f.area,
      title: f.title,
      caseCount: f.cases.length,
      handCalculated: hand,
      carriedFromTests: carried,
      derived: f.cases.length - hand,
      books: f.books ? Object.keys(f.books) : [],
      ops,
    };
  });
  return {
    oracleVersion: ORACLE_VERSION,
    generator: 'tools/oracle/build.ts',
    regenerate: 'node_modules/.bin/vite-node tools/oracle/write.ts',
    verify: 'npx vitest run tests/oracle.test.ts',
    // No timestamp on purpose: a generated-at field would change on every run
    // and make the "committed files are unchanged" test impossible.
    totalCases: handCalculated + derived,
    handCalculated,
    carriedFromTests,
    derived,
    files: entries,
  };
}

/** Filename → exact file text, ready to write or compare. */
export async function buildOracle(): Promise<OracleOutput> {
  const files = await buildOracleFiles();
  validate(files);
  const out: OracleOutput = new Map();
  out.set('index.json', JSON.stringify(indexFile(files), null, 2) + '\n');
  for (const f of files) out.set(`${f.area}.json`, renderOracleFile(f));
  return out;
}
