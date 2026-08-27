// Google identity lifecycle (D42) — the two ways a working connection used to
// stop working for reasons that had nothing to do with the user's data:
//
//   * a single failed load of the Google Identity Services script POISONED THE
//     TAB. The dead <script> stayed in <head>, every later Connect adopted it,
//     and since an errored script never fires `load` or `error` again, each
//     attempt sat for the full 15 s timeout and then advised "check your
//     connection and try again" — advice that could not work without a page
//     reload that nothing mentioned. Load failures are ordinary (offline,
//     proxy, extension, slow phone), so a retry has to actually retry.
//   * "connected" meant "holds a live access token in memory". The token is
//     memory-only by design and lasts about an hour, so a fully configured
//     device reported itself as NOT SET UP after every reload and every ~59
//     minutes, refusing to sync — while the silent re-grant that would have
//     fixed it in one round trip was never reached.
//
// These live apart from tests/sync-transport.test.ts because they are about
// src/sync/googleAuth.ts alone: no Drive, no fetch, no transport. The DOM
// double here differs from that file's in the two ways that matter for the
// first bug — its querySelector really finds what was appended, and a script
// that has fired `error` is inert afterwards, exactly like a real one.
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  createGoogleTokenProvider,
  DRIVE_SCOPE,
  GSI_LOAD_TIMEOUT_MS,
  GSI_SCRIPT_SRC,
  isReconnectNeeded,
  LINKED_STORAGE_KEY,
  loadGsi,
  resetGsiLoaderForTests,
  SyncTransportError,
  type GisOAuth2,
  type GisTokenResponse,
} from '../src/sync/googleAuth';

/** Let queued microtasks (and the fake consent popup) run. */
const tick = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  resetGsiLoaderForTests();
});

// ---------------------------------------------------------------------------
// The script loader
// ---------------------------------------------------------------------------

describe('loading the Google sign-in script', () => {
  it('re-requests the script after a failed load, instead of adopting the dead one', async () => {
    const dom = fakeDom();
    vi.stubGlobal('document', dom.document);

    const first = loadGsi();
    const firstFailure = first.catch((e: unknown) => e);
    expect(dom.appended).toHaveLength(1);
    expect(dom.appended[0]!.src).toBe(GSI_SCRIPT_SRC);

    dom.appended[0]!.fire('error');
    expect((await firstFailure) as SyncTransportError).toMatchObject({ kind: 'network' });
    // The corpse is out of the document, so nothing can find it and wait on it.
    expect(dom.head.children).toHaveLength(0);

    // The retry the error message promises: a NEW element, actually fetched.
    const second = loadGsi();
    expect(dom.appended).toHaveLength(2);
    expect(dom.appended[1]).not.toBe(dom.appended[0]);
    expect(dom.appended[1]!.src).toBe(GSI_SCRIPT_SRC);

    const gis = installFakeGis();
    dom.appended[1]!.fire('load');
    await expect(second).resolves.toBe(gis.oauth2);
  });

  it('re-requests the script after a load that timed out as well', async () => {
    vi.useFakeTimers();
    const dom = fakeDom();
    vi.stubGlobal('document', dom.document);

    const first = loadGsi();
    const firstFailure = first.catch((e: unknown) => e);
    expect(dom.appended).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(GSI_LOAD_TIMEOUT_MS);
    expect((await firstFailure) as SyncTransportError).toMatchObject({ kind: 'network' });
    // Unlike the error path this element is LEFT in place — the request may
    // still be in flight and a late load still defines the namespace — but the
    // next attempt must not be handed it.
    expect(dom.head.children).toHaveLength(1);

    const second = loadGsi();
    expect(dom.appended).toHaveLength(2);
    const gis = installFakeGis();
    dom.appended[1]!.fire('load');
    await expect(second).resolves.toBe(gis.oauth2);
  });

  it('never hands a later caller a cached failure', async () => {
    const dom = fakeDom();
    vi.stubGlobal('document', dom.document);

    const first = loadGsi();
    const firstFailure = first.catch((e: unknown) => e);
    dom.appended[0]!.fire('error');
    await firstFailure;

    const second = loadGsi();
    expect(second).not.toBe(first);
    const secondFailure = second.catch((e: unknown) => e);
    dom.appended[1]!.fire('error');
    expect((await secondFailure) as SyncTransportError).toMatchObject({ kind: 'network' });
    // Two attempts, two real requests: the second failed on its own evidence.
    expect(dom.appended).toHaveLength(2);
  });

  it('still loads the script only once while an attempt is in flight', async () => {
    const dom = fakeDom();
    vi.stubGlobal('document', dom.document);

    const a = loadGsi();
    const b = loadGsi();
    expect(b).toBe(a);
    expect(dom.appended).toHaveLength(1);

    const gis = installFakeGis();
    dom.appended[0]!.fire('load');
    await expect(a).resolves.toBe(gis.oauth2);
    // And once it is loaded, no further element is ever appended.
    await expect(loadGsi()).resolves.toBe(gis.oauth2);
    expect(dom.appended).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// What "connected" means
// ---------------------------------------------------------------------------

describe('a standing grant, not a token in hand', () => {
  it('is still connected after a reload, and gets a token silently when asked', async () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    const gis = installFakeGis();

    const before = createGoogleTokenProvider({ clientId: () => 'abc.apps.googleusercontent.com' });
    const connecting = before.connect();
    await tick();
    gis.respond({ access_token: 'tok-1', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;
    expect(before.isConnected()).toBe(true);

    // THE STORAGE DECISION, asserted: one flag saying consent happened, and
    // nothing else. The access token is a bearer credential for the owner's
    // Drive and never leaves memory.
    expect(store.dump()).toEqual({ [LINKED_STORAGE_KEY]: '1' });
    expect(JSON.stringify(store.dump())).not.toContain('tok-1');

    // A page reload: same origin and same localStorage, brand-new closure —
    // so no token at all. The device is still set up.
    const after = createGoogleTokenProvider({ clientId: () => 'abc.apps.googleusercontent.com' });
    expect(after.isConnected()).toBe(true);
    expect(after.hasValidToken()).toBe(true); // the name transport.ts asks by

    gis.prompts.length = 0;
    const getting = after.getToken();
    await tick();
    expect(gis.prompts).toEqual(['']); // '' = silent: no window, no clicking
    gis.respond({ access_token: 'tok-2', expires_in: 3600, scope: DRIVE_SCOPE });
    await expect(getting).resolves.toBe('tok-2');
  });

  it('stays connected when the token lapses in an open tab', async () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    const gis = installFakeGis();
    let clock = 5_000_000;
    const provider = createGoogleTokenProvider({ clientId: () => 'abc', now: () => clock });

    const connecting = provider.connect();
    await tick();
    gis.respond({ access_token: 'tok-1', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;

    clock += 3600_000; // an hour later: the token is past its usable life
    expect(provider.isConnected()).toBe(true);

    const getting = provider.getToken();
    await tick();
    gis.respond({ access_token: 'tok-2', expires_in: 3600, scope: DRIVE_SCOPE });
    await expect(getting).resolves.toBe('tok-2');
    expect(gis.prompts).toEqual(['consent', '']); // still no visible prompt
  });

  it('says "not connected" only when there really is no grant', async () => {
    vi.stubGlobal('localStorage', fakeStorage());
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    expect(provider.isConnected()).toBe(false);
    await expect(provider.getToken()).rejects.toMatchObject({ kind: 'not-connected' });
    expect(gis.prompts).toEqual([]); // nothing was asked of Google or the user
  });

  it('reports a device whose client ID has been cleared as needing setup', async () => {
    const store = fakeStorage();
    store.setItem(LINKED_STORAGE_KEY, '1');
    vi.stubGlobal('localStorage', store);
    installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => '   ' });

    // Before anything has looked, a grant is a grant: the id lives in Dexie and
    // guessing "not set up" is the failure this replaces.
    expect(provider.isConnected()).toBe(true);
    const err = await provider.getToken().catch((e: unknown) => e);
    expect((err as SyncTransportError).kind).toBe('config');
    expect(isReconnectNeeded(err)).toBe(true);
    // ...and now it knows, so the screen can ask for the client ID again.
    expect(provider.isConnected()).toBe(false);
  });

  it('forgets the standing grant on disconnect', async () => {
    const store = fakeStorage();
    vi.stubGlobal('localStorage', store);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const connecting = provider.connect();
    await tick();
    gis.respond({ access_token: 'tok-1', expires_in: 3600, scope: DRIVE_SCOPE });
    await connecting;

    await provider.disconnect();
    expect(provider.isConnected()).toBe(false);
    expect(provider.isLinked()).toBe(false);
    expect(store.dump()).toEqual({});
    expect(gis.revoked).toEqual(['tok-1']);
  });
});

// ---------------------------------------------------------------------------
// The refresh ladder: silent, then visible, then reconnect
// ---------------------------------------------------------------------------

describe('getting a token on demand', () => {
  it('falls back to a visible prompt when the silent re-grant genuinely fails', async () => {
    const store = fakeStorage();
    store.setItem(LINKED_STORAGE_KEY, '1'); // consent happened; the token did not survive
    vi.stubGlobal('localStorage', store);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const getting = provider.getToken();
    await tick();
    expect(gis.prompts).toEqual(['']);

    // GIS's way of saying "I cannot mint one without interaction". Nobody
    // declined anything — so offer the interaction.
    gis.respond({ error: 'access_denied' });
    await tick();
    expect(gis.prompts).toEqual(['', 'select_account']);

    gis.respond({ access_token: 'tok-3', expires_in: 3600, scope: DRIVE_SCOPE });
    await expect(getting).resolves.toBe('tok-3');
    expect(provider.isConnected()).toBe(true);
  });

  it('never opens a window for a caller that says it has no user gesture', async () => {
    const store = fakeStorage();
    store.setItem(LINKED_STORAGE_KEY, '1');
    vi.stubGlobal('localStorage', store);
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const getting = provider.getToken({ allowPrompt: false });
    const failure = getting.catch((e: unknown) => e);
    await tick();
    gis.respond({ error: 'access_denied' });

    const err = (await failure) as SyncTransportError;
    // 'reconnect', not 'you declined' — the owner declined nothing.
    expect(err.kind).toBe('auth');
    expect(isReconnectNeeded(err)).toBe(true);
    expect(gis.prompts).toEqual(['']); // the silent attempt only

    // The contrast that shows the flag is what decided it, not the failure:
    // the identical silent refusal, from a caller with a click behind it, is
    // offered the account chooser and syncs.
    const withGesture = provider.getToken();
    await tick();
    gis.respond({ error: 'access_denied' });
    await tick();
    expect(gis.prompts).toEqual(['', '', 'select_account']);
    gis.respond({ access_token: 'tok-4', expires_in: 3600, scope: DRIVE_SCOPE });
    await expect(withGesture).resolves.toBe('tok-4');
  });

  it('does not throw a window at a screen the owner is only looking at', async () => {
    const store = fakeStorage();
    store.setItem(LINKED_STORAGE_KEY, '1');
    vi.stubGlobal('localStorage', store);
    // The browser's own verdict: no user gesture is in effect, so a popup would
    // be blocked. (This is the Sync screen probing the remote on open, or a
    // refresh needed after a long download, rather than a click on Sync now.)
    vi.stubGlobal('navigator', { onLine: true, userActivation: { isActive: false } });
    const gis = installFakeGis();
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const failure = provider.getToken().catch((e: unknown) => e);
    await tick();
    gis.respond({ error: 'access_denied' });

    const err = (await failure) as SyncTransportError;
    expect(err.kind).toBe('auth');
    expect(isReconnectNeeded(err)).toBe(true);
    expect(gis.prompts).toEqual(['']);
    // Still connected: the grant did not go anywhere, it just needs a click.
    expect(provider.isConnected()).toBe(true);
  });

  it('does not answer "sign-in expired" when the sign-in script would not load', async () => {
    const store = fakeStorage();
    store.setItem(LINKED_STORAGE_KEY, '1');
    vi.stubGlobal('localStorage', store);
    const dom = fakeDom();
    vi.stubGlobal('document', dom.document);
    // No GIS namespace installed: the provider has to load the script, and the
    // load fails the way a train tunnel makes it fail.
    const provider = createGoogleTokenProvider({ clientId: () => 'abc' });

    const failure = provider.getToken().catch((e: unknown) => e);
    await tick();
    expect(dom.appended).toHaveLength(1);
    dom.appended[0]!.fire('error');

    const err = (await failure) as SyncTransportError;
    expect(err.kind).toBe('network');
    expect(err.message).toMatch(/connection/i);
  });
});

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface FakeScript {
  src: string;
  async: boolean;
  defer: boolean;
  parentNode: FakeHead | null;
  /** A script fires load or error ONCE; afterwards it is inert for ever. */
  spent: boolean;
  addEventListener(type: string, fn: () => void): void;
  fire(type: 'load' | 'error'): void;
}

interface FakeHead {
  children: FakeScript[];
  appendChild(el: FakeScript): FakeScript;
  removeChild(el: FakeScript): FakeScript;
}

/**
 * A document double faithful in the two respects the old bug depended on:
 * querySelector really finds what is in <head>, and a script that has already
 * failed stays failed. A double without those is why nothing caught this.
 */
function fakeDom() {
  const appended: FakeScript[] = [];
  const head: FakeHead = {
    children: [],
    appendChild(el) {
      el.parentNode = head;
      head.children.push(el);
      appended.push(el);
      return el;
    },
    removeChild(el) {
      const i = head.children.indexOf(el);
      if (i === -1) throw new Error('removeChild: not a child of <head>');
      head.children.splice(i, 1);
      el.parentNode = null;
      return el;
    },
  };
  const make = (): FakeScript => {
    const listeners: Record<string, Array<() => void>> = {};
    return {
      src: '',
      async: false,
      defer: false,
      parentNode: null,
      spent: false,
      addEventListener(type, fn) {
        (listeners[type] ??= []).push(fn);
      },
      fire(type) {
        if (this.spent) return;
        this.spent = true;
        for (const fn of listeners[type] ?? []) fn();
      },
    };
  };
  const document = {
    createElement: () => make(),
    querySelector: (selector: string) =>
      head.children.find((s) => selector === `script[src="${s.src}"]`) ?? null,
    head,
  };
  return { document: document as unknown as Document, appended, head };
}

/** localStorage, in a Map, so a test can read back exactly what was stored. */
function fakeStorage() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
    dump: () => Object.fromEntries(map),
  };
}

/** Stand-in for `google.accounts.oauth2`; `respond` plays the popup coming back. */
function installFakeGis() {
  let callback: ((r: GisTokenResponse) => void) | null = null;
  let errorCallback: ((e: { type?: string }) => void) | null = null;
  const state = {
    oauth2: null as unknown as GisOAuth2,
    prompts: [] as string[],
    revoked: [] as string[],
    respond: (r: GisTokenResponse) => callback?.(r),
    fail: (e: { type: string }) => errorCallback?.(e),
  };
  state.oauth2 = {
    initTokenClient(config) {
      callback = config.callback;
      errorCallback = config.error_callback ?? null;
      return {
        requestAccessToken(overrides) {
          state.prompts.push(overrides?.prompt ?? '');
        },
      };
    },
    revoke(accessToken, done) {
      state.revoked.push(accessToken);
      done?.();
    },
  };
  vi.stubGlobal('google', { accounts: { oauth2: state.oauth2 } });
  return state;
}
