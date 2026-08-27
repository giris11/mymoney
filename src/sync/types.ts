// Shared vocabulary for Google Drive sync (D42; SPEC §8.3 pulled forward).
//
// The one rule everything here exists to serve: WHEN IN DOUBT, REFUSE AND ASK.
// There is no automatic winner, no silent merge, and no outcome that changes
// data without a name the UI can put in front of the user first.

/**
 * The whole book, as one file. Identical in content to a backup (same tables,
 * same rows, same integer minor units — nothing is transformed, rounded or
 * re-interpreted on the way through) plus the fields sync needs to reason
 * about IDENTITY, ANCESTRY, ordering and provenance.
 */
export interface SyncSnapshot {
  app: 'MyMoney';
  /** Schema the rows conform to. A snapshot from a NEWER build is refused. */
  schemaVersion: number;
  /**
   * Remote version, for DISPLAY AND ORDERING ONLY.
   *
   * It used to be the safety input too — "same number ⇒ same book, bigger
   * number ⇒ descends from mine" — and it is neither. Two devices that both
   * read revision N can both WRITE revision N (nothing made the second write
   * fail), and a re-created file starts counting at 1 again, so a stale device
   * can read equality where there is none. Identity now lives in snapshotId
   * and ancestry in parentSnapshotId; this number is what the UI prints.
   */
  revision: number;
  /** Which device wrote it (stable per browser profile). */
  deviceId: string;
  /** What the user calls that device — shown verbatim in conflict dialogs. */
  deviceName: string;
  /** ISO timestamp of the write. */
  savedAt: string;
  /**
   * IMMUTABLE IDENTITY OF THIS WRITE — a fresh uid() for every single upload,
   * never reused, never recomputed. Two writes are the same snapshot if and
   * only if these match. This is the thing `revision` was being asked to be.
   *
   * OPTIONAL ON THE TYPE, REQUIRED ON THE WIRE. A file written by a build from
   * before ancestry existed has none, and refusing to read it would strand a
   * working sync file in the owner's Drive; so reading tolerates its absence
   * (treated as "identity unknown") while `writeRemote` refuses to send a
   * snapshot without one.
   */
  snapshotId?: string;
  /**
   * The snapshotId this write DESCENDS FROM: the exact remote head its author
   * had in hand when it built this book. `null` means "first write of a
   * lineage" — there was no file. Undefined means the file predates ancestry.
   *
   * This is the whole safety mechanism. A write is only allowed to land when
   * the file it is replacing still has this id (see SyncTransport.writeRemote),
   * so a lineage is a chain, not a set of coincidentally-numbered files.
   */
  parentSnapshotId?: string | null;
  /**
   * The snapshots this one DESCENDS FROM, newest first, not including itself:
   * `[parentSnapshotId, grandparent, …]`, bounded to the most recent few.
   *
   * WHY A LIST AND NOT JUST THE PARENT. A head names only its parent, so a
   * device that is TWO pushes behind cannot prove it is behind rather than
   * diverged — and "cannot prove" has to mean "ask", because the alternative is
   * the silent wipe this whole mechanism exists to stop. That made a conflict
   * out of the commonest thing two devices do: the iMac syncs twice, then the
   * phone syncs. With the chain in hand the phone finds its own id inside it
   * and fast-forwards, and a conflict is once again reserved for lineages that
   * really have parted.
   *
   * It can only ever GRANT descent, never deny it: ids are random uid()s, so a
   * writer that never saw a snapshot cannot name it, and a chain that has run
   * past its bound simply stops proving things (⇒ conflict ⇒ the user is
   * asked). It is exactly as trustworthy as parentSnapshotId, which the same
   * writer also supplies.
   *
   * Optional: a file written before ancestry existed carries neither.
   */
  ancestry?: string[];
  /** table name → rows, exactly as `exportBackup()` produces them. */
  tables: Record<string, unknown[]>;
}

/**
 * The cheap head read: what is in Drive right now, without downloading rows.
 *
 * Named and exported (it used to be an inline object type) because the engine
 * now reasons about three of its fields, and a shape that three modules agree
 * on should be written down once.
 */
export interface SyncRemoteMeta {
  revision: number;
  savedAt: string;
  deviceName: string;
  /**
   * `deviceId` of whoever wrote the head — read from the same cheap head, and
   * the one field there that a LEGACY writer still fills in truthfully.
   *
   * It matters because Drive MERGES appProperties: a writer that omits
   * `snapshotId` leaves the previous one in place, so identity can describe a
   * file whose contents somebody else replaced. `deviceId` cannot lie that
   * way — a writer either writes its own or writes none. Compared as part of
   * the stamp in syncEngine (C18).
   *
   * OPTIONAL, so that a transport (or a test fake) written before this field
   * existed still satisfies the interface. `undefined` means "not reported"
   * and makes the field ABSTAIN from the comparison; it never counts as
   * agreement on its own.
   */
  deviceId?: string | null;
  /** Identity of the snapshot in Drive; null when the file predates ancestry. */
  snapshotId: string | null;
  /** What that snapshot descends from; null for a first write or a legacy file. */
  parentSnapshotId: string | null;
  /**
   * The file is IN DRIVE'S BIN. It still exists, it is one click from being
   * restored, and it must never be mistaken for "no file yet" — that mistake
   * is how a device that had synced 47 times silently started a second file at
   * revision 1 (C13). Absent/false means a normal, live file.
   */
  trashed?: boolean;
}

/**
 * THE WHOLE STAMP a writer leaves on the remote head — identity AND the fields
 * that prove who left it there.
 *
 * `snapshotId` alone cannot answer "is the file in Drive still the snapshot I
 * left?", because Google Drive MERGES appProperties on files.update: a key the
 * writer omits keeps its previous value. A device running a build from before
 * ancestry existed writes no snapshotId, so its upload leaves OUR id sitting
 * on a file whose contents are now ITS book. The fields beside the id are the
 * ones such a writer ACTIVELY WRITES — `revision`, `savedAt`, its own
 * `deviceId` — and only an actively-written field can testify that somebody
 * wrote. Any disagreement across the stamp is DIVERGENCE (C18).
 */
export interface SyncStamp {
  /** null only for a file written before ancestry existed. */
  snapshotId: string | null;
  revision: number;
  savedAt: string;
  /** null/undefined ⇒ the head did not report one; that field abstains. */
  deviceId?: string | null;
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

/**
 * Outcomes carry `snapshotId` — the id this device now descends from — so the
 * caller can persist it (see SyncOptions.lastPulledSnapshotId). OPTIONAL on
 * every variant, because syncFormat/SyncSection are built against the pinned
 * shape and must keep compiling untouched.
 */
export type SyncOutcome =
  | { kind: 'up-to-date'; snapshotId?: string | null }
  | { kind: 'pushed'; revision: number; snapshotId?: string | null }
  | { kind: 'pulled'; revision: number; counts: Record<string, number>; snapshotId?: string | null }
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
  /**
   * Write `snap` as the new head, but ONLY if the file it replaces is still
   * `snap.parentSnapshotId`. A transport MUST refuse (throw) when the head has
   * moved, and MUST verify after the upload that what landed is
   * `snap.snapshotId`. Returning normally is a promise that this exact
   * snapshot is the file in Drive; anything less and the caller records an
   * agreement that does not exist.
   *
   * `expectHead` is the SECOND half of that precondition and the reason a
   * merged appProperties key cannot slip a stranger's book past it: the whole
   * stamp the caller read, which the head must still match field for field.
   * `null` asserts there is no file at all. `undefined` means the caller
   * states no expectation, and the transport falls back to the identity check
   * alone — the behaviour before C18, kept so that a transport or a caller
   * written against the older shape still works.
   */
  writeRemote(snap: SyncSnapshot, expectHead?: SyncStamp | null): Promise<void>;
  /** Cheap head: identity/ancestry/revision without downloading the rows. */
  readRemoteMeta(): Promise<SyncRemoteMeta | null>;
}
