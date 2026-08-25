// Category tree editor (SPEC §8.1.3): expense/income toggle, indented tree,
// add child, edit (name/colour/archive), delete honouring {ok, reason}.
import { useMemo, useState } from 'react';
import { db } from '../../db/db';
import { useLive } from '../../db/useLive';
import {
  buildTree,
  deleteCategory,
  saveCategory,
  type CategoryNode,
} from '../../domain/categories';
import type { Category, CategoryKind } from '../../db/types';
import {
  Button,
  Card,
  Checkbox,
  Chip,
  ConfirmDialog,
  EmptyState,
  Field,
  IconButton,
  Input,
  Modal,
  Segmented,
} from '../kit/kit';
import { IconList, IconPencil, IconPlus, IconTrash } from '../kit/icons';
import { useToast } from '../kit/toast';
import { ColourSwatches, ENTITY_COLOURS, errorMessage, SettingsPage } from './shared';

interface FlatRow {
  cat: CategoryNode;
  depth: number;
}

interface ModalState {
  category: Category | null; // null = create
  parentId: string | null;
  parentName: string | null;
  parentColour: string | null;
}

export default function CategoriesSection() {
  const { toast } = useToast();
  const [kind, setKind] = useState<CategoryKind>('expense');
  const cats = useLive(() => db.categories.toArray(), []);
  const [modal, setModal] = useState<ModalState | null>(null);
  const [toDelete, setToDelete] = useState<Category | null>(null);

  const flat = useMemo(() => {
    const tree = buildTree((cats ?? []).filter((c) => c.kind === kind));
    const out: FlatRow[] = [];
    const walk = (nodes: CategoryNode[], depth: number) => {
      for (const n of nodes) {
        out.push({ cat: n, depth });
        walk(n.children, depth + 1);
      }
    };
    walk(tree, 0);
    return out;
  }, [cats, kind]);

  const remove = async (cat: Category) => {
    setToDelete(null);
    const result = await deleteCategory(cat.id);
    if (result.ok) toast('Category deleted', 'success');
    else toast(`Can’t delete “${cat.name}”: ${result.reason}. Archive it instead.`, 'error');
  };

  return (
    <SettingsPage
      title="Categories"
      description="Categories can nest to any depth. Archiving hides a category (and its subcategories) from pickers without touching history."
      actions={
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            setModal({ category: null, parentId: null, parentName: null, parentColour: null })
          }
        >
          <IconPlus size={16} /> Add category
        </Button>
      }
    >
      <Segmented
        label="Category kind"
        value={kind}
        onChange={setKind}
        options={[
          { value: 'expense', label: 'Expense' },
          { value: 'income', label: 'Income' },
        ]}
      />
      <Card className="p-0">
        {cats && flat.length === 0 ? (
          <EmptyState
            icon={<IconList size={32} />}
            title={`No ${kind} categories`}
            message="Add a category to start organising transactions."
          />
        ) : (
          <ul>
            {flat.map(({ cat, depth }) => (
              <li
                key={cat.id}
                className="flex items-center gap-2 border-b border-border py-1.5 pr-2 last:border-0"
                style={{ paddingLeft: `${16 + depth * 22}px` }}
              >
                <span
                  aria-hidden="true"
                  className="h-2.5 w-2.5 shrink-0 rounded-full"
                  style={{ backgroundColor: cat.colour ?? 'var(--c-border)' }}
                />
                <span className="min-w-0 flex-1 truncate text-sm text-text">{cat.name}</span>
                {cat.archived && <Chip>Archived</Chip>}
                <span className="flex shrink-0 items-center">
                  <IconButton
                    label={`Add subcategory to ${cat.name}`}
                    className="p-1.5"
                    onClick={() =>
                      setModal({
                        category: null,
                        parentId: cat.id,
                        parentName: cat.name,
                        parentColour: cat.colour ?? null,
                      })
                    }
                  >
                    <IconPlus size={15} />
                  </IconButton>
                  <IconButton
                    label={`Edit ${cat.name}`}
                    className="p-1.5"
                    onClick={() =>
                      setModal({
                        category: cat,
                        parentId: cat.parentId,
                        parentName: null,
                        parentColour: null,
                      })
                    }
                  >
                    <IconPencil size={15} />
                  </IconButton>
                  <IconButton
                    label={`Delete ${cat.name}`}
                    className="p-1.5"
                    onClick={() => setToDelete(cat)}
                  >
                    <IconTrash size={15} />
                  </IconButton>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {modal && <CategoryModal modal={modal} kind={kind} onClose={() => setModal(null)} />}
      <ConfirmDialog
        open={toDelete !== null}
        title="Delete category"
        danger
        confirmLabel="Delete"
        message={
          <>
            Delete <strong>{toDelete?.name}</strong>? Only categories with no subcategories,
            transactions or budgets can be deleted — otherwise archive it.
          </>
        }
        onConfirm={() => toDelete && void remove(toDelete)}
        onCancel={() => setToDelete(null)}
      />
    </SettingsPage>
  );
}

function CategoryModal({
  modal,
  kind,
  onClose,
}: {
  modal: ModalState;
  kind: CategoryKind;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const cat = modal.category;
  const [name, setName] = useState(cat?.name ?? '');
  const [colour, setColour] = useState(cat?.colour ?? modal.parentColour ?? ENTITY_COLOURS[0]);
  const [archived, setArchived] = useState(cat?.archived ?? false);

  const save = async () => {
    try {
      await saveCategory({
        id: cat?.id,
        name,
        parentId: cat ? cat.parentId : modal.parentId,
        kind,
        colour,
        archived,
      });
      toast(cat ? 'Category saved' : 'Category added', 'success');
      onClose();
    } catch (e) {
      toast(errorMessage(e), 'error');
    }
  };

  return (
    <Modal
      open
      onClose={onClose}
      title={
        cat
          ? 'Edit category'
          : modal.parentName
            ? `Add subcategory to ${modal.parentName}`
            : `New ${kind} category`
      }
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <Field label="Name">
          {(id) => (
            <Input
              id={id}
              value={name}
              autoComplete="off"
              onChange={(e) => setName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void save();
              }}
            />
          )}
        </Field>
        <div className="flex flex-col gap-1">
          <span className="text-sm font-medium text-text">Colour</span>
          <ColourSwatches value={colour} onChange={setColour} label="Category colour" />
        </div>
        <div className="flex flex-col gap-1">
          <Checkbox label="Archived" checked={archived} onChange={setArchived} />
          <p className="text-xs text-muted">
            Archived categories (and their subcategories) are hidden from pickers; existing
            transactions keep them.
          </p>
        </div>
      </div>
    </Modal>
  );
}
