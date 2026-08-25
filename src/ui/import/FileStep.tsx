// Step 1 — choose a file. Drag-drop zone + picker; the wizard parses on
// selection and moves on automatically (MoneyWiz → Preview, else → Map).
import { useRef, useState, type DragEvent } from 'react';
import { cn } from '../../lib/util';
import { IconUpload } from '../kit/icons';
import { Button } from '../kit/kit';
import { WizardFooter, formatBytes } from './bits';

export function FileStep({
  loaded,
  busy,
  error,
  onFile,
  onContinue,
  onCancel,
}: {
  loaded: { name: string; sizeBytes: number; source: 'moneywiz' | 'csv' } | null;
  busy: boolean;
  error: string | null;
  onFile: (f: File) => void;
  /** Present when a file is already parsed — resumes where the user left off. */
  onContinue: (() => void) | null;
  onCancel: () => void;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragOver, setDragOver] = useState(false);

  const handleDrop = (e: DragEvent<HTMLDivElement>) => {
    e.preventDefault();
    setDragOver(false);
    const f = e.dataTransfer.files?.[0];
    if (f) onFile(f);
  };

  return (
    <div className="flex flex-col gap-4">
      <div
        onDragOver={(e) => {
          e.preventDefault();
          setDragOver(true);
        }}
        onDragLeave={() => setDragOver(false)}
        onDrop={handleDrop}
        className={cn(
          'flex flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed px-4 py-10 text-center transition-colors',
          dragOver ? 'border-accent bg-surface2' : 'border-border',
        )}
      >
        <IconUpload size={28} className="text-faint" />
        <p className="text-sm text-muted">Drag and drop a CSV file here, or</p>
        <Button variant="primary" disabled={busy} onClick={() => inputRef.current?.click()}>
          Choose file…
        </Button>
        <input
          ref={inputRef}
          type="file"
          accept=".csv,.txt,text/csv,text/plain"
          className="sr-only"
          aria-label="Choose a CSV file to import"
          onChange={(e) => {
            const f = e.target.files?.[0];
            if (f) onFile(f);
            e.target.value = ''; // allow re-picking the same file
          }}
        />
        <p className="max-w-sm text-xs text-faint">
          MoneyWiz exports are detected automatically; any other CSV goes through column mapping.
          Nothing is imported until you confirm the preview.
        </p>
      </div>

      {busy && (
        <p role="status" className="text-sm text-muted">
          Reading file…
        </p>
      )}
      {error && (
        <p role="alert" className="text-sm text-danger">
          {error}
        </p>
      )}
      {loaded && !busy && (
        <div className="flex items-center justify-between gap-2 rounded-lg border border-border bg-surface2 px-3 py-2 text-sm">
          <span className="truncate font-medium text-text">{loaded.name}</span>
          <span className="shrink-0 text-muted">
            {formatBytes(loaded.sizeBytes)}
            {loaded.source === 'moneywiz' ? ' · MoneyWiz export detected' : ''}
          </span>
        </div>
      )}

      <WizardFooter left={<Button onClick={onCancel}>Cancel</Button>}>
        {onContinue && (
          <Button variant="primary" disabled={busy} onClick={onContinue}>
            Continue
          </Button>
        )}
      </WizardFooter>
    </div>
  );
}
