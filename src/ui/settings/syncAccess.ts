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

export { DRIVE_SCOPE };

let instance: SyncTransport | null = null;

export function driveTransport(): SyncTransport {
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
