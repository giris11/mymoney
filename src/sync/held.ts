// Sync is HELD — deliberately refused, in code, until it is sound.
//
// WHERE THIS STANDS TODAY, since the history below is now the history of a
// service this build cannot reach. The hold was written against Google Drive.
// Sync has since been rebuilt on Dropbox (D44/D45), which is the structural
// answer to the pattern this file was written about: the compare-and-swap
// token (Dropbox's `rev`, held only by the transport) and the causal-descent
// claim (`snapshotId`/`parentSnapshotId`/`ancestry`, carried inside the file
// body, which every write replaces whole) are now two separate things that
// cannot be mistaken for each other. C18 and C19 are not fixed so much as made
// unrepresentable, and the engine's stamp apparatus was deleted rather than
// guarded.
//
// THE HOLD STAYS ANYWAY, and for the same reason it was raised: every previous
// round was well tested and every previous round was wrong in a way its own
// tests could not see. A rebuild is exactly the moment that is most likely to
// be true again. It lifts when a review pass over the new design comes back
// empty — not when the suite is green, which it already is.
//
// Nothing has ever been sent to Dropbox. No build of this app has written
// there, and this gate is why that stays true by construction rather than by
// the owner reading a message in a terminal before he presses a button.
//
// ---------------------------------------------------------------------------
// The original entry, kept because the reasoning is what justifies the hold:
// ---------------------------------------------------------------------------
//
// Why this file exists rather than a revert: the sync subsystem has had three
// rounds of review. The first confirmed 17 defects; fixing those exposed C18
// (Drive MERGES appProperties, so a device on an older build leaves OUR
// snapshotId on a file whose contents are now its own book); fixing C18
// exposed C19 (parentSnapshotId merges identically, and the fast-forward
// branch trusted it alone); and fixing C19 introduced D1 — a conflict whose
// RESOLUTION silently destroys a third device's rows — while leaving C18
// reachable through a second door (D2). Every round has been well tested and
// every round has been wrong in a way its own tests could not see.
//
// The pattern, not any single defect, is the reason for this hold. Two fields
// are each doing two incompatible jobs (parentSnapshotId is both the
// transport's compare-and-swap token and a causal-descent claim other devices
// trust; a recorded stamp is both "what I last saw" and "what I have proved"),
// and a design that overloads its safety primitives will keep producing this.
// That is a design decision for the owner of this app to weigh, not something
// to patch again at four in the morning while he is asleep.
//
// What is NOT the reason: nothing here is at risk today. No device has ever
// connected, so no sync has ever run and no data has ever been at stake. This
// hold exists so that stays true by construction rather than by his reading a
// message in a terminal before he presses a button.
//
// The gate is deliberately in TWO places — the screen never offers the
// controls, and the transport refuses to be constructed even if something
// calls for it directly — so a stray code path cannot reach the cloud because
// one of them was forgotten.
//
// TO LIFT: delete this file's export and its two call sites. Do that only when
// D1-D4 are closed and a review pass comes back empty, not merely when the
// suite is green; a green suite is what every previous round already had.

export const SYNC_HELD = true;

export const SYNC_HELD_REASON =
  'Syncing is switched off in this build. A review found faults that could ' +
  'lose transactions when two devices sync; syncing has since been rebuilt ' +
  'on Dropbox to remove the cause of them, and it stays switched off until ' +
  'that rebuild has been reviewed in its turn. Nothing on this device is ' +
  'affected, and nothing has ever been sent to Dropbox. Your backups in ' +
  'Settings → Backup still work as normal.';
