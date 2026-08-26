// Shared vocabulary for Google Drive sync (D42; SPEC §8.3 pulled forward).
//
// The one rule everything here exists to serve: WHEN IN DOUBT, REFUSE AND ASK.
// There is no automatic winner, no silent merge, and no outcome that changes
// data without a name the UI can put in front of the user first.

/**
 * The whole book, as one file. Identical in content to a backup (same tables,
 * same rows, same integer minor units — nothing is transformed, rounded or
 * re-interpreted on the way through) plus the four fields sync needs to reason
 * about ordering and provenance.
 */
export interface SyncSnapshot {
  app: 'MyMoney';
  /** Schema the rows conform to. A snapshot from a NEWER build is refused. */
  schemaVersion: number;
  /** Monotonic remote version. Every accepted push is exactly previous + 1. */
  revision: number;
  /** Which device wrote it (stable per browser profile). */
  deviceId: string;
  /** What the user calls that device — shown verbatim in conflict dialogs. */
  deviceName: string;
  /** ISO timestamp of the write. */
  savedAt: string;
  /** table name → rows, exactly as `exportBackup()` produces them. */
  tables: Record<string, unknown[]>;
}

/** Everything the UI needs to describe where this device stands. */
export interface SyncState {
  /** Master switch for AUTOMATIC syncing (a manual sync ignores it). */
  enabled: boolean;
  /** Is a transport signed in right now? */
  connected: boolean;
  lastSyncedAt: string | null;
  /** Remote revision this device's data descends from (0 = never synced). */
  lastPulledRevision: number;
  /** Monotonic count of local change batches. */
  localRevision: number;
  /** Last known remote revision, or null if never looked. */
  remoteRevision: number | null;
  deviceId: string;
  /**
   * ADDITION to the pinned shape (optional, so anything built against the
   * pinned fields still type-checks): does this device hold changes the remote
   * has not seen? It cannot be derived from the fields above — localRevision
   * is monotonic, and the value it is compared against is engine bookkeeping —
   * yet it is the one thing a sync UI most needs to say truthfully.
   */
  hasLocalChanges?: boolean;
}

/** One side of a conflict, in terms a person can actually judge. */
export interface SyncSummary {
  revision: number;
  deviceName: string;
  savedAt: string;
  /** table name → row count. Never a diff, never a guess. */
  counts: Record<string, number>;
}

export type SyncOutcome =
  | { kind: 'up-to-date' }
  | { kind: 'pushed'; revision: number }
  | { kind: 'pulled'; revision: number; counts: Record<string, number> }
  /** Both sides moved. NOTHING was written. Ask, then call again with resolve. */
  | { kind: 'conflict'; local: SyncSummary; remote: SyncSummary }
  | { kind: 'offline' }
  | { kind: 'not-connected' }
  | { kind: 'error'; message: string };

/**
 * The remote half of sync — implemented for Google Drive in ./transport.ts
 * (Cluster B) and by a fake in tests. The engine only ever knows this much.
 *
 * Declared HERE rather than in transport.ts so the engine has no import edge
 * into the Google-specific module; transport.ts re-exports the type so the
 * pinned `import type { SyncTransport } from './transport'` keeps working.
 */
export interface SyncTransport {
  isConnected(): boolean;
  /** Interactive OAuth. Throws on refusal/cancellation. */
  connect(): Promise<void>;
  disconnect(): Promise<void>;
  /** The remote snapshot, or null when no file exists yet. */
  readRemote(): Promise<SyncSnapshot | null>;
  writeRemote(snap: SyncSnapshot): Promise<void>;
  /** Cheap head: revision/savedAt/deviceName without downloading the rows. */
  readRemoteMeta(): Promise<{ revision: number; savedAt: string; deviceName: string } | null>;
}
