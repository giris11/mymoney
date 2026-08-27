// The single import edge between the Settings UI and the sync modules.
//
// One transport instance for the life of the tab, because it caches the
// Dropbox access token in a closure — rebuilding it on every render would
// throw that away and cost a token round trip on every sync. Constructing it
// does nothing: no network, no script load, no storage write happens until
// connect() or a sync actually asks for a token, so simply opening this screen
// still leaves the app the zero-request island SPEC §2.3 asks for.
//
// The app key is read through a getter rather than captured, so editing it in
// Settings takes effect immediately (and the transport is never bound to a
// stale value). Blank is the normal case: the app ships a public Dropbox app
// key of its own, and `settings.syncClientId` is an optional override for an
// owner who wants their own Dropbox app. A browser app cannot hold the app
// SECRET, and this file never asks for one.
import { getSettings } from '../../db/db';
import { createDropboxTransport } from '../../sync/transport';
import {
  DROPBOX_SCOPE,
  DROPBOX_SCOPES,
  isOfflineError,
  isReconnectNeeded,
  SyncTransportError,
} from '../../sync/dropboxAuth';
import type { SyncTransport } from '../../sync/types';
import { SYNC_HELD, SYNC_HELD_REASON } from '../../sync/held';

export { DROPBOX_SCOPE, DROPBOX_SCOPES };

/**
 * Re-exported for the Sync screen, which has to tell TWO failures apart while
 * probing the remote (C11):
 *
 *   * the grant has lapsed or been revoked at Dropbox — the screen must stop
 *     saying "Connected to Dropbox" and ask for a fresh sign-in;
 *   * anything else (offline, a timeout, Dropbox being slow) — the screen has
 *     simply not checked, which it already says honestly.
 *
 * Without the distinction a revoked grant renders as a green tick over the word
 * "Connected", which is the screen claiming an off-site copy it cannot reach.
 */
export { isReconnectNeeded };

let instance: SyncTransport | null = null;

export function dropboxTransport(): SyncTransport {
  // The second half of the sync hold (src/sync/held.ts). The Sync screen
  // returns early and never offers a control that reaches Dropbox; this is the
  // backstop for any OTHER caller, now or later, that has not been taught
  // about the hold.
  //
  // Gated HERE rather than inside syncNow() on purpose. syncNow is the thing
  // under test — a thousand tests drive it, and a hold baked into it would
  // either gut that coverage or need a test-only escape hatch, which is one
  // more thing to get wrong. This module is the single import edge between the
  // UI and the sync engine (see the note at the top of this file), so holding
  // it here stops the app without touching what the tests exercise.
  if (SYNC_HELD) throw new Error(SYNC_HELD_REASON);
  instance ??= createDropboxTransport({
    // Empty string ⇒ the built-in public app key (see dropboxAuth's appKey()).
    appKey: async () => (await getSettings()).syncClientId ?? '',
  });
  return instance;
}

/**
 * A sentence for a failure thrown by connect()/disconnect() — the two calls
 * that do not go through syncNow() and so have no SyncOutcome to describe
 * them. Always says what happened to the data, because "Error: 403" beside a
 * button that touches a financial database is not an answer.
 */
export function connectErrorMessage(e: unknown): string {
  if (isOfflineError(e)) {
    return 'Could not reach Dropbox — you appear to be offline. Nothing was changed.';
  }
  if (isReconnectNeeded(e)) {
    return 'Dropbox did not grant access. Nothing was changed; try again, and check the app key if you set one of your own.';
  }
  if (e instanceof SyncTransportError || e instanceof Error) {
    return `${e.message} Nothing on this device was changed.`;
  }
  return `${String(e)} Nothing on this device was changed.`;
}
