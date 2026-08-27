// Google OAuth for Drive sync — browser-only, no client secret (D42).
//
// This module is the ONLY place in the app that talks to Google's identity
// service, and it is deliberately inert until the user clicks "Connect".
// Constraints it exists to honour:
//
//   * ZERO FEES — Drive API on a personal Google account is free. No server of
//     ours sits in this flow; there is nothing to pay for and nothing to run.
//   * NO SECRET — a browser app cannot keep one, so this is the GIS *token*
//     flow (OAuth 2.0 implicit-style): the client id is public by design and
//     is the USER'S OWN (settings.syncClientId). No client id of ours is ever
//     hard-coded or shipped in the repo; see docs/DRIVE-SETUP.md.
//   * MINIMUM SCOPE — `drive.file` and nothing else. That grants access ONLY
//     to files this app itself created. The app cannot see, list, read or
//     touch any other file in the user's Drive, and must never be widened;
//     tests/sync-transport.test.ts fails the build if anyone tries.
//   * NO REQUEST UNTIL ASKED — SPEC §2.3 keeps the app's outbound traffic
//     minimal and disclosed. The GSI script is fetched lazily on the first
//     connect(), never at import, never at start-up. Importing this module
//     touches the network zero times.
//   * OFFLINE-FIRST — every failure here is a non-event for the rest of the
//     app. Errors are typed (SyncTransportError) so the engine can turn them
//     into a calm outcome instead of an exception the user has to clear.
//
// TOKEN LIFETIME — the honest limitation. The token flow issues an access
// token that lasts about an hour and there is NO refresh token (that requires
// a confidential client, i.e. a server, which this app does not have).
//
// WHAT IS KEPT WHERE, AND WHY:
//
//   * THE ACCESS TOKEN — memory only, in the provider closure below. Never
//     localStorage, never sessionStorage, never IndexedDB, never a backup
//     file. It is a bearer credential for the owner's Drive: persisting it
//     would hand an hour-long key to their financial data to every script on
//     this origin, and — through a backup file — to wherever that file is
//     later copied. A page reload therefore starts with NO token BY DESIGN.
//     That is a property to work with, not a fault to engineer around.
//   * THE STANDING GRANT — a single flag in localStorage (LINKED_STORAGE_KEY,
//     the string '1'). It is not a credential and unlocks nothing: it says
//     only "this browser profile completed consent for this app once", which
//     is exactly what makes a silent re-grant worth attempting instead of
//     asking the owner again. localStorage rather than IndexedDB because
//     isConnected() must answer synchronously, before any await, for the UI to
//     render the right card on first paint.
//   * THE CLIENT ID — the app's own settings row (Dexie). The user's own, and
//     public by design; read through a getter so editing it takes effect at
//     once (see GoogleTokenProviderOptions.clientId).
//
// CONNECTED THEREFORE MEANS "a client id and a standing grant", NOT "a live
// token in hand". It used to mean the latter, and since the token is
// memory-only and lasts about an hour, a fully configured device announced
// itself as NOT SET UP after every reload and every ~59 minutes: the Sync
// screen offered "Set up this device", sync refused with 'not-connected', and
// the silent re-grant that would have fixed it in one round trip was never
// reached. Getting a token is an on-demand step inside sync (getToken()), not
// a precondition the UI tests for.
//
// THE LADDER, when something needs a token and none is in hand:
//   1. a silent re-grant (`prompt: ''`) — no UI at all. It succeeds while the
//      owner still has a live Google session and has already granted the
//      scope, which is the ordinary case after a reload;
//   2. if that genuinely fails, a VISIBLE prompt (the account chooser) — but
//      only while the browser still reports a live user activation, so a sync
//      the owner just asked for gets the chooser and merely opening a screen
//      never does. A caller that knows it has no gesture behind it (a future
//      background sync) says so with `getToken({ allowPrompt: false })`;
//   3. a clean "reconnect" state (SyncTransportError kind 'auth',
//      isReconnectNeeded() === true) rather than retrying forever or, worse,
//      letting sync think there is no remote.

/**
 * The ONLY OAuth scope this app ever requests.
 *
 * `drive.file` is per-file access limited to files the app created or the user
 * explicitly opened with it. What that means concretely:
 *   CAN  — create `mymoney-sync.json`, read it back, overwrite it.
 *   CANNOT — list, read, search or modify anything else in the user's Drive;
 *            it cannot even tell that the rest of the Drive exists.
 * Widening this (drive, drive.readonly, drive.appdata, …) would hand a
 * personal-finance app a view of the user's entire Drive for no benefit.
 * Locked by test.
 */
export const DRIVE_SCOPE = 'https://www.googleapis.com/auth/drive.file';

/** Google Identity Services client library. Loaded lazily, only on connect. */
export const GSI_SCRIPT_SRC = 'https://accounts.google.com/gsi/client';

/** A script that never loads must not leave connect() hanging forever. */
export const GSI_LOAD_TIMEOUT_MS = 15_000;

/** How long to wait for the user to finish (or dismiss) the consent popup. */
export const INTERACTIVE_TOKEN_TIMEOUT_MS = 180_000;

/** A silent re-grant either works quickly or it is not going to work. */
export const SILENT_TOKEN_TIMEOUT_MS = 20_000;

/**
 * Treat a token as expired this long before it really is, so a request never
 * starts with a token that dies mid-flight.
 */
export const TOKEN_EXPIRY_MARGIN_MS = 60_000;

/** Remembers that this device has completed consent at least once. Not a
 *  credential — just the hint that makes a silent re-grant worth attempting. */
export const LINKED_STORAGE_KEY = 'mymoney.sync.google.linked';

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

/**
 * Why a sync step could not happen. The engine maps these onto SyncOutcome;
 * the UI shows `message` verbatim, so every message is written for a person.
 *
 *  config        — no client id set up yet (docs/DRIVE-SETUP.md).
 *  not-connected — user has never connected on this device.
 *  auth          — the grant is gone or expired: reconnect needed.
 *  cancelled     — user closed the consent popup. Not an error, a choice.
 *  popup-blocked — the browser refused to open the Google popup.
 *  offline       — no network. Expected, routine, harmless.
 *  timeout       — request took too long and was aborted.
 *  network       — the request failed for some other transport reason.
 *  remote        — Drive answered, but with something we refuse to trust.
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
 * True when the fix is "click Connect again" — the UI's reconnect state.
 * 'popup-blocked' counts: the user has to allow the popup and re-connect, so
 * the same button is the answer. 'not-connected' deliberately does NOT — it is
 * its own SyncOutcome ("never set up"), not a grant that lapsed.
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
 * (Same rule as src/domain/fxAuto.ts.)
 */
export function isOffline(): boolean {
  return typeof navigator !== 'undefined' && navigator.onLine === false;
}

// ---------------------------------------------------------------------------
// Google Identity Services — minimal local typings
// ---------------------------------------------------------------------------
// Typed by hand rather than by pulling in @types/google.accounts: the surface
// we use is four fields wide, and SPEC §3 says ask before adding dependencies.

export interface GisTokenResponse {
  access_token?: string;
  expires_in?: number | string;
  /** Space-delimited list of scopes actually granted. */
  scope?: string;
  error?: string;
  error_description?: string;
}

export interface GisErrorResponse {
  type?: 'popup_closed' | 'popup_failed_to_open' | 'unknown' | string;
  message?: string;
}

export interface GisTokenClient {
  requestAccessToken(overrides?: { prompt?: string; hint?: string }): void;
}

export interface GisOAuth2 {
  initTokenClient(config: {
    client_id: string;
    scope: string;
    callback: (response: GisTokenResponse) => void;
    error_callback?: (error: GisErrorResponse) => void;
    prompt?: string;
  }): GisTokenClient;
  revoke(accessToken: string, done?: () => void): void;
}

interface GisGlobal {
  google?: { accounts?: { oauth2?: GisOAuth2 } };
}

/** The GIS namespace, or null when the script has not loaded (yet, or ever). */
export function gisOAuth2(): GisOAuth2 | null {
  return (globalThis as GisGlobal).google?.accounts?.oauth2 ?? null;
}

// ---------------------------------------------------------------------------
// Lazy script loading
// ---------------------------------------------------------------------------

let gsiLoad: Promise<GisOAuth2> | null = null;

/**
 * Take a dead <script> back out of the document. Deliberately defensive: this
 * only ever runs on a failure path, where an element that cannot be detached
 * (already removed, or a DOM double in a test) must not turn a load failure
 * into a thrown exception on top of it.
 */
function detach(script: HTMLScriptElement): void {
  try {
    script.parentNode?.removeChild(script);
  } catch {
    /* litter in <head> is not worth failing a retry over */
  }
}

/**
 * Fetch the GSI client, on demand. Nothing calls this until the user connects,
 * which is what keeps a freshly opened app silent (SPEC §2.3).
 *
 * A RETRY MUST ACTUALLY RETRY. Failing to load this script is ordinary — a
 * phone out of coverage, a proxy or extension blocking accounts.google.com, a
 * slow first paint — so "press Connect again" has to work. Two rules make it
 * work, and both replace something that looked harmless and was not:
 *
 *  1. EVERY ATTEMPT APPENDS A FRESH ELEMENT. A <script> that has errored is
 *     dead for good: the HTML spec runs its "prepare" algorithm once, so
 *     re-appending it or re-assigning .src fetches nothing and it never fires
 *     `load` or `error` again. The previous version looked the tag up with
 *     document.querySelector and reused whatever it found, so one failed load
 *     poisoned the tab: every later Connect adopted the corpse, waited the
 *     full GSI_LOAD_TIMEOUT_MS, and then advised "check your connection and
 *     try again" — advice that could not work, because only a page reload
 *     could, and nothing said so. Appending a duplicate is the far cheaper
 *     mistake: the early return above means we only ever get here when the
 *     library is NOT loaded, and a second request for a cached script costs
 *     nothing. A failed element is removed from <head> as well, so a page that
 *     retries a few times does not accumulate corpses.
 *  2. NO FAILURE IS EVER CACHED. `gsiLoad` holds the attempt only while it is
 *     pending or fulfilled; the moment it rejects it is cleared (see below),
 *     so the next caller starts from scratch rather than being handed the
 *     same rejection for the life of the tab.
 */
export function loadGsi(): Promise<GisOAuth2> {
  const already = gisOAuth2();
  if (already) return Promise.resolve(already);
  if (gsiLoad) return gsiLoad;

  const attempt = new Promise<GisOAuth2>((resolve, reject) => {
    if (typeof document === 'undefined') {
      reject(
        new SyncTransportError('config', 'Google sign-in is only available in a browser window.'),
      );
      return;
    }
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const failed = () =>
      finish(() =>
        reject(
          new SyncTransportError(
            'network',
            "Couldn't load Google sign-in. Check your connection and try again.",
          ),
        ),
      );

    const timer = setTimeout(() => {
      // The element is deliberately LEFT in the document here (unlike the
      // error path): the request may still be in flight, and a load that
      // finishes late still defines google.accounts.oauth2, which the early
      // return above then picks up for free. Nothing reuses this element
      // either way — the next attempt appends its own.
      failed();
    }, GSI_LOAD_TIMEOUT_MS);

    const script = document.createElement('script');
    script.addEventListener('load', () => {
      const api = gisOAuth2();
      finish(() =>
        api
          ? resolve(api)
          : reject(new SyncTransportError('network', 'Google sign-in loaded but is unavailable.')),
      );
    });
    script.addEventListener('error', () => {
      // This element is inert from here on. Leaving it in the document is what
      // let the next attempt adopt it and hang.
      detach(script);
      failed();
    });
    script.src = GSI_SCRIPT_SRC;
    script.async = true;
    script.defer = true;
    document.head.appendChild(script);
  });

  // Rule 2, in one place: a rejected attempt un-caches itself. The handler is
  // attached before the promise is handed to any caller, so it runs first and
  // `gsiLoad` is already null by the time a caller's catch block decides to
  // retry. (It also means the rejection is never "unhandled".)
  attempt.catch(() => {
    if (gsiLoad === attempt) gsiLoad = null;
  });
  gsiLoad = attempt;
  return attempt;
}

/** Test seam: forget any cached load so the next loadGsi() starts fresh. */
export function resetGsiLoaderForTests(): void {
  gsiLoad = null;
}

// ---------------------------------------------------------------------------
// Token provider
// ---------------------------------------------------------------------------

/**
 * What the Drive transport needs from an identity source. Everything network-
 * facing is behind this interface so the transport can be tested with a fake
 * and never has to reach for a real popup.
 */
export interface TokenProvider {
  /**
   * Synchronous — is this device SET UP to sync? That means a client id and a
   * standing grant, NOT a live access token: the token is memory-only and
   * lasts about an hour, so answering with it made a configured device claim
   * it was never set up after every reload (see the header). A `true` here is
   * a promise that a token can probably be obtained, not that one is in hand;
   * getToken() is what actually obtains it, when something needs it.
   */
  isConnected(): boolean;
  /**
   * DEPRECATED — an alias of isConnected(), kept only because transport.ts
   * still spells the question this way (`isConnected: () => auth.hasValidToken()`).
   * It does NOT answer "is a token in hand"; nothing outside this module needs
   * to ask that, and asking it was the bug. Delete this together with that
   * call site.
   */
  hasValidToken(): boolean;
  /** Has this device completed consent before (so a silent re-grant is worth a try)? */
  isLinked(): boolean;
  /**
   * A usable access token, obtained on demand: cached one, else a silent
   * re-grant, else a visible prompt. Throws SyncTransportError.
   *
   * `allowPrompt: false` forbids the visible step, for a caller with no user
   * gesture behind it (a background sync). It defaults to TRUE because every
   * caller today is one click deep from the Sync screen, and refusing to sync
   * when a two-second account chooser would have fixed it is the worse
   * failure for someone whose data is the point — and because the default is
   * belt-and-braces anyway: the window is only ever opened while the browser
   * still reports a live user activation (see popupCouldOpen).
   */
  getToken(opts?: { allowPrompt?: boolean }): Promise<string>;
  /** Interactive consent. Only ever called from a real user click. */
  connect(): Promise<void>;
  /** Drop the cached token after a 401 so the next getToken() re-requests. */
  invalidate(): void;
  /** Revoke and forget. Never touches anything stored in Drive. */
  disconnect(): Promise<void>;
}

function storage(): Storage | null {
  // Accessing localStorage throws outright in some privacy modes.
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

function readLinked(): boolean {
  try {
    return storage()?.getItem(LINKED_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

function writeLinked(linked: boolean): void {
  try {
    const s = storage();
    if (!s) return;
    if (linked) s.setItem(LINKED_STORAGE_KEY, '1');
    else s.removeItem(LINKED_STORAGE_KEY);
  } catch {
    /* a hint we cannot persist is not worth an error */
  }
}

function errorFromTokenResponse(r: GisTokenResponse): SyncTransportError {
  const detail = r.error_description ?? r.error ?? 'unknown error';
  if (r.error === 'access_denied') {
    return new SyncTransportError('cancelled', 'Google Drive access was declined.');
  }
  return new SyncTransportError('auth', `Google sign-in failed (${detail}).`);
}

function errorFromGisError(e: GisErrorResponse): SyncTransportError {
  switch (e.type) {
    case 'popup_closed':
      return new SyncTransportError('cancelled', 'Google sign-in was closed before finishing.');
    case 'popup_failed_to_open':
      return new SyncTransportError(
        'popup-blocked',
        'Your browser blocked the Google sign-in window. Allow pop-ups for this site and try again.',
      );
    default:
      return new SyncTransportError('auth', `Google sign-in failed (${e.message ?? e.type ?? 'unknown'}).`);
  }
}

/**
 * Every failure the token flow raises is already typed and already written for
 * a person: 'config' says paste your client ID, 'network' says the sign-in
 * script would not load, 'cancelled' says you closed the window, 'popup-blocked'
 * says allow pop-ups, 'auth' says the grant lapsed. Only something that is NOT
 * one of ours is a genuine "no idea what happened" — and the honest thing to
 * say about the grant then is that it needs re-making.
 *
 * (The previous version flattened everything into 'auth', which told an owner
 * whose phone was on a train that their Google sign-in had expired.)
 */
function asTokenError(e: unknown): SyncTransportError {
  if (e instanceof SyncTransportError) return e;
  return new SyncTransportError('auth', 'Google sign-in has expired. Reconnect to sync.', {
    cause: e,
  });
}

/**
 * Is a silent failure one that showing the account chooser could actually fix?
 *
 *  'auth'      — no live Google session, or the grant needs re-issuing. Asking
 *                is exactly the fix.
 *  'cancelled' — from the SILENT path this is not a person declining anything:
 *                GIS answers `access_denied` when it cannot mint a token
 *                without interaction. Interaction is what we are offering.
 *
 * Everything else is answered, not blocked: 'config' has no client id to use,
 * 'offline'/'network'/'timeout' would fail the same way with a popup in front
 * of them, and 'popup-blocked' IS the browser having already refused a window
 * — asking for a second one repeats the refusal, while the message already
 * tells the owner what to change.
 */
function silentFailureIsPromptable(e: unknown): boolean {
  return e instanceof SyncTransportError && (e.kind === 'auth' || e.kind === 'cancelled');
}

/**
 * Would a window opened right now survive the browser's popup blocker?
 *
 * Consent UI has to ride on a real user gesture, and `navigator.userActivation
 * .isActive` is the browser's own answer to "is one still in effect". This is
 * what keeps the visible step honest: a sync the owner just asked for gets the
 * account chooser, while merely OPENING the Sync screen (which probes the
 * remote) can never throw a window at them.
 *
 * When the API is absent we answer TRUE rather than guessing false: refusing to
 * ask would strand the owner on a screen telling them to reconnect that then
 * never reconnects. Asking and being refused costs one 'popup-blocked' error,
 * whose message already says to allow pop-ups and try again.
 */
function popupCouldOpen(): boolean {
  if (typeof navigator === 'undefined') return true;
  const activation = (navigator as unknown as { userActivation?: { isActive?: boolean } })
    .userActivation;
  if (!activation || typeof activation.isActive !== 'boolean') return true;
  return activation.isActive;
}

export interface GoogleTokenProviderOptions {
  /**
   * The user's OWN OAuth client id (settings.syncClientId). A function, not a
   * value, because it is user-editable at any time and must never be captured
   * at module load. Never defaulted to a client id of ours — there isn't one.
   */
  clientId: () => string | Promise<string>;
  /** Test seam. */
  loadScript?: () => Promise<GisOAuth2>;
  /** Test seam. */
  now?: () => number;
}

export function createGoogleTokenProvider(opts: GoogleTokenProviderOptions): TokenProvider {
  const load = opts.loadScript ?? loadGsi;
  const now = opts.now ?? Date.now;

  // The access token. Closure only — see "WHAT IS KEPT WHERE" in the header.
  let token: { value: string; expiresAt: number } | null = null;
  let linked = readLinked();
  /**
   * The client id as last read from settings: '' when it was positively empty,
   * null when we have not looked yet. isConnected() has to answer without
   * awaiting anything, and the id lives in Dexie, so "not looked yet" must not
   * be reported as "not set up" — that is the very failure this replaces. It
   * cannot be a false positive for long: whatever needs a token resolves the
   * id first, and an empty one comes straight back as kind 'config' ("paste
   * your client ID"), which flips this to '' and the screen to "set up".
   */
  let clientIdSeen: string | null = null;
  let client: { id: string; handle: GisTokenClient } | null = null;
  let pending: {
    resolve: (r: GisTokenResponse) => void;
    reject: (e: unknown) => void;
  } | null = null;
  let inFlight: Promise<string> | null = null;

  const settle = (fn: (p: NonNullable<typeof pending>) => void) => {
    const p = pending;
    pending = null;
    if (p) fn(p);
  };

  async function resolveClientId(): Promise<string> {
    const id = (await opts.clientId()) ?? '';
    const trimmed = String(id).trim();
    clientIdSeen = trimmed;
    if (!trimmed) {
      throw new SyncTransportError(
        'config',
        'No Google client ID yet. Follow docs/DRIVE-SETUP.md to create your own (it is free), then paste it into Settings.',
      );
    }
    return trimmed;
  }

  async function tokenClient(): Promise<GisTokenClient> {
    const id = await resolveClientId();
    if (client && client.id === id) return client.handle;
    const oauth2 = await load();
    const handle = oauth2.initTokenClient({
      client_id: id,
      // One scope. Exactly one. See DRIVE_SCOPE.
      scope: DRIVE_SCOPE,
      callback: (response) =>
        settle((p) => (response.error ? p.reject(errorFromTokenResponse(response)) : p.resolve(response))),
      error_callback: (error) => settle((p) => p.reject(errorFromGisError(error))),
    });
    client = { id, handle };
    return handle;
  }

  /**
   * Ask GIS for a token. `prompt: ''` is the silent path (works only while the
   * user still has a Google session and has already granted the scope);
   * anything else shows UI and must therefore come from a user gesture.
   */
  async function requestToken(prompt: string, timeoutMs: number): Promise<string> {
    if (inFlight) return inFlight;
    const run = (async () => {
      const handle = await tokenClient();
      const response = await new Promise<GisTokenResponse>((resolve, reject) => {
        // A popup the user simply walks away from must not leave the app with
        // a promise that never settles.
        const timer = setTimeout(() => {
          settle((p) =>
            p.reject(
              new SyncTransportError(
                prompt === '' ? 'auth' : 'cancelled',
                prompt === ''
                  ? 'Google sign-in has expired. Reconnect to sync.'
                  : 'Google sign-in timed out.',
              ),
            ),
          );
        }, timeoutMs);
        pending = {
          resolve: (r) => {
            clearTimeout(timer);
            resolve(r);
          },
          reject: (e) => {
            clearTimeout(timer);
            reject(e);
          },
        };
        try {
          handle.requestAccessToken({ prompt });
        } catch (e) {
          settle((p) => p.reject(new SyncTransportError('auth', 'Google sign-in could not start.', { cause: e })));
        }
      });

      const value = response.access_token;
      if (!value) throw errorFromTokenResponse(response);

      // Refuse a token that did not actually come with the scope we asked for.
      // (When GIS omits `scope` we accept it — absence is not evidence of a
      // narrower grant, and failing here would break a working connection.)
      if (typeof response.scope === 'string' && response.scope.trim() !== '') {
        const granted = response.scope.split(/\s+/).filter(Boolean);
        if (!granted.includes(DRIVE_SCOPE)) {
          throw new SyncTransportError(
            'auth',
            'Google Drive access was not granted. Sync needs permission to manage the file it creates.',
          );
        }
      }

      const seconds = Number(response.expires_in);
      const lifetimeMs = Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : 3600_000;
      token = { value, expiresAt: now() + Math.max(0, lifetimeMs - TOKEN_EXPIRY_MARGIN_MS) };
      if (!linked) {
        linked = true;
        writeLinked(true);
      }
      return value;
    })();
    inFlight = run;
    try {
      return await run;
    } finally {
      inFlight = null;
    }
  }

  /**
   * Set up to sync: a client id and a standing grant. Says nothing about
   * whether a token is in hand — see the header, and TokenProvider.
   */
  const isConnected = () => linked && clientIdSeen !== '';

  return {
    isConnected,
    hasValidToken: isConnected,
    isLinked: () => linked,

    invalidate() {
      // Only the token. `linked` is the standing grant and survives, which is
      // what lets the retry that follows a 401 re-grant silently instead of
      // reporting the device as never set up.
      token = null;
    },

    async getToken(o) {
      const allowPrompt = o?.allowPrompt ?? true;
      if (token && token.expiresAt > now()) return token.value;
      token = null;
      if (!linked) {
        throw new SyncTransportError('not-connected', 'Google Drive sync is not connected yet.');
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }

      // Step 1 — the silent re-grant. No UI, and it is the ordinary path after
      // a reload: the owner still has a live Google session and granted this
      // scope long ago.
      try {
        return await requestToken('', SILENT_TOKEN_TIMEOUT_MS);
      } catch (e) {
        if (!silentFailureIsPromptable(e)) throw asTokenError(e);
        if (!allowPrompt || !popupCouldOpen()) {
          // What is missing is interaction, and there is none to offer: either
          // the caller said it has no gesture behind it, or the browser says
          // the gesture has lapsed and would block the window anyway. Report
          // the grant as needing re-making — 'cancelled' would read as "you
          // declined", and the owner declined nothing.
          throw new SyncTransportError('auth', 'Google sign-in has expired. Reconnect to sync.', {
            cause: e,
          });
        }
      }

      // Step 2 — ask, visibly. Reached only when the silent path genuinely
      // failed, so this is not an extra popup on the happy path: it is the
      // difference between "sync now" working and a screen that says the
      // device was never set up. `select_account` rather than `consent`
      // because the scope is already granted; what may have changed is which
      // Google account the browser is signed into.
      try {
        return await requestToken('select_account', INTERACTIVE_TOKEN_TIMEOUT_MS);
      } catch (e) {
        throw asTokenError(e);
      }
    },

    async connect() {
      // First time: force the consent screen so the user reads exactly what
      // they are granting. After that: the account chooser, so a person with
      // several Google accounts can pick the right one.
      await requestToken(linked ? 'select_account' : 'consent', INTERACTIVE_TOKEN_TIMEOUT_MS);
    },

    async disconnect() {
      const held = token?.value;
      token = null;
      linked = false;
      writeLinked(false);
      client = null;
      if (!held) return;
      // Best-effort revoke: the local grant is already gone either way, and a
      // failure here must never look like "disconnect didn't work".
      try {
        const oauth2 = gisOAuth2();
        if (!oauth2) return;
        await new Promise<void>((resolve) => {
          let done = false;
          const finish = () => {
            if (!done) {
              done = true;
              resolve();
            }
          };
          setTimeout(finish, 5_000);
          oauth2.revoke(held, finish);
        });
      } catch {
        /* nothing to tell the user: they are disconnected locally regardless */
      }
    },
  };
}
