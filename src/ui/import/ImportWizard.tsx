// Import wizard (SPEC §7): file → detect/map → MANDATORY preview → commit.
// Rendered by Settings and Onboarding inside their own containers (e.g. a
// wide Modal), so this is a self-contained panel — no page chrome.
//
// Hard rule honoured here: NOTHING is written to the database before
// commitImport on the preview step. (The one deliberate exception, per SPEC
// §7.2, is persisting the column mapping to settings.savedMappings when the
// user continues past the Map step — a settings write, not data.)
import { useEffect, useState } from 'react';
import { db, getSettings, updateSettings } from '../../db/db';
import type { ColumnMapping, ImportBatch } from '../../db/types';
import { guessMapping, parseCsv, parseWithMapping } from '../../import/generic';
import { buildImportPlan, commitImport } from '../../import/importer';
import { isMoneyWizCsv, parseMoneyWizCsv } from '../../import/moneywiz';
import type { ImportPlan } from '../../import/types';
import { useToast } from '../kit/toast';
import { StepIndicator, errMsg } from './bits';
import { DoneStep } from './DoneStep';
import { FileStep } from './FileStep';
import { MapStep } from './MapStep';
import { PreviewStep } from './PreviewStep';
import {
  isMoneyWizReportCsv,
  parseMoneyWizReportCsv,
  reportBuildOptions,
  type MoneyWizReportResult,
  type ReportAccount,
} from './reportFormat';
import {
  findSavedMapping,
  firstDateCell,
  needsDiscardConfirm,
  savedMappingKey,
  type ImportDateFormat,
  type WizardStep,
} from './wizardLogic';

export interface ImportWizardProps {
  onDone: () => void;
  onCancel: () => void;
  /** Fires whenever the wizard starts/stops holding work that closing would
   *  destroy, so a host rendering it in a dismissable container can confirm
   *  before unmounting it (a backdrop click must not eat an import). */
  onDirtyChange?: (dirty: boolean) => void;
}

interface LoadedFile {
  name: string;
  sizeBytes: number;
  text: string; // kept so MoneyWiz files can be re-parsed under another date format
  data: string[][]; // raw parsed rows, header row included
  headers: string[];
  parseErrors: string[];
  source: 'moneywiz' | 'csv';
  /** Which MoneyWiz shape this file is: the flat one-row-per-transaction
   *  export, or the Report layout that interleaves account rows carrying each
   *  account's closing balance. Both skip the Map step; only the report one
   *  brings opening balances. */
  mwLayout: 'flat' | 'report' | null;
  /** Report layout only: one summary per account in the file. */
  reportAccounts: ReportAccount[] | null;
  mwWarnings: string[];
  /** How the MoneyWiz parser read the date column (null for generic CSV). */
  dateFormat: ImportDateFormat | null;
  savedMappingLoaded: boolean;
  baseCurrency: string;
}

const ALL_STEPS: { key: WizardStep; label: string }[] = [
  { key: 'file', label: 'File' },
  { key: 'map', label: 'Map' },
  { key: 'preview', label: 'Preview' },
  { key: 'done', label: 'Done' },
];

export default function ImportWizard({ onDone, onCancel, onDirtyChange }: ImportWizardProps) {
  const { toast } = useToast();
  const [step, setStep] = useState<WizardStep>('file');
  const [file, setFile] = useState<LoadedFile | null>(null);
  const [fileError, setFileError] = useState<string | null>(null);
  const [mapping, setMapping] = useState<ColumnMapping | null>(null);
  const [fixedAccountId, setFixedAccountId] = useState('');
  const [plan, setPlan] = useState<ImportPlan | null>(null);
  const [batch, setBatch] = useState<ImportBatch | null>(null);
  const [busy, setBusy] = useState(false);

  // MoneyWiz files skip the Map step entirely.
  const steps = file?.source === 'moneywiz' ? ALL_STEPS.filter((s) => s.key !== 'map') : ALL_STEPS;

  const dirty = needsDiscardConfirm(step, file !== null);
  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  /**
   * The plan for a report-format parse. Identical to every other import call
   * except for one thing: the opening balances the parser derived travel with
   * it, so each new account is created at the balance the file implies rather
   * than at zero. That is the whole point of supporting this layout — SPEC §6
   * makes an account's balance opening + Σ amounts, so without the opening
   * every account would land short by exactly its opening balance.
   */
  const planForReport = (
    mw: MoneyWizReportResult,
    fileName: string,
    defaultCurrency: string,
  ): Promise<ImportPlan> =>
    buildImportPlan(
      mw.rows,
      reportBuildOptions({ source: 'moneywiz', fileName, defaultCurrency }, mw.accounts),
    );

  async function handleFile(f: File) {
    setBusy(true);
    setFileError(null);
    try {
      const text = await f.text();
      // parseCsv drops a leading Excel `sep=,` hint (report exports open with
      // one), so data[0] is the real header row for every layout.
      const { data, errors } = parseCsv(text);
      if (data.length === 0) {
        setFileError('No rows found in this file — is it a CSV export?');
        return;
      }
      const headers = (data[0] ?? []).map((h) => h.trim());
      const settings = await getSettings();

      // Fresh file ⇒ reset everything downstream.
      setPlan(null);
      setBatch(null);
      setMapping(null);
      setFixedAccountId('');

      // ORDER MATTERS. A report export also passes the flat MoneyWiz header
      // test — it has Account, Date, Amount and Payee columns — but the two
      // layouts mean opposite things by them: in a report file the "Account"
      // column holds the account's CURRENCY on account rows and the account
      // NAME on transaction rows. Read as a flat export it would import
      // account headers as transactions and file everything under accounts
      // called "GBP" and "TRY". So the report test goes first, always.
      if (isMoneyWizReportCsv(headers)) {
        const mw = parseMoneyWizReportCsv(text);
        setFile({
          name: f.name,
          sizeBytes: f.size,
          text,
          data,
          headers,
          parseErrors: errors,
          source: 'moneywiz',
          mwLayout: 'report',
          reportAccounts: mw.accounts,
          mwWarnings: mw.warnings,
          dateFormat: mw.detectedDateFormat,
          savedMappingLoaded: false,
          baseCurrency: settings.baseCurrency,
        });
        setPlan(await planForReport(mw, f.name, settings.baseCurrency));
        setStep('preview');
      } else if (isMoneyWizCsv(headers)) {
        const mw = parseMoneyWizCsv(text);
        setFile({
          name: f.name,
          sizeBytes: f.size,
          text,
          data,
          headers,
          parseErrors: errors,
          source: 'moneywiz',
          mwLayout: 'flat',
          reportAccounts: null,
          mwWarnings: mw.warnings,
          dateFormat: mw.detectedDateFormat,
          savedMappingLoaded: false,
          baseCurrency: settings.baseCurrency,
        });
        const p = await buildImportPlan(mw.rows, {
          source: 'moneywiz',
          fileName: f.name,
          defaultCurrency: settings.baseCurrency,
        });
        setPlan(p);
        setStep('preview');
      } else {
        // Guess first: the saved-mapping signature depends on headerRow, so a
        // headerless file can only be looked up once we know it is headerless.
        const guessed = guessMapping(headers, data.slice(1, 11));
        const saved = findSavedMapping(settings.savedMappings, headers, guessed);
        setFile({
          name: f.name,
          sizeBytes: f.size,
          text,
          data,
          headers,
          parseErrors: errors,
          source: 'csv',
          mwLayout: null,
          reportAccounts: null,
          mwWarnings: [],
          dateFormat: null,
          savedMappingLoaded: !!saved,
          baseCurrency: settings.baseCurrency,
        });
        setMapping(saved ? { ...saved } : guessed);
        setStep('map');
      }
    } catch (e) {
      setFileError(errMsg(e));
    } finally {
      setBusy(false);
    }
  }

  /** Re-read a MoneyWiz file under a different date ordering (D20): the whole
   *  plan is rebuilt, since every row's date — and so every dedupe match —
   *  changes with it. */
  async function handleDateFormat(fmt: ImportDateFormat) {
    if (!file || file.source !== 'moneywiz') return;
    setBusy(true);
    try {
      if (file.mwLayout === 'report') {
        // Re-reading changes every date, so it changes which transfer legs
        // pair and which rows look like duplicates — and therefore the sums
        // behind every opening balance. The account summaries have to come
        // from the SAME parse as the rows, never be carried over.
        const mw = parseMoneyWizReportCsv(file.text, fmt);
        setFile({
          ...file,
          reportAccounts: mw.accounts,
          mwWarnings: mw.warnings,
          dateFormat: fmt,
        });
        setPlan(await planForReport(mw, file.name, file.baseCurrency));
        return;
      }
      const mw = parseMoneyWizCsv(file.text, fmt);
      // The parser reports what it *detected*; once the user overrides it, the
      // chosen ordering is what the rows were actually read with.
      setFile({ ...file, mwWarnings: mw.warnings, dateFormat: fmt });
      const p = await buildImportPlan(mw.rows, {
        source: 'moneywiz',
        fileName: file.name,
        defaultCurrency: file.baseCurrency,
      });
      setPlan(p);
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleMapContinue() {
    if (!file || !mapping) return;
    setBusy(true);
    try {
      const fixedAccount = fixedAccountId ? await db.accounts.get(fixedAccountId) : undefined;
      const rows = parseWithMapping(
        file.data,
        mapping,
        fixedAccount?.currency ?? file.baseCurrency,
      );
      // Save the mapping for next time, keyed by the file's header signature.
      const settings = await getSettings();
      await updateSettings({
        savedMappings: {
          ...settings.savedMappings,
          [savedMappingKey(file.headers, mapping)]: mapping,
        },
      });
      const p = await buildImportPlan(rows, {
        source: 'csv',
        fileName: file.name,
        fixedAccountId: fixedAccountId || undefined,
        defaultCurrency: file.baseCurrency,
      });
      setPlan(p);
      setStep('preview');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  async function handleCommit() {
    if (!plan) return;
    setBusy(true);
    try {
      const b = await commitImport(plan);
      setBatch(b);
      setStep('done');
      toast(`Imported ${b.rowCount} transaction${b.rowCount === 1 ? '' : 's'}`, 'success');
    } catch (e) {
      toast(errMsg(e), 'error');
    } finally {
      setBusy(false);
    }
  }

  // Resume forward from the File step when a file is already parsed.
  const fileContinue =
    file && !busy
      ? file.source === 'moneywiz'
        ? plan
          ? () => setStep('preview')
          : null
        : mapping
          ? () => setStep('map')
          : null
      : null;

  return (
    <div className="flex flex-col gap-4">
      <StepIndicator steps={steps} current={step} />

      {step === 'file' && (
        <FileStep
          loaded={file ? { name: file.name, sizeBytes: file.sizeBytes, source: file.source } : null}
          busy={busy}
          error={fileError}
          onFile={handleFile}
          onContinue={fileContinue}
          onCancel={onCancel}
        />
      )}

      {step === 'map' && file && mapping && (
        <MapStep
          headers={file.headers}
          data={file.data}
          parseErrors={file.parseErrors}
          savedMappingLoaded={file.savedMappingLoaded}
          baseCurrency={file.baseCurrency}
          mapping={mapping}
          onMapping={setMapping}
          fixedAccountId={fixedAccountId}
          onFixedAccount={setFixedAccountId}
          busy={busy}
          onBack={() => setStep('file')}
          onContinue={handleMapContinue}
          onCancel={onCancel}
        />
      )}

      {step === 'preview' && file && plan && (
        <PreviewStep
          plan={plan}
          mwWarnings={file.mwWarnings}
          baseCurrency={file.baseCurrency}
          dateFormat={file.dateFormat}
          sampleDate={firstDateCell(file.data, file.headers)}
          onDateFormat={handleDateFormat}
          reportAccounts={file.reportAccounts}
          busy={busy}
          onBack={() => setStep(file.source === 'moneywiz' ? 'file' : 'map')}
          onCommit={handleCommit}
          onCancel={onCancel}
        />
      )}

      {step === 'done' && plan && batch && <DoneStep plan={plan} batch={batch} onDone={onDone} />}
    </div>
  );
}
