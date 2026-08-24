// Import planning, commit and undo (SPEC §7.4). CONTRACT — implemented by the
// import build agent.
//
//  * buildImportPlan WRITES NOTHING — it resolves rows against the current db
//    (existing accounts/categories/payees/tags, duplicates, suggestions) and
//    returns the full plan for the mandatory preview screen.
//  * commitImport applies a plan in ONE Dexie rw-transaction: creates the
//    ImportBatch row first (with created-entity ids, D18), then entities, then
//    transactions (importBatchId set, dedupeHash computed, transfer pairs
//    linked via a shared transferGroupId).
//  * undoImport deletes the batch's transactions AND any created entities that
//    are no longer referenced by anything else (D18).
import type { ImportBatch } from '../db/types';
import type { ImportPlan, ParsedRow } from './types';

export interface BuildPlanOptions {
  source: 'moneywiz' | 'csv';
  fileName: string;
  /** Generic imports may pin every row to one chosen account. */
  fixedAccountId?: string;
  /** Currency for rows without one (usually the base currency). */
  defaultCurrency: string;
}

export async function buildImportPlan(
  rows: ParsedRow[],
  opts: BuildPlanOptions,
): Promise<ImportPlan> {
  void rows;
  void opts;
  throw new Error('not implemented');
}

export async function commitImport(plan: ImportPlan): Promise<ImportBatch> {
  void plan;
  throw new Error('not implemented');
}

export async function undoImport(batchId: string): Promise<void> {
  void batchId;
  throw new Error('not implemented');
}

export async function listImportBatches(): Promise<ImportBatch[]> {
  throw new Error('not implemented');
}
