// Hash router (D3): works on GitHub Pages subpaths, and keeps working when the
// app is served from any static host without server-side rewrites.
//
// THE URL IS THE STATE. Every view the user can reach — including a *narrowed*
// one, e.g. the register filtered to one account — must be addressable, or
// Back/Forward, reload, bookmark and "send me that link" all quietly break.
// Anything a page keeps in `useState` instead is invisible to history: the
// browser's Back button skips straight past it to the previous PAGE, which is
// exactly the "I filtered, and now there's no way back" complaint. See
// `filtersToParams`/`filtersFromParams` in src/ui/tx/txShared.ts for the
// register's half of that contract.
import { useEffect, useState } from 'react';

export interface Route {
  path: string; // e.g. '/transactions'
  params: URLSearchParams;
}

export interface NavigateOptions {
  /**
   * Overwrite the current history entry instead of adding one. For changes
   * that fire per keystroke — anything debounced — so that typing a six-letter
   * search leaves ONE entry to go back through, not six.
   */
  replace?: boolean;
}

function parseHash(): Route {
  const raw = typeof window === 'undefined' ? '' : window.location.hash;
  const h = raw.replace(/^#/, '') || '/dashboard';
  // Split on the FIRST '?' only — a query value may legitimately contain an
  // encoded one, and `split('?')` would drop everything after it.
  const q = h.indexOf('?');
  const rawPath = q === -1 ? h : h.slice(0, q);
  const query = q === -1 ? '' : h.slice(q + 1);
  const path = rawPath.startsWith('/') ? rawPath : `/${rawPath}`;
  return { path, params: new URLSearchParams(query) };
}

// ---------------------------------------------------------------- in-app depth
/**
 * HOW WE KNOW WHETHER BACK STAYS INSIDE THE APP.
 *
 * `history.length` cannot answer this. It counts every entry in the tab,
 * including the pages visited BEFORE the app was opened (open a link to the
 * app from a search results page and `history.length` is already 2), and some
 * browsers cap it. Trusting it would send the user out of the app — on a PWA
 * cold start or a shared deep link, out of the app means a blank tab or
 * whatever site they came from.
 *
 * So we count our own steps instead: every entry this app creates is stamped
 * with its own depth in `history.state`, starting at 0 for whichever entry the
 * app was loaded into. `depth > 0` therefore means "there is an entry BELOW us
 * that we ourselves created" — a Back step that certainly lands inside the app.
 *
 * Stamping the depth into `history.state` rather than holding a bare counter
 * buys two things a counter cannot: it survives a reload (the state travels
 * with the entry, so Back still works after F5 three screens deep), and it
 * tells us where a Back/Forward jump LANDED — the entry's own stamp is the
 * new depth, so we stay correct even when the user jumps several entries at
 * once from the browser's history menu.
 */
const DEPTH_KEY = '__mmDepth';

let depth = 0;
let started = false;
const listeners = new Set<() => void>();

function emit(): void {
  // Copy: a listener may unsubscribe while we are notifying.
  for (const fn of [...listeners]) fn();
}

/** The depth stamped on the entry we are on, or null if we never stamped it. */
function stampedDepth(): number | null {
  const st = window.history.state as Record<string, unknown> | null;
  const v = st && typeof st === 'object' ? st[DEPTH_KEY] : undefined;
  return typeof v === 'number' && Number.isFinite(v) ? v : null;
}

/** Write the current depth onto the current entry, keeping any other state. */
function stampCurrent(): void {
  const prev = window.history.state;
  const base = typeof prev === 'object' && prev !== null ? prev : {};
  try {
    window.history.replaceState({ ...base, [DEPTH_KEY]: depth }, '');
  } catch {
    // Some sandboxes refuse history writes; depth then simply stays in memory,
    // which still gets goBack() right for this page-load.
  }
}

/**
 * Re-derive our depth after a navigation we did not perform ourselves:
 * a Back/Forward step, an `<a href="#/x">` click, or a raw
 * `location.hash = …` assignment (BackupSection does one).
 */
function adoptCurrentEntry(): void {
  const stamped = stampedDepth();
  if (stamped === null) {
    // A brand-new entry: it was pushed on top of the one we were on, so it is
    // one step deeper. Claim it so a later Back knows it can come home.
    depth += 1;
    stampCurrent();
  } else {
    depth = stamped;
  }
}

function ensureStarted(): void {
  if (started || typeof window === 'undefined') return;
  started = true;
  // A reload keeps the entry's state, so a deep entry stays deep.
  depth = stampedDepth() ?? 0;
  stampCurrent();
  const onExternal = () => {
    adoptCurrentEntry();
    emit();
  };
  // A same-document Back can fire popstate, hashchange, or both (browsers
  // differ, and the order differs too). Both handlers are idempotent — the
  // second one reads the stamp the first one left — so listening to both is
  // safe and covers anchor clicks, which fire hashchange only.
  window.addEventListener('hashchange', onExternal);
  window.addEventListener('popstate', onExternal);
}

function subscribe(fn: () => void): () => void {
  ensureStarted();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

export function useRoute(): Route {
  const [route, setRoute] = useState<Route>(parseHash);
  useEffect(() => {
    const onChange = () =>
      setRoute((prev) => {
        const next = parseHash();
        // Keep the old object when nothing actually changed: `route.params` is
        // a fresh URLSearchParams every parse, and handing consumers a new
        // identity for the same URL re-runs every memo keyed on it.
        return prev.path === next.path && prev.params.toString() === next.params.toString()
          ? prev
          : next;
      });
    onChange(); // catch a hash change between render and effect
    return subscribe(onChange);
  }, []);
  return route;
}

/**
 * Are these two hashes the same view? Not just a string compare: browsers
 * disagree about whether `location.hash` reads back percent-encoded (we always
 * WRITE it encoded, via URLSearchParams), and a search for "café" must not
 * count as a change just because the browser handed the accent back decoded.
 * decodeURI leaves reserved characters alone, so genuinely different values
 * (`a+b` vs `a%2Bb`) still compare as different.
 */
function sameHash(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return decodeURI(a) === decodeURI(b);
  } catch {
    return false; // malformed escape: treat as a real change
  }
}

/**
 * Go to `to` ('/transactions?account=x'). Adds a history entry unless
 * `opts.replace` is set.
 *
 * Navigating to the URL we are already on is a no-op: no duplicate entry, no
 * event. That is what makes re-clicking the same account in the sidebar
 * harmless now that filters live in the URL — the view already matches.
 */
export function navigate(to: string, opts: NavigateOptions = {}): void {
  if (typeof window === 'undefined') return;
  ensureStarted();
  const hash = to.startsWith('#') ? to : `#${to}`;
  if (sameHash(window.location.hash, hash)) return;
  try {
    if (opts.replace) {
      window.history.replaceState({ [DEPTH_KEY]: depth }, '', hash);
    } else {
      const next = depth + 1;
      window.history.pushState({ [DEPTH_KEY]: next }, '', hash);
      depth = next; // only after the push actually succeeded
    }
  } catch {
    // pushState is refused in a few contexts (file://, some sandboxes). The
    // plain assignment still navigates; the hashchange handler adopts the new
    // entry and notifies, so we must not emit again here.
    window.location.hash = hash;
    return;
  }
  // Neither pushState nor replaceState fires an event of its own.
  emit();
}

/** True when a Back step would land on an entry this app created. */
export function canGoBack(): boolean {
  if (typeof window === 'undefined') return false;
  ensureStarted();
  return depth > 0;
}

/**
 * Back, but never out of the app. With in-app history it is a real
 * `history.back()` — the browser's own Back and an in-app Back button must do
 * the same thing, and only a real back step restores the entry the user
 * actually left. Without it (deep link, PWA cold start, a shared URL opened in
 * a fresh tab) `history.back()` would exit to whatever preceded the app, so we
 * navigate to `fallback` instead — pushed, not replaced, so the view being
 * left is still reachable with Forward/Back.
 */
export function goBack(fallback: string): void {
  if (typeof window === 'undefined') return;
  if (canGoBack()) {
    window.history.back();
    return;
  }
  navigate(fallback);
}

/** Reactive `canGoBack()` for rendering a Back affordance only when it works. */
export function useCanGoBack(): boolean {
  const [can, setCan] = useState(canGoBack);
  useEffect(() => {
    const onChange = () => setCan(canGoBack());
    onChange();
    return subscribe(onChange);
  }, []);
  return can;
}

/** For <a href={href('/reports')}> links. */
export const href = (to: string): string => `#${to}`;

/** Test seam: forget the module-level history bookkeeping. */
export function __resetRouterForTests(): void {
  depth = 0;
  started = false;
  listeners.clear();
}
