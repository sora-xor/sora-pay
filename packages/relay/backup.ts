import { backup } from 'node:sqlite';
import { mkdtemp, readFile, rm, writeFile, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { encrypt, decrypt } from './crypto.js';
import type { OrderStore } from './store.js';

/** Snapshot SQLite consistently, encrypt the complete archive, then remove the temporary snapshot. */
export async function encryptedBackup(store: OrderStore, destination: string, backupKey: Buffer): Promise<void> {
  const directory = await mkdtemp(join(tmpdir(), 'sora-pay-backup-')); await chmod(directory, 0o700);
  try { const path = join(directory, 'orders.sqlite'); await backup(store.db, path); const bytes = await readFile(path); await writeFile(destination, encrypt({ version: 1, sqlite: bytes.toString('base64') }, backupKey, 'sora-pay-backup-v1'), { mode: 0o600, flag: 'wx' }); } finally { await rm(directory, { recursive: true, force: true }); }
}

/** Restore into a new path only. Retain the original encryption key separately from backups. */
export async function restoreBackup(source: string, destination: string, backupKey: Buffer): Promise<void> {
  const archive = decrypt<{ version: number; sqlite: string }>(await readFile(source, 'utf8'), backupKey, 'sora-pay-backup-v1');
  if (archive.version !== 1 || typeof archive.sqlite !== 'string') throw new Error('Invalid backup');
  await writeFile(destination, Buffer.from(archive.sqlite, 'base64'), { mode: 0o600, flag: 'wx' });
}
