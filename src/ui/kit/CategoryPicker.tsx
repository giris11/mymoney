// Category pickers: single-select dropdown-tree and multi-select tree
// (budgets). Both keyboard-usable.
import { useMemo, useRef, useState, useEffect } from 'react';
import { useLive } from '../../db/useLive';
import { categoryTree, type CategoryNode } from '../../domain/categories';
import type { CategoryKind } from '../../db/types';
import { cn } from '../../lib/util';
import { Checkbox, Input } from './kit';
import { IconChevronDown, IconX } from './icons';

interface FlatOption {
  id: string;
  label: string;
  depth: number;
  colour?: string;
}

function flatten(nodes: CategoryNode[], depth = 0, out: FlatOption[] = []): FlatOption[] {
  for (const n of nodes) {
    out.push({ id: n.id, label: n.name, depth, colour: n.colour });
    flatten(n.children, depth + 1, out);
  }
  return out;
}

/** Single category select — searchable dropdown showing the tree indented. */
export function CategoryPicker({
  id,
  kind,
  value,
  onChange,
  allowNone = true,
  placeholder = 'Choose category',
}: {
  id?: string;
  kind?: CategoryKind;
  value: string | null;
  onChange: (id: string | null) => void;
  allowNone?: boolean;
  placeholder?: string;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [highlight, setHighlight] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const tree = useLive(() => categoryTree(kind), [kind]);
  const flat = useMemo(() => flatten(tree ?? []), [tree]);
  const byId = useMemo(() => new Map(flat.map((f) => [f.id, f])), [flat]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return flat;
    return flat.filter((f) => f.label.toLowerCase().includes(q));
  }, [flat, query]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDown);
    return () => document.removeEventListener('mousedown', onDown);
  }, [open]);

  useEffect(() => setHighlight(0), [query, open]);

  const pick = (catId: string | null) => {
    onChange(catId);
    setOpen(false);
    setQuery('');
  };

  const selected = value ? byId.get(value) : undefined;

  return (
    <div ref={rootRef} className="relative">
      <button
        id={id}
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className="flex w-full items-center justify-between gap-2 rounded-lg border border-border bg-surface px-3 py-2 text-left text-sm cursor-pointer"
      >
        <span className={cn('flex items-center gap-2 truncate', !selected && 'text-faint')}>
          {selected?.colour && (
            <span
              aria-hidden="true"
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ backgroundColor: selected.colour }}
            />
          )}
          {selected ? selected.label : value ? 'Unknown category' : placeholder}
        </span>
        <span className="flex items-center gap-1">
          {allowNone && value && (
            <span
              role="button"
              tabIndex={0}
              aria-label="Clear category"
              onClick={(e) => {
                e.stopPropagation();
                pick(null);
              }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.stopPropagation();
                  pick(null);
                }
              }}
              className="rounded p-0.5 text-faint hover:text-text"
            >
              <IconX size={14} />
            </span>
          )}
          <IconChevronDown size={16} className="text-faint" />
        </span>
      </button>
      {open && (
        <div className="absolute z-30 mt-1 w-full rounded-lg border border-border bg-surface shadow-lg">
          <div className="p-2">
            <Input
              autoFocus
              value={query}
              placeholder="Search categories"
              aria-label="Search categories"
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'ArrowDown') {
                  e.preventDefault();
                  setHighlight((h) => Math.min(h + 1, filtered.length - 1));
                } else if (e.key === 'ArrowUp') {
                  e.preventDefault();
                  setHighlight((h) => Math.max(h - 1, 0));
                } else if (e.key === 'Enter') {
                  e.preventDefault();
                  const opt = filtered[highlight];
                  if (opt) pick(opt.id);
                } else if (e.key === 'Escape') {
                  setOpen(false);
                }
              }}
            />
          </div>
          <ul role="listbox" aria-label="Categories" className="max-h-64 overflow-y-auto pb-1">
            {filtered.length === 0 && (
              <li className="px-3 py-2 text-sm text-faint">No matches</li>
            )}
            {filtered.map((f, i) => (
              <li key={f.id} role="option" aria-selected={value === f.id}>
                <button
                  type="button"
                  onClick={() => pick(f.id)}
                  onMouseEnter={() => setHighlight(i)}
                  className={cn(
                    'flex w-full items-center gap-2 px-3 py-1.5 text-left text-sm cursor-pointer',
                    i === highlight && 'bg-surface2',
                    value === f.id && 'font-semibold',
                  )}
                  style={{ paddingLeft: `${12 + (query ? 0 : f.depth) * 16}px` }}
                >
                  {f.colour && (
                    <span
                      aria-hidden="true"
                      className="h-2 w-2 shrink-0 rounded-full"
                      style={{ backgroundColor: f.colour }}
                    />
                  )}
                  <span className="truncate">{f.label}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

/** Multi-select category tree with checkboxes (budgets: pick parents to
 *  include whole subtrees — descendants are implied, shown as hint text). */
export function CategoryMultiSelect({
  kind,
  value,
  onChange,
}: {
  kind?: CategoryKind;
  value: string[];
  onChange: (ids: string[]) => void;
}) {
  const tree = useLive(() => categoryTree(kind), [kind]);
  const toggle = (id: string, on: boolean) => {
    onChange(on ? [...value, id] : value.filter((v) => v !== id));
  };
  const renderNodes = (nodes: CategoryNode[], depth: number) =>
    nodes.map((n) => (
      <div key={n.id}>
        <div style={{ paddingLeft: `${depth * 20}px` }} className="py-0.5">
          <Checkbox
            label={
              <span className="flex items-center gap-2">
                {n.colour && (
                  <span
                    aria-hidden="true"
                    className="h-2 w-2 rounded-full"
                    style={{ backgroundColor: n.colour }}
                  />
                )}
                {n.name}
                {n.children.length > 0 && value.includes(n.id) && (
                  <span className="text-xs text-faint">(includes subcategories)</span>
                )}
              </span>
            }
            checked={value.includes(n.id)}
            onChange={(on) => toggle(n.id, on)}
          />
        </div>
        {renderNodes(n.children, depth + 1)}
      </div>
    ));
  return (
    <div className="max-h-72 overflow-y-auto rounded-lg border border-border bg-surface p-2">
      {tree ? renderNodes(tree, 0) : <p className="p-2 text-sm text-faint">Loading…</p>}
    </div>
  );
}
