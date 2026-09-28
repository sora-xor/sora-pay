import { statfsSync } from 'node:fs';

/** Parse exact configured bytes; omission preserves existing reusable merchant behavior. */
export function storageMinimumBytes(value?: string): bigint | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== 'string' || !/^[1-9]\d{0,19}$/.test(value) || BigInt(value) > 18_446_744_073_709_551_615n) throw new Error('Invalid storage admission minimum');
  return BigInt(value);
}

/** Validate merchant-selected thresholds; startup/reset uses the ordinary floor unless explicitly higher. */
export function storageAdmissionThresholds(minimumFreeBytes?: string, resumeFreeBytes?: string): { minimum: bigint; resume: bigint } | undefined {
  const minimum = storageMinimumBytes(minimumFreeBytes);
  const resume = storageMinimumBytes(resumeFreeBytes);
  if (resume !== undefined && (minimum === undefined || resume < minimum)) throw new Error('Invalid storage admission resume threshold');
  return minimum === undefined ? undefined : { minimum, resume: resume ?? minimum };
}

/** Only blocks available to the relay user count, measured on the actual database volume. */
export interface StorageSpace { bavail: bigint; bsize: bigint }

/** Fresh local statfs checks never use floating-point bytes or cache a previously healthy volume. */
export function storageAdmissionAvailable(databasePath: string, minimumBytes: bigint, probe: (path: string) => StorageSpace = (path) => statfsSync(path, { bigint: true })): boolean {
  try {
    const space = probe(databasePath);
    return typeof space.bavail === 'bigint' && typeof space.bsize === 'bigint' && space.bavail >= 0n && space.bsize > 0n && space.bavail * space.bsize >= minimumBytes;
  } catch { return false; }
}

/** Existing SQLite metadata stores the pause; no new database schema or customer data is needed. */
export interface StorageAdmissionPersistence { paused(value?: boolean): boolean | undefined }

/** A persisted pause survives restarts; only a reviewed operator reset can clear it. */
export function createStorageAdmissionGuard(options: {
  databasePath: string;
  minimumFreeBytes?: string;
  resumeFreeBytes?: string;
  persistence: StorageAdmissionPersistence;
  probe?: (path: string) => StorageSpace;
  onPersistenceError?: () => void;
}): { allowed(): boolean; reset(): void } {
  const thresholds = storageAdmissionThresholds(options.minimumFreeBytes, options.resumeFreeBytes);
  if (thresholds === undefined) return { allowed: () => true, reset: () => { throw new Error('Storage admission guard is not configured'); } };
  const { minimum, resume: resumeMinimum } = thresholds;
  const available = (floor: bigint): boolean => storageAdmissionAvailable(options.databasePath, floor, options.probe);
  let paused = true;
  let pauseNeedsPersistence = false;
  let reportedPersistenceError = false;
  const report = (): void => { if (!reportedPersistenceError) { reportedPersistenceError = true; options.onPersistenceError?.(); } };
  const savePause = (): void => {
    paused = true; pauseNeedsPersistence = true;
    try { options.persistence.paused(true); pauseNeedsPersistence = false; } catch { report(); }
  };
  try {
    const saved = options.persistence.paused();
    if (saved === true) paused = true;
    else if (available(resumeMinimum)) {
      // Restart is admission reopening, even if a previous pause could not be persisted.
      if (saved === undefined) options.persistence.paused(false);
      paused = false;
    } else savePause();
  } catch { report(); savePause(); }
  return {
    allowed() {
      if (pauseNeedsPersistence) savePause();
      if (paused) return false;
      if (!available(minimum)) { savePause(); return false; }
      return true;
    },
    reset() {
      if (!available(resumeMinimum)) throw new Error('Storage admission reset requires sufficient available space');
      // A failed reset cannot release the in-memory pause or any customer signing lease.
      paused = true;
      try { options.persistence.paused(false); }
      catch { pauseNeedsPersistence = true; report(); throw new Error('Storage admission reset could not be persisted'); }
      paused = false; pauseNeedsPersistence = false; reportedPersistenceError = false;
    },
  };
}
