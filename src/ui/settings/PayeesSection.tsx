// Payees & rules (SPEC §7.4): searchable list, inline rename, and the editable
// payee → default-category rules list (the auto-categorisation overrides).
import { useMemo, useState } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import {
  deletePayee,
  renamePayee,
  setPayeeDefaultCategory,
} from '../../domain/payees';
import type { Payee } from '../../db/types';
import { nameKey } from '../../lib/util';
import { Card, ConfirmDialog, EmptyState, IconButton, Input } from '../kit/kit';
import { CategoryPicker } from '../kit/CategoryPicker';
import { IconSearch, IconTrash } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, InlineRename, SettingsPage } from './shared';

const MAX_SHOWN = 300;

export default function PayeesSection() {
  const { toast } = useToast();
  const payees = useLive(() => db.payees.toArray(), []);
  const [query, setQuery] = useState('');
  const [toDelete, setToDelete] = useState<Payee | null>(null);

  const filtered = useMemo(() => {
    const q = nameKey(query);
    return (payees ?? [])
      .filter((p) => !q || p.nameLower.includes(q))
      .sort((a, b) => a.name.localeCompare(b.name));
  }, [payees, query]);
  const shown = filtered.slice(0, MAX_SHOWN);

  const remove = async (payee: Payee) => {
    setToDelete(null);
    const result = await deletePayee(payee.id);
    if (result.ok) toast('Payee deleted', 'success');
    else toast(`Can’t delete “${payee.name}”: ${result.reason}`, 'error');
  };

  return (
    <SettingsPage
      title="Payees & rules"
      description="The default category is the auto-categorisation rule for a payee: it pre-fills quick add and is suggested for imported rows without a category. It is learned from your history — set it here to override."
    >
      <label className="relative block">
        <span className="sr-only">Search payees</span>
        <IconSearch
          size={16}
          className="pointer-events-none absolute left-3 top-1/2 -translate-y-1/2 text-faint"
        />
        <Input
          type="search"
          value={query}
          placeholder="Search payees"
          className="pl-9"
          onChange={(e) => setQuery(e.target.value)}
        />
      </label>

      <Card className="p-0">
        {payees && filtered.length === 0 ? (
          <EmptyState
            title={query ? 'No matching payees' : 'No payees yet'}
            message={
              query
                ? 'Try a different search.'
                : 'Payees are created automatically as you add or import transactions.'
            }
          />
        ) : (
          <>
            <ul>
              {shown.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-col gap-2 border-b border-border px-4 py-2.5 last:border-0 sm:flex-row sm:items-center sm:gap-3"
                >
                  <InlineRename
                    className="min-w-0 flex-1"
                    name={p.name}
                    label={`Rename payee ${p.name}`}
                    onRename={async (next) => {
                      try {
                        await renamePayee(p.id, next);
                        return true;
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                        return false;
                      }
                    }}
                  />
                  <div className="flex items-center gap-1">
                    <div className="w-full sm:w-64">
                      <CategoryPicker
                        value={p.defaultCategoryId}
                        placeholder="No default category"
                        onChange={(categoryId) => {
                          setPayeeDefaultCategory(p.id, categoryId).catch((e) =>
                            toast(errorMessage(e), 'error'),
                          );
                        }}
                      />
                    </div>
                    <IconButton
                      label={`Delete payee ${p.name}`}
                      className="p-1.5"
                      onClick={() => setToDelete(p)}
                    >
                      <IconTrash size={15} />
                    </IconButton>
                  </div>
                </li>
              ))}
            </ul>
            {filtered.length > MAX_SHOWN && (
              <p className="px-4 py-2.5 text-xs text-muted">
                Showing the first {MAX_SHOWN} of {filtered.length} payees — refine your search to
                see the rest.
              </p>
            )}
          </>
        )}
      </Card>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete payee"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <strong>{toDelete?.name}</strong>? Only payees with no transactions can be
            deleted.
          </>
        }
        onConfirm={() => toDelete && void remove(toDelete)}
        onCancel={() => setToDelete(null)}
      />
    </SettingsPage>
  );
}
