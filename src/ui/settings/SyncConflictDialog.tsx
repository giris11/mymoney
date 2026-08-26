// The conflict screen (D42). The single most consequential dialog in the app.
//
// It appears when both this device and the copy in Drive changed since they
// last matched. NOTHING has been written at this point and nothing will be
// until the user picks — twice.
//
// Rules this component is built to, all of them deliberate:
//
//  * NO PRE-SELECTED WINNER. The two options are rendered identically — same
//    size, same weight, neither styled as the primary action, listed in a
//    fixed order that carries no recommendation. Newer is not better here: a
//    device with more rows may simply not have had the deletions applied yet.
//  * BOTH SIDES DESCRIBED CONCRETELY. Device name, exact save time, and the
//    per-table row counts side by side — not "local" vs "remote", which tells
//    a person nothing about which one is the week of spending they remember.
//  * NO SINGLE MIS-CLICK CAN RESOLVE IT. Choosing opens a ConfirmDialog that
//    spells out what is replaced; keeping the remote copy — the only choice
//    that overwrites data on the device in front of the user — also requires
//    typing REPLACE.
//  * COUNTS ARE NOT PROOF. Equal counts do not mean equal data, and the
//    footnote says so rather than letting the table imply otherwise.
import { useEffect, useState } from 'react';
import type { SyncSummary } from '../../sync/types';
import { Button, ConfirmDialog, Modal } from '../kit/kit';
import { IconAlert } from '../kit/icons';
import {
  countRows,
  differenceHeadline,
  formatCount,
  summariseCounts,
  whenPhrase,
} from './syncFormat';

export type ConflictChoice = 'keep-local' | 'keep-remote';

/** Column heading for this device — its own name if it has one. */
function localHeading(local: SyncSummary): string {
  const name = local.deviceName.trim();
  return name ? `This device (${name})` : 'This device';
}

function SideCard({
  heading,
  subtitle,
  summary,
}: {
  heading: string;
  subtitle: string;
  summary: SyncSummary;
}) {
  return (
    <div className="rounded-lg border border-border bg-surface2/50 p-3">
      <h3 className="text-sm font-semibold text-text">{heading}</h3>
      <p className="mt-1 text-xs text-muted">{subtitle}</p>
      <p className="mt-2 text-sm text-text">{summariseCounts(summary.counts, 3)}</p>
      <p className="mt-1 text-xs text-faint tnum">Version {summary.revision}</p>
    </div>
  );
}

export default function SyncConflictDialog({
  open,
  local,
  remote,
  busy = false,
  onResolve,
  onCancel,
}: {
  open: boolean;
  /** This device's copy. */
  local: SyncSummary;
  /** The copy currently in Drive. */
  remote: SyncSummary;
  busy?: boolean;
  onResolve: (choice: ConflictChoice) => void;
  onCancel: () => void;
}) {
  const [pending, setPending] = useState<ConflictChoice | null>(null);
  // A reopened conflict must never inherit a half-made decision.
  useEffect(() => {
    if (!open) setPending(null);
  }, [open]);

  const nowMs = Date.now();
  const rows = countRows(local.counts, remote.counts);
  const thisName = localHeading(local);
  const otherName = remote.deviceName.trim() || 'the copy in Drive';

  return (
    <>
      <Modal
        open={open}
        onClose={onCancel}
        wide
        title="Both copies have changed"
        footer={
          <Button onClick={onCancel} disabled={busy}>
            Cancel — decide later
          </Button>
        }
      >
        <div className="flex flex-col gap-4 text-sm">
          <div className="flex items-start gap-2 rounded-lg border border-warn bg-surface2 p-3">
            <IconAlert size={18} className="mt-0.5 shrink-0 text-warn" />
            <p className="text-text">
              This device and <strong>{otherName}</strong> both changed since they last matched, so
              there is no safe way to combine them automatically.{' '}
              <strong>Nothing has been changed yet</strong> — and nothing will be until you choose
              below.
            </p>
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* The local side is live data, not a saved file — the engine
                stamps it "now" by definition. Calling that "saved just now"
                beside a copy "saved yesterday" would imply this device is the
                fresher one, which is exactly the nudge this screen must not
                give. */}
            <SideCard
              heading={thisName}
              subtitle="Everything on this device as it stands right now"
              summary={local}
            />
            <SideCard
              heading={otherName}
              subtitle={`Saved ${whenPhrase(remote.savedAt, nowMs)}`}
              summary={remote}
            />
          </div>

          <p className="text-text">{differenceHeadline(rows, thisName, otherName)}</p>

          <div className="overflow-x-auto">
            <table className="w-full min-w-[26rem] border-collapse text-sm">
              <caption className="sr-only">
                Row counts on this device compared with the copy in Drive
              </caption>
              <thead>
                <tr className="border-b border-border text-left text-xs text-muted">
                  <th scope="col" className="py-1.5 pr-3 font-medium">
                    What
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {thisName}
                  </th>
                  <th scope="col" className="py-1.5 pr-3 text-right font-medium">
                    {otherName}
                  </th>
                  <th scope="col" className="py-1.5 font-medium">
                    Difference
                  </th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => (
                  <tr key={r.table} className="border-b border-border/60 last:border-0">
                    <th scope="row" className="py-1.5 pr-3 text-left font-normal text-muted">
                      {r.label}
                    </th>
                    <td className="py-1.5 pr-3 text-right text-text tnum">
                      {formatCount(r.local)}
                    </td>
                    <td className="py-1.5 pr-3 text-right text-text tnum">
                      {formatCount(r.remote)}
                    </td>
                    {/* Spelled out, never a bare +13 in a colour: the meaning
                        has to survive both greyscale and a screen reader. */}
                    <td className="py-1.5 text-xs text-muted">{r.difference}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <p className="text-xs text-muted">
            Row counts are all that can be compared without downloading both copies in full. Two
            copies with the same counts can still hold different rows — check the save times above
            and think about which device you last used.
          </p>

          <div className="rounded-lg border border-border bg-surface2/50 p-3 text-sm text-text">
            Whichever copy you do not keep is saved to a file on this device first — it downloads
            as <code className="text-xs">mymoney-conflict-….json</code>, and it is a normal backup
            file you can restore from. If that file cannot be written, nothing is replaced at all.
          </div>

          <div className="grid gap-3 sm:grid-cols-2">
            {/* Identical styling on both: the app has no opinion about which
                copy is right, and must not appear to. */}
            <div className="flex flex-col rounded-lg border border-border p-3">
              <h3 className="text-sm font-semibold text-text">Keep this device’s copy</h3>
              <p className="mt-1 flex-1 text-xs text-muted">
                Uploads this device’s copy and replaces the one in Drive. Nothing on this device
                changes. {otherName} keeps its own data until it next syncs, and will then take
                this copy.
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => setPending('keep-local')}
              >
                Keep this device’s copy
              </Button>
            </div>

            <div className="flex flex-col rounded-lg border border-border p-3">
              <h3 className="text-sm font-semibold text-text">Keep {otherName}’s copy</h3>
              <p className="mt-1 flex-1 text-xs text-muted">
                Replaces everything on this device with the copy from Drive. Anything entered here
                since it last matched — including the differences listed above — will no longer be
                in the app.
              </p>
              <Button
                className="mt-3"
                disabled={busy}
                onClick={() => setPending('keep-remote')}
              >
                Keep {otherName}’s copy
              </Button>
            </div>
          </div>
        </div>
      </Modal>

      <ConfirmDialog
        open={pending === 'keep-local'}
        danger
        title="Replace the copy in Drive"
        confirmLabel="Replace the copy in Drive"
        message={
          <>
            <p>
              The copy in Drive — saved by <strong>{otherName}</strong>{' '}
              {whenPhrase(remote.savedAt, nowMs)}, {summariseCounts(remote.counts, 2)} — is
              replaced by this device’s copy.
            </p>
            <p className="mt-2">
              Nothing on this device changes. A backup of the Drive copy is saved here first.
            </p>
          </>
        }
        onConfirm={() => {
          setPending(null);
          onResolve('keep-local');
        }}
        onCancel={() => setPending(null)}
      />

      <ConfirmDialog
        open={pending === 'keep-remote'}
        danger
        // The only choice that overwrites the database in front of the user,
        // so it is the only one that asks for the word to be typed (D21).
        requireText="REPLACE"
        title="Replace this device’s data"
        confirmLabel="Replace this device’s data"
        message={
          <>
            <p>
              Everything on this device — {summariseCounts(local.counts, 3)} — is replaced by the
              copy from Drive, saved by <strong>{otherName}</strong>{' '}
              {whenPhrase(remote.savedAt, nowMs)}.
            </p>
            <p className="mt-2">
              {differenceHeadline(rows, 'This device', otherName)} Those differences will not be in
              the app afterwards; they will exist only in the backup file saved here first.
            </p>
          </>
        }
        onConfirm={() => {
          setPending(null);
          onResolve('keep-remote');
        }}
        onCancel={() => setPending(null)}
      />
    </>
  );
}
