// Tags (SPEC §8.1.3): list with usage counts, inline rename, delete with a
// warning that the tag is stripped from N transactions.
import { useMemo, useState } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import { deleteTag, renameTag, tagUsageCounts } from '../../domain/tags';
import type { Tag } from '../../db/types';
import { Card, Chip, ConfirmDialog, EmptyState, IconButton } from '../kit/kit';
import { IconTag, IconTrash } from '../kit/icons';
import { useToast } from '../kit/toast';
import { errorMessage, InlineRename, SettingsPage } from './shared';

export default function TagsSection() {
  const { toast } = useToast();
  const tags = useLive(() => db.tags.toArray(), []);
  const counts = useLive(() => tagUsageCounts(), []);
  const [toDelete, setToDelete] = useState<Tag | null>(null);

  const sorted = useMemo(
    () => [...(tags ?? [])].sort((a, b) => a.name.localeCompare(b.name)),
    [tags],
  );
  const deleteCount = toDelete ? (counts?.get(toDelete.id) ?? 0) : 0;

  const remove = async (tag: Tag) => {
    setToDelete(null);
    try {
      await deleteTag(tag.id);
      toast(`Tag “${tag.name}” deleted`, 'success');
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <SettingsPage
      title="Tags"
      description="Tags cut across categories — deleting one removes it from every transaction that carries it."
    >
      <Card className="p-0">
        {tags && sorted.length === 0 ? (
          <EmptyState
            icon={<IconTag size={32} />}
            title="No tags yet"
            message="Add tags to transactions (e.g. “holiday”) and they’ll appear here."
          />
        ) : (
          <ul>
            {sorted.map((t) => {
              const used = counts?.get(t.id) ?? 0;
              return (
                <li
                  key={t.id}
                  className="flex items-center gap-3 border-b border-border px-4 py-2 last:border-0"
                >
                  <InlineRename
                    className="min-w-0 flex-1"
                    name={t.name}
                    label={`Rename tag ${t.name}`}
                    onRename={async (next) => {
                      try {
                        await renameTag(t.id, next);
                        return true;
                      } catch (e) {
                        toast(errorMessage(e), 'error');
                        return false;
                      }
                    }}
                  />
                  <Chip>
                    {used} transaction{used === 1 ? '' : 's'}
                  </Chip>
                  <IconButton
                    label={`Delete tag ${t.name}`}
                    className="p-1.5"
                    onClick={() => setToDelete(t)}
                  >
                    <IconTrash size={15} />
                  </IconButton>
                </li>
              );
            })}
          </ul>
        )}
      </Card>

      <ConfirmDialog
        open={toDelete !== null}
        title="Delete tag"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete the tag <strong>{toDelete?.name}</strong>?{' '}
            {deleteCount > 0
              ? `This removes it from ${deleteCount} transaction${
                  deleteCount === 1 ? '' : 's'
                } — the transactions themselves are kept.`
              : 'It is not used by any transactions.'}
          </>
        }
        onConfirm={() => toDelete && void remove(toDelete)}
        onCancel={() => setToDelete(null)}
      />
    </SettingsPage>
  );
}
