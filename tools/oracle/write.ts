// Regenerate the committed fixtures:
//
//   node_modules/.bin/vite-node tools/oracle/write.ts
//
// Deliberately NOT an npm script and NOT part of `npm test`: regenerating is a
// decision, not a side effect. The suite only ever CHECKS (tests/oracle.test.ts),
// so a change to the engine fails the build and someone has to look at the diff
// and say whether the money rules were meant to move.
//
// fake-indexeddb is imported first because the balance/budget/report suites
// compute their expected values by running the real engine against a real
// Dexie database, and there is no IndexedDB in a bare Node process.
import 'fake-indexeddb/auto';
import { mkdirSync, readdirSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { buildOracle } from './build';

const dir = new URL('./cases/', import.meta.url).pathname;
const out = await buildOracle();

mkdirSync(dir, { recursive: true });
// Remove any file the generator no longer produces, so a renamed area cannot
// leave a stale fixture behind for a harness to keep running.
for (const name of readdirSync(dir)) {
  if (name.endsWith('.json') && !out.has(name)) unlinkSync(join(dir, name));
}
let total = 0;
for (const [name, text] of out) {
  writeFileSync(join(dir, name), text, 'utf8');
  const cases = name === 'index.json' ? 0 : (JSON.parse(text) as { cases: unknown[] }).cases.length;
  total += cases;
  console.log(`${name.padEnd(16)} ${cases ? `${cases} cases` : 'index'}`);
}
console.log(`\n${total} cases written to tools/oracle/cases/`);
