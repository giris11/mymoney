// Dropbox OAuth for sync (D44) — replaces tests/sync-google-auth.test.ts,
// which tested a module that no longer exists.
//
// The four things this file is really here to hold down:
//
//  1. NO CLIENT SECRET LEAVES THIS APP, EVER. Every request the flow makes is
//     inspected for one. A browser app cannot keep a secret, so a build that
//     started sending one would be publishing it to every visitor.
//  2. THE REFRESH IS SILENT AND NEEDS NO WINDOW. This is the whole reason for
//     leaving Google: Drive's browser flow had no refresh token at all, so a
//     reloaded page could not sync without asking the owner again. If Dropbox
//     ever refused a refresh from a public client, that finding would reopen
//     the provider decision — so there is a test naming exactly that, and the
//     code reports it as a decision to revisit rather than an error to retry.
//  3. CONNECTED MEANS "HAS A STANDING GRANT", NOT "HOLDS A LIVE TOKEN" (C11).
//     A configured device must never announce itself as never-set-up after a
//     reload.
//  4. NO FAILURE IS EVER CACHED (C9). "Press Connect again" must be a real
//     retry, not the same stale rejection for the life of the tab.
//
// Nothing here touches the network, and no popup is ever opened: `fetch` and
// the window opener are both seams.
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  base64Url,
  codeChallenge,
  createDropboxTokenProvider,
  defaultRedirectUri,
  DROPBOX_APP_KEY,
  DROPBOX_AUTHORIZE_URL,
  DROPBOX_REVOKE_URL,
  DROPBOX_SCOPE,
  DROPBOX_TOKEN_URL,
  isOfflineError,
  isReconnectNeeded,
  randomVerifier,
  REFRESH_TOKEN_STORAGE_KEY,
  SyncTransportError,
  TOKEN_REQUEST_TIMEOUT_MS,
  type AuthWindow,
  type RefreshTokenStore,
} from '../src/sync/dropboxAuth';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

interface Request {
  url: string;
  method: string;
  headers: Record<string, string>;
  /** Form fields, for the token endpoint. */
  form: Record<string, string>;
  raw: string;
}

class FakeDropbox {
  readonly requests: Request[] = [];
  /** Queued answers, one per token-endpoint call. */
  replies: { status: number; body: unknown }[] = [];

  fetch = async (input: unknown, init: RequestInit = {}): Promise<Response> => {
    const raw = typeof init.body === 'string' ? init.body : '';
    this.requests.push({
      url: String(input),
      method: (init.method ?? 'GET').toUpperCase(),
      headers: (init.headers ?? {}) as Record<string, string>,
      form: Object.fromEntries(new URLSearchParams(raw)),
      raw,
    });
    const next = this.replies.shift() ?? { status: 200, body: {} };
    return {
      status: next.status,
      ok: next.status >= 200 && next.status < 300,
      text: async () => (typeof next.body === 'string' ? next.body : JSON.stringify(next.body)),
      headers: { get: () => null },
    } as unknown as Response;
  };

  tokenCalls(): Request[] {
    return this.requests.filter((r) => r.url === DROPBOX_TOKEN_URL);
  }
}

/** A popup that sits on dropbox.com until a test says it has come back. */
class FakePopup implements AuthWindow {
  closed = false;
  /** null while cross-origin: reading .href THROWS, as a real browser does. */
  private returnedTo: string | null = null;
  closes = 0;

  get location(): { href: string } {
    const href = this.returnedTo;
    return {
      get href(): string {
        if (href === null) {
          throw Object.assign(new Error('cross-origin'), { name: 'SecurityError' });
        }
        return href;
      },
    };
  }
  close(): void {
    this.closes += 1;
    this.closed = true;
  }
  returnTo(href: string): void {
    this.returnedTo = href;
  }
}

function memoryStore(initial: string | null = null): RefreshTokenStore {
  let value = initial;
  return {
    get: () => value,
    set: (v) => {
      value = v;
    },
  };
}

const REDIRECT = 'https://giris11.github.io/mymoney/';

let dropbox: FakeDropbox;

interface Harness {
  popup: FakePopup | null;
  opened: string[];
  blocked: boolean;
}

function provider(o: { store?: RefreshTokenStore; harness?: Harness; now?: () => number } = {}) {
  const harness: Harness = o.harness ?? { popup: null, opened: [], blocked: false };
  return {
    harness,
    provider: createDropboxTokenProvider({
      fetchImpl: dropbox.fetch,
      redirectUri: () => REDIRECT,
      refreshTokenStore: o.store ?? memoryStore(),
      pollIntervalMs: 0,
      now: o.now,
      openWindow: (url) => {
        harness.opened.push(url);
        if (harness.blocked) return null;
        harness.popup = new FakePopup();
        return harness.popup;
      },
    }),
  };
}

/** Let the polling loop run: it awaits a 0 ms timer between looks. */
const tick = () => new Promise((r) => setTimeout(r, 0));

/**
 * Wait until the flow has actually opened its window, then hand back the URL
 * it opened. NOT a fixed number of ticks: authorize() awaits a real SHA-256
 * before it opens anything, and how many turns of the loop that takes is not
 * ours to predict — guessing made three of these tests fail only when the
 * whole suite ran.
 */
async function openedUrl(harness: Harness): Promise<URL> {
  for (let i = 0; i < 500 && harness.opened.length === 0; i += 1) await tick();
  expect(harness.opened.length, 'the sign-in window never opened').toBeGreaterThan(0);
  return new URL(harness.opened[0]!);
}

async function rejection(p: Promise<unknown>): Promise<SyncTransportError> {
  const e = await p.then(
    () => null,
    (err: unknown) => err,
  );
  expect(e, 'expected this to be refused, and it was not').toBeInstanceOf(SyncTransportError);
  return e as SyncTransportError;
}

beforeEach(() => {
  dropbox = new FakeDropbox();
  vi.stubGlobal('navigator', { onLine: true });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ===========================================================================
// PKCE
// ===========================================================================

describe('PKCE', () => {
  it('generates a fresh 43-character verifier from the unreserved set', () => {
    const a = randomVerifier();
    const b = randomVerifier();
    expect(a).toHaveLength(43); // 32 random bytes, base64url, unpadded
    expect(a).toMatch(/^[A-Za-z0-9\-_]+$/);
    expect(a).not.toBe(b);
  });

  it('challenges with S256 — base64url of the SHA-256 of the verifier', async () => {
    const verifier = 'a'.repeat(43);
    const expected = createHash('sha256').update(verifier).digest('base64url');
    expect(await codeChallenge(verifier)).toBe(expected);
    expect(base64Url(new Uint8Array([251, 255, 190]))).toBe('-_--');
  });

  it('refuses to start rather than falling back to a weak random source', () => {
    vi.stubGlobal('crypto', {});
    expect(() => randomVerifier()).toThrow(/secure random/);
  });
});

describe('defaultRedirectUri', () => {
  it('is the directory the app is served from, trailing slash and all', () => {
    vi.stubGlobal('location', {
      origin: 'https://giris11.github.io',
      pathname: '/mymoney/index.html',
    });
    expect(defaultRedirectUri()).toBe('https://giris11.github.io/mymoney/');
    vi.stubGlobal('location', { origin: 'http://localhost:5173', pathname: '/' });
    expect(defaultRedirectUri()).toBe('http://localhost:5173/');
  });
});

// ===========================================================================
// The interactive flow
// ===========================================================================

describe('connect()', () => {
  it('sends a PKCE authorization request with an offline token type, and no secret', async () => {
    const store = memoryStore();
    const { provider: auth, harness } = provider({ store });
    dropbox.replies = [
      { status: 200, body: { access_token: 'at-1', refresh_token: 'rt-1', expires_in: 14400, scope: DROPBOX_SCOPE } },
    ];

    const done = auth.connect();
    const url = await openedUrl(harness);
    expect(`${url.origin}${url.pathname}`).toBe(DROPBOX_AUTHORIZE_URL);
    expect(url.searchParams.get('client_id')).toBe(DROPBOX_APP_KEY);
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('code_challenge_method')).toBe('S256');
    expect(url.searchParams.get('code_challenge')).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(url.searchParams.get('redirect_uri')).toBe(REDIRECT);
    expect(url.searchParams.get('scope')).toBe(DROPBOX_SCOPE);
    // The whole reason for moving: a refresh token that is valid until revoked.
    expect(url.searchParams.get('token_access_type')).toBe('offline');
    // The verifier itself must NEVER be in the authorize URL — only its hash.
    expect(url.searchParams.get('code_verifier')).toBeNull();
    expect(harness.opened[0]).not.toMatch(/client_secret/);

    harness.popup!.returnTo(`${REDIRECT}?code=the-code&state=${url.searchParams.get('state')}`);
    await done;

    const exchange = dropbox.tokenCalls()[0]!;
    expect(exchange.method).toBe('POST');
    expect(exchange.headers['content-type']).toBe('application/x-www-form-urlencoded');
    expect(exchange.form).toMatchObject({
      grant_type: 'authorization_code',
      code: 'the-code',
      client_id: DROPBOX_APP_KEY,
      redirect_uri: REDIRECT,
    });
    expect(exchange.form.code_verifier).toMatch(/^[A-Za-z0-9\-_]{43}$/);
    expect(exchange.raw).not.toMatch(/client_secret/);
    // The standing grant is what got stored — not the access token.
    expect(store.get()).toBe('rt-1');
    expect(auth.isConnected()).toBe(true);
    // The popup is shut behind us.
    expect(harness.popup!.closes).toBe(1);
  });

  it('ignores a callback whose state is not the one it started', async () => {
    const { provider: auth, harness } = provider();
    const done = rejection(auth.connect());
    await openedUrl(harness);
    harness.popup!.returnTo(`${REDIRECT}?code=someone-elses&state=not-mine`);
    const e = await done;
    expect(e.kind).toBe('auth');
    expect(e.message).toMatch(/did not match/);
    // The code was never redeemed.
    expect(dropbox.tokenCalls()).toHaveLength(0);
  });

  it('reads a declined consent as a choice, not a failure', async () => {
    const { provider: auth, harness } = provider();
    const done = rejection(auth.connect());
    await openedUrl(harness);
    harness.popup!.returnTo(`${REDIRECT}?error=access_denied&error_description=nope`);
    const e = await done;
    expect(e.kind).toBe('cancelled');
    expect(isReconnectNeeded(e)).toBe(false);
  });

  it('reads a closed window as cancellation', async () => {
    const { provider: auth, harness } = provider();
    const done = rejection(auth.connect());
    await openedUrl(harness);
    harness.popup!.closed = true;
    expect((await done).kind).toBe('cancelled');
  });

  it('says what to do when the browser blocks the window', async () => {
    const { provider: auth } = provider({ harness: { popup: null, opened: [], blocked: true } });
    const e = await rejection(auth.connect());
    expect(e.kind).toBe('popup-blocked');
    expect(e.message).toMatch(/Allow pop-ups/);
    expect(isReconnectNeeded(e)).toBe(true);
  });

  it('refuses a sign-in that came back with no lasting connection', async () => {
    // token_access_type=offline was requested. Without a refresh token this
    // device would work for hours and then demand consent for ever after —
    // which is precisely the Google behaviour this migration exists to end.
    const { provider: auth, harness } = provider();
    dropbox.replies = [{ status: 200, body: { access_token: 'at-1', expires_in: 14400 } }];
    const done = rejection(auth.connect());
    const state = (await openedUrl(harness)).searchParams.get('state');
    harness.popup!.returnTo(`${REDIRECT}?code=c&state=${state}`);
    const e = await done;
    expect(e.message).toMatch(/lasting connection/);
    expect(auth.isConnected()).toBe(false);
  });

  it('refuses a grant narrower than sync needs', async () => {
    const { provider: auth, harness } = provider();
    dropbox.replies = [
      { status: 200, body: { access_token: 'at', refresh_token: 'rt', scope: 'account_info.read files.metadata.read' } },
    ];
    const done = rejection(auth.connect());
    const state = (await openedUrl(harness)).searchParams.get('state');
    harness.popup!.returnTo(`${REDIRECT}?code=c&state=${state}`);
    const e = await done;
    expect(e.message).toMatch(/files\.content\.read/);
    expect(e.message).toMatch(/files\.content\.write/);
  });
});

// ===========================================================================
// The silent refresh — the point of the whole migration
// ===========================================================================

describe('getToken()', () => {
  it('refreshes with the app key alone: no secret, no verifier, no window', async () => {
    const { provider: auth, harness } = provider({ store: memoryStore('rt-stored') });
    dropbox.replies = [{ status: 200, body: { access_token: 'at-new', expires_in: 14400 } }];

    expect(await auth.getToken()).toBe('at-new');

    const call = dropbox.tokenCalls()[0]!;
    expect(call.form).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt-stored',
      client_id: DROPBOX_APP_KEY,
    });
    expect(call.raw).not.toMatch(/client_secret/);
    expect(call.raw).not.toMatch(/code_verifier/);
    // No UI whatsoever. This is what a reloaded page does.
    expect(harness.opened).toHaveLength(0);
  });

  it('caches the access token and does not refresh again until it nears expiry', async () => {
    let clock = 1_000_000;
    const { provider: auth } = provider({ store: memoryStore('rt'), now: () => clock });
    dropbox.replies = [
      { status: 200, body: { access_token: 'at-1', expires_in: 14400 } },
      { status: 200, body: { access_token: 'at-2', expires_in: 14400 } },
    ];
    expect(await auth.getToken()).toBe('at-1');
    expect(await auth.getToken()).toBe('at-1');
    expect(dropbox.tokenCalls()).toHaveLength(1);
    clock += 14400 * 1000;
    expect(await auth.getToken()).toBe('at-2');
  });

  it('invalidate() drops the access token and KEEPS the standing grant', async () => {
    const store = memoryStore('rt');
    const { provider: auth } = provider({ store });
    dropbox.replies = [
      { status: 200, body: { access_token: 'at-1', expires_in: 14400 } },
      { status: 200, body: { access_token: 'at-2', expires_in: 14400 } },
    ];
    await auth.getToken();
    auth.invalidate();
    expect(auth.isConnected()).toBe(true);
    expect(store.get()).toBe('rt');
    expect(await auth.getToken()).toBe('at-2');
  });

  it('answers "connected" from the standing grant before any network call (C11)', () => {
    const { provider: auth } = provider({ store: memoryStore('rt') });
    // No await, no fetch, no token in hand. A reloaded, fully configured
    // device must not offer "set up this device".
    expect(auth.isConnected()).toBe(true);
    expect(auth.hasValidToken()).toBe(true);
    expect(auth.isLinked()).toBe(true);
    expect(dropbox.requests).toHaveLength(0);
  });

  it('says "not connected" — not "sign-in expired" — on a device that never connected', async () => {
    const { provider: auth } = provider();
    const e = await rejection(auth.getToken());
    expect(e.kind).toBe('not-connected');
    expect(dropbox.requests).toHaveLength(0);
  });

  it('throws away a grant Dropbox has disowned, rather than retrying it for ever', async () => {
    const store = memoryStore('rt-revoked');
    const { provider: auth } = provider({ store });
    dropbox.replies = [{ status: 400, body: { error: 'invalid_grant' } }];
    // No gesture behind this call, so no window is offered.
    const e = await rejection(auth.getToken({ allowPrompt: false }));
    expect(e.kind).toBe('auth');
    expect(isReconnectNeeded(e)).toBe(true);
    expect(store.get()).toBeNull();
    expect(auth.isConnected()).toBe(false);
  });

  it('keeps the grant when the failure was merely transient', async () => {
    const store = memoryStore('rt');
    const { provider: auth } = provider({ store });
    dropbox.replies = [{ status: 503, body: {} }];
    const e = await rejection(auth.getToken({ allowPrompt: false }));
    expect(e.kind).toBe('network');
    expect(isOfflineError(e)).toBe(true);
    // A busy Dropbox is not a revoked grant.
    expect(store.get()).toBe('rt');
    expect(auth.isConnected()).toBe(true);
  });

  it('falls back to the window only when the grant is genuinely dead and a gesture exists', async () => {
    const store = memoryStore('rt-revoked');
    const { provider: auth, harness } = provider({ store });
    dropbox.replies = [
      { status: 400, body: { error: 'invalid_grant' } },
      { status: 200, body: { access_token: 'at', refresh_token: 'rt-fresh', expires_in: 14400 } },
    ];
    const done = auth.getToken();
    const state = (await openedUrl(harness)).searchParams.get('state');
    expect(harness.opened).toHaveLength(1);
    harness.popup!.returnTo(`${REDIRECT}?code=c&state=${state}`);
    expect(await done).toBe('at');
    expect(store.get()).toBe('rt-fresh');
  });

  it('does not touch the network at all when the device is offline', async () => {
    vi.stubGlobal('navigator', { onLine: false });
    const { provider: auth } = provider({ store: memoryStore('rt') });
    const e = await rejection(auth.getToken());
    expect(e.kind).toBe('offline');
    expect(dropbox.requests).toHaveLength(0);
  });

  it('never caches a failure — the next attempt really is an attempt (C9)', async () => {
    const { provider: auth } = provider({ store: memoryStore('rt') });
    dropbox.replies = [
      { status: 503, body: {} },
      { status: 200, body: { access_token: 'at-2', expires_in: 14400 } },
    ];
    await rejection(auth.getToken({ allowPrompt: false }));
    // The Drive build handed the same rejection back for the life of the tab,
    // and no amount of pressing Connect could clear it.
    expect(await auth.getToken({ allowPrompt: false })).toBe('at-2');
    expect(dropbox.tokenCalls()).toHaveLength(2);
  });
});

// ===========================================================================
// THE FINDING THAT WOULD REOPEN THE PROVIDER DECISION
// ===========================================================================

describe('a refresh that Dropbox refuses without a client secret', () => {
  it('is reported as a decision to revisit, NOT as something to retry or work around', async () => {
    // If this ever happens against the live API, the answer is not to ship a
    // secret (a browser cannot keep one) and not to stand up a server (there
    // isn't one, by design). It is to choose a different provider — so the
    // message has to say that rather than "reconnect and try again".
    const store = memoryStore('rt');
    const { provider: auth, harness } = provider({ store });
    dropbox.replies = [
      {
        status: 400,
        body: { error: 'invalid_client', error_description: 'Missing client_secret.' },
      },
    ];
    const e = await rejection(auth.getToken());
    expect(e.kind).toBe('config');
    expect(e.message).toMatch(/client secret, which a browser app cannot have/);
    expect(e.message).toMatch(/sign-in method rethinking, not a retry/);
    // It does not silently escalate to a popup, and it does not throw the
    // grant away — nothing is wrong with the grant.
    expect(harness.opened).toHaveLength(0);
    expect(store.get()).toBe('rt');
  });

  it('recognises the same refusal when Dropbox only mentions the secret in prose', async () => {
    const { provider: auth } = provider({ store: memoryStore('rt') });
    dropbox.replies = [
      { status: 401, body: { error_description: 'This app requires a client_secret.' } },
    ];
    expect((await rejection(auth.getToken({ allowPrompt: false }))).kind).toBe('config');
  });
});

// ===========================================================================
// Disconnect
// ===========================================================================

describe('disconnect()', () => {
  it('revokes at Dropbox and forgets the grant locally', async () => {
    const store = memoryStore('rt');
    const { provider: auth } = provider({ store });
    dropbox.replies = [{ status: 200, body: { access_token: 'at', expires_in: 14400 } }, { status: 200, body: {} }];
    await auth.getToken();
    await auth.disconnect();

    const revoke = dropbox.requests.find((r) => r.url === DROPBOX_REVOKE_URL)!;
    expect(revoke.method).toBe('POST');
    expect(revoke.headers.authorization).toBe('Bearer at');
    expect(store.get()).toBeNull();
    expect(auth.isConnected()).toBe(false);
  });

  it('disconnects locally even when the revoke call fails', async () => {
    const store = memoryStore('rt');
    const { provider: auth } = provider({ store });
    dropbox.replies = [{ status: 200, body: { access_token: 'at', expires_in: 14400 } }];
    await auth.getToken();
    dropbox.fetch = () => Promise.reject(new Error('network down'));
    await auth.disconnect();
    expect(store.get()).toBeNull();
    expect(auth.isConnected()).toBe(false);
  });

  it('makes no request at all when there was no token in hand', async () => {
    const { provider: auth } = provider({ store: memoryStore('rt') });
    await auth.disconnect();
    expect(dropbox.requests).toHaveLength(0);
  });
});

// ===========================================================================
// Where the standing grant lives
// ===========================================================================

describe('the refresh token is kept where a backup cannot reach it', () => {
  it('lives under its own localStorage key and nowhere else', () => {
    expect(REFRESH_TOKEN_STORAGE_KEY).toBe('mymoney.sync.dropbox.refreshToken');
  });

  it('is never routed through Dexie, backup or settings', async () => {
    const { readFileSync } = await import('node:fs');
    const { fileURLToPath } = await import('node:url');
    const source = readFileSync(
      fileURLToPath(new URL('../src/sync/dropboxAuth.ts', import.meta.url)),
      'utf8',
    );
    // The settings table is exported by exportBackup(), so a credential stored
    // there would end up in every copy of every backup file the owner makes.
    // Keeping this module free of those imports is what stops that happening
    // by accident later. Comments are stripped first: the file EXPLAINS this
    // decision at length, and that prose is the point of it.
    const code = source
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .split('\n')
      .filter((line) => !line.trim().startsWith('//'))
      .join('\n');
    expect(code).not.toMatch(/from '\.\.\/db\//);
    expect(code).not.toMatch(/from '\.\.\/backup\//);
    expect(code).not.toMatch(/updateSettings|getSettings|exportBackup/);
    // What it DOES use is localStorage, under its own key.
    expect(code).toMatch(/REFRESH_TOKEN_STORAGE_KEY/);
  });

  it('bounds the token request so a hung sign-in cannot wedge the tab', () => {
    expect(TOKEN_REQUEST_TIMEOUT_MS).toBeLessThanOrEqual(30_000);
  });
});
