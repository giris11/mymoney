// Backup & restore (SPEC §8.1.9). CONTRACT — implemented by the backup build
// agent.
//
// Semantics:
//  * exportBackup snapshots EVERY table (src/db/db.ts ALL_TABLES) plus
//    schemaVersion + exportedAt;
//  * validateBackup fully validates shape/version BEFORE any write;
//  * restoreBackup is all-or-nothing: one Dexie rw-transaction that clears and
//    repopulates every table — a malformed file must change nothing (D21);
//  * restoring a backup with schemaVersion older than current applies the
//    necessary upgrades; newer than current → refuse with a clear error;
//  * downloadBackup triggers a JSON file download and stamps
//    settings.lastBackupAt;
//  * nudge: due when transactions exist and lastBackupAt is null or >7 days
//    ago (SPEC §8.1.9).
import { SCHEMA_VERSION } from '../db/db';

export interface BackupFile {
  app: 'MyMoney';
  schemaVersion: number;
  exportedAt: string;
  tables: Record<string, unknown[]>;
}

export async function exportBackup(): Promise<BackupFile> {
  throw new Error('not implemented');
}

export function serializeBackup(file: BackupFile): string {
  void file;
  throw new Error('not implemented');
}

export type BackupValidation = { ok: true; file: BackupFile } | { ok: false; error: string };

export function validateBackup(parsed: unknown): BackupValidation {
  void parsed;
  throw new Error('not implemented');
}

export async function restoreBackup(file: BackupFile): Promise<void> {
  void file;
  throw new Error('not implemented');
}

/** Browser-only: create the file and hand it to the user; updates lastBackupAt. */
export async function downloadBackup(): Promise<void> {
  throw new Error('not implemented');
}

export interface BackupNudge {
  due: boolean;
  lastBackupAt: string | null;
  txCount: number;
}

export async function backupNudgeState(): Promise<BackupNudge> {
  return { due: false, lastBackupAt: null, txCount: 0 }; // stub — shell renders pre-integration
}

export const CURRENT_SCHEMA_VERSION = SCHEMA_VERSION;
