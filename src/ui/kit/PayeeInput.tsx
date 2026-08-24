// Payee combobox: autocompletes existing payees, free text creates new ones
// on save (SPEC §4 quick add). Reports the picked payee's learned default
// category so forms can pre-fill it (D17).
import { useEffect, useRef, useState } from 'react';
import { searchPayees } from '../../domain/payees';
import type { Payee } from '../../db/types';
import { cn } from '../../lib/util';
import { Input } from './kit';

export function PayeeInput({
  id,
  value,
  onChange,
  onPick,
  placeholder = 'Payee',
  autoFocus,
}: {
  id?: string;
  value: string;
  onChange: (text: string) => void;
  /** Fired when an existing payee is chosen from the list. */
  onPick?: (payee: Payee) => void;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [options, setOptions] = useState<Payee[]>([]);
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const debounce = useRef<number>(0);

  useEffect(() => {
    window.clearTimeout(debounce.current);
    debounce.current = window.setTimeout(async () => {
      const res = await searchPayees(value, 8);
      setOptions(res);
      setHighlight(0);
    }, 80);
    return () => window.clearTimeout(debounce.current);
  }, [value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const pick = (p: Payee) => {
    onChange(p.name);
    onPick?.(p);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="relative">
      <Input
        id={id}
        role="combobox"
        aria-expanded={open && options.length > 0}
        aria-autocomplete="list"
        autoComplete="off"
        autoFocus={autoFocus}
        placeholder={placeholder}
        value={value}
        onFocus={() => setOpen(true)}
        onChange={(e) => {
          onChange(e.target.value);
          setOpen(true);
        }}
        onKeyDown={(e) => {
          if (!open || options.length === 0) return;
          if (e.key === 'ArrowDown') {
            e.preventDefault();
            setHighlight((h) => Math.min(h + 1, options.length - 1));
          } else if (e.key === 'ArrowUp') {
            e.preventDefault();
            setHighlight((h) => Math.max(h - 1, 0));
          } else if (e.key === 'Enter') {
            const opt = options[highlight];
            if (opt && opt.name.toLowerCase() !== value.trim().toLowerCase()) {
              e.preventDefault();
              pick(opt);
            } else {
              setOpen(false);
            }
          } else if (e.key === 'Escape') {
            setOpen(false);
          }
        }}
      />
      {open && options.length > 0 && (
        <ul
          role="listbox"
          aria-label="Payee suggestions"
          className="absolute z-30 mt-1 max-h-52 w-full overflow-y-auto rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {options.map((p, i) => (
            <li key={p.id} role="option" aria-selected={i === highlight}>
              <button
                type="button"
                onMouseEnter={() => setHighlight(i)}
                onClick={() => pick(p)}
                className={cn(
                  'w-full px-3 py-1.5 text-left text-sm cursor-pointer truncate',
                  i === highlight && 'bg-surface2',
                )}
              >
                {p.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
