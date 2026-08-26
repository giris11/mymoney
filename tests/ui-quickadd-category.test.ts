// Quick add's payee auto-categorisation rule (D17 applied at quick add).
// The sheet keeps the category across "Save & add another"; these cover which
// carried-over categories a fresh payee pick is allowed to overwrite (D1).
//
// The rule is a pure function because the app has no DOM test environment —
// the component wiring around it (state + PayeeInput's onPick) is not covered.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { categoryAfterPayeePick } from '../src/ui/quickadd/QuickAddSheet';

// Only these two exist, are of the right kind, and are unarchived.
const usable = (id: string) => id === 'groceries' || id === 'fuel';

const payee = (defaultCategoryId: string | null) => ({ defaultCategoryId });

describe('categoryAfterPayeePick', () => {
  it('fills an empty category from the payee default', () => {
    expect(categoryAfterPayeePick({ id: null, auto: false }, payee('fuel'), usable)).toEqual({
      id: 'fuel',
      auto: true,
    });
  });

  it('replaces a category that was itself auto-filled by an earlier payee', () => {
    // Save Tesco → Groceries, "add another", then pick Shell: must become Fuel.
    expect(categoryAfterPayeePick({ id: 'groceries', auto: true }, payee('fuel'), usable)).toEqual({
      id: 'fuel',
      auto: true,
    });
  });

  it('never overwrites a category the user chose themselves', () => {
    expect(categoryAfterPayeePick({ id: 'groceries', auto: false }, payee('fuel'), usable)).toBe(
      null,
    );
  });

  it('clears a stale auto-fill when the new payee has no default', () => {
    expect(categoryAfterPayeePick({ id: 'groceries', auto: true }, payee(null), usable)).toEqual({
      id: null,
      auto: false,
    });
  });

  it('treats an unusable default (wrong kind or archived) as no default', () => {
    expect(categoryAfterPayeePick({ id: 'groceries', auto: true }, payee('salary'), usable)).toEqual(
      { id: null, auto: false },
    );
    expect(categoryAfterPayeePick({ id: null, auto: false }, payee('salary'), usable)).toBe(null);
  });

  it('reports no change when the payee default is already selected', () => {
    expect(categoryAfterPayeePick({ id: 'fuel', auto: true }, payee('fuel'), usable)).toBe(null);
    expect(categoryAfterPayeePick({ id: null, auto: false }, payee(null), usable)).toBe(null);
  });
});
