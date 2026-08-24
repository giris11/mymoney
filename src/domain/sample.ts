// Demo/sample data (SPEC §4: clearly labelled, one-tap removal). CONTRACT —
// implemented by the import build agent (it reuses the import-batch machinery:
// sample data is one batch with source 'sample', so removal IS undoImport, D19).
//
// The generated set: 2 account groups, 4 accounts (incl. one EUR account for
// multi-currency), ~6 months of realistic transactions incl. transfers, a
// split, a refund and a pending one, 2 budgets, and a EUR→GBP manual rate.
export async function loadSampleData(): Promise<void> {
  throw new Error('not implemented');
}

export async function removeSampleData(): Promise<void> {
  throw new Error('not implemented');
}

/** The sample batch id when sample data is currently loaded, else null. */
export async function sampleDataBatchId(): Promise<string | null> {
  return null; // stub — shell renders pre-integration
}
