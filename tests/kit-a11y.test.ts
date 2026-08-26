// UI-kit behaviour that is expressible without a DOM: dialog stacking,
// radiogroup key navigation, and the money field's text→minor rule.
import { describe, it, expect, beforeEach } from 'vitest';
import {
  pushModalToken,
  removeModalToken,
  isTopModalToken,
  radioGroupNextIndex,
  moneyTextToMinor,
} from '../src/ui/kit/kit';
import { formatMinorPlain } from '../src/money/money';

describe('modal stacking (Escape reaches only the topmost dialog)', () => {
  const editor = { name: 'editor' };
  const confirm = { name: 'confirm' };
  beforeEach(() => {
    removeModalToken(editor);
    removeModalToken(confirm);
  });

  it('a lone dialog is the top one', () => {
    pushModalToken(editor);
    expect(isTopModalToken(editor)).toBe(true);
    removeModalToken(editor);
    expect(isTopModalToken(editor)).toBe(false);
  });

  it('a confirmation opened over an editor takes the Escape by itself', () => {
    pushModalToken(editor);
    pushModalToken(confirm);
    // this is the bug: Escape used to close BOTH, binning the editor's edits
    expect(isTopModalToken(confirm)).toBe(true);
    expect(isTopModalToken(editor)).toBe(false);
    // backing out of the confirmation hands the dialog back to the editor
    removeModalToken(confirm);
    expect(isTopModalToken(editor)).toBe(true);
  });

  it('registering the same dialog twice leaves no stale entry behind', () => {
    pushModalToken(editor);
    pushModalToken(confirm);
    pushModalToken(editor);
    expect(isTopModalToken(editor)).toBe(true);
    removeModalToken(editor);
    expect(isTopModalToken(confirm)).toBe(true);
    expect(isTopModalToken(editor)).toBe(false);
  });
});

describe('radioGroupNextIndex (Segmented arrow keys)', () => {
  it('arrows move forwards and backwards, wrapping at both ends', () => {
    expect(radioGroupNextIndex('ArrowRight', 0, 3)).toBe(1);
    expect(radioGroupNextIndex('ArrowDown', 0, 3)).toBe(1);
    expect(radioGroupNextIndex('ArrowRight', 2, 3)).toBe(0);
    expect(radioGroupNextIndex('ArrowLeft', 0, 3)).toBe(2);
    expect(radioGroupNextIndex('ArrowUp', 2, 3)).toBe(1);
  });
  it('Home/End jump to the ends', () => {
    expect(radioGroupNextIndex('Home', 2, 3)).toBe(0);
    expect(radioGroupNextIndex('End', 0, 3)).toBe(2);
  });
  it('leaves other keys (and empty groups) alone', () => {
    expect(radioGroupNextIndex('Enter', 0, 3)).toBeNull();
    expect(radioGroupNextIndex('Tab', 0, 3)).toBeNull();
    expect(radioGroupNextIndex(' ', 0, 3)).toBeNull();
    expect(radioGroupNextIndex('ArrowRight', 0, 0)).toBeNull();
  });
  it('starts at an end when nothing is selected yet', () => {
    expect(radioGroupNextIndex('ArrowRight', -1, 3)).toBe(0);
    expect(radioGroupNextIndex('ArrowLeft', -1, 3)).toBe(2);
  });
});

describe('moneyTextToMinor (what MoneyInput reports)', () => {
  it('reads the visible text in the field’s current currency', () => {
    expect(moneyTextToMinor('5.00', 'GBP')).toBe(500);
    expect(moneyTextToMinor('500', 'JPY')).toBe(500);
    expect(moneyTextToMinor('1,234.56', 'GBP')).toBe(123456);
  });
  it('reports nothing for empty or unparseable input', () => {
    expect(moneyTextToMinor('', 'GBP')).toBeNull();
    expect(moneyTextToMinor('   ', 'GBP')).toBeNull();
    expect(moneyTextToMinor('abc', 'GBP')).toBeNull();
  });
  it('does not carry a GBP amount over to JPY at 100× (SPEC §6)', () => {
    // "5.00" against a GBP account is 500 minor; switching the account to JPY
    // must NOT keep 500 (which JPY renders as ¥500) — the digits on screen are
    // not a valid JPY amount, so the field reports nothing until retyped.
    const typed = '5.00';
    expect(moneyTextToMinor(typed, 'GBP')).toBe(500);
    expect(formatMinorPlain(500, 'JPY')).toBe('500'); // 100× what the user sees
    expect(moneyTextToMinor(typed, 'JPY')).toBeNull();
  });
});
