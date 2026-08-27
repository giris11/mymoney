// The single import edge between the Settings UI and the sync modules.
//
// One transport instance for the life of the tab, because it caches the Google
// access token in a closure — rebuilding it on every render would throw that
// away and pop the consent flow again. Constructing it does nothing: no
// network, no script load, no storage write happens until connect() or a sync
// actually asks for a token, so simply opening this screen still leaves the
// app the zero-request island SPEC §2.3 asks for.
//
// The client id is read through a getter rather than captured, so editing it
// in Settings takes effect immediately (and the transport is never bound to a
// stale value).
import { getSettings } from '../../db/db';
import { createDriveTransport } from '../../sync/transport';
import { DRIVE_SCOPE, isOfflineError, isReconnectNeeded, SyncTransportError } from '../../sync/googleAuth';
import type { SyncTransport } from '../../sync/types';
import { SYNC_HELD, SYNC_HELD_REASON } from '../../sync/held';

export { DRIVE_SCOPE };

/**
 * Re-exported for the Sync screen, which has to tell TWO failures apart while
 * probing the remote (C11):
 *
 *   * the grant has lapsed or been revoked at Google — the screen must stop
 *     saying "Connected to Google Drive" and ask for a fresh sign-in;
 *   * anything else (offline, a timeout, Drive being slow) — the screen has
 *     simply not checked, which it already says honestly.
 *
 * Without the distinction a revoked grant renders as a green tick over the word
 * "Connected", which is the screen claiming an off-site copy it cannot reach.
 */
export { isReconnectNeeded };

let instance: SyncTransport | null = null;

export function driveTransport(): SyncTransport {
  // The second half of the sync hold (src/sync/held.ts). The Sync screen
  // returns early and never offers a control that reaches Drive; this is the
  // backstop for any OTHER caller, now or later, that has not been taught
  // about the hold.
  //
  // Gated HERE rather than inside syncNow() on purpose. syncNow is the thing
  // under test — 1,014 tests drive it, and a hold baked into it would either
  // gut that coverage or need a test-only escape hatch, which is one more
  // thing to get wrong. This module is the single import edge between the UI
  // and the sync engine (see the note at the top of this file), so holding it
  // here stops the app without touching what the tests exercise.
  if (SYNC_HELD) throw new Error(SYNC_HELD_REASON);
  instance ??= createDriveTransport({
    clientId: async () => (await getSettings()).syncClientId ?? '',
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
    return 'Could not reach Google — you appear to be offline. Nothing was changed.';
  }
  if (isReconnectNeeded(e)) {
    return 'Google did not grant access. Nothing was changed; check the client ID and try again.';
  }
  if (e instanceof SyncTransportError || e instanceof Error) {
    return `${e.message} Nothing on this device was changed.`;
  }
  return `${String(e)} Nothing on this device was changed.`;
}
