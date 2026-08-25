// Manual FX rates (SPEC §8.1.4). Rates convert at DISPLAY/report time only;
// stored amounts never change; a missing rate is surfaced, never guessed.
import { useMemo, useState } from 'react';
import { db, getSettings } from '../../db/db';
import { COMMON_CURRENCIES } from '../../db/seed';
import { useLive } from '../../db/useLive';
import { listRates, removeRate, setManualRate } from '../../domain/fx';
import type { FxRate } from '../../db/types';
import { formatDate } from '../../lib/util';
import { makeRateLookup } from '../../money/money';
import {
  Button,
  Card,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Select,
} from '../kit/kit';
import { IconCheck, IconCoins, IconPencil, IconTrash, IconX } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, SettingsPage } from './shared';

export default function RatesSection() {
  const { toast } = useToast();
  const settings = useLive(() => getSettings(), []);
  const rates = useLive(() => listRates(), []);
  const accounts = useLive(() => db.accounts.toArray(), []);
  const base = settings?.baseCurrency ?? '';

  const [ccy, setCcy] = useState('');
  const [rateText, setRateText] = useState('');
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editText, setEditText] = useState('');
  const [toRemove, setToRemove] = useState<FxRate | null>(null);

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
    const inUse = new Set((accounts ?? []).filter((a) => !a.archived).map((a) => a.currency));
    return [...inUse].filter((c) => c !== base && lookup(c, base) === null).sort();
  }, [accounts, rates, base]);

  const parseRate = (text: string): number | null => {
    const n = Number(text.trim());
    return Number.isFinite(n) && n > 0 ? n : null;
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
      toast(`Saved: 1 ${r.base} = ${rate} ${r.quote}`, 'success');
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

  return (
    <SettingsPage
      title="Currency rates"
      description={`Manual rates are used only at display and report time, to show totals in ${
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
      </Card>

      <Card className="p-0">
        {rates && sortedRates.length === 0 ? (
          <EmptyState
            icon={<IconCoins size={32} />}
            title="No rates yet"
            message="Add a rate above if you have accounts in more than one currency."
          />
        ) : (
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
                    <IconButton label="Save rate" className="p-1" onClick={() => void saveEdit(r)}>
                      <IconCheck size={16} />
                    </IconButton>
                    <IconButton label="Cancel edit" className="p-1" onClick={() => setEditingId(null)}>
                      <IconX size={16} />
                    </IconButton>
                  </span>
                ) : (
                  <span className="tnum min-w-0 flex-1 text-sm text-text">
                    1 {r.base} = {r.rate} {r.quote}
                  </span>
                )}
                <span className="text-xs text-muted">as of {formatDate(r.asOf)}</span>
                <span className="flex shrink-0 items-center">
                  <IconButton
                    label={`Edit ${r.base} to ${r.quote} rate`}
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
              </li>
            ))}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={toRemove !== null}
        title="Remove rate"
        danger
        confirmLabel="Remove"
        message={
          <>
            Remove the <strong>{toRemove?.base} → {toRemove?.quote}</strong> rate? Amounts in{' '}
            {toRemove?.base} will show unconverted (marked “no rate”) until a rate is set again.
          </>
        }
        onConfirm={() => toRemove && void doRemove(toRemove)}
        onCancel={() => setToRemove(null)}
      />
    </SettingsPage>
  );
}
