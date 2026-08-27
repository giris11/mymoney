// Sync (SPEC §8.3 "optional Google Drive backup sync", pulled forward as D42).
//
// This is the first screen in the app that can destroy real data, so it is
// written to one rule: WHEN IN DOUBT, REFUSE AND ASK. Concretely —
//
//  * Nothing here touches the network until the user has read what this does
//    and pressed Connect. With no client id there is no transport at all.
//  * Every outcome is reported by direction ("sent", "fetched", "nothing
//    happened and here is why"), never as a green tick that means "finished".
//  * A conflict is never resolved by this screen. syncNow() reports one, the
//    user decides in SyncConflictDialog, and only then is syncNow() called
//    again carrying that decision.
//  * Disconnecting stops syncing and never deletes anything in Drive; the
//    screen says so, and says how to delete the file if that is what is meant.
//  * NOTHING ON THIS SCREEN SYNCS BY ITSELF. There is no timer, no
//    visibilitychange handler, no background sync — syncNow() is called from
//    the "Sync now" button and from the conflict dialog's answer, and nowhere
//    else. The "Sync automatically" control says so rather than implying a
//    protection that does not exist (C15).
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, updateSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { getSyncState, syncNow, type SyncOptions } from '../../sync/syncEngine';
import type { SyncOutcome, SyncRemoteMeta, SyncState, SyncSummary } from '../../sync/types';
import { Button, Card, Checkbox, ConfirmDialog, Field, Input } from '../kit/kit';
import { IconAlert, IconCheck, IconShield } from '../kit/icons';
import { useToast } from '../kit/toast';
import { cn } from '../../lib/util';
import { SettingsPage } from './shared';
import {
  connectErrorMessage,
  driveTransport,
  DRIVE_SCOPE,
  isReconnectNeeded,
} from './syncAccess';
import DriveSetupSteps from './DriveSetupSteps';
import SyncConflictDialog, { type ConflictChoice } from './SyncConflictDialog';
import {
  clientIdError,
  describeOutcome,
  deviceNameError,
  deviceNameSuggestion,
  formatCount,
  lastSyncedWords,
  revisionWords,
  safeDeviceName,
  setupStage,
  signInAgainWords,
  toastKind,
  whenPhrase,
  type OutcomeReport,
  type SyncFacts,
} from './syncFormat';

type Busy = null | 'connecting' | 'syncing' | 'disconnecting';

/**
 * What Drive currently holds — the whole head, not a cut-down copy of it.
 *
 * `undefined` = not looked since this screen opened, `null` = looked, there is
 * no file yet. The distinction matters: the screen must not claim the two sides
 * match when it has not checked. It carries `snapshotId`/`parentSnapshotId`
 * because IDENTITY, not the revision number, is what decides whether the two
 * copies really are the same one (C17), and `trashed` because a file in Drive's
 * bin is not a working off-site copy.
 */
type RemoteProbe = undefined | null | SyncRemoteMeta;

const TONE_BORDER: Record<OutcomeReport['tone'], string> = {
  success: 'border-pos',
  info: 'border-border',
  warn: 'border-warn',
  error: 'border-danger',
};

export default function SyncSection() {
  const { toast } = useToast();
  const settings = useLive(() => getSettings(), []);
  const transport = useMemo(() => driveTransport(), []);

  const [state, setState] = useState<SyncState | null>(null);
  const [probe, setProbe] = useState<RemoteProbe>(undefined);
  const [busy, setBusy] = useState<Busy>(null);
  const [report, setReport] = useState<OutcomeReport | null>(null);
  // The conflict SURVIVES cancelling: "decide later" must not mean "lose the
  // question". The data stays, only the dialog closes, and the report keeps a
  // way back into it.
  const [conflict, setConflict] = useState<{ local: SyncSummary; remote: SyncSummary } | null>(null);
  const [conflictOpen, setConflictOpen] = useState(false);
  const [clientIdText, setClientIdText] = useState('');
  const [clientIdErr, setClientIdErr] = useState<string | null>(null);
  const [nameText, setNameText] = useState('');
  const [nameErr, setNameErr] = useState<string | null>(null);
  const [disconnectOpen, setDisconnectOpen] = useState(false);
  const [reseedOpen, setReseedOpen] = useState(false);
  const [showClientIdField, setShowClientIdField] = useState(false);
  // Google says the standing grant is gone. transport.isConnected() cannot see
  // this — it answers synchronously from a stored flag and a client id, which
  // is right (it must not claim "not set up" merely because no token is in
  // hand) but means only an actual request can discover a revoked grant.
  const [signInLapsed, setSignInLapsed] = useState(false);
  const seeded = useRef(false);

  const connected = (state?.connected ?? false) && !signInLapsed;

  const refreshState = useCallback(async () => {
    setState(await getSyncState(transport));
  }, [transport]);

  /**
   * Read the file's metadata (a few hundred bytes — never the rows). Only ever
   * when already connected, so opening this screen on an unconfigured device
   * makes no request at all.
   *
   * TWO KINDS OF FAILURE, and they must not be merged. Offline, a timeout, a
   * slow Drive: the screen has simply not checked, which it already says
   * honestly. But a refused grant means this device cannot reach Drive at all
   * — and swallowing that would leave a green "Connected to Google Drive" tick
   * over a connection that does not exist, which is the screen claiming an
   * off-site copy it has no way to write.
   */
  const probeRemote = useCallback(async () => {
    if (!transport.isConnected()) return;
    try {
      setProbe(await transport.readRemoteMeta());
      setSignInLapsed(false);
    } catch (e) {
      setProbe(undefined);
      if (isReconnectNeeded(e)) setSignInLapsed(true);
    }
  }, [transport]);

  useEffect(() => {
    void refreshState().then(probeRemote);
  }, [refreshState, probeRemote]);

  // Seed the editable fields once, from whatever is already stored.
  useEffect(() => {
    if (!settings || seeded.current) return;
    seeded.current = true;
    setClientIdText(settings.syncClientId ?? '');
    setNameText(settings.syncDeviceName || deviceNameSuggestion(navigator.userAgent));
  }, [settings]);

  const show = useCallback(
    (r: OutcomeReport) => {
      setReport(r);
      toast(r.headline, toastKind(r.tone));
    },
    [toast],
  );

  const handleOutcome = useCallback(
    async (outcome: SyncOutcome) => {
      const described = describeOutcome(outcome);
      if (outcome.kind === 'conflict') {
        // Straight to the dialog: the engine wrote nothing and neither do we.
        setConflict({ local: outcome.local, remote: outcome.remote });
        setConflictOpen(true);
        setReport(described);
      } else {
        setConflict(null);
        setConflictOpen(false);
        show(described);
      }
      // The engine reached the transport and was told there is no grant. This
      // is the same fact probeRemote catches, arriving by the other door.
      if (outcome.kind === 'not-connected') setSignInLapsed(true);
      await refreshState();
      // Re-read the head after anything that actually REACHED Drive — a
      // failure most of all. The old code refreshed only after a push or a
      // pull, so after "the sync file is no longer in your Drive" the card
      // above went on describing a file that is not there, contradicting the
      // report three lines below it. Offline and not-connected are skipped
      // because there is nothing to read and the attempt would only downgrade
      // what the screen already knows to "not checked".
      if (outcome.kind !== 'offline' && outcome.kind !== 'not-connected') await probeRemote();
    },
    [probeRemote, refreshState, show],
  );

  // ------------------------------------------------------------ actions

  const connect = async () => {
    const err = clientIdError(clientIdText);
    setClientIdErr(err);
    if (err) return;
    setBusy('connecting');
    try {
      // Stored BEFORE connecting: the transport reads the client id back out
      // of settings when it asks Google for a token.
      const name = nameText.trim() || deviceNameSuggestion(navigator.userAgent);
      await updateSettings({ syncClientId: clientIdText.trim(), syncDeviceName: name });
      await transport.connect();
      toast('Connected to Google Drive', 'success');
      setReport(null);
      setSignInLapsed(false);
      setShowClientIdField(false);
      await refreshState();
      await probeRemote();
    } catch (e) {
      toast(connectErrorMessage(e), 'error');
      await refreshState();
    } finally {
      setBusy(null);
    }
  };

  // `resolve` is SyncOptions' own union, not ConflictChoice: 'reseed-remote'
  // answers a different question from the two-sided conflict (see the Start a
  // new sync file button below), and widening ConflictChoice to carry it would
  // let the conflict dialog offer an answer to a question it never asked.
  const runSync = async (resolve?: SyncOptions['resolve']) => {
    setBusy('syncing');
    try {
      await handleOutcome(await syncNow(transport, resolve ? { resolve } : {}));
    } catch (e) {
      // syncNow is written to return outcomes rather than throw; if one ever
      // escapes, say so plainly rather than leaving a spinner running.
      show({
        tone: 'error',
        headline: 'Sync failed',
        detail: `${connectErrorMessage(e)}`,
      });
      await refreshState();
    } finally {
      setBusy(null);
    }
  };

  const disconnect = async () => {
    setDisconnectOpen(false);
    setBusy('disconnecting');
    try {
      await transport.disconnect();
      // Clears the stale master switch. It schedules nothing today (see the
      // "Sync automatically" control), but leaving a flag set that says
      // "automatic syncing is on" for a device with no grant is a lie waiting
      // for whoever finally implements the scheduler.
      await updateSettings({ syncEnabled: false });
      setProbe(undefined);
      setReport(null);
      setConflict(null);
      setConflictOpen(false);
      // The device really is signed out now, and that is not a lapse — the
      // reconnect card would be shouting about a thing the user just chose.
      setSignInLapsed(false);
      toast('Disconnected. The file in your Drive was not deleted.', 'info');
    } catch (e) {
      toast(connectErrorMessage(e), 'error');
    } finally {
      await refreshState();
      setBusy(null);
    }
  };

  const saveDeviceName = async () => {
    const err = deviceNameError(nameText);
    setNameErr(err);
    if (err) return;
    await updateSettings({ syncDeviceName: nameText.trim() });
    toast('Device name saved', 'success');
  };

  // -------------------------------------------------------------- render

  const everSynced = (state?.lastPulledRevision ?? 0) > 0 || state?.lastSyncedAt != null;

  const facts: SyncFacts = {
    connected,
    hasLocalChanges: state?.hasLocalChanges ?? false,
    lastPulledRevision: state?.lastPulledRevision ?? 0,
    remoteRevision: probe === undefined ? undefined : probe === null ? null : probe.revision,
    // Identity, which is what "the same copy" actually means. `undefined` while
    // settings are still loading, and undefined is the cautious answer: it
    // sends every sentence to the revision fallback, none of which claims the
    // two sides are the same copy.
    lastPulledSnapshotId: settings?.syncLastPulledSnapshotId,
    localAncestry: settings?.syncAncestry,
    remoteSnapshotId: probe?.snapshotId ?? null,
    remoteParentSnapshotId: probe?.parentSnapshotId ?? null,
    remoteTrashed: probe?.trashed === true,
    everSynced,
  };

  const stage = setupStage({
    connected,
    hasClientId: (settings?.syncClientId ?? '') !== '',
    everSynced,
  });

  // One field, two cards. Written once so the setup card and the sign-in-again
  // card cannot drift into giving different advice about the same input — and
  // in particular so the "never paste a client secret" hint is on both.
  const clientIdField = (
    <Field
      label="Google OAuth client ID"
      error={clientIdErr}
      hint="Ends in .apps.googleusercontent.com. This is not a secret — never paste a client secret anywhere."
    >
      {(id) => (
        <Input
          id={id}
          value={clientIdText}
          spellCheck={false}
          autoComplete="off"
          autoCapitalize="none"
          placeholder="000000000000-xxxxxxxx.apps.googleusercontent.com"
          onChange={(e) => {
            setClientIdText(e.target.value);
            if (clientIdErr) setClientIdErr(null);
          }}
        />
      )}
    </Field>
  );

  return (
    <SettingsPage
      title="Sync"
      description="Keep this device in step with your others through a single file in your own Google Drive. Optional, off until you set it up, and never required for the app to work."
    >
      {/* ------------------------------------------------ what this does */}
      <Card>
        <h2 className="text-sm font-semibold text-text">What this does, before you turn it on</h2>
        <ul className="mt-2 flex flex-col gap-2 text-sm text-muted">
          <li>
            <strong className="text-text">A copy of your whole database is uploaded</strong> — every
            account, transaction, budget, payee, tag, rate and setting — as one file.
          </li>
          <li>
            <strong className="text-text">It goes to your own Google Drive</strong>, into a single
            file this app creates there. This app has no server: nothing is sent to us, and nobody
            else can see it. What you can see in your Drive is all there is.
          </li>
          <li>
            <strong className="text-text">The app asks for the narrowest access Google offers</strong>{' '}
            — <code className="break-all text-xs">{DRIVE_SCOPE}</code>, which means files this app itself
            created, and nothing else in your Drive.
          </li>
          <li>
            <strong className="text-text">Nothing leaves this device until you say so.</strong> With
            no client ID set up, the app makes no request to Google at all.
          </li>
          <li>
            <strong className="text-text">You can stop at any time.</strong> Disconnecting ends the
            syncing; the file stays in your Drive until you delete it yourself, which you can do
            from Drive like any other file.
          </li>
        </ul>
      </Card>

      {/* ------------------------------------------------------- setup */}
      {stage === 'not-set-up' && (
        <Card>
          <h2 className="text-sm font-semibold text-text">Set up this device</h2>
          <p className="mt-1 text-sm text-muted">
            This app ships no Google credentials of its own — a web app cannot keep a secret safe,
            so there is nothing of ours in the middle. You create a client ID in your own Google
            account and paste it here, once per device.
          </p>
          <div className="mt-3 flex flex-col gap-3">
            {clientIdField}
            <DriveSetupSteps />
            <div>
              <Button
                variant="primary"
                disabled={busy !== null}
                aria-busy={busy === 'connecting'}
                onClick={() => void connect()}
              >
                {busy === 'connecting' ? 'Waiting for Google…' : 'Connect to Google Drive'}
              </Button>
            </div>
            <p className="text-xs text-muted">
              Connecting opens Google’s own sign-in window. Nothing is uploaded by connecting —
              the first upload happens when you press Sync now.
            </p>
          </div>
        </Card>
      )}

      {/* --------------------------------------------- signed out, set up */}
      {/* This card exists because "set up" and "signed in" are different facts
          (C11). The access token is deliberately never stored, so an ordinary
          page reload leaves a fully configured device holding no token; showing
          it "Set up this device" told the owner his iMac — client ID stored,
          5,127 transactions already in Drive — was a blank slate, and hid the
          one button that would have fixed it. */}
      {stage === 'needs-sign-in' && (
        <Card className="border-warn">
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <IconAlert size={16} className="text-warn" />
            Sign in to Google again
          </h2>
          <p className="mt-2 text-sm text-text">
            {signInAgainWords({ everSynced, hasLocalChanges: state?.hasLocalChanges ?? false })}
          </p>
          <p className="mt-1 text-sm text-muted">
            {lastSyncedWords(state?.lastSyncedAt ?? null)}
          </p>
          <div className="mt-3 flex flex-wrap items-center gap-2">
            <Button
              variant="primary"
              disabled={busy !== null}
              aria-busy={busy === 'connecting'}
              onClick={() => void connect()}
            >
              {busy === 'connecting' ? 'Waiting for Google…' : 'Sign in to Google Drive'}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              disabled={busy !== null}
              onClick={() => setShowClientIdField((v) => !v)}
            >
              {showClientIdField ? 'Keep the stored client ID' : 'Use a different client ID'}
            </Button>
          </div>
          {showClientIdField && <div className="mt-3">{clientIdField}</div>}
          <p className="mt-2 text-xs text-muted">
            Signing in opens Google’s own window. Nothing is uploaded or fetched by signing in —
            that happens when you press Sync now.
          </p>
        </Card>
      )}

      {/* -------------------------------------------------- connection */}
      {stage === 'ready' && (
        <Card>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <IconCheck size={16} className="text-pos" />
            Connected to Google Drive
          </h2>
          <p className="mt-2 text-sm text-text">{revisionWords(facts)}</p>
          <p className="mt-1 text-sm text-muted">
            {lastSyncedWords(state?.lastSyncedAt ?? null)}
          </p>
          {probe && (
            <p className="mt-1 text-sm text-muted">
              {/* The name is whatever was typed on the OTHER device, and it
                  arrives inside a file that can be edited in Drive by hand.
                  React escapes it; safeDeviceName stops it impersonating this
                  sentence with newlines, bidi overrides or sheer length. */}
              The file in Drive was last written by{' '}
              <strong className="text-text">{safeDeviceName(probe.deviceName, 'an unnamed device')}</strong>{' '}
              {whenPhrase(probe.savedAt)}.
            </p>
          )}
          {settings?.syncClientId && (
            <p className="mt-2 break-all text-xs text-faint">
              Using client ID <code>{settings.syncClientId}</code>. To change it, disconnect first.
            </p>
          )}
          {/* Two different numbering spaces, so both are named. "Version 214 on
              this device" is a count of local change batches; the Drive one is
              the file's revision. Neither is evidence the copies are the same —
              the sentence at the top of this card is (C17). */}
          <p className="mt-2 text-xs text-faint tnum">
            {formatCount(state?.localRevision ?? 0)} change
            {(state?.localRevision ?? 0) === 1 ? '' : 's'} recorded on this device
            {probe ? `; the file in Drive is at version ${formatCount(probe.revision)}` : ''}
            {probe?.trashed ? ' and is in the bin' : ''}
            {probe === null ? '; no file in Drive yet' : ''}.
          </p>
        </Card>
      )}

      {/* ------------------------------------------------- this device */}
      <Card>
        <h2 className="text-sm font-semibold text-text">This device</h2>
        <p className="mt-1 text-sm text-muted">
          This name appears on your other devices when the two copies disagree, so make it one you
          will recognise — “Girish’s iMac” beats a random ID at the moment it matters.
        </p>
        <div className="mt-3 flex flex-wrap items-end gap-2">
          <Field label="Device name" error={nameErr} className="min-w-[14rem] flex-1">
            {(id) => (
              <Input
                id={id}
                value={nameText}
                autoComplete="off"
                onChange={(e) => {
                  setNameText(e.target.value);
                  if (nameErr) setNameErr(null);
                }}
              />
            )}
          </Field>
          <Button
            onClick={() => void saveDeviceName()}
            disabled={!settings || nameText.trim() === settings.syncDeviceName}
          >
            Save name
          </Button>
        </div>
      </Card>

      {/* ---------------------------------------------------- controls */}
      <Card>
        <h2 className="text-sm font-semibold text-text">Syncing</h2>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="primary"
            disabled={!connected || busy !== null}
            aria-busy={busy === 'syncing'}
            onClick={() => void runSync()}
          >
            {busy === 'syncing' ? 'Syncing…' : 'Sync now'}
          </Button>
          {!connected && (
            <span className="text-sm text-muted">
              {stage === 'needs-sign-in'
                ? 'Sign in to Google above before syncing.'
                : 'Set this device up above before syncing.'}
            </span>
          )}
        </div>
        {/* C15 — THIS SWITCH DID NOTHING. It wrote settings.syncEnabled, which
            no scheduler reads: there is no timer, no visibilitychange or online
            handler, no periodic background sync anywhere in the app, and
            syncNow() is called only from the button above and the conflict
            dialog's answer. Meanwhile the caption said "the app syncs by itself
            in the background", so a month of entries could sit on one device
            while the owner believed they were being copied off it.

            It is disabled rather than implemented. Turning on background sync
            is a real behaviour change — it would run against the owner's live
            book, unattended, and it multiplies every remaining risk in a
            subsystem that has just been through a review — so it is his to
            switch on deliberately, not something to slip in behind a caption.
            `checked` is hard-coded false: a device that ticked this before
            still has syncEnabled = true stored (db.ts reads it for revision
            tracking, so it is not cleared here), and rendering that as a ticked
            "Sync automatically" box would be the same lie by another route. */}
        <div className="mt-3">
          <Checkbox label="Sync automatically" checked={false} disabled onChange={() => {}} />
          <p className="mt-1 text-xs text-muted">
            <strong className="text-text">Not yet — use “Sync now”.</strong> This app never syncs on
            its own: nothing is sent to Drive or taken from it except when you press the button
            above. Until that changes, treat the last sync time as exactly what it says.
          </p>
        </div>

        {report && (
          <div
            role="status"
            aria-live="polite"
            className={cn('mt-3 rounded-lg border bg-surface2 p-3 text-sm', TONE_BORDER[report.tone])}
          >
            <p className="flex items-center gap-1.5 font-semibold text-text">
              {report.tone === 'success' ? (
                <IconCheck size={16} className="text-pos" />
              ) : (
                <IconAlert
                  size={16}
                  className={report.tone === 'error' ? 'text-danger' : 'text-warn'}
                />
              )}
              {report.headline}
            </p>
            <p className="mt-1 text-muted">{report.detail}</p>
            {/* A permanent failure must not sit under a screen whose only
                other suggestion is to press the button again. Nothing here
                will clear on its own — a full Drive, a deleted file, a file in
                the bin — and the off-site copy has stopped advancing until the
                owner acts (C14). */}
            {report.needsYou && (
              <p className="mt-2 text-xs text-warn">
                Waiting will not clear this, and until it is cleared nothing new is reaching Drive.
                In the meantime this device is the only copy — Settings → Backup &amp; storage
                exports one you can keep elsewhere.
              </p>
            )}
            {conflict && !conflictOpen && (
              <div className="mt-2">
                <Button size="sm" onClick={() => setConflictOpen(true)}>
                  Choose which copy to keep
                </Button>
              </div>
            )}
            {/* The engine refuses to re-create a deleted sync file on its own,
                because a second file called mymoney-sync.json would leave every
                device comparing two unrelated histories as one. That refusal
                left the owner with no way forward at all until this button:
                the choice is his, it is spelled out, and it is the only thing
                that answers the message above. */}
            {report.offer === 'reseed-remote' && (
              <div className="mt-2">
                <Button size="sm" disabled={busy !== null} onClick={() => setReseedOpen(true)}>
                  Start a new sync file from this device
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* -------------------------------------------------- disconnect */}
      {/* Shown for a device that is signed OUT as well as one signed in: a
          device whose grant lapsed still has a stored client ID and a stored
          "linked" flag, and hiding this card was what left the owner unable to
          stop syncing from the app once the token went (C11). */}
      {stage !== 'not-set-up' && (
        <Card>
          <h2 className="flex items-center gap-1.5 text-sm font-semibold text-text">
            <IconShield size={16} className="text-muted" />
            Disconnecting
          </h2>
          <ul className="mt-2 flex flex-col gap-1.5 text-sm text-muted">
            <li>
              <strong className="text-text">It stops this device syncing</strong> and withdraws the
              app’s access to your Drive.
            </li>
            <li>
              <strong className="text-text">It does not delete the file in your Drive</strong>, and
              it does not touch anything on this device. Your other devices carry on as they were.
            </li>
            <li>
              To remove the file as well, open Drive and delete{' '}
              <code className="text-xs">mymoney-sync.json</code> yourself — then empty Drive’s bin.
            </li>
          </ul>
          <div className="mt-3">
            <Button disabled={busy !== null} onClick={() => setDisconnectOpen(true)}>
              Disconnect from Google Drive
            </Button>
          </div>
        </Card>
      )}

      <ConfirmDialog
        open={disconnectOpen}
        title="Disconnect from Google Drive"
        confirmLabel="Disconnect"
        message={
          <>
            <p>
              This device will stop syncing — “Sync now” will no longer work until you sign in
              again. Nothing on this device is deleted or changed.
            </p>
            <p className="mt-2">
              The file <code className="text-xs">mymoney-sync.json</code> stays in your Drive. To
              remove it, delete it in Drive yourself.
            </p>
          </>
        }
        onConfirm={() => void disconnect()}
        onCancel={() => setDisconnectOpen(false)}
      />

      <ConfirmDialog
        open={reseedOpen}
        danger
        title="Start a new sync file"
        confirmLabel="Start a new sync file"
        message={
          <>
            <p>
              This uploads <strong>this device’s copy</strong> as a brand-new
              <code className="text-xs"> mymoney-sync.json</code> in your Drive. Nothing on this
              device is changed or deleted.
            </p>
            <p className="mt-2">
              Do this only if the old file is really gone. Your other devices were syncing with
              that file, not this one: the next time each of them syncs it will find a history it
              does not recognise and stop to ask you which copy to keep — so if one of them holds
              entries this device has never seen, sync it first, or export a backup from it.
            </p>
          </>
        }
        onConfirm={() => {
          setReseedOpen(false);
          void runSync('reseed-remote');
        }}
        onCancel={() => setReseedOpen(false)}
      />

      {conflict && (
        <SyncConflictDialog
          open={conflictOpen}
          local={conflict.local}
          remote={conflict.remote}
          busy={busy === 'syncing'}
          onResolve={(choice) => void runSync(choice)}
          onCancel={() => setConflictOpen(false)}
        />
      )}
    </SettingsPage>
  );
}
