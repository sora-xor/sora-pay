import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readlink, readdir, readFile } from 'node:fs/promises';
import { resolve, relative, sep, join, isAbsolute } from 'node:path';

/** Stream file hashes instead of retaining a runtime archive or dependency tree in memory. */
export async function fileSha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

/** Treat archives as data until their exact official digest has been checked. */
export async function verifyRuntimeArchive(path, expectedSha256) {
  if (!/^[a-f0-9]{64}$/.test(expectedSha256) || await fileSha256(path) !== expectedSha256) throw new Error('runtime_checksum_mismatch');
}

/** Prevent traversal and absolute links from escaping a self-contained staged directory. */
export function insidePath(root, candidate) {
  const path = relative(resolve(root), resolve(candidate));
  return path === '' || (!path.startsWith(`..${sep}`) && path !== '..' && !isAbsolute(path));
}

/** Inventory deterministic bytes and executable modes; secrets are not read into the report. */
export async function inventory(root, excluded = new Set(['staging-manifest.json'])) {
  const records = [];
  async function walk(directory) {
    for (const name of (await readdir(directory)).sort()) {
      const absolute = join(directory, name); const path = relative(root, absolute).split(sep).join('/');
      if (excluded.has(path)) continue;
      const stat = await lstat(absolute);
      if (stat.isSymbolicLink()) {
        const target = await readlink(absolute);
        if (isAbsolute(target) || !insidePath(root, resolve(directory, target))) throw new Error('staging_symlink_escape');
        records.push({ path, kind: 'symlink', target });
      } else if (stat.isDirectory()) await walk(absolute);
      else if (stat.isFile()) records.push({ path, kind: 'file', bytes: stat.size, mode: stat.mode & 0o777, sha256: await fileSha256(absolute) });
      else throw new Error('unsupported_staging_file');
    }
  }
  await walk(root); return records;
}

/** Verify every staged immutable file without opening any private runtime environment. */
export async function verifyManifest(root, expectedDigest) {
  const manifestPath = join(root, 'staging-manifest.json');
  const digest = await fileSha256(manifestPath);
  if (expectedDigest && digest !== expectedDigest) throw new Error('staging_manifest_checksum_mismatch');
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (manifest.version !== 1 || !Array.isArray(manifest.files) || !manifest.runtime || manifest.merchantEnabled !== false) throw new Error('invalid_staging_manifest');
  for (const item of manifest.files) {
    if (typeof item.path !== 'string' || item.path.startsWith('/') || !insidePath(root, join(root, item.path))) throw new Error('invalid_manifest_path');
    const path = join(root, item.path); const stat = await lstat(path);
    if (item.kind === 'symlink') {
      const target = stat.isSymbolicLink() ? await readlink(path) : null;
      if (target !== item.target || isAbsolute(target) || !insidePath(root, resolve(path, '..', target))) throw new Error('staging_manifest_symlink_mismatch');
    } else if (item.kind !== 'file' || !stat.isFile() || stat.size !== item.bytes || (stat.mode & 0o777) !== item.mode || await fileSha256(path) !== item.sha256) throw new Error('staging_manifest_file_mismatch');
  }
  return { manifest, digest };
}

/** Refuse accidental secret-bearing configuration fields in a public deployment template. */
export function assertNoSecretFields(value) {
  if (!value || typeof value !== 'object') return;
  for (const [key, child] of Object.entries(value)) {
    if (/(?:private_?key|password|secret|credential|token)/i.test(key)) throw new Error('secret_field_in_staging_template');
    assertNoSecretFields(child);
  }
}
