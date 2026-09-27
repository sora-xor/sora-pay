import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, statfsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createStorageAdmissionGuard, OrderStore, storageAdmissionAvailable, storageMinimumBytes, validateConfig } from '../../dist/relay/index.js';
import type { MerchantConfig, StorageSpace } from '../../dist/relay/index.js';

const floor = 5n * 1024n ** 3n;
const resumeFloor = 10n * 1024n ** 3n;

test('omitted storage guard never probes or changes reusable merchant metadata', () => {
  const forbidden = () => { throw new Error('must not be called'); };
  const guard = createStorageAdmissionGuard({ databasePath: 'unused', persistence: { paused: forbidden }, probe: forbidden });
  assert.equal(guard.allowed(), true);
  assert.throws(() => guard.reset(), /not configured/);
});

test('new configured admission requires the 10 GiB reserve and only explicit reset releases a pause', () => {
  let saved: boolean | undefined;
  let free = resumeFloor - 1n;
  const persistence = { paused(value?: boolean) { if (value !== undefined) saved = value; return saved; } };
  const guard = createStorageAdmissionGuard({ databasePath: 'synthetic', minimumFreeBytes: floor.toString(), persistence, probe: () => ({ bavail: free, bsize: 1n }) });
  assert.equal(saved, true);
  assert.equal(guard.allowed(), false);
  assert.throws(() => guard.reset(), /sufficient available space/);
  free = resumeFloor;
  assert.equal(guard.allowed(), false);
  guard.reset();
  assert.equal(saved, false);
  assert.equal(guard.allowed(), true);
  free = floor - 1n;
  assert.equal(guard.allowed(), false);
  assert.equal(saved, true);
  free = resumeFloor + 1n;
  assert.equal(guard.allowed(), false);
});

test('storage pause survives closing and reopening the actual SQLite database without changing cursor', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sora-pay-pause-'));
  const path = join(directory, 'synthetic.sqlite');
  const config = { enabled: false } as MerchantConfig;
  let store = new OrderStore(path, config, Buffer.alloc(32, 3));
  let free = resumeFloor;
  const makeGuard = () => createStorageAdmissionGuard({ databasePath: path, minimumFreeBytes: floor.toString(), persistence: { paused: (value) => store.storageAdmissionPaused(value) }, probe: () => ({ bavail: free, bsize: 1n }) });
  try {
    store.cursor(100);
    const first = makeGuard();
    assert.equal(first.allowed(), true);
    free = floor - 1n;
    assert.equal(first.allowed(), false);
    store.close();
    store = new OrderStore(path, config, Buffer.alloc(32, 3));
    free = resumeFloor;
    const restarted = makeGuard();
    assert.equal(restarted.allowed(), false);
    assert.equal(store.cursor(), 100);
    restarted.reset();
    assert.equal(restarted.allowed(), true);
    assert.equal(store.cursor(), 100);
  } finally { store.close(); rmSync(directory, { recursive: true }); }
});

test('stat errors latch closed and failed persistence cannot release the in-memory pause', () => {
  let saved: boolean | undefined;
  let statFails = false; let writeFails = false; let reports = 0;
  const guard = createStorageAdmissionGuard({ databasePath: 'synthetic', minimumFreeBytes: floor.toString(), persistence: { paused(value?: boolean) { if (value !== undefined) { if (writeFails) throw new Error('private database'); saved = value; } return saved; } }, probe: () => { if (statFails) throw new Error('private volume'); return { bavail: resumeFloor, bsize: 1n }; }, onPersistenceError: () => { reports++; } });
  assert.equal(guard.allowed(), true);
  statFails = true; writeFails = true;
  assert.equal(guard.allowed(), false);
  statFails = false;
  assert.equal(guard.allowed(), false);
  assert.throws(() => guard.reset(), /could not be persisted/);
  assert.equal(guard.allowed(), false);
  assert.equal(reports, 1);
  writeFails = false;
  assert.equal(guard.allowed(), false);
  assert.equal(saved, true);
  guard.reset();
  assert.equal(guard.allowed(), true);
});

test('corrupt saved pause metadata fails closed without changing order data', () => {
  const store = new OrderStore(':memory:', { enabled: false } as MerchantConfig, Buffer.alloc(32, 3));
  try {
    store.db.prepare("INSERT INTO meta VALUES('storage-admission',?)").run('{"version":1,"paused":"false"}');
    assert.throws(() => store.storageAdmissionPaused(), /Invalid saved/);
    let reports = 0;
    const guard = createStorageAdmissionGuard({ databasePath: 'synthetic', minimumFreeBytes: floor.toString(), persistence: { paused: (value) => store.storageAdmissionPaused(value) }, probe: () => ({ bavail: resumeFloor, bsize: 1n }), onPersistenceError: () => { reports++; } });
    assert.equal(guard.allowed(), false);
    assert.equal(store.storageAdmissionPaused(), true);
    assert.equal(reports, 1);
    assert.equal(store.list().length, 0);
  } finally { store.close(); }
});

test('restart at 6 GiB latches closed even when a previous pause write failed over saved open state', () => {
  let saved: boolean | undefined;
  let free = resumeFloor;
  let writeFails = false;
  const persistence = { paused(value?: boolean) { if (value !== undefined) { if (writeFails) throw new Error('synthetic write failure'); saved = value; } return saved; } };
  const start = () => createStorageAdmissionGuard({ databasePath: 'synthetic', minimumFreeBytes: floor.toString(), persistence, probe: () => ({ bavail: free, bsize: 1n }) });
  const original = start();
  assert.equal(original.allowed(), true);
  assert.equal(saved, false);
  free = floor - 1n; writeFails = true;
  assert.equal(original.allowed(), false);
  assert.equal(saved, false);
  free = 6n * 1024n ** 3n;
  const restarted = start();
  assert.equal(restarted.allowed(), false);
  assert.equal(saved, false);
  writeFails = false;
  assert.equal(restarted.allowed(), false);
  assert.equal(saved, true);
  free = resumeFloor;
  assert.equal(start().allowed(), false);
  restarted.reset();
  assert.equal(restarted.allowed(), true);
  assert.equal(saved, false);
  assert.equal(start().allowed(), true);
});

test('storage admission uses exact available bytes and the actual database path at the threshold', () => {
  const seen: string[] = [];
  let available = floor - 1n;
  const probe = (path: string) => { seen.push(path); return { bavail: available, bsize: 1n }; };
  assert.equal(storageAdmissionAvailable('/private/orders.sqlite', floor, probe), false);
  available = floor;
  assert.equal(storageAdmissionAvailable('/private/orders.sqlite', floor, probe), true);
  available = floor + 1n;
  assert.equal(storageAdmissionAvailable('/private/orders.sqlite', floor, probe), true);
  assert.deepEqual(seen, Array(3).fill('/private/orders.sqlite'));
  assert.equal(storageAdmissionAvailable('synthetic', 9_007_199_254_740_993n, () => ({ bavail: 9_007_199_254_740_992n, bsize: 1n })), false);
  assert.equal(storageAdmissionAvailable('synthetic', floor, () => ({ bavail: floor / 4096n, bsize: 4096n })), true);
});

test('failed or malformed statfs results fail closed without disclosing filesystem errors', () => {
  assert.equal(storageAdmissionAvailable('synthetic', floor, () => { throw new Error('private filesystem detail'); }), false);
  for (const space of [{ bavail: -1n, bsize: 4096n }, { bavail: 100n, bsize: 0n }, { bavail: 100n, bsize: -1n }, { bavail: 10_000_000, bsize: 4096 }]) {
    assert.equal(storageAdmissionAvailable('synthetic', floor, () => space as StorageSpace), false);
  }
});

test('optional merchant storage floor preserves omission and rejects lossy or ambiguous configuration', () => {
  assert.equal(storageMinimumBytes(), undefined);
  assert.equal(storageMinimumBytes('5368709120'), floor);
  assert.equal(validateConfig({ enabled: false } as MerchantConfig).storageMinimumFreeBytes, undefined);
  for (const value of ['0', '-1', '5.0', '5e9', ' 5368709120', '05368709120', '18446744073709551616', 5368709120, null]) {
    assert.throws(() => validateConfig({ enabled: false, storageMinimumFreeBytes: value } as MerchantConfig), /storage admission/);
  }
});

test('native statfs accepts an existing database file and detects an unavailable path', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sora-pay-storage-'));
  try {
    const database = join(directory, 'synthetic.sqlite');
    writeFileSync(database, 'synthetic', { mode: 0o600 });
    const native = statfsSync(database, { bigint: true });
    assert.equal(storageAdmissionAvailable(database, native.bavail * native.bsize + 1024n ** 4n), false);
    assert.equal(storageAdmissionAvailable(database, 1n), true);
    assert.equal(storageAdmissionAvailable(join(directory, 'missing'), 1n), false);
  } finally { rmSync(directory, { recursive: true }); }
});
