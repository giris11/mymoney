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
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { getSettings, updateSettings } from '../../db/db';
import { useLive } from '../../db/useLive';
import { getSyncState, syncNow } from '../../sync/syncEngine';
import type { SyncOutcome, SyncState, SyncSummary } from '../../sync/types';
import { Button, Card, Checkbox, ConfirmDialog, Field, Input } from '../kit/kit';
import { IconAlert, IconCheck, IconShield } from '../kit/icons';
import { useToast } from '../kit/toast';
import { cn } from '../../lib/util';
import { SettingsPage } from './shared';
import { connectErrorMessage, driveTransport, DRIVE_SCOPE } from './syncAccess';
import DriveSetupSteps from './DriveSetupSteps';
import SyncConflictDialog, { type ConflictChoice } from './SyncConflictDialog';
import {
  clientIdError,
  describeOutcome,
  deviceNameError,
  deviceNameSuggestion,
  lastSyncedWords,
  revisionWords,
  toastKind,
  whenPhrase,
  type OutcomeReport,
} from './syncFormat';

type Busy = null | 'connecting' | 'syncing' | 'disconnecting';

/**
 * What Drive currently holds. `undefined` = not looked since this screen
 * opened, `null` = looked, there is no file yet. The distinction matters: the
 * screen must not claim the two sides match when it has not checked.
 */
type RemoteProbe = undefined | null | { revision: number; savedAt: string; deviceName: string };

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
  const seeded = useRef(false);

  const connected = state?.connected ?? false;

  const refreshState = useCallback(async () => {
    setState(await getSyncState(transport));
  }, [transport]);

  /**
   * Read the file's metadata (a few hundred bytes — never the rows). Only ever
   * when already connected, so opening this screen on an unconfigured device
   * makes no request at all. A failure is left as "not checked" rather than
   * being reported as an error: the user has not asked for anything yet.
   */
  const probeRemote = useCallback(async () => {
    if (!transport.isConnected()) return;
    try {
      setProbe(await transport.readRemoteMeta());
    } catch {
      setProbe(undefined);
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
      await refreshState();
      if (outcome.kind === 'pushed' || outcome.kind === 'pulled') await probeRemote();
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
      await refreshState();
      await probeRemote();
    } catch (e) {
      toast(connectErrorMessage(e), 'error');
      await refreshState();
    } finally {
      setBusy(null);
    }
  };

  const runSync = async (resolve?: ConflictChoice) => {
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
      // Automatic syncing without a grant would just fail on a timer.
      await updateSettings({ syncEnabled: false });
      setProbe(undefined);
      setReport(null);
      setConflict(null);
      setConflictOpen(false);
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

  const setAuto = async (on: boolean) => {
    await updateSettings({ syncEnabled: on });
    await refreshState();
  };

  // -------------------------------------------------------------- render

  const facts = {
    connected,
    hasLocalChanges: state?.hasLocalChanges ?? false,
    lastPulledRevision: state?.lastPulledRevision ?? 0,
    remoteRevision: probe === undefined ? undefined : probe === null ? null : probe.revision,
  };

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
      {!connected && (
        <Card>
          <h2 className="text-sm font-semibold text-text">Set up this device</h2>
          <p className="mt-1 text-sm text-muted">
            This app ships no Google credentials of its own — a web app cannot keep a secret safe,
            so there is nothing of ours in the middle. You create a client ID in your own Google
            account and paste it here, once per device.
          </p>
          <div className="mt-3 flex flex-col gap-3">
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

      {/* -------------------------------------------------- connection */}
      {connected && (
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
              The file in Drive was last written by <strong className="text-text">{probe.deviceName}</strong>{' '}
              {whenPhrase(probe.savedAt)}.
            </p>
          )}
          {settings?.syncClientId && (
            <p className="mt-2 break-all text-xs text-faint">
              Using client ID <code>{settings.syncClientId}</code>. To change it, disconnect first.
            </p>
          )}
          <p className="mt-2 text-xs text-faint tnum">
            Version {state?.localRevision ?? 0} on this device
            {probe ? `, version ${probe.revision} in Drive` : ''}
            {probe === null ? ', no file in Drive yet' : ''}.
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
            <span className="text-sm text-muted">Connect above before syncing.</span>
          )}
        </div>
        <div className="mt-3">
          <Checkbox
            label="Sync automatically"
            checked={settings?.syncEnabled ?? false}
            disabled={!connected}
            onChange={(v) => void setAuto(v)}
          />
          <p className="mt-1 text-xs text-muted">
            When on, the app syncs by itself in the background. It still stops and asks whenever
            both copies have changed — automatic never means automatic resolution. “Sync now”
            works whether this is on or off.
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
            {conflict && !conflictOpen && (
              <div className="mt-2">
                <Button size="sm" onClick={() => setConflictOpen(true)}>
                  Choose which copy to keep
                </Button>
              </div>
            )}
          </div>
        )}
      </Card>

      {/* -------------------------------------------------- disconnect */}
      {connected && (
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
              This device will stop syncing and automatic syncing will be turned off. Nothing on
              this device is deleted or changed.
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
