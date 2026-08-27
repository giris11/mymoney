// Shared vocabulary for sync (D42/D44; SPEC §8.3 pulled forward).
//
// The one rule everything here exists to serve: WHEN IN DOUBT, REFUSE AND ASK.
// There is no automatic winner, no silent merge, and no outcome that changes
// data without a name the UI can put in front of the user first.
//
// ===========================================================================
// TWO KINDS OF "WHICH VERSION IS THIS?", AND WHY THEY MUST NEVER MERGE AGAIN
// ===========================================================================
//
// The Drive design failed four review rounds running, and the pattern behind
// every round was the same: TWO FIELDS EACH DOING TWO INCOMPATIBLE JOBS.
// `parentSnapshotId` was both the transport's compare-and-swap token and a
// causal-descent claim other devices trust; a recorded stamp was both "what I
// last saw" and "what I have proved". A design that overloads its safety
// primitives keeps producing that class of defect, which is why sync was held
// in code rather than patched again (src/sync/held.ts).
//
// The move to Dropbox exists to separate them, and this file is where the
// separation is written down:
//
//   THE TRANSPORT PRECONDITION — Dropbox's `rev`. An opaque token issued by
//   Dropbox that names one exact file content. It is the argument to a real
//   compare-and-swap (`files/upload` with `mode: update(rev)`), it cannot be
//   forged or guessed by any writer, and it means nothing outside the request
//   that carries it. IT IS NOT IN THIS FILE except as a field the transport
//   may report back for display; the engine never reasons with it, never
//   stores it as a claim, and never compares it to decide what descends from
//   what. It answers exactly one question: "is the file still the bytes I
//   think it is, right now, as I write?"
//
//   CAUSAL IDENTITY — `snapshotId`, `parentSnapshotId`, `ancestry`. These live
//   INSIDE THE SNAPSHOT BODY, which is replaced wholesale on every write, so
//   no writer can inherit another writer's identity by leaving a field out.
//   (On Drive they lived in appProperties, which MERGE per key: a device on an
//   older build wrote no snapshotId, and Drive left the previous device's id
//   sitting on a file whose contents were now its own — C18/C19. That is the
//   failure this arrangement makes structurally impossible.) They answer a
//   different question entirely: "does this book descend from that one?"
//
// A future change that makes either one stand in for the other is the defect,
// not a simplification.

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
   *
   * NOR IS IT THE TRANSPORT'S PRECONDITION. That is Dropbox's `rev`, which
   * this app neither generates nor interprets — see the header. A counter we
   * write ourselves could never be one: we would be asserting the very thing
   * the precondition is supposed to check.
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
   * This is the CAUSAL half of the safety mechanism: a write is only allowed
   * to land when the file it is replacing still has this id (see
   * SyncTransport.writeRemote), so a lineage is a chain, not a set of
   * coincidentally-numbered files.
   *
   * It is NOT the compare-and-swap token, and the distinction is the whole
   * reason this design was rebuilt. The transport translates this claim into a
   * `rev` it has observed to belong to this snapshot, and Dropbox enforces the
   * rev atomically with the bytes. If that translation were removed and this
   * id used directly as a precondition, we would be back to a value writers
   * supply about themselves — which is where C18 and C19 came from.
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
 * The head read: what is in the remote right now, without the caller having to
 * reason about rows.
 *
 * Named and exported (it used to be an inline object type) because the engine
 * now reasons about three of its fields, and a shape that three modules agree
 * on should be written down once.
 *
 * "CHEAP" NOW MEANS SOMETHING SLIGHTLY DIFFERENT, and it is worth being honest
 * about the trade. On Drive these fields were duplicated into appProperties,
 * so a sync check read a few hundred bytes — and that duplicate store was
 * exactly what could disagree with the file beside it (C18). On Dropbox the
 * identity fields are only ever in the body. The transport therefore answers
 * from a cache keyed by the remote's own `rev`, refreshing it by downloading
 * the file when — and only when — the rev has moved. A rev names one immutable
 * file content, so that cache CANNOT describe a file it did not come from.
 * The cost of never being lied to is one download per remote change, and the
 * device was going to want that file anyway.
 */
export interface SyncRemoteMeta {
  revision: number;
  savedAt: string;
  deviceName: string;
  /**
   * `deviceId` of whoever wrote the head.
   *
   * OPTIONAL, so that a transport (or a test fake) written before this field
   * existed still satisfies the interface. `undefined` means "not reported"
   * and makes the field ABSTAIN from the comparison; it never counts as
   * agreement on its own.
   */
  deviceId?: string | null;
  /** Identity of the snapshot in the remote; null when it predates ancestry. */
  snapshotId: string | null;
  /** What that snapshot descends from; null for a first write or a legacy file. */
  parentSnapshotId: string | null;
  /**
   * THE TRANSPORT'S COMPARE-AND-SWAP TOKEN for this head — Dropbox's `rev`.
   * Optional, opaque, and FOR DISPLAY AND DEBUGGING ONLY.
   *
   * It is reported so that a person reading a log or a support screen can see
   * which file version a decision was taken against. NOTHING in the engine may
   * branch on it, store it as a claim about descent, or pass it back as a
   * precondition: the moment a value can be both "the token I write with" and
   * "the evidence I reason from", we are back to the overload that produced
   * C18 and C19. Only the transport, which received it from Dropbox in the
   * same breath as the bytes, is entitled to use it.
   */
  rev?: string;
  /**
   * The file EXISTS BUT HAS BEEN DELETED — in Drive's bin, or in Dropbox's
   * deleted files. It is restorable, and it must never be mistaken for "no
   * file yet": that mistake is how a device that had synced 47 times silently
   * started a second file at revision 1 (C13). Absent/false means a normal,
   * live file.
   *
   * When this is true the identity fields above are NOT MERELY UNREAD BUT
   * UNKNOWABLE — Dropbox's metadata for a deleted file carries a path and
   * nothing else, so there are no bytes to derive them from. The engine checks
   * this field before any of them and stops.
   */
  trashed?: boolean;
}

// `SyncStamp` USED TO BE DECLARED HERE, and its retirement is worth recording
// because it is the last piece of the two-fields-two-jobs pattern that cost
// this feature four review rounds.
//
// It was the WHOLE stamp a writer left on the remote head — `snapshotId` plus
// the fields that prove who left it there (`revision`, `savedAt`, `deviceId`).
// It existed because `snapshotId` alone could not answer "is the file still
// the snapshot I left?" on Drive: appProperties MERGED on files.update, so a
// device running a build from before ancestry existed wrote no snapshotId and
// its upload left OUR id sitting on a file whose contents were now ITS book
// (C18). Only a field such a writer ACTIVELY WRITES could testify that
// somebody had written.
//
// On Dropbox the identity travels in the BODY, which every write replaces
// wholesale, so a foreign writer cannot leave our id behind: `snapshotId`
// answers the question on its own, and the `rev` in `mode: update` refuses the
// write regardless of what any read concluded. The stamp's own note said it
// "should be retired together with the engine bookkeeping that feeds it, not
// before" — D45 deleted that bookkeeping (`headStamp`, `HeadVerdict`,
// `proveHeadFromBody`, and the `syncLastPulled*` settings), so this is that
// retirement. Nothing passed `expectHead` any more, which left a SECOND
// identity check sitting in the write path behind an argument no caller
// supplied. Two checks answering one question is the shape of the whole
// defect class, so it is gone rather than left inert.

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
 * The remote half of sync — implemented for Dropbox in ./transport.ts and by a
 * fake in tests. The engine only ever knows this much, which is what let the
 * provider change underneath it without a line of syncEngine.ts moving.
 *
 * Declared HERE rather than in transport.ts so the engine has no import edge
 * into the provider-specific module; transport.ts re-exports the type so the
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
   * moved. Returning normally is a promise that this exact snapshot is the
   * file in the remote; anything less and the caller records an agreement that
   * does not exist.
   *
   * HOW THAT PROMISE IS KEPT is the transport's business, and it changed with
   * the provider. Drive had no conditional write, so the transport read the
   * head as late as it could, uploaded, and then read the file BACK to see
   * whether it had been overwritten in between — detection after the fact,
   * with a window that could not be closed. Dropbox takes the precondition,
   * the bytes and an integrity hash in ONE request and rejects the write
   * outright if the file has moved, so there is nothing to read back: the
   * upload's own response says what landed. A caller cannot tell the two
   * apart, which is the point of this interface.
   *
   * THE SNAPSHOT SAYS EVERYTHING THE TRANSPORT NEEDS, and it is the only thing
   * that does. `snap.parentSnapshotId` names the body this one replaces, or is
   * `null` to assert there is no file at all — the only state in which a
   * create is safe, and one Dropbox checks itself via `add` with
   * `autorename:false` rather than one this app checks beforehand. There is
   * deliberately no second argument carrying an expectation alongside it: see
   * the note where `SyncStamp` used to be declared, above.
   */
  writeRemote(snap: SyncSnapshot): Promise<void>;
  /**
   * The head: identity, ancestry and revision, without the caller handling
   * rows. Returns null ONLY when the file has never existed — a deleted file
   * comes back with `trashed: true`, because it is restorable and calling it
   * absent is how a device starts a second lineage (C13).
   */
  readRemoteMeta(): Promise<SyncRemoteMeta | null>;
}
