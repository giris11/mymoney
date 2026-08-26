// Currency rates (SPEC §8.1.4) — manual rates plus the optional live-rate
// layer (D34, pulled forward from SPEC §8.2).
//
// Invariants this screen must never break:
//  * Rates convert at DISPLAY/report time only; stored amounts never change.
//  * A missing rate is surfaced, never guessed (SPEC §6).
//  * A rate the user typed is their explicit statement: it is only ever
//    replaced by a live one through an explicit, confirmed action.
//  * When live rates are OFF the app makes no network requests at all; when ON
//    it contacts exactly one rate service and nothing else (SPEC §2.3).
import { useMemo, useState } from 'react';
import { db, getSettings, updateSettings } from '../../db/db';
import { COMMON_CURRENCIES } from '../../db/seed';
import { useLive } from '../../db/useLive';
import { listRates, removeRate, setManualRate } from '../../domain/fx';
import {
  FX_SOURCES,
  currenciesInUse,
  isStale,
  refreshLiveRates,
  switchPairToLive,
  type FxRefreshOutcome,
} from '../../domain/fxAuto';
import type { FxRate } from '../../db/types';
import { formatDate, nowISO } from '../../lib/util';
import { convertMinor, formatMinor, makeRateLookup, minorFactor } from '../../money/money';
import {
  Button,
  Card,
  Chip,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Segmented,
  Select,
} from '../kit/kit';
import {
  IconAlert,
  IconCheck,
  IconCoins,
  IconDownload,
  IconPencil,
  IconTrash,
  IconX,
} from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, SettingsPage } from './shared';

/** Hostnames the live-rate module may contact, read off its own source list. */
const RATE_HOSTS: string[] = (() => {
  const out: string[] = [];
  for (const s of FX_SOURCES) {
    try {
      const host = new URL(s.url('GBP')).hostname;
      if (!out.includes(host)) out.push(host);
    } catch {
      // A source whose URL we can't parse simply isn't named here.
    }
  }
  return out;
})();

/**
 * Rates span 0.0000x (VND) to 100s (KWD), so a fixed number of decimals is
 * always wrong somewhere. Six significant figures, trailing zeros trimmed.
 * The editor still shows the stored number in full.
 */
export function formatRate(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  const s = n >= 1000 ? n.toFixed(2) : n.toPrecision(6);
  if (s.includes('e') || !s.includes('.')) return s;
  return s.replace(/0+$/, '').replace(/\.$/, '');
}

/** "3 hours ago (26/08/2026)" — relative for feel, absolute for certainty. */
export function relativeTime(iso: string, nowMs: number = Date.now()): string {
  const t = Date.parse(iso);
  if (!Number.isFinite(t)) return formatDate(iso);
  const mins = Math.floor((nowMs - t) / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins} minute${mins === 1 ? '' : 's'} ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'} ago`;
  const days = Math.floor(hours / 24);
  if (days <= 7) return `${days} day${days === 1 ? '' : 's'} ago`;
  return `on ${formatDate(iso)}`;
}

const plural = (n: number, one: string, many = `${one}s`): string =>
  `${n} ${n === 1 ? one : many}`;

/** Currency codes for a one-line message, never an endless run of them. */
const list = (xs: string[], max = 4): string =>
  xs.length <= max ? xs.join(', ') : `${xs.slice(0, max).join(', ')} and ${xs.length - max} more`;

/**
 * One line for a successful fetch: what changed, what was protected, what's
 * still missing. Every currency the refresh looked at lands in exactly one of
 * those three buckets, so "No rates changed" always arrives with its reason.
 */
export function successLine(o: Extract<FxRefreshOutcome, { ok: true }>): string {
  const parts: string[] = [
    o.updatedCount === 0
      ? 'No rates changed'
      : `${plural(o.updatedCount, 'rate')} updated from ${o.sourceName}`,
  ];
  if (o.keptManual.length > 0) {
    parts.push(`${plural(o.keptManual.length, 'rate')} you typed kept (${list(o.keptManual)})`);
  }
  if (o.missing.length > 0) parts.push(`no live rate for ${list(o.missing)}`);
  return parts.join(' · ');
}

interface Notice {
  tone: 'warn' | 'info';
  text: string;
}

/** Calm, honest copy for every non-success outcome. A failed fetch is a non-event. */
export function noticeFor(
  o: Extract<FxRefreshOutcome, { ok: false }>,
  base: string,
): Notice {
  switch (o.reason) {
    case 'offline':
      return {
        tone: 'warn',
        text: 'No internet connection, so no rates were fetched. Your saved rates are still in use and nothing has changed.',
      };
    case 'unavailable':
      return {
        tone: 'warn',
        text: 'Couldn’t reach the rate service. Your saved rates are still in use and nothing has changed — try again later, or set a rate by hand below.',
      };
    case 'disabled':
      return {
        tone: 'info',
        text: 'Live rates are switched off, so nothing was fetched and no network request was made.',
      };
    case 'nothing-to-do':
      // The domain knows *why* there is nothing to do (no base currency set,
      // every account already in base) — say its reason, then what to expect.
      return {
        tone: 'info',
        text: `${o.message}${
          base ? ` Rates appear here once an account uses a currency other than ${base}.` : ''
        }`,
      };
    default:
      return { tone: 'info', text: o.message };
  }
}

export default function RatesSection() {
  const { toast } = useToast();
  const settings = useLive(() => getSettings(), []);
  const rates = useLive(() => listRates(), []);
  const accounts = useLive(() => db.accounts.toArray(), []);
  const inUse = useLive(() => currenciesInUse(), []);
  const base = settings?.baseCurrency ?? '';
  const autoOn = settings?.autoFxEnabled ?? false;

  const [ccy, setCcy] = useState('');
  const [rateText, setRateText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [toRemove, setToRemove] = useState<FxRate | null>(null);
  const [toSwitch, setToSwitch] = useState<FxRate | null>(null);
  /** null = idle; otherwise the job running ('refresh' or a currency code). */
  const [busy, setBusy] = useState<string | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);

  const options = useMemo(() => {
    const set = new Set<string>(COMMON_CURRENCIES);
    for (const a of accounts ?? []) set.add(a.currency);
    set.delete(base);
    return [...set].sort();
  }, [accounts, base]);
  const chosenCcy = ccy || options[0] || '';

  const sortedRates = useMemo(
    () => [...(rates ?? [])].sort((a, b) => a.id.localeCompare(b.id)),
    [rates],
  );

  /** Account currencies with no way to convert to base — shown, never guessed. */
  const missing = useMemo(() => {
    if (!base) return [];
    const lookup = makeRateLookup(rates ?? []);
    const inUseSet = new Set((accounts ?? []).filter((a) => !a.archived).map((a) => a.currency));
    return [...inUseSet].filter((c) => c !== base && lookup(c, base) === null).sort();
  }, [accounts, rates, base]);

  /** Would setting this pair by hand switch it off live updates? */
  const chosenIsLive = useMemo(
    () => sortedRates.some((r) => r.base === chosenCcy && r.quote === base && r.source === 'auto'),
    [sortedRates, chosenCcy, base],
  );

  /**
   * A worked example in the user's own numbers, so the direction can't be
   * misread. Falls back to an illustrative LKR line when no rates exist yet.
   */
  const example = useMemo(() => {
    if (rates === undefined) return null; // don't flash an illustration while loading
    const row = sortedRates.find((r) => r.quote === base) ?? sortedRates[0];
    // With no rates of their own, show a real LKR→GBP line rather than
    // inventing a number against their base currency.
    const from = row?.base ?? 'LKR';
    const to = row?.quote ?? 'GBP';
    const rate = row?.rate ?? 0.00223;
    if (from === to) return null;
    const fromMinor = 1000 * minorFactor(from);
    const toMinor = convertMinor(fromMinor, from, to, () => rate);
    if (toMinor === null) return null;
    return {
      hypothetical: !row,
      line: `1 ${from} = ${formatRate(rate)} ${to}`,
      from: formatMinor(fromMinor, from),
      to: formatMinor(toMinor, to),
    };
  }, [rates, sortedRates, base]);

  const parseRate = (text: string): number | null => {
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
  };

  /** Single funnel for every live-rate call: never throws, never shouts. */
  const runLive = async (job: string, fn: () => Promise<FxRefreshOutcome>) => {
    setBusy(job);
    setNotice(null);
    try {
      const outcome = await fn();
      if (outcome.ok) {
        toast(successLine(outcome), 'success');
      } else {
        setNotice(noticeFor(outcome, base));
      }
    } catch {
      // The contract says it never throws; if it ever does, it still isn't an
      // error the user has to clear — the saved rates are untouched.
      setNotice({
        tone: 'warn',
        text: 'Couldn’t fetch rates just now. Your saved rates are still in use and nothing has changed.',
      });
    } finally {
      setBusy(null);
    }
  };

  const setAutoEnabled = async (enabled: boolean) => {
    try {
      await updateSettings({ autoFxEnabled: enabled });
    } catch (e) {
      toast(errorMessage(e), 'error');
      return;
    }
    if (enabled) await runLive('refresh', () => refreshLiveRates({ force: true }));
    else setNotice(null);
  };

  const doSwitchToLive = async (r: FxRate) => {
    setToSwitch(null);
    // Rows are stored { base: <foreign>, quote: <base currency> } (D11), so the
    // pair is identified by the foreign code.
    await runLive(r.base, () => switchPairToLive(r.base));
  };

  const addRate = async () => {
    if (!base || !chosenCcy) return;
    const rate = parseRate(rateText);
    if (rate === null) {
      toast('Enter a positive rate, e.g. 0.85', 'error');
      return;
    }
    try {
      await setManualRate(chosenCcy, base, rate);
      toast(`Saved: 1 ${chosenCcy} = ${rate} ${base}`, 'success');
      setRateText('');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const saveEdit = async (r: FxRate) => {
    const rate = parseRate(editText);
    if (rate === null) {
      toast('Enter a positive rate, e.g. 0.85', 'error');
      return;
    }
    try {
      await setManualRate(r.base, r.quote, rate);
      toast(
        r.source === 'auto'
          ? `Saved: 1 ${r.base} = ${rate} ${r.quote} — now a manual rate`
          : `Saved: 1 ${r.base} = ${rate} ${r.quote}`,
        'success',
      );
      setEditingId(null);
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const doRemove = async (r: FxRate) => {
    setToRemove(null);
    try {
      await removeRate(r.id);
      toast(`Removed the ${r.base} → ${r.quote} rate`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  const noForeignCurrency = inUse !== undefined && inUse.length === 0;
  const stale = autoOn && isStale(settings?.lastFxSyncAt ?? null, nowISO());

  return (
    <SettingsPage
      title="Currency rates"
      description={`Rates are used only at display and report time, to show totals in ${
        base || 'your base currency'
      }. Stored amounts never change, and where a rate is missing the app shows the original currency — it never guesses.`}
    >
      {missing.length > 0 && (
        <p className="text-sm text-warn">
          No rate set for {missing.join(', ')} — balances in{' '}
          {missing.length === 1 ? 'this currency' : 'these currencies'} are excluded from converted
          totals until you add one.
        </p>
      )}

      {/* ------------------------------------------------------- Live rates */}
      <Card>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-sm font-semibold text-text">Live rates</h2>
            <p className="mt-0.5 text-xs text-muted">
              Daily reference rates — published about once a day, not live market prices.
            </p>
          </div>
          <Segmented
            label="Live rates"
            value={autoOn ? 'on' : 'off'}
            options={[
              { value: 'off', label: 'Off' },
              { value: 'on', label: 'On' },
            ]}
            onChange={(v) => void setAutoEnabled(v === 'on')}
          />
        </div>

        <p className="mt-3 max-w-prose text-sm text-muted">
          {autoOn ? (
            <>
              While this is on, MyMoney fetches rates from{' '}
              <span className="text-text">{RATE_HOSTS[0] ?? 'one free rate service'}</span>
              {RATE_HOSTS[1] && <> (or {RATE_HOSTS[1]} if the first is down)</>} — the only network
              request this app ever makes, and it sends none of your data.
            </>
          ) : (
            <>
              Live rates are off, so the app makes no network requests at all — every rate below is
              one you typed. Turning this on lets MyMoney fetch daily rates from{' '}
              <span className="text-text">{RATE_HOSTS[0] ?? 'one free rate service'}</span>, the
              only network request this app ever makes.
            </>
          )}
        </p>

        <div className="mt-3 flex flex-wrap items-center gap-3">
          <Button
            variant="secondary"
            disabled={!autoOn || busy !== null}
            aria-busy={busy === 'refresh'}
            onClick={() => void runLive('refresh', () => refreshLiveRates({ force: true }))}
          >
            <IconDownload size={15} />
            {busy === 'refresh' ? 'Fetching rates…' : 'Refresh now'}
          </Button>
          <p className="text-xs text-muted" role="status" aria-live="polite">
            {busy === 'refresh' ? (
              'Fetching today’s rates…'
            ) : !autoOn ? (
              'Turn live rates on to fetch.'
            ) : settings?.lastFxSyncAt ? (
              <>
                Last updated {relativeTime(settings.lastFxSyncAt)}
                {settings.lastFxSyncSource ? ` from ${settings.lastFxSyncSource}` : ''}.
                {stale && ' Due a refresh.'}
              </>
            ) : (
              'Not fetched yet.'
            )}
          </p>
        </div>

        {notice && (
          <div
            role="status"
            aria-live="polite"
            className="mt-3 flex items-start gap-2 rounded-lg bg-surface2 px-3 py-2 text-sm text-muted"
          >
            {notice.tone === 'warn' && (
              <span className="mt-0.5 shrink-0 text-warn">
                <IconAlert size={15} />
              </span>
            )}
            <span className="max-w-prose">{notice.text}</span>
          </div>
        )}
      </Card>

      {/* ------------------------------------------------- Manual rate entry */}
      <Card>
        <h2 className="text-sm font-semibold text-text">Add or update a rate</h2>
        <div className="mt-3 flex flex-wrap items-end gap-3">
          <Field label="Currency" className="w-28">
            {(id) => (
              <Select id={id} value={chosenCcy} onChange={(e) => setCcy(e.target.value)}>
                {options.map((c) => (
                  <option key={c} value={c}>
                    {c}
                  </option>
                ))}
              </Select>
            )}
          </Field>
          <Field label={`1 ${chosenCcy || '—'} in ${base || '—'}`} className="w-36">
            {(id) => (
              <Input
                id={id}
                value={rateText}
                inputMode="decimal"
                autoComplete="off"
                placeholder="e.g. 0.85"
                className="tnum"
                onChange={(e) => setRateText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') void addRate();
                }}
              />
            )}
          </Field>
          <Button variant="primary" className="mb-0.5" onClick={() => void addRate()}>
            Set rate
          </Button>
        </div>
        {chosenIsLive && (
          <p className="mt-2 text-xs text-muted">
            {chosenCcy} currently uses the live rate. Saving your own number makes it a manual rate —
            it stops updating automatically until you switch it back.
          </p>
        )}
      </Card>

      {/* -------------------------------------------------------- Rates list */}
      <Card className="p-0">
        {rates && sortedRates.length === 0 ? (
          noForeignCurrency ? (
            <EmptyState
              icon={<IconCoins size={32} />}
              title="No other currencies yet"
              message={
                <>
                  Rates appear here once an account uses a currency other than{' '}
                  {base || 'your base currency'} — transactions are stored in their account’s
                  currency, so that is what decides it. Live rates cover 160+ currencies, including
                  Sri Lankan Rupee (LKR) and Indian Rupee (INR).
                </>
              }
            />
          ) : (
            <EmptyState
              icon={<IconCoins size={32} />}
              title="No rates yet"
              message={
                autoOn
                  ? 'Tap “Refresh now” above to fetch today’s rates, or add one by hand.'
                  : 'Turn on live rates above, or add a rate by hand if you have accounts in more than one currency.'
              }
            />
          )
        ) : (
          <>
            <p className="border-b border-border px-4 py-2 text-xs text-muted">
              Each row reads <span className="text-text">1 foreign unit = amount in {base || '—'}</span>.
            </p>
            <ul>
              {sortedRates.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-2.5 last:border-0"
                >
                  {editingId === r.id ? (
                    <span className="flex min-w-0 flex-1 items-center gap-2 text-sm">
                      <span className="tnum shrink-0">1 {r.base} =</span>
                      <Input
                        value={editText}
                        inputMode="decimal"
                        autoFocus
                        autoComplete="off"
                        aria-label={`Rate for 1 ${r.base} in ${r.quote}`}
                        className="tnum w-28 py-1"
                        onChange={(e) => setEditText(e.target.value)}
                        onKeyDown={(e) => {
                          if (e.key === 'Enter') void saveEdit(r);
                          else if (e.key === 'Escape') setEditingId(null);
                        }}
                      />
                      <span className="shrink-0">{r.quote}</span>
                      <IconButton
                        label="Save rate"
                        className="p-1"
                        onClick={() => void saveEdit(r)}
                      >
                        <IconCheck size={16} />
                      </IconButton>
                      <IconButton
                        label="Cancel edit"
                        className="p-1"
                        onClick={() => setEditingId(null)}
                      >
                        <IconX size={16} />
                      </IconButton>
                    </span>
                  ) : (
                    <span className="tnum min-w-0 flex-1 text-sm text-text">
                      1 {r.base} = {formatRate(r.rate)} {r.quote}
                    </span>
                  )}

                  <span className="flex shrink-0 items-center gap-2">
                    {r.source === 'auto' ? (
                      <Chip className="border border-accent font-medium text-accent">Live</Chip>
                    ) : (
                      <Chip>Manual</Chip>
                    )}
                    <span className="text-xs text-muted">
                      {r.source === 'auto' ? 'updated' : 'saved'} {formatDate(r.asOf)}
                    </span>
                  </span>

                  <span className="flex shrink-0 items-center">
                    {r.source === 'manual' && autoOn && (
                      <IconButton
                        label={`Use the live rate for ${r.base} instead of the one you typed`}
                        className="p-1.5"
                        disabled={busy !== null}
                        aria-busy={busy === r.base}
                        onClick={() => setToSwitch(r)}
                      >
                        <IconDownload size={15} />
                      </IconButton>
                    )}
                    <IconButton
                      label={
                        r.source === 'auto'
                          ? `Edit the ${r.base} to ${r.quote} rate by hand — it will stop updating automatically`
                          : `Edit ${r.base} to ${r.quote} rate`
                      }
                      className="p-1.5"
                      onClick={() => {
                        setEditingId(r.id);
                        setEditText(String(r.rate));
                      }}
                    >
                      <IconPencil size={15} />
                    </IconButton>
                    <IconButton
                      label={`Remove ${r.base} to ${r.quote} rate`}
                      className="p-1.5"
                      onClick={() => setToRemove(r)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </span>

                  {editingId === r.id && r.source === 'auto' && (
                    <p className="w-full text-xs text-muted">
                      Saving your own number makes this a manual rate — it stops updating
                      automatically.
                    </p>
                  )}
                </li>
              ))}
            </ul>
          </>
        )}
      </Card>

      {example && (
        <p className="max-w-prose text-xs text-muted">
          {example.hypothetical ? 'For example, ' : ''}
          <span className="tnum text-text">{example.line}</span> means {example.from} shows as{' '}
          {example.to}
          {example.hypothetical ? ' (illustration only — no rate is set yet)' : ''}.
        </p>
      )}

      <ConfirmDialog
        open={toSwitch !== null}
        title="Use the live rate?"
        confirmLabel="Use live rate"
        message={
          <>
            You typed{' '}
            <strong className="tnum">
              1 {toSwitch?.base} = {toSwitch ? formatRate(toSwitch.rate) : ''} {toSwitch?.quote}
            </strong>
            . Fetching replaces that number with today’s published rate, and this pair will keep
            updating automatically from then on. Your typed rate is not kept — you can always type
            it again.
          </>
        }
        onConfirm={() => toSwitch && void doSwitchToLive(toSwitch)}
        onCancel={() => setToSwitch(null)}
      />

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove rate"
        danger
        confirmLabel="Remove"
        message={
          <>
            Remove the{' '}
            <strong>
              {toRemove?.base} → {toRemove?.quote}
            </strong>{' '}
            rate? Amounts in {toRemove?.base} will show unconverted (marked “no rate”) until a rate
            is set again.
          </>
        }
        onConfirm={() => toRemove && void doRemove(toRemove)}
        onCancel={() => setToRemove(null)}
      />
    </SettingsPage>
  );
}
