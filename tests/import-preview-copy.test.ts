// PreviewStep's plain-English warning copy (C1). The wizard components need a
// DOM the suite does not have, so the pure helper is tested directly.
import 'fake-indexeddb/auto';
import { describe, expect, it } from 'vitest';
import { unpairedTransferNote } from '../src/ui/import/PreviewStep';

describe('unpaired transfer warning (C1)', () => {
  it('says nothing when every leg found its partner', () => {
    expect(unpairedTransferNote(0)).toBe(null);
  });

  it('names the count and what it means for the reports', () => {
    const one = unpairedTransferNote(1) ?? '';
    expect(one).toMatch(/^1 transfer leg/);
    expect(one).toContain('ordinary uncategorised transaction');
    expect(one).toContain('income and spending');
    const many = unpairedTransferNote(4) ?? '';
    expect(many).toMatch(/^4 transfer legs/);
    expect(many).toContain('income and spending');
  });
});
