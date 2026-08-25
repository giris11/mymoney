// First-run onboarding wizard (SPEC §4, D24). Rendered full-screen by App
// while settings.onboarded is false. Four calm steps: welcome → base currency
// → starter accounts → get your data in (MoneyWiz import / sample data /
// start fresh). Every path ends in one finish flow that writes settings,
// creates the ticked accounts, requests persistent storage and lands on the
// dashboard. `onboarded: true` is written LAST so a mid-flight failure leaves
// onboarding safely retryable and the app never shows a half-set-up state.
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { APP_NAME } from '../../config';
import { db, getSettings, updateSettings } from '../../db/db';
import { COMMON_CURRENCIES } from '../../db/seed';
import { loadSampleData } from '../../domain/sample';
import { requestPersistence } from '../../lib/storage';
import { cn } from '../../lib/util';
import ImportWizard from '../import/ImportWizard';
import { navigate } from '../router';
import { Button, Field, Select } from '../kit/kit';
import { IconChevronLeft, IconCoins } from '../kit/icons';
import { useToast } from '../kit/toast';
import {
  AccountsStep,
  accountsStepError,
  buildAccounts,
  defaultAccountRows,
  type AccountRowState,
} from '../onboarding/AccountsStep';
import { DataStep, type DataChoice } from '../onboarding/DataStep';

const TOTAL_STEPS = 4;

let currencyNames: Intl.DisplayNames | null = null;
try {
  currencyNames = new Intl.DisplayNames(['en-GB'], { type: 'currency' });
} catch {
  currencyNames = null;
}
function currencyLabel(code: string): string {
  try {
    const name = currencyNames?.of(code);
    return name && name !== code ? `${code} — ${name}` : code;
  } catch {
    return code;
  }
}

function StepDots({ step }: { step: number }) {
  return (
    <div className="flex items-center justify-center gap-1.5">
      <span className="sr-only">
        Step {step + 1} of {TOTAL_STEPS}
      </span>
      {Array.from({ length: TOTAL_STEPS }, (_, i) => (
        <span
          key={i}
          aria-hidden="true"
          className={cn(
            'h-1.5 rounded-full transition-all',
            i === step ? 'w-5 bg-accent' : 'w-1.5 bg-border',
          )}
        />
      ))}
    </div>
  );
}

function StepHeading({ title, subtitle }: { title: string; subtitle?: ReactNode }) {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-xl font-bold text-text">{title}</h1>
      {subtitle && <p className="text-sm text-muted">{subtitle}</p>}
    </div>
  );
}

export default function Onboarding() {
  const { toast } = useToast();
  const [step, setStep] = useState(0);
  const [baseCurrency, setBaseCurrency] = useState('GBP');
  const [rows, setRows] = useState<AccountRowState[]>(defaultAccountRows);
  const [importing, setImporting] = useState(false);
  const [busyChoice, setBusyChoice] = useState<DataChoice | null>(null);

  // Guards: never create the accounts twice, never run finish twice.
  const accountsCreatedRef = useRef(false);
  const finishingRef = useRef(false);

  // Re-entry safety: if onboarding somehow renders after it's already done,
  // head straight to the dashboard.
  useEffect(() => {
    let cancelled = false;
    void getSettings().then((s) => {
      if (!cancelled && s.onboarded) navigate('/dashboard');
    });
    return () => {
      cancelled = true;
    };
  }, []);

  /** Write base currency + ticked accounts once, atomically. */
  const createAccountsAndSettings = async () => {
    if (accountsCreatedRef.current) return;
    const accounts = buildAccounts(rows, baseCurrency);
    await db.transaction('rw', db.accounts, db.settings, async () => {
      await updateSettings({ baseCurrency });
      if (accounts.length > 0) await db.accounts.bulkAdd(accounts);
    });
    accountsCreatedRef.current = true;
  };

  /** One finish flow for every path (import already created the accounts). */
  const finish = async (withSample: boolean) => {
    if (finishingRef.current) return;
    finishingRef.current = true;
    try {
      await createAccountsAndSettings();
      if (withSample) await loadSampleData();
      await updateSettings({ onboarded: true }); // flips App to the main layout
      void requestPersistence(); // fire and forget (result surfaced in Settings)
      navigate('/dashboard');
    } catch (err) {
      finishingRef.current = false;
      setBusyChoice(null);
      toast(err instanceof Error ? err.message : 'Something went wrong — please try again.', 'error');
    }
  };

  const choose = async (choice: DataChoice) => {
    if (busyChoice || finishingRef.current) return;
    setBusyChoice(choice);
    if (choice === 'import') {
      // Accounts + settings FIRST so the import can match against them.
      try {
        await createAccountsAndSettings();
        setImporting(true);
      } catch (err) {
        toast(err instanceof Error ? err.message : 'Could not create your accounts.', 'error');
      } finally {
        setBusyChoice(null);
      }
    } else {
      await finish(choice === 'sample');
    }
  };

  if (importing) {
    return (
      <div className="min-h-dvh overflow-y-auto bg-bg">
        <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
          <ImportWizard onDone={() => void finish(false)} onCancel={() => void finish(false)} />
        </div>
      </div>
    );
  }

  const accountsError = accountsStepError(rows);

  return (
    <div className="flex min-h-dvh items-center justify-center bg-bg p-4 py-8">
      <div className="w-full max-w-lg rounded-2xl border border-border bg-surface p-6 shadow-sm sm:p-8">
        <StepDots step={step} />

        {step === 0 && (
          <div className="mt-8 flex flex-col items-center gap-4 text-center">
            <div className="rounded-2xl bg-accent p-3 text-on-accent">
              <IconCoins size={28} />
            </div>
            <h1 className="text-2xl font-bold text-text">{APP_NAME}</h1>
            <p className="max-w-sm text-sm text-muted">
              Your money, on your device. No accounts, no cloud, works offline.
            </p>
            <Button variant="primary" className="mt-2 w-full" onClick={() => setStep(1)}>
              Get started
            </Button>
          </div>
        )}

        {step === 1 && (
          <div className="mt-6 flex flex-col gap-5">
            <StepHeading
              title="Choose your base currency"
              subtitle="Reports, budgets and totals are shown in this currency."
            />
            <Field label="Base currency" hint="You can change this later in Settings.">
              {(id) => (
                <Select
                  id={id}
                  value={baseCurrency}
                  onChange={(e) => setBaseCurrency(e.target.value)}
                >
                  {COMMON_CURRENCIES.map((c) => (
                    <option key={c} value={c}>
                      {currencyLabel(c)}
                    </option>
                  ))}
                </Select>
              )}
            </Field>
          </div>
        )}

        {step === 2 && (
          <div className="mt-6 flex flex-col gap-5">
            <StepHeading
              title="Set up your accounts"
              subtitle="Tick the ones you use and rename anything. You can add more later in Settings."
            />
            <AccountsStep rows={rows} onRowsChange={setRows} baseCurrency={baseCurrency} />
          </div>
        )}

        {step === 3 && (
          <div className="mt-6 flex flex-col gap-5">
            <StepHeading title="Get your data in" subtitle="How would you like to begin?" />
            <DataStep busyChoice={busyChoice} onChoose={(c) => void choose(c)} />
          </div>
        )}

        {step > 0 && (
          <div className="mt-6 flex items-center justify-between">
            <Button
              variant="ghost"
              onClick={() => setStep(step - 1)}
              disabled={busyChoice !== null}
            >
              <IconChevronLeft size={16} /> Back
            </Button>
            {step < 3 && (
              <Button
                variant="primary"
                onClick={() => setStep(step + 1)}
                disabled={step === 2 && accountsError !== null}
              >
                Continue
              </Button>
            )}
          </div>
        )}

        {step === 2 && accountsError && (
          <p className="mt-2 text-right text-xs text-muted">{accountsError}</p>
        )}
      </div>
    </div>
  );
}
