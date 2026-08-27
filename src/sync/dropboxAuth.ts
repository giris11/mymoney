// Dropbox OAuth for sync — browser-only, PKCE, NO CLIENT SECRET (D44).
//
// This module replaces src/sync/googleAuth.ts. It is the ONLY place in the app
// that talks to Dropbox's identity endpoints, and it stays inert until the
// user clicks "Connect": importing it touches the network zero times and loads
// no third-party script at all.
//
// WHY DROPBOX AT ALL — the short version, because it is the reason this file
// exists rather than a tidy-up of the last one. Google Drive sync accumulated
// twenty confirmed defects over four review rounds, and two of the root causes
// were properties of the DRIVE API rather than of our logic:
//
//   RC1  Drive has no conditional write. Two devices could both write and the
//        loser could not tell. We could only detect a clobber after the bytes
//        had landed on somebody else's book.
//   RC2  Drive's appProperties MERGE per key, so a device on an older build,
//        writing no snapshot id, left the PREVIOUS device's identity stamped
//        on a file whose contents were now its own.
//
// Dropbox's files/upload takes `mode: update(rev)` — a true compare-and-swap
// in the same request as the bytes — and has no per-key metadata store to
// merge, because our identity fields live INSIDE the file body. See the header
// of ./transport.ts for what that buys.
//
// WHAT THIS FILE PROMISES:
//
//  * NO SECRET, EVER. Not in code, not in storage, not in a request. The app
//    key below is public by design (Dropbox documents it as safe for
//    client-side code); the confidential half of the app credential is never
//    used by this app and must never be added here. The authorization-code
//    flow is bound to this browser by PKCE instead: a random verifier stays in
//    memory, only its SHA-256 hash crosses the wire, and the code Dropbox
//    hands back is worthless to anyone who did not generate that verifier.
//  * NO SCRIPT LOADED. There is no SDK and no CDN in this path — two fetches
//    and a popup, all first-party. That deletes an entire class of failure the
//    Google flow had (C9: a <script> that has errored is dead for good, so one
//    failed load poisoned the tab until reload).
//  * MINIMUM SCOPE, and an App Folder. See DROPBOX_SCOPES. The app is
//    registered as a SCOPED APP WITH APP FOLDER ACCESS, so even a stolen token
//    reaches only /Apps/<this app>/ — never the user's wider Dropbox.
//  * CONNECTED MEANS "HAS A STANDING GRANT", NOT "HOLDS A LIVE ACCESS TOKEN"
//    (the C11 lesson, kept). isConnected() answers from the refresh token,
//    synchronously, so a reloaded page renders as the configured device it is
//    instead of offering "set up this device" to somebody with 5,127
//    transactions already synced.
//  * NOTHING IS CACHED AS PERMANENTLY BROKEN (the C9 lesson, kept). Every
//    in-flight promise is cleared on rejection, so "press Connect again" is
//    always a real retry and never hands back the same stale failure.
//
// ---------------------------------------------------------------------------
// WHERE THE REFRESH TOKEN LIVES, AND WHY — a deliberate decision, not a default
// ---------------------------------------------------------------------------
//
// Dropbox's refresh token is long-lived: valid until revoked. That is exactly
// what makes it worth having (Drive's browser flow offers no refresh at all,
// so every reload needed a fresh round trip through Google) and exactly what
// makes it worth thinking about, because it is a standing key to the app
// folder that does not expire on its own.
//
// The three candidates, and what is actually true of each:
//
//   MEMORY ONLY — safest in the abstract, and useless in practice. Every page
//     load, every PWA cold start, every iOS tab eviction would demand a full
//     interactive trip through dropbox.com before a sync could run. An owner
//     who has to re-consent several times a day turns sync off, and sync off
//     means no off-site copy at all — which is the actual data-loss risk this
//     whole feature exists to reduce (SPEC §2). Rejected on those grounds, not
//     because it is inconvenient.
//
//   INDEXEDDB (the Dexie settings row) — no better isolated than localStorage
//     (identical same-origin rules; both fall to the same XSS), and STRICTLY
//     WORSE here for one specific reason: the settings table is exported by
//     exportBackup(). A credential in a backup file is a credential in every
//     copy of that file — emailed, on a USB stick, in a cloud folder, restored
//     onto a machine the owner has since sold. That is a new and permanent
//     exposure created by us, so it is disqualifying. This is the reason the
//     key below is NOT a settings field, and the reason to keep it that way.
//
//   LOCALSTORAGE — chosen. It survives reloads, it is never swept into a
//     backup, and it reads synchronously, which isConnected() needs in order
//     to answer before the first paint.
//
// THE HONEST COST of that choice, stated plainly rather than buried: any
// script that can execute on this origin can read the token, and with it reach
// the app folder — which holds a full copy of the book. What limits the damage
// is not the storage medium but everything around it: the grant is App Folder
// only (the rest of Dropbox is unreachable), the app ships no third-party
// script and no CDN, and disconnect() revokes the token server-side rather
// than merely forgetting it. If a future build ever adds a script it does not
// itself compile, this decision must be revisited — that, and not the storage
// API, is what would change the risk.
//
// The ACCESS token is memory-only regardless. It is short-lived, a refresh
// mints another in one request without any user interaction, and there is
// nothing to gain by writing it down.

/**
 * The Dropbox app key. PUBLIC BY DESIGN — Dropbox's PKCE flow is built for
 * clients that cannot keep a secret, and this value is meant to live in
 * client-side code. It identifies the app; it authorises nothing on its own.
 *
 * THE APP SECRET IS NOT HERE AND MUST NEVER BE. A browser app cannot hold one:
 * shipping it would publish it to every visitor while adding no security
 * whatsoever. If any code path in this app ever needs `client_secret`, that is
 * a bug in the flow, not a missing constant — see refreshAccessToken().
 *
 * Overridable through DropboxAuthOptions.appKey so the owner can point the app
 * at a Dropbox app of their own.
 */
export const DROPBOX_APP_KEY = 'kbqcrqxstpn4baq';

/**
 * Every scope this app asks for, and nothing beyond it.
 *
 *   account_info.read    mandatory; Dropbox requires it of every scoped app.
 *   files.metadata.read  the cheap head read (files/get_metadata) — the rev,
 *                        without downloading megabytes to learn it.
 *   files.content.read   downloading the snapshot.
 *   files.content.write  uploading it.
 *
 * NOT REQUESTED, deliberately: files.metadata.write (Dropbox's property
 * groups — the closest thing it has to Drive's appProperties — are written in
 * a SEPARATE request from the upload and so could disagree with the file's
 * contents. That is the exact shape of RC2, and refusing the scope is the
 * cheapest possible guarantee that nobody reintroduces it), sharing.*,
 * file_requests.*, contacts.*.
 *
 * The app is registered with APP FOLDER access, so these verbs reach only the
 * folder Dropbox creates for this app. Locked by test.
 */
export const DROPBOX_SCOPES = [
  'account_info.read',
  'files.metadata.read',
  'files.content.read',
  'files.content.write',
] as const;

/** The scope list as the authorize endpoint wants it: space-delimited. */
export const DROPBOX_SCOPE = DROPBOX_SCOPES.join(' ');

export const DROPBOX_AUTHORIZE_URL = 'https://www.dropbox.com/oauth2/authorize';
export const DROPBOX_TOKEN_URL = 'https://api.dropboxapi.com/oauth2/token';
export const DROPBOX_REVOKE_URL = 'https://api.dropboxapi.com/2/auth/token/revoke';

/**
 * The standing grant. NOT a flag this time — the Google flow could only store
 * "consent happened once" because its token died with the tab; Dropbox gives
 * us a credential that can actually reconnect, and this is it. See the header
 * for why it is here and not in Dexie.
 */
export const REFRESH_TOKEN_STORAGE_KEY = 'mymoney.sync.dropbox.refreshToken';

/** Token endpoint calls are small; a hung one must never wedge the app. */
export const TOKEN_REQUEST_TIMEOUT_MS = 20_000;

/** How long to wait for the user to finish (or walk away from) the popup. */
export const INTERACTIVE_TIMEOUT_MS = 180_000;

/** How often to look at the popup to see whether it has come back to us. */
export const AUTH_POLL_INTERVAL_MS = 250;

/**
 * Treat an access token as expired this long before it really is, so a request
 * never starts with a token that dies mid-flight.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

// ---------------------------------------------------------------------------
// Errors — the vocabulary the engine and the UI already speak
// ---------------------------------------------------------------------------

/**
 * Why a sync step could not happen. Unchanged from the Google module on
 * purpose: syncEngine maps these onto SyncOutcome and the Settings screen
 * shows `message` verbatim, so every message here is written for a person.
 *
 *  config        — the app is misconfigured (bad key, bad redirect URI).
 *  not-connected — this device has never connected.
 *  auth          — the grant is gone or was revoked: reconnect needed.
 *  cancelled     — the user closed the Dropbox window. Not an error, a choice.
 *  popup-blocked — the browser refused to open the Dropbox window.
 *  offline       — no network. Expected, routine, harmless.
 *  timeout       — request took too long and was aborted.
 *  network       — the request failed for some other transport reason.
 *  remote        — Dropbox answered, but with something we refuse to trust.
 */
export type SyncErrorKind =
  | 'config'
  | 'not-connected'
  | 'auth'
  | 'cancelled'
  | 'popup-blocked'
  | 'offline'
  | 'timeout'
  | 'network'
  | 'remote';

export class SyncTransportError extends Error {
  readonly kind: SyncErrorKind;
  constructor(kind: SyncErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options as ErrorOptions);
    this.name = 'SyncTransportError';
    this.kind = kind;
  }
}

/**
 * True when the fix is "click Connect again". 'popup-blocked' counts (allow
 * pop-ups, then press it again); 'not-connected' deliberately does not — that
 * is its own SyncOutcome ("never set up"), not a grant that lapsed.
 */
export function isReconnectNeeded(err: unknown): boolean {
  return (
    err instanceof SyncTransportError &&
    (err.kind === 'auth' || err.kind === 'config' || err.kind === 'popup-blocked')
  );
}

/** True when the right response is to shrug and try later (SPEC §2.5). */
export function isOfflineError(err: unknown): boolean {
  return (
    err instanceof SyncTransportError &&
    (err.kind === 'offline' || err.kind === 'timeout' || err.kind === 'network')
  );
}

/**
 * Only `false` counts as offline. `navigator.onLine === true` merely means a
 * network interface exists, and in a non-DOM context navigator may be absent
 * entirely — we use it purely to skip a request that cannot possibly succeed.
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// ---------------------------------------------------------------------------
// PKCE
// ---------------------------------------------------------------------------

/** base64url, no padding — RFC 7636 §4.2 wants exactly this alphabet. */
export function base64Url(bytes: Uint8Array): string {
  let binary = '';
  for (const b of bytes) binary += String.fromCharCode(b);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

/**
 * A fresh code verifier: 43–128 characters from the unreserved set (RFC 7636
 * §4.1). 32 random bytes base64url-encoded gives 43 characters and 256 bits of
 * entropy, which is the whole security of this flow — a guessable verifier
 * would let an attacker who intercepted the redirect redeem the code.
 *
 * `crypto.getRandomValues` is required, not optional: Math.random() is not a
 * CSPRNG and using it here would silently reduce PKCE to decoration. If the
 * platform has no crypto we refuse to start the flow.
 */
export function randomVerifier(): string {
  const c = globalThis.crypto;
  if (!c || typeof c.getRandomValues !== 'function') {
    throw new SyncTransportError(
      'config',
      'This browser cannot generate the secure random value Dropbox sign-in needs, so nothing was sent.',
    );
  }
  return base64Url(c.getRandomValues(new Uint8Array(32)));
}

/** S256: the only challenge method we offer. `plain` is not implemented. */
export async function codeChallenge(verifier: string): Promise<string> {
  const subtle = globalThis.crypto?.subtle;
  if (!subtle) {
    throw new SyncTransportError(
      'config',
      'This browser cannot hash the Dropbox sign-in challenge (it may not be a secure context), so nothing was sent.',
    );
  }
  const digest = await subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  return base64Url(new Uint8Array(digest));
}

// ---------------------------------------------------------------------------
// Storage
// ---------------------------------------------------------------------------

function storage(): Storage | null {
  // Accessing localStorage throws outright in some privacy modes.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export interface RefreshTokenStore {
  get(): string | null;
  set(value: string | null): void;
}

export const localRefreshTokenStore: RefreshTokenStore = {
  get() {
    try {
      const v = storage()?.getItem(REFRESH_TOKEN_STORAGE_KEY) ?? null;
      return v === '' ? null : v;
    } catch {
      return null;
    }
  },
  set(value) {
    try {
      const s = storage();
      if (!s) return;
      if (value) s.setItem(REFRESH_TOKEN_STORAGE_KEY, value);
      else s.removeItem(REFRESH_TOKEN_STORAGE_KEY);
    } catch {
      /* a browser that refuses to persist it simply reconnects next time */
    }
  },
};

// ---------------------------------------------------------------------------
// The contract
// ---------------------------------------------------------------------------

/**
 * What the transport needs from an identity source. Shape unchanged from the
 * Google module so the transport, and every fake written against it, keeps
 * working across the provider swap.
 */
export interface TokenProvider {
  /**
   * Synchronous — is this device SET UP to sync? That means a standing grant
   * (a refresh token), NOT a live access token. A `true` here promises that a
   * token can probably be obtained, not that one is in hand.
   */
  isConnected(): boolean;
  /**
   * DEPRECATED alias of isConnected(), kept because transport.ts and existing
   * fakes spell the question this way. It does NOT answer "is a token in
   * hand"; asking that was the C11 bug.
   */
  hasValidToken(): boolean;
  /** Has this device completed consent before? */
  isLinked(): boolean;
  /**
   * A usable access token, obtained on demand: the cached one, else a silent
   * refresh, else (only with a user gesture behind it) the Dropbox window.
   * Throws SyncTransportError.
   */
  getToken(opts?: { allowPrompt?: boolean }): Promise<string>;
  /** Interactive consent. Only ever called from a real user click. */
  connect(): Promise<void>;
  /** Drop the cached ACCESS token after a 401. Keeps the standing grant. */
  invalidate(): void;
  /** Revoke and forget. Never touches anything stored in Dropbox. */
  disconnect(): Promise<void>;
}

/**
 * The popup, as much of it as we use. Typed narrowly so tests can supply a
 * double without pretending to be a whole Window.
 */
export interface AuthWindow {
  closed: boolean;
  close(): void;
  /** Reading `.href` THROWS while the window is on dropbox.com — that is the
   *  same-origin policy doing its job, and the polling loop expects it. */
  readonly location: { href: string };
}

export interface DropboxAuthOptions {
  /** The Dropbox app key. Defaults to DROPBOX_APP_KEY. */
  appKey?: () => string | Promise<string>;
  /**
   * @deprecated Legacy name from the Drive build, where the owner supplied
   * their own Google OAuth client id. Treated as an app key when it is
   * non-empty, ignored when it is blank (which is the normal case now: the
   * Dropbox app key is built in and public). Accepted only so the Settings
   * screen, which is owned elsewhere, keeps compiling and working unchanged.
   */
  clientId?: () => string | Promise<string>;
  /**
   * The registered redirect URI. MUST match one in the Dropbox app console
   * character for character, trailing slash included, or Dropbox refuses the
   * authorize request outright. Defaults to the directory this app is served
   * from, which is what makes one build work at both registered URIs.
   */
  redirectUri?: () => string;
  /** Test seam for window.open. */
  openWindow?: (url: string, name: string, features: string) => AuthWindow | null;
  /** Test seam. */
  fetchImpl?: typeof fetch;
  /** Test seam. */
  now?: () => number;
  /** Test seam — how often the popup is checked. */
  pollIntervalMs?: number;
  /** Test seam for where the standing grant is kept. */
  refreshTokenStore?: RefreshTokenStore;
}

/**
 * The directory this app is served from, with a trailing slash.
 *
 * Both registered redirect URIs (the GitHub Pages subpath and the dev server
 * root) are exactly this, which is why it is computed rather than configured:
 * one build, two hosts, no environment variable. A path segment after the last
 * slash (index.html) is dropped; a query string or fragment never appears in a
 * redirect URI at all.
 */
export function defaultRedirectUri(): string {
  const loc = (globalThis as { location?: { origin?: string; pathname?: string } }).location;
  if (!loc?.origin) {
    throw new SyncTransportError(
      'config',
      'Dropbox sign-in is only available in a browser window.',
    );
  }
  const path = loc.pathname ?? '/';
  return `${loc.origin}${path.slice(0, path.lastIndexOf('/') + 1)}`;
}

/**
 * Would a window opened right now survive the popup blocker? Consent UI has to
 * ride on a real user gesture, and this is the browser's own answer.
 *
 * When the API is absent we answer TRUE rather than guessing false: refusing
 * to ask would strand the owner on a screen that tells them to reconnect and
 * then never reconnects. Asking and being refused costs one 'popup-blocked'
 * error, whose message already says what to change.
 */
function popupCouldOpen(): boolean {
  if (typeof navigator === 'undefined') return true;
  const activation = (navigator as unknown as { userActivation?: { isActive?: boolean } })
    .userActivation;
  if (!activation || typeof activation.isActive !== 'boolean') return true;
  return activation.isActive;
}

function isAbort(e: unknown): boolean {
  return (
    typeof e === 'object' &&
    e !== null &&
    ((e as { name?: string }).name === 'AbortError' ||
      (e as { name?: string }).name === 'TimeoutError')
  );
}

/** The body Dropbox's token endpoint sends when it says no. */
interface TokenErrorBody {
  error?: string | { '.tag'?: string };
  error_description?: string;
}

function tagOf(error: TokenErrorBody['error']): string {
  if (typeof error === 'string') return error;
  return error?.['.tag'] ?? '';
}

export function createDropboxTokenProvider(opts: DropboxAuthOptions = {}): TokenProvider {
  const store = opts.refreshTokenStore ?? localRefreshTokenStore;
  const now = opts.now ?? Date.now;
  const pollMs = opts.pollIntervalMs ?? AUTH_POLL_INTERVAL_MS;
  const openWindow =
    opts.openWindow ??
    ((url: string, name: string, features: string) =>
      (globalThis as { open?: (u: string, n: string, f: string) => AuthWindow | null }).open?.(
        url,
        name,
        features,
      ) ?? null);

  // Memory only — see "WHERE THE REFRESH TOKEN LIVES" in the header.
  let access: { value: string; expiresAt: number } | null = null;
  // Read once, then kept here, so isConnected() never touches storage on a hot
  // path and never disagrees with itself mid-render.
  let refresh: string | null = store.get();
  let inFlight: Promise<string> | null = null;

  function doFetch(url: string, init: RequestInit): Promise<Response> {
    const f = opts.fetchImpl ?? globalThis.fetch;
    return f(url, init);
  }

  async function appKey(): Promise<string> {
    const own = opts.appKey ? String((await opts.appKey()) ?? '').trim() : '';
    if (own) return own;
    // The legacy Drive-era setting. Blank on every device that has not been
    // hand-configured, which is the normal case.
    const legacy = opts.clientId ? String((await opts.clientId()) ?? '').trim() : '';
    if (legacy) return legacy;
    return DROPBOX_APP_KEY;
  }

  /**
   * One call to Dropbox's token endpoint, bounded end to end WITH THE BODY
   * READ INSIDE THE LEASH. `fetch` resolves when the headers arrive; releasing
   * the timer there is what left body reads unbounded in the Drive build, so a
   * connection that said "200 OK" and then went silent hung for ever behind a
   * spinner that never stopped.
   *
   * NO CLIENT SECRET IS SENT. Not here, not anywhere. `client_id` plus the
   * PKCE verifier is the whole credential for the authorization-code grant,
   * and `client_id` alone for the refresh grant (a public client has no other
   * half to offer — RFC 6749 §6 with RFC 7636). If Dropbox ever answered
   * `invalid_client` to that, adding a secret would NOT be the fix; see
   * refreshAccessToken().
   */
  async function tokenRequest(body: Record<string, string>, what: string): Promise<{
    access_token?: string;
    refresh_token?: string;
    expires_in?: number | string;
    scope?: string;
  }> {
    if (isOffline()) {
      throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
    }
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
    let status: number;
    let text: string;
    try {
      const res = await doFetch(DROPBOX_TOKEN_URL, {
        method: 'POST',
        signal: controller.signal,
        credentials: 'omit',
        referrerPolicy: 'no-referrer',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(body).toString(),
      });
      status = res.status;
      text = await res.text();
    } catch (e) {
      if (isAbort(e)) {
        throw new SyncTransportError(
          'timeout',
          `Dropbox took too long to ${what}. Nothing was changed; try again.`,
        );
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }
      throw new SyncTransportError('network', `Couldn't reach Dropbox to ${what}.`, { cause: e });
    } finally {
      clearTimeout(timer);
    }

    if (status >= 200 && status < 300) {
      try {
        return JSON.parse(text) as Record<string, never>;
      } catch {
        throw new SyncTransportError(
          'remote',
          `Dropbox's answer when asked to ${what} was not readable. Nothing was changed.`,
        );
      }
    }

    let parsed: TokenErrorBody = {};
    try {
      parsed = JSON.parse(text) as TokenErrorBody;
    } catch {
      /* a body we cannot read must not stop us reporting the status */
    }
    const tag = tagOf(parsed.error);
    const detail = parsed.error_description ?? tag ?? '';

    // ==== THE FINDING THAT WOULD REOPEN THE PROVIDER DECISION ==============
    // A public client authenticates with `client_id` and PKCE and nothing
    // else. If Dropbox rejects that as an unauthenticated client, then this
    // app cannot use Dropbox at all — the answer is NOT to ship a secret (a
    // browser cannot keep one; publishing it would authenticate every visitor
    // as us) and NOT to stand up a server (there isn't one, by design). It is
    // to go back and choose a different provider. So it is reported as
    // exactly that, loudly, rather than being swallowed as "reconnect".
    if (tag === 'invalid_client' || /client[_ ]secret/i.test(detail)) {
      throw new SyncTransportError(
        'config',
        'Dropbox refused this app without a client secret, which a browser app cannot ' +
          'have. Sync cannot work this way and nothing was changed — this needs the ' +
          `sign-in method rethinking, not a retry. (Dropbox said: ${detail || tag}.)`,
      );
    }

    if (status === 400 && tag === 'invalid_grant') {
      // The code was replayed/expired, or the refresh token has been revoked
      // (from dropbox.com, or by the user disconnecting elsewhere). Either
      // way the standing grant is gone and only a fresh consent restores it.
      throw new SyncTransportError(
        'auth',
        'Dropbox no longer accepts this device’s sign-in. Reconnect to sync.',
      );
    }
    if (status === 429 || status >= 500) {
      throw new SyncTransportError(
        'network',
        `Dropbox is busy right now (HTTP ${status}). Nothing was changed; try again shortly.`,
      );
    }
    if (status === 400 || status === 401 || status === 403) {
      throw new SyncTransportError(
        'auth',
        `Dropbox refused the sign-in (${detail || `HTTP ${status}`}). Reconnect to sync.`,
      );
    }
    throw new SyncTransportError(
      'remote',
      `Dropbox couldn't ${what} (HTTP ${status}${detail ? `: ${detail}` : ''}).`,
    );
  }

  /** Store an access token, and a refresh token when one came with it. */
  function adopt(r: { access_token?: string; refresh_token?: string; expires_in?: number | string }): string {
    const value = r.access_token;
    if (typeof value !== 'string' || value === '') {
      throw new SyncTransportError('auth', 'Dropbox did not return an access token.');
    }
    const seconds = Number(r.expires_in);
    // Dropbox short-lived tokens run about four hours; the fallback is
    // deliberately pessimistic, because expiring early costs one extra refresh
    // and expiring late costs a failed request mid-sync.
    const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600_000;
    access = { value, expiresAt: now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS) };
    if (typeof r.refresh_token === 'string' && r.refresh_token !== '') {
      refresh = r.refresh_token;
      store.set(refresh);
    }
    return value;
  }

  /**
   * Swap the standing grant for a fresh access token. No user interaction, no
   * window, no live browser session at Dropbox required — this is the thing
   * Google's browser flow could not do at all, and the reason a reloaded page
   * can sync without asking the owner for anything.
   */
  async function refreshAccessToken(): Promise<string> {
    const token = refresh;
    if (!token) {
      throw new SyncTransportError('not-connected', 'Dropbox sync is not connected yet.');
    }
    const key = await appKey();
    try {
      return adopt(
        await tokenRequest(
          {
            grant_type: 'refresh_token',
            refresh_token: token,
            // The ONLY credential. A public client sends no secret; PKCE's
            // verifier belongs to the authorization-code grant and has no
            // place in a refresh (RFC 7636 §4.5 — it is checked once, at code
            // redemption, and the refresh token is what carries the binding
            // afterwards).
            client_id: key,
          },
          'refresh the connection',
        ),
      );
    } catch (e) {
      // A grant Dropbox has disowned must not sit in storage pretending this
      // device is connected: isConnected() would keep saying yes and every
      // sync would fail the same way. Transient failures (offline, 5xx) leave
      // it exactly where it is.
      if (e instanceof SyncTransportError && e.kind === 'auth') forgetGrant();
      throw e;
    }
  }

  function forgetGrant(): void {
    refresh = null;
    access = null;
    store.set(null);
  }

  /**
   * The interactive half: a popup at Dropbox, and the authorization code it
   * comes back with.
   *
   * A POPUP RATHER THAN A FULL-PAGE REDIRECT, on purpose. A redirect would
   * navigate away from an app holding unsaved state and would need the app
   * shell to notice `?code=` at boot — code in a file this module does not
   * own. The popup keeps the entire flow inside this module: it returns to our
   * own redirect URI, which is same-origin, so the opener can simply read the
   * query string off it. Nothing is persisted at any point — the verifier and
   * the state live in this closure and die with the attempt.
   */
  async function authorize(): Promise<string> {
    const key = await appKey();
    const redirectUri = (opts.redirectUri ?? defaultRedirectUri)();
    const verifier = randomVerifier();
    const challenge = await codeChallenge(verifier);
    // Not a secret, and not load-bearing for PKCE — it is here so a callback
    // that did not come from the request we just made is thrown away rather
    // than redeemed.
    const state = randomVerifier();

    const url =
      `${DROPBOX_AUTHORIZE_URL}?` +
      new URLSearchParams({
        client_id: key,
        response_type: 'code',
        redirect_uri: redirectUri,
        code_challenge: challenge,
        code_challenge_method: 'S256',
        state,
        scope: DROPBOX_SCOPE,
        // The whole point of moving: a refresh token that is valid until
        // revoked, so the owner consents once rather than once an hour.
        token_access_type: 'offline',
      }).toString();

    const popup = openWindow(url, 'mymoney-dropbox', 'width=640,height=760,menubar=no,toolbar=no');
    if (!popup) {
      throw new SyncTransportError(
        'popup-blocked',
        'Your browser blocked the Dropbox sign-in window. Allow pop-ups for this site and try again.',
      );
    }

    const deadline = now() + INTERACTIVE_TIMEOUT_MS;
    const shut = () => {
      try {
        popup.close();
      } catch {
        /* a window that will not close is not a reason to fail the sign-in */
      }
    };

    for (;;) {
      if (popup.closed) {
        throw new SyncTransportError('cancelled', 'Dropbox sign-in was closed before finishing.');
      }
      let href: string | null = null;
      try {
        // Throws (SecurityError) for as long as the popup is on dropbox.com.
        // That is not an error condition, it is how we know it has not come
        // back yet.
        href = popup.location.href;
      } catch {
        href = null;
      }
      if (href && href.startsWith(redirectUri)) {
        shut();
        const params = new URL(href).searchParams;
        const error = params.get('error');
        if (error) {
          if (error === 'access_denied') {
            throw new SyncTransportError('cancelled', 'Dropbox access was declined.');
          }
          throw new SyncTransportError(
            'auth',
            `Dropbox sign-in failed (${params.get('error_description') ?? error}).`,
          );
        }
        if (params.get('state') !== state) {
          // Somebody else's callback, or a stale one. Redeeming it would bind
          // this device to a grant nobody here asked for.
          throw new SyncTransportError(
            'auth',
            'The Dropbox sign-in that came back did not match the one this device started, so it was ignored. Try again.',
          );
        }
        const code = params.get('code');
        if (!code) {
          throw new SyncTransportError('auth', 'Dropbox sign-in returned no authorization code.');
        }
        return await redeem(code, verifier, redirectUri, key);
      }
      if (now() >= deadline) {
        shut();
        throw new SyncTransportError('cancelled', 'Dropbox sign-in timed out.');
      }
      await new Promise((r) => setTimeout(r, pollMs));
    }
  }

  /** Exchange the one-time code for tokens. The verifier proves it is ours. */
  async function redeem(
    code: string,
    verifier: string,
    redirectUri: string,
    key: string,
  ): Promise<string> {
    const r = await tokenRequest(
      {
        grant_type: 'authorization_code',
        code,
        code_verifier: verifier,
        client_id: key,
        redirect_uri: redirectUri,
      },
      'complete sign-in',
    );
    // token_access_type=offline was requested, so a refresh token is expected.
    // Without one this device would work until the access token expired and
    // then quietly demand consent again for ever, which is precisely the
    // Google failure this migration exists to end — so say so now.
    if (typeof r.refresh_token !== 'string' || r.refresh_token === '') {
      throw new SyncTransportError(
        'auth',
        'Dropbox signed in but did not give this device a lasting connection, so it would ' +
          'ask again within hours. Nothing was changed; try connecting again.',
      );
    }
    // Refuse a grant that came back narrower than what sync needs, rather than
    // discovering it later as a 403 in the middle of a push.
    if (typeof r.scope === 'string' && r.scope.trim() !== '') {
      const granted = new Set(r.scope.split(/\s+/).filter(Boolean));
      const missing = DROPBOX_SCOPES.filter((s) => !granted.has(s));
      if (missing.length > 0) {
        throw new SyncTransportError(
          'auth',
          `Dropbox did not grant everything sync needs (missing ${missing.join(', ')}). Nothing was changed.`,
        );
      }
    }
    return adopt(r);
  }

  /**
   * One attempt at a time, and NEVER a cached failure (the C9 lesson). The
   * in-flight promise is cleared in a `finally`, so a rejection is handed to
   * the caller that is waiting and to nobody else — the next press of Connect
   * starts from scratch instead of being given the same stale error for the
   * life of the tab.
   */
  function once(run: () => Promise<string>): Promise<string> {
    if (inFlight) return inFlight;
    const p = run();
    inFlight = p;
    return p.finally(() => {
      if (inFlight === p) inFlight = null;
    });
  }

  const isConnected = () => refresh !== null;

  return {
    isConnected,
    hasValidToken: isConnected,
    isLinked: isConnected,

    invalidate() {
      // Only the access token. The standing grant survives, which is what lets
      // the retry after a 401 refresh silently instead of reporting the device
      // as never set up.
      access = null;
    },

    async getToken(o) {
      const allowPrompt = o?.allowPrompt ?? true;
      if (access && access.expiresAt > now()) return access.value;
      access = null;
      if (!refresh) {
        throw new SyncTransportError('not-connected', 'Dropbox sync is not connected yet.');
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }
      try {
        return await once(refreshAccessToken);
      } catch (e) {
        // Only a dead grant is worth a window, and only when there is a
        // gesture to hang it on. Offline, a timeout or a 5xx would fail the
        // same way with a popup in front of them.
        const dead = e instanceof SyncTransportError && e.kind === 'auth';
        if (!dead || !allowPrompt || !popupCouldOpen()) throw e;
      }
      return once(authorize);
    },

    async connect() {
      await once(authorize);
    },

    async disconnect() {
      const held = access?.value;
      // Local state goes first and unconditionally: whatever Dropbox says
      // next, this device is disconnected, and a failed revoke must never look
      // like "disconnect didn't work".
      forgetGrant();
      if (!held) return;
      try {
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), TOKEN_REQUEST_TIMEOUT_MS);
        try {
          // Revoking the access token revokes the whole grant, refresh token
          // included — which is the point. The file in Dropbox is left exactly
          // where it is; there is no code path in this app that deletes it.
          await doFetch(DROPBOX_REVOKE_URL, {
            method: 'POST',
            signal: controller.signal,
            credentials: 'omit',
            referrerPolicy: 'no-referrer',
            headers: { authorization: `Bearer ${held}` },
          });
        } finally {
          clearTimeout(timer);
        }
      } catch {
        /* nothing to tell the user: they are disconnected locally regardless */
      }
    },
  };
}
