// The oracle must never drift from the code it describes.
//
// tools/oracle/cases/*.json states, in a language-neutral form, what this
// app's money rules produce for a few hundred inputs — so a Swift rewrite can
// be driven against the SAME cases and must produce the SAME answers. That is
// only worth anything if the JSON still describes THIS engine. So this test
// regenerates every fixture from the live source and compares it byte for byte
// with what is committed.
//
// A failure here is not a broken test, it is a QUESTION: the engine's answers
// moved. Look at the diff and decide whether the money rules were meant to
// move. If they were, regenerate and commit; if they were not, you have just
// caught a real bug before it reached a ledger.
//
//   node_modules/.bin/vite-node tools/oracle/write.ts
//
// Regeneration is deliberately a separate command and NOT wired into `npm
// test`: a suite that rewrites its own expectations cannot fail.
import 'fake-indexeddb/auto';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { buildOracle } from '../tools/oracle/build';
import type { OracleCase } from '../tools/oracle/oracle';

const casesDir = new URL('../tools/oracle/cases/', import.meta.url);
const committed = (name: string): string =>
  readFileSync(new URL(name, casesDir), 'utf8');

// Built ONCE: the book-backed suites share a single database and must run in
// their fixed order, and re-running them per test would also triple the work.
const generated = await buildOracle();
const parsed = new Map(
  [...generated].map(([name, text]) => [name, JSON.parse(text) as Record<string, unknown>]),
);
const allCases: OracleCase[] = [...parsed]
  .filter(([name]) => name !== 'index.json')
  .flatMap(([, file]) => (file.cases as OracleCase[]) ?? []);

describe('oracle fixtures are in step with the engine', () => {
  it('emits the files the index claims, and no others', () => {
    const onDisk = readdirSync(casesDir).filter((n) => n.endsWith('.json')).sort();
    expect(onDisk).toEqual([...generated.keys()].sort());
  });

  // One test per file so a failure names the area whose numbers moved rather
  // than dumping every fixture in the repo into the terminal.
  for (const name of generated.keys()) {
    it(`${name} matches the committed fixture`, () => {
      const fresh = generated.get(name)!;
      let onDisk: string;
      try {
        onDisk = committed(name);
      } catch {
        throw new Error(
          `tools/oracle/cases/${name} is missing. Regenerate with:\n` +
            '  node_modules/.bin/vite-node tools/oracle/write.ts',
        );
      }
      if (onDisk !== fresh) {
        // Point at the first differing line: these files are thousands of
        // lines long and a raw string diff of the whole thing helps nobody.
        const a = onDisk.split('\n');
        const b = fresh.split('\n');
        const i = a.findIndex((line, idx) => line !== b[idx]);
        throw new Error(
          `tools/oracle/cases/${name} no longer matches what the engine produces.\n` +
            `First difference at line ${i + 1}:\n` +
            `  committed: ${a[i] ?? '(end of file)'}\n` +
            `  generated: ${b[i] ?? '(end of file)'}\n` +
            'If the money rules were MEANT to change, regenerate and commit:\n' +
            '  node_modules/.bin/vite-node tools/oracle/write.ts\n' +
            'If they were not, this is a real bug — the oracle just caught it.',
        );
      }
      expect(onDisk).toBe(fresh);
    });
  }
});

describe('oracle fixtures are usable by a harness that has never seen this repo', () => {
  it('every case id is unique across every file', () => {
    const ids = allCases.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('every case carries a human sentence, so a Swift failure says what broke', () => {
    for (const c of allCases) {
      expect(c.describes.length, `${c.id} has no description`).toBeGreaterThan(20);
      expect(c.op, `${c.id} has no op`).toMatch(/^[a-z]+\.[A-Za-z]+/);
      expect(typeof c.input, `${c.id} has no named inputs`).toBe('object');
      expect(Object.keys(c.expect).length, `${c.id} expects nothing`).toBeGreaterThan(0);
    }
  });

  it('every case declares its provenance, and hand-calculated ones dominate', () => {
    for (const c of allCases) {
      expect(['hand-calculated', 'derived']).toContain(c.provenance);
    }
    const hand = allCases.filter((c) => c.provenance === 'hand-calculated');
    // A fixture generated from the implementation can only prove agreement,
    // never correctness — so the oracle would be worth little if it were
    // mostly derived. This is a floor, not a target.
    expect(hand.length).toBeGreaterThan(allCases.length / 2);
  });

  it('carries the golden month’s hand-calculated figures through, marked as such', () => {
    const golden = allCases.filter((c) => c.carriedFrom === 'tests/golden.test.ts');
    // SPEC §12's acceptance figures: balances, net worth, category spend,
    // income/expense, cash flow, payee spend, net-worth series.
    expect(golden.length).toBeGreaterThanOrEqual(8);
    for (const c of golden) expect(c.provenance).toBe('hand-calculated');
    const netWorth = golden.find((c) => c.id === 'balances.golden.net-worth');
    expect(netWorth?.expect.totalBaseMinor).toBe(393_300);
  });

  it('states every area the port has to reproduce', () => {
    const index = parsed.get('index.json') as { files: { area: string }[] };
    expect(index.files.map((f) => f.area).sort()).toEqual(
      ['balances', 'budgets', 'fx', 'import', 'money', 'reports'].sort(),
    );
  });

  it('every advisory field it names actually exists in that case’s expectation', () => {
    for (const c of allCases) {
      for (const field of c.advisory ?? []) {
        expect(Object.keys(c.expect), `${c.id} marks "${field}" advisory`).toContain(field);
      }
    }
  });

  it('every book-backed case names a book its own file carries', () => {
    for (const [name, file] of parsed) {
      if (name === 'index.json') continue;
      const books = (file.books ?? {}) as Record<string, unknown>;
      for (const c of (file.cases as OracleCase[]) ?? []) {
        const book = (c.input as { book?: string }).book;
        if (book !== undefined) expect(Object.keys(books), `${c.id}`).toContain(book);
      }
    }
  });

  it('the index counts what the files actually contain', () => {
    const index = parsed.get('index.json') as {
      totalCases: number;
      handCalculated: number;
      derived: number;
      carriedFromTests: number;
      files: { file: string; caseCount: number; handCalculated: number }[];
    };
    expect(index.totalCases).toBe(allCases.length);
    expect(index.handCalculated + index.derived).toBe(index.totalCases);
    expect(index.carriedFromTests).toBe(
      allCases.filter((c) => c.carriedFrom !== undefined).length,
    );
    for (const entry of index.files) {
      const file = parsed.get(entry.file) as { cases: OracleCase[] };
      expect(file.cases.length, entry.file).toBe(entry.caseCount);
      expect(file.cases.filter((c) => c.provenance === 'hand-calculated').length).toBe(
        entry.handCalculated,
      );
    }
  });

  it('holds no timestamp, hostname or other value that would change between runs', () => {
    // The whole scheme rests on regeneration being byte-identical. A stray
    // Date.now() anywhere in the generator would make this suite fail on the
    // second day rather than on the first, which is the worst kind of flake.
    for (const [name, text] of generated) {
      expect(text, `${name} contains an ISO timestamp`).not.toMatch(
        /"\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/,
      );
    }
  });

  it('regenerating a second time produces the identical bytes', async () => {
    const again = await buildOracle();
    for (const [name, text] of generated) expect(again.get(name), name).toBe(text);
  });
});
