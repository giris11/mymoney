// The oracle: language-neutral fixtures (input → expected output) generated
// FROM the TypeScript implementation, so a Swift port can be driven against
// the same cases and must produce the same answers.
//
// WHY THIS FILE EXISTS AT ALL. The 1,000-odd tests in tests/ are the most
// valuable artefact in this repo — they are a specification of the money rules
// that happens to be written in TypeScript. A Swift rewrite cannot run them.
// It can, however, run the numbers. This module is the small amount of
// machinery needed to state those numbers once, in JSON, with a stable id and
// a human sentence per case, and to guarantee the JSON never drifts from the
// code it claims to describe (tests/oracle.test.ts regenerates and compares).
//
// TWO PROVENANCES, AND THE DIFFERENCE MATTERS.
//  * 'derived'         — the expected value was captured by CALLING the real
//                        function. It proves AGREEMENT between two
//                        implementations. It cannot prove either is right.
//  * 'hand-calculated' — the expected value is a literal a human worked out
//                        (carried over from tests/golden.test.ts and friends,
//                        where the arithmetic is written out in comments).
//                        The generator still calls the implementation and
//                        REFUSES TO EMIT unless the two agree, so a
//                        hand-calculated case is a fact about the money, not
//                        about the code — and if the code ever moves away from
//                        it, generation fails loudly instead of quietly
//                        rewriting the expectation.
// A fixture generated from an implementation can only prove agreement, never
// correctness; that is exactly why the hand-calculated cases are marked and
// must never be "regenerated" into derived ones.
import { canonicalJson } from '../../src/backup/canonical';

export type Provenance = 'derived' | 'hand-calculated';

export interface OracleCase {
  /** Stable, dotted, unique across the whole oracle. Never renumber. */
  id: string;
  /** One line: what this case pins, so a Swift failure names the rule. */
  describes: string;
  /** Operation the harness must dispatch on (see tools/oracle/README.md). */
  op: string;
  /** Named arguments. */
  input: Record<string, unknown>;
  /** Expected result, always an object with named fields. */
  expect: Record<string, unknown>;
  provenance: Provenance;
  /**
   * The test file whose written-out arithmetic this expectation was copied
   * from, when there is one. These are the strongest cases in the oracle: the
   * figure was worked out by a human, in prose, BEFORE any implementation
   * agreed with it, and it has been the acceptance criterion for this app
   * since SPEC §12. A case without this key is still a human-written literal
   * (see Provenance) — just one written here rather than carried over.
   */
  carriedFrom?: string;
  /**
   * Present only when a field of `expect` is NOT a hard requirement on a
   * re-implementation — locale-formatted display strings and English warning
   * text being the two cases. Everything without this key is exact.
   */
  advisory?: string[];
  /** Optional extra context for whoever reads a failure. */
  note?: string;
}

export interface OracleFile {
  oracleVersion: number;
  area: string;
  title: string;
  /** Source files whose behaviour this fixture states. */
  generatedFrom: string[];
  notes: string[];
  /** Named books (accounts/transactions/…) referenced by `input.book`. */
  books?: Record<string, unknown>;
  cases: OracleCase[];
}

export const ORACLE_VERSION = 1;

/**
 * Plain, JSON-safe, byte-stable copy of a value.
 *
 * Sets and Maps appear in real return values (descendantIds returns a Set) and
 * JSON.stringify turns both into `{}` — silently, which is the worst possible
 * failure for a file whose whole job is to be checkable. They are converted
 * here instead. `undefined` properties are dropped rather than emitted as
 * null, because an absent optional field (CategorySpendRow.colour) and a field
 * that is null are different claims. -0 is normalised to 0: JSON has no
 * negative zero, and Swift's Double(0) == -0.0 anyway, so keeping it would
 * only make a diff appear where no disagreement exists.
 */
export function toPlain(value: unknown): unknown {
  if (value === null) return null;
  if (typeof value === 'number') return Object.is(value, -0) ? 0 : value;
  if (typeof value !== 'object') return value;
  if (value instanceof Set) return [...value].map(toPlain);
  if (value instanceof Map) {
    const out: Record<string, unknown> = {};
    for (const [k, v] of value) out[String(k)] = toPlain(v);
    return out;
  }
  if (Array.isArray(value)) return value.map(toPlain);
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (v === undefined) continue;
    out[k] = toPlain(v);
  }
  return out;
}

/** Key-order-independent equality, via the app's own canonical form. */
export function sameValue(a: unknown, b: unknown): boolean {
  return canonicalJson(toPlain(a)) === canonicalJson(toPlain(b));
}

/**
 * Accumulates the cases of one area. `derived` records what the code does;
 * `hand` records what a human calculated and checks the code still agrees.
 */
export class Cases {
  readonly list: OracleCase[] = [];

  private push(c: OracleCase): void {
    this.list.push(c);
  }

  /** Expected value captured from the real implementation. */
  derived(
    id: string,
    describes: string,
    op: string,
    input: Record<string, unknown>,
    actual: unknown,
    extra: { advisory?: string[]; note?: string } = {},
  ): void {
    this.push({
      id,
      describes,
      op,
      input: toPlain(input) as Record<string, unknown>,
      expect: toPlain(actual) as Record<string, unknown>,
      provenance: 'derived',
      ...(extra.advisory ? { advisory: extra.advisory } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    });
  }

  /**
   * Expected value written out by hand. `actual` is what the implementation
   * produces for the same input; disagreement throws, because the whole point
   * of a hand-calculated case is that the human figure wins.
   */
  hand(
    id: string,
    describes: string,
    op: string,
    input: Record<string, unknown>,
    actual: unknown,
    expected: Record<string, unknown>,
    extra: { note?: string; carriedFrom?: string } = {},
  ): void {
    if (!sameValue(actual, expected)) {
      throw new Error(
        `Oracle case ${id} is marked hand-calculated but the implementation disagrees.\n` +
          `  hand-calculated: ${canonicalJson(toPlain(expected))}\n` +
          `  implementation : ${canonicalJson(toPlain(actual))}\n` +
          'Fix the engine, or fix the arithmetic comment it came from — never ' +
          'quietly adopt the code’s answer as the expectation.',
      );
    }
    this.push({
      id,
      describes,
      op,
      input: toPlain(input) as Record<string, unknown>,
      expect: toPlain(expected) as Record<string, unknown>,
      provenance: 'hand-calculated',
      ...(extra.carriedFrom ? { carriedFrom: extra.carriedFrom } : {}),
      ...(extra.note ? { note: extra.note } : {}),
    });
  }
}

/**
 * Serialise one fixture file. Plain two-space JSON, not the sorted-key
 * canonical form: these files are read by humans reviewing a diff, and the
 * construction order (id, describes, op, input, expect) is the order that
 * makes them readable. Stability comes from the generator being deterministic,
 * and tests/oracle.test.ts proves it byte for byte.
 */
export function renderOracleFile(file: OracleFile): string {
  return JSON.stringify(toPlain(file), null, 2) + '\n';
}
