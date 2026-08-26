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
// a confidential client, i.e. a server, which this app does not have). So:
//
//   * the token is held in memory only. It is never written to localStorage,
//     never to IndexedDB, never to a backup file. A page reload therefore
//     starts with no token by design — a bearer token for the user's Drive is
//     not something to leave lying in storage for every script on the origin
//     to read;
//   * when a token expires we try ONE silent re-grant (`prompt: ''`). That
//     succeeds while the user still has a live Google session and has already
//     granted the scope — but it goes through a popup, so a browser that
//     blocks popups outside a user gesture will refuse it. That is not a bug
//     to work around, it is the flow's ceiling;
//   * when the silent path fails we surface a clean "reconnect" state
//     (SyncTransportError kind 'auth', isReconnectNeeded() === true) rather
//     than retrying forever or, worse, letting sync think there is no remote.

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
 * Fetch the GSI client, once, on demand. Nothing calls this until the user
 * connects, which is what keeps a freshly opened app silent (SPEC §2.3).
 */
export function loadGsi(): Promise<GisOAuth2> {
  const already = gisOAuth2();
  if (already) return Promise.resolve(already);
  if (gsiLoad) return gsiLoad;

  gsiLoad = new Promise<GisOAuth2>((resolve, reject) => {
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
    const timer = setTimeout(() => {
      // Leave gsiLoad null so a later attempt can retry from scratch.
      gsiLoad = null;
      finish(() =>
        reject(
          new SyncTransportError(
            'network',
            "Couldn't load Google sign-in. Check your connection and try again.",
          ),
        ),
      );
    }, GSI_LOAD_TIMEOUT_MS);

    const existing = document.querySelector<HTMLScriptElement>(
      `script[src="${GSI_SCRIPT_SRC}"]`,
    );
    const script = existing ?? document.createElement('script');
    script.addEventListener('load', () => {
      const api = gisOAuth2();
      finish(() =>
        api
          ? resolve(api)
          : reject(new SyncTransportError('network', 'Google sign-in loaded but is unavailable.')),
      );
    });
    script.addEventListener('error', () => {
      gsiLoad = null;
      finish(() =>
        reject(
          new SyncTransportError(
            'network',
            "Couldn't load Google sign-in. Check your connection and try again.",
          ),
        ),
      );
    });
    if (!existing) {
      script.src = GSI_SCRIPT_SRC;
      script.async = true;
      script.defer = true;
      document.head.appendChild(script);
    }
  });
  return gsiLoad;
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
  /** Synchronous — is a usable, unexpired access token held right now? */
  hasValidToken(): boolean;
  /** Has this device completed consent before (so a silent re-grant is worth a try)? */
  isLinked(): boolean;
  /** A usable access token, refreshed silently when possible. Throws SyncTransportError. */
  getToken(): Promise<string>;
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

  let token: { value: string; expiresAt: number } | null = null;
  let linked = readLinked();
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

  return {
    hasValidToken: () => token !== null && token.expiresAt > now(),
    isLinked: () => linked,

    invalidate() {
      token = null;
    },

    async getToken() {
      if (token && token.expiresAt > now()) return token.value;
      token = null;
      if (!linked) {
        throw new SyncTransportError('not-connected', 'Google Drive sync is not connected yet.');
      }
      if (isOffline()) {
        throw new SyncTransportError('offline', "You're offline, so nothing was synced.");
      }
      // Silent re-grant. Popup-blocking browsers can refuse this outside a
      // user gesture — that surfaces as 'auth', i.e. "reconnect", not a crash.
      try {
        return await requestToken('', SILENT_TOKEN_TIMEOUT_MS);
      } catch (e) {
        if (e instanceof SyncTransportError && e.kind === 'popup-blocked') throw e;
        if (e instanceof SyncTransportError && e.kind === 'auth') throw e;
        throw new SyncTransportError('auth', 'Google sign-in has expired. Reconnect to sync.', {
          cause: e,
        });
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
