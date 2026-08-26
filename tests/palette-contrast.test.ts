// The palette in styles.css is the app's only source of colour, so AA is
// checkable statically: every text colour against every surface it can sit on,
// in its own theme (SPEC §9 — WCAG AA contrast in both themes).
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';

const css = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');

function block(selector: string): Record<string, string> {
  const start = css.indexOf(selector);
  if (start < 0) throw new Error(`palette block not found: ${selector}`);
  const open = css.indexOf('{', start);
  const close = css.indexOf('}', open);
  const vars: Record<string, string> = {};
  for (const line of css.slice(open + 1, close).split('\n')) {
    const m = /^\s*(--c-[a-z0-9-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/.exec(line);
    if (m) vars[m[1]] = m[2].toLowerCase();
  }
  return vars;
}

function relativeLuminance(hex: string): number {
  const ch = [1, 3, 5].map((i) => {
    const c = parseInt(hex.slice(i, i + 2), 16) / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}

/** WCAG 2.1 contrast ratio, 1–21. */
export function contrastRatio(a: string, b: string): number {
  const [hi, lo] = [relativeLuminance(a), relativeLuminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const themes = {
  light: block(':root {'),
  dark: block("[data-theme='dark'] {"),
};

describe('palette contrast (WCAG AA, 4.5:1 for body text)', () => {
  it('sanity-checks the ratio maths', () => {
    expect(contrastRatio('#000000', '#ffffff')).toBeCloseTo(21, 5);
    expect(contrastRatio('#ffffff', '#ffffff')).toBeCloseTo(1, 5);
  });

  for (const [theme, vars] of Object.entries(themes)) {
    for (const fg of ['--c-text', '--c-muted', '--c-faint']) {
      for (const bg of ['--c-bg', '--c-surface', '--c-surface2']) {
        it(`${theme}: ${fg} on ${bg}`, () => {
          expect(vars[fg], `${theme} ${fg} missing`).toBeTruthy();
          expect(vars[bg], `${theme} ${bg} missing`).toBeTruthy();
          const ratio = contrastRatio(vars[fg], vars[bg]);
          expect(
            Number(ratio.toFixed(2)),
            `${vars[fg]} on ${vars[bg]} is ${ratio.toFixed(2)}:1`,
          ).toBeGreaterThanOrEqual(4.5);
        });
      }
    }
  }
});
