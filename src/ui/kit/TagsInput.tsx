// Tag chips input: type to add (suggests existing tags), Backspace removes,
// works by tag NAME — forms pass names to domain functions which create/look
// up the actual tag records.
import { useEffect, useMemo, useRef, useState } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { cn, nameKey } from '../../lib/util';
import { IconX } from './icons';

export function TagsInput({
  id,
  value,
  onChange,
  placeholder = 'Add tag…',
}: {
  id?: string;
  value: string[]; // tag names
  onChange: (names: string[]) => void;
  placeholder?: string;
}) {
  const [text, setText] = useState('');
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);
  const allTags = useLive(() => db.tags.toArray(), []) ?? [];

  const suggestions = useMemo(() => {
    const q = nameKey(text);
    const chosen = new Set(value.map(nameKey));
    return allTags
      .filter((t) => !chosen.has(t.nameLower) && (!q || t.nameLower.includes(q)))
      .slice(0, 6);
  }, [allTags, text, value]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  const add = (name: string) => {
    const clean = name.trim().replace(/\s+/g, ' ');
    if (!clean) return;
    if (value.some((v) => nameKey(v) === nameKey(clean))) return;
    onChange([...value, clean]);
    setText('');
  };

  const listOpen = open && suggestions.length > 0;

  return (
    <div ref={rootRef} className="relative">
      <div className="flex flex-wrap items-center gap-1.5 rounded-lg border border-border bg-surface px-2 py-1.5">
        {value.map((name) => (
          <span
            key={name}
            className="inline-flex items-center gap-1 rounded-full bg-surface2 px-2 py-0.5 text-xs text-text"
          >
            {name}
            <button
              type="button"
              aria-label={`Remove tag ${name}`}
              className="text-faint hover:text-text cursor-pointer"
              onClick={() => onChange(value.filter((v) => v !== name))}
            >
              <IconX size={12} />
            </button>
          </span>
        ))}
        <input
          id={id}
          value={text}
          placeholder={value.length === 0 ? placeholder : ''}
          aria-label="Add tag"
          autoComplete="off"
          className="min-w-24 flex-1 bg-transparent px-1 py-0.5 text-sm text-text placeholder:text-faint outline-none"
          onFocus={() => setOpen(true)}
          onChange={(e) => {
            setText(e.target.value);
            setOpen(true);
          }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ',') {
              e.preventDefault();
              add(text);
            } else if (e.key === 'Backspace' && !text && value.length > 0) {
              onChange(value.slice(0, -1));
            } else if (e.key === 'Escape') {
              // with nothing showing, Escape belongs to the surrounding dialog;
              // when the suggestions ARE showing it must not reach the
              // window-level Modal listener, which would close the whole sheet
              if (!listOpen) return;
              e.preventDefault();
              e.stopPropagation();
              setOpen(false);
            }
          }}
        />
      </div>
      {listOpen && (
        <ul
          role="listbox"
          aria-label="Tag suggestions"
          className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-surface py-1 shadow-lg"
        >
          {suggestions.map((t) => (
            <li key={t.id} role="option" aria-selected={false}>
              <button
                type="button"
                onClick={() => add(t.name)}
                className={cn('w-full px-3 py-1.5 text-left text-sm cursor-pointer hover:bg-surface2')}
              >
                {t.name}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
