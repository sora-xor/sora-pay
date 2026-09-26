import { existsSync, statSync, statfsSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { arch, cpus, freemem, loadavg, platform, totalmem } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseEnv } from 'node:util';
import { verifyManifest } from './staging-utils.mjs';

/** Report staging integrity and prerequisites without creating databases, networking, or starting services. */
export async function checkReadiness(root, expectedManifestDigest) {
  root = resolve(root);
  const { manifest, digest } = await verifyManifest(root, expectedManifestDigest);
  const runtimePath = join(root, 'runtime', manifest.runtime.directory, 'bin/node');
  const runtimeHostMatches = platform() === manifest.runtime.platform && arch() === manifest.runtime.arch;
  let runtimeVersion = null; let runtimeImportsPass = false;
  if (runtimeHostMatches) {
    runtimeVersion = execFileSync(runtimePath, ['--version'], { encoding: 'utf8', timeout: 10_000 }).trim();
    const probe = "import {DatabaseSync} from 'node:sqlite'; import {ApiPromise} from '@polkadot/api'; import nodemailer from 'nodemailer'; const db=new DatabaseSync(':memory:'); db.close(); if(typeof ApiPromise.create!=='function'||typeof nodemailer.createTransport!=='function') process.exit(2);";
    execFileSync(runtimePath, ['--input-type=module', '-e', probe], { cwd: root, stdio: 'pipe', timeout: 20_000 }); runtimeImportsPass = true;
  }
  const privatePath = join(root, 'private'); const merchantPath = join(privatePath, 'merchant.json'); const envPath = join(privatePath, 'relay.env');
  const merchant = JSON.parse(readFileSync(merchantPath, 'utf8'));
  const environment = existsSync(envPath) ? parseEnv(readFileSync(envPath, 'utf8')) : {};
  const credentials = {
    databaseEncryptionKey: /^[a-fA-F0-9]{64}$/.test(environment.SORA_PAY_ENCRYPTION_KEY ?? ''),
    operatorToken: (environment.SORA_PAY_OPERATOR_TOKEN?.length ?? 0) >= 32 && !environment.SORA_PAY_OPERATOR_TOKEN.startsWith('REPLACE_'),
    notification: environment.SORA_PAY_NOTIFY === 'telegram' ? Boolean(environment.SORA_PAY_TELEGRAM_TOKEN && environment.SORA_PAY_TELEGRAM_CHAT_ID) : environment.SORA_PAY_NOTIFY === 'email' ? ['SORA_PAY_SMTP_HOST', 'SORA_PAY_SMTP_USER', 'SORA_PAY_SMTP_PASSWORD', 'SORA_PAY_EMAIL_FROM', 'SORA_PAY_EMAIL_TO'].every((key) => Boolean(environment[key])) : false,
    archiveEndpointConfigured: Boolean(merchant.chain?.archiveRpcUrl),
  };
  const permissionsPrivate = (statSync(privatePath).mode & 0o077) === 0 && (statSync(merchantPath).mode & 0o077) === 0 && (!existsSync(envPath) || (statSync(envPath).mode & 0o077) === 0);
  const fs = statfsSync(root, { bigint: true });
  return {
    root, manifestSha256: digest, integrityVerified: true,
    stagingReady: runtimeHostMatches && runtimeVersion === `v${manifest.runtime.version}` && runtimeImportsPass && permissionsPrivate && merchant.enabled === false,
    merchantEnabled: merchant.enabled === true, liveReadinessVerified: false,
    runtime: { path: runtimePath, expected: `v${manifest.runtime.version}`, actual: runtimeVersion, hostMatches: runtimeHostMatches, importsPass: runtimeImportsPass },
    privatePermissions: permissionsPrivate, environmentPresent: existsSync(envPath), credentials,
    capacity: { freeDiskBytes: (fs.bavail * fs.bsize).toString(), totalDiskBytes: (fs.blocks * fs.bsize).toString(), memoryBytes: totalmem(), freeMemoryBytes: freemem(), cpuCount: cpus().length, loadAverage: loadavg() },
    launchChecksOutstanding: ['Approved archival RPC and outage recovery rehearsal', 'Private transport credentials and delivery rehearsal', 'Operator service identity, HTTPS routing and service installation', 'Capacity review for continuously running services', 'Explicit merchant activation after internal payment/refund rehearsal'],
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const root = process.argv[2] ?? resolve(dirname(fileURLToPath(import.meta.url)), '..');
  checkReadiness(root, process.argv[3]).then((report) => { console.log(JSON.stringify(report, null, 2)); if (!report.stagingReady) process.exitCode = 1; }).catch(() => { console.error('Staging readiness check failed; inspect runtime, permissions and manifest integrity.'); process.exitCode = 1; });
}
