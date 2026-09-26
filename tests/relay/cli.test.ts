import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { encrypt } from '../../dist/relay/crypto.js';

const cli = fileURLToPath(new URL('../../dist/relay/cli.js', import.meta.url));

/** Run the actual restore command with synthetic data and reject every serving-stack import. */
test('restore CLI skips the serving stack while preserving restore validation and safe failures', () => {
  const directory = mkdtempSync(join(tmpdir(), 'sora-pay-cli-test-'));
  try {
    const source = join(directory, 'source.sqlite');
    const db = new DatabaseSync(source);
    db.exec("CREATE TABLE fixture(value TEXT); INSERT INTO fixture VALUES('synthetic restore record')");
    db.close();
    const bytes = readFileSync(source);
    const archive = join(directory, 'backup.enc');
    writeFileSync(archive, encrypt({ version: 1, sqlite: bytes.toString('base64') }, Buffer.alloc(32, 7), 'sora-pay-backup-v1'), { mode: 0o600 });
    const forbidden = join(directory, 'forbidden-import');
    const guard = join(directory, 'guard.mjs');
    writeFileSync(guard, `
import { registerHooks } from 'node:module';
import { writeFileSync } from 'node:fs';
registerHooks({ resolve(specifier, context, nextResolve) {
  const resolved = nextResolve(specifier, context);
  if (['chain.js', 'server.js', 'notifications.js', 'catalog-refresh.js', 'lifecycle.js', 'store.js', 'config.js'].includes(new URL(resolved.url).pathname.split('/').pop())
    || resolved.url.includes('/node_modules/@polkadot/') || resolved.url.includes('/node_modules/nodemailer/')) {
    writeFileSync(${JSON.stringify(forbidden)}, 'blocked', { mode: 0o600 });
    throw new Error('serving_import_forbidden');
  }
  return resolved;
}});
`, { mode: 0o600 });
    const run = (destination: string, key = '07'.repeat(32)) => spawnSync(process.execPath, ['--import', guard, cli, 'restore'], {
      env: { SORA_PAY_BACKUP_PATH: archive, SORA_PAY_DB: destination, SORA_PAY_BACKUP_KEY: key },
      timeout: 10_000, encoding: 'utf8',
    });
    const restored = join(directory, 'restored.sqlite');
    const success = run(restored);
    assert.equal(success.error, undefined); assert.equal(success.status, 0, success.stderr);
    assert.equal(success.stdout, ''); assert.deepEqual(readFileSync(restored), bytes);
    assert.equal(statSync(restored).mode & 0o777, 0o600);
    const restoredDb = new DatabaseSync(restored, { readOnly: true });
    try { assert.equal(restoredDb.prepare('SELECT value FROM fixture').get()?.value, 'synthetic restore record'); }
    finally { restoredDb.close(); }

    for (const [destination, key] of [[restored, '07'.repeat(32)], [join(directory, 'wrong-key.sqlite'), '08'.repeat(32)], [join(directory, 'invalid-key.sqlite'), 'invalid-key']] as const) {
      const failure = run(destination, key);
      assert.equal(failure.error, undefined); assert.equal(failure.status, 1);
      assert.equal(failure.stdout, '');
      assert.match(failure.stderr, /Sora Pay relay failed to start\. Check private configuration and service health\./);
      assert.doesNotMatch(failure.stderr, /synthetic restore record|invalid-key|serving_import_forbidden/);
      if (destination === restored) assert.deepEqual(readFileSync(restored), bytes);
      else assert.equal(existsSync(destination), false);
    }
    assert.equal(existsSync(forbidden), false, 'restore resolved a serving dependency');
    const control = spawnSync(process.execPath, ['--import', guard, '--input-type=module', '--eval', `await import(${JSON.stringify(new URL('../../dist/relay/chain.js', import.meta.url).href)})`], { env: {}, timeout: 10_000, encoding: 'utf8' });
    assert.equal(control.status, 1); assert.equal(readFileSync(forbidden, 'utf8'), 'blocked', 'the dependency guard must reject actual serving imports');
  } finally { rmSync(directory, { recursive: true, force: true }); }
});
