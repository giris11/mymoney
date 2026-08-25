// Shared building blocks for the Settings area only (page shell, colour
// swatches, inline rename). Cross-app widgets live in src/ui/kit — these are
// deliberately settings-local.
import { useState, type ReactNode } from 'react';
import { cn } from '../../lib/util';
import { href } from '../router';
import { IconButton, Input } from '../kit/kit';
import { IconCheck, IconChevronLeft, IconPencil, IconX } from '../kit/icons';

/** Human message for a caught domain error. */
export function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** Section page shell: back link to the index, title, optional actions row. */
export function SettingsPage({
  title,
  description,
  actions,
  children,
}: {
  title: string;
  description?: ReactNode;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div className="mx-auto w-full max-w-3xl p-4 lg:p-6">
      <a
        href={href('/settings')}
        className="mb-2 inline-flex items-center gap-0.5 text-sm text-muted hover:text-text"
      >
        <IconChevronLeft size={16} />
        Settings
      </a>
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h1 className="text-xl font-semibold">{title}</h1>
        {actions && <div className="flex items-center gap-2">{actions}</div>}
      </div>
      {description && <p className="mt-1 max-w-prose text-sm text-muted">{description}</p>}
      <div className="mt-4 flex flex-col gap-4">{children}</div>
    </div>
  );
}

/** ~10 hue-spread entity colours (matches the seed palette family). */
export const ENTITY_COLOURS = [
  '#2563eb', // blue
  '#0284c7', // sky
  '#0d9488', // teal
  '#059669', // green
  '#65a30d', // lime
  '#b45309', // amber
  '#ea580c', // orange
  '#dc2626', // red
  '#db2777', // pink
  '#7c3aed', // violet
  '#6b7280', // grey
];

/** Radio-group row of colour swatches. Data colours, so inline style is OK. */
export function ColourSwatches({
  value,
  onChange,
  label = 'Colour',
}: {
  value: string;
  onChange: (colour: string) => void;
  label?: string;
}) {
  const colours = ENTITY_COLOURS.includes(value) ? ENTITY_COLOURS : [...ENTITY_COLOURS, value];
  return (
    <div role="radiogroup" aria-label={label} className="flex flex-wrap gap-2">
      {colours.map((c) => (
        <button
          key={c}
          type="button"
          role="radio"
          aria-checked={value === c}
          aria-label={`Colour ${c}`}
          onClick={() => onChange(c)}
          className={cn(
            'h-7 w-7 cursor-pointer rounded-full border-2 transition-transform',
            value === c ? 'scale-110 border-text' : 'border-transparent hover:scale-105',
          )}
          style={{ backgroundColor: c }}
        />
      ))}
    </div>
  );
}

/**
 * Name with a pencil that switches to an inline input (Enter/✓ saves,
 * Esc/✕ cancels). `onRename` returns false to stay in edit mode (failed save —
 * the caller toasts the error).
 */
export function InlineRename({
  name,
  label,
  onRename,
  className,
}: {
  name: string;
  label: string; // accessible label, e.g. `Rename payee ${name}`
  onRename: (next: string) => Promise<boolean>;
  className?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(name);

  const cancel = () => {
    setEditing(false);
    setText(name);
  };
  const save = async () => {
    const next = text.trim();
    if (!next || next === name) {
      cancel();
      return;
    }
    if (await onRename(next)) setEditing(false);
  };

  if (!editing) {
    return (
      <span className={cn('flex min-w-0 items-center gap-0.5', className)}>
        <span className="truncate text-sm font-medium text-text">{name}</span>
        <IconButton
          label={label}
          className="p-1"
          onClick={() => {
            setText(name);
            setEditing(true);
          }}
        >
          <IconPencil size={14} />
        </IconButton>
      </span>
    );
  }
  return (
    <span className={cn('flex min-w-0 items-center gap-1', className)}>
      <Input
        value={text}
        aria-label={label}
        autoFocus
        autoComplete="off"
        className="py-1 text-sm"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') void save();
          else if (e.key === 'Escape') cancel();
        }}
      />
      <IconButton label="Save name" className="p-1" onClick={() => void save()}>
        <IconCheck size={16} />
      </IconButton>
      <IconButton label="Cancel rename" className="p-1" onClick={cancel}>
        <IconX size={16} />
      </IconButton>
    </span>
  );
}
