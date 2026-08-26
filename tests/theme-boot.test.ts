// Pre-paint theme stamping (SPEC §8.1.11, D29). The authoritative theme lives
// in IndexedDB, which is async, so index.html carries a tiny inline script that
// stamps <html data-theme> from a localStorage HINT before the first frame —
// otherwise a dark-theme user gets a white flash on every cold start. These
// tests run that script exactly as shipped, and pin the hint contract shared
// between index.html and src/ui/theme.ts.
import 'fake-indexeddb/auto';
import { readFileSync } from 'node:fs';
import { afterEach, describe, expect, it } from 'vitest';
import { readThemeHint, THEME_HINT_KEY, writeThemeHint } from '../src/ui/theme';

const html = readFileSync(new URL('../index.html', import.meta.url), 'utf8');

/** The inline (src-less) <script> from <head> — the boot script under test. */
function bootScript(): string {
  const head = html.slice(html.indexOf('<head'), html.indexOf('</head>'));
  const match = /<script>([\s\S]*?)<\/script>/.exec(head);
  if (!match) throw new Error('no inline <script> in <head> — the theme would flash on boot');
  return match[1];
}

interface RunOpts {
  hint?: string | null;
  prefersDark?: boolean;
  storageThrows?: boolean;
}

/** Execute the boot script against a minimal fake document/window. */
function runBoot({ hint = null, prefersDark = false, storageThrows = false }: RunOpts): string {
  const attrs: Record<string, string> = {};
  const documentStub = {
    documentElement: {
      dataset: {} as Record<string, string>,
      setAttribute: (name: string, value: string) => {
        attrs[name] = value;
      },
    },
  };
  const windowStub = {
    localStorage: {
      getItem: (key: string) => {
        if (storageThrows) throw new Error('storage blocked');
        return key === THEME_HINT_KEY ? hint : null;
      },
    },
    matchMedia: (query: string) => ({ matches: query.includes('dark') && prefersDark }),
  };
  // eslint-disable-next-line @typescript-eslint/no-implied-eval
  new Function('window', 'document', bootScript())(windowStub, documentStub);
  return attrs['data-theme'] ?? documentStub.documentElement.dataset.theme ?? '';
}

describe('index.html boot script', () => {
  it('runs in <head>, before the app bundle, so the first paint is already themed', () => {
    const headEnd = html.indexOf('</head>');
    const inline = html.indexOf('<script>');
    const bundle = html.indexOf('<script type="module"');
    expect(inline).toBeGreaterThan(-1);
    expect(inline).toBeLessThan(headEnd);
    expect(bundle).toBeGreaterThan(inline);
  });

  it('reads the same localStorage key that theme.ts writes', () => {
    expect(bootScript()).toContain(THEME_HINT_KEY);
  });

  it('stamps dark when the stored hint says dark, even on a light system', () => {
    expect(runBoot({ hint: 'dark', prefersDark: false })).toBe('dark');
  });

  it('stamps light when the stored hint says light, even on a dark system', () => {
    expect(runBoot({ hint: 'light', prefersDark: true })).toBe('light');
  });

  it('falls back to the OS preference when there is no hint yet', () => {
    expect(runBoot({ hint: null, prefersDark: true })).toBe('dark');
    expect(runBoot({ hint: null, prefersDark: false })).toBe('light');
  });

  it("treats a 'system' hint as: ask the OS", () => {
    expect(runBoot({ hint: 'system', prefersDark: true })).toBe('dark');
    expect(runBoot({ hint: 'system', prefersDark: false })).toBe('light');
  });

  it('survives unreadable storage (private mode, file://) without throwing', () => {
    expect(runBoot({ storageThrows: true, prefersDark: true })).toBe('dark');
  });

  it('ignores a junk hint rather than stamping garbage', () => {
    expect(runBoot({ hint: 'purple', prefersDark: true })).toBe('dark');
  });
});

// ------------------------------------------------------------- the hint side

const g = globalThis as unknown as Record<string, unknown>;
afterEach(() => {
  delete g.window;
});

function stubStorage(opts: { throws?: boolean } = {}): Map<string, string> {
  const store = new Map<string, string>();
  g.window = {
    localStorage: {
      getItem: (k: string) => {
        if (opts.throws) throw new Error('storage blocked');
        return store.has(k) ? store.get(k)! : null;
      },
      setItem: (k: string, v: string) => {
        if (opts.throws) throw new Error('storage blocked');
        store.set(k, v);
      },
    },
  };
  return store;
}

describe('theme hint', () => {
  it('writes the choice the boot script expects', () => {
    const store = stubStorage();
    writeThemeHint('dark');
    expect(store.get(THEME_HINT_KEY)).toBe('dark');
    expect(runBoot({ hint: store.get(THEME_HINT_KEY)!, prefersDark: false })).toBe('dark');
    writeThemeHint('system');
    expect(store.get(THEME_HINT_KEY)).toBe('system');
    expect(readThemeHint()).toBe('system');
  });

  it('reads back what it wrote, and treats junk as system', () => {
    const store = stubStorage();
    writeThemeHint('light');
    expect(readThemeHint()).toBe('light');
    store.set(THEME_HINT_KEY, 'neon');
    expect(readThemeHint()).toBe('system');
  });

  it('never throws when storage is unavailable — the hint is optional', () => {
    stubStorage({ throws: true });
    expect(() => writeThemeHint('dark')).not.toThrow();
    expect(readThemeHint()).toBe('system');
  });
});
