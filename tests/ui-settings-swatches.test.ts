// Settings colour swatches (D2): the radio-group keyboard contract and the
// accessible names the swatches announce. The DOM wiring (roving tabindex,
// focus move) is not covered — the app has no DOM test environment.
import { describe, expect, it } from 'vitest';
import { ENTITY_COLOURS, colourName, nextRadioIndex } from '../src/ui/settings/shared';

describe('nextRadioIndex', () => {
  const n = 11;

  it('moves forward on Right/Down and backward on Left/Up', () => {
    expect(nextRadioIndex('ArrowRight', 3, n)).toBe(4);
    expect(nextRadioIndex('ArrowDown', 3, n)).toBe(4);
    expect(nextRadioIndex('ArrowLeft', 3, n)).toBe(2);
    expect(nextRadioIndex('ArrowUp', 3, n)).toBe(2);
  });

  it('wraps at both ends', () => {
    expect(nextRadioIndex('ArrowRight', n - 1, n)).toBe(0);
    expect(nextRadioIndex('ArrowLeft', 0, n)).toBe(n - 1);
  });

  it('jumps to the ends on Home/End', () => {
    expect(nextRadioIndex('Home', 5, n)).toBe(0);
    expect(nextRadioIndex('End', 5, n)).toBe(n - 1);
  });

  it('ignores keys it does not own, and an empty group', () => {
    expect(nextRadioIndex('Enter', 5, n)).toBe(null);
    expect(nextRadioIndex(' ', 5, n)).toBe(null);
    expect(nextRadioIndex('Tab', 5, n)).toBe(null);
    expect(nextRadioIndex('a', 5, n)).toBe(null);
    expect(nextRadioIndex('ArrowRight', 0, 0)).toBe(null);
  });
});

describe('colourName', () => {
  it('names every palette colour rather than reading out the hex', () => {
    for (const c of ENTITY_COLOURS) {
      expect(colourName(c)).not.toContain('#');
      expect(colourName(c).length).toBeGreaterThan(2);
    }
    expect(colourName('#2563eb')).toBe('Blue');
    expect(colourName('#6B7280')).toBe('Grey'); // case-insensitive
  });

  it('falls back to the hex for a colour outside the palette', () => {
    expect(colourName('#123456')).toBe('Custom colour #123456');
  });
});
