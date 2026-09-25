import { chmod, cp, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { assertNoSecretFields, fileSha256, insidePath, inventory, verifyRuntimeArchive } from './staging-utils.mjs';

const sourceDefault = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** Build an inactive, self-contained directory from a fresh build and an authenticated Node archive. */
export async function stageRelay({ sourceRoot = sourceDefault, output, runtimeArchive, installationRoot }) {
  sourceRoot = resolve(sourceRoot);
  if (!output || !runtimeArchive || !installationRoot || !isAbsolute(output) || !isAbsolute(installationRoot) || /[\r\n'"<>]/.test(installationRoot)) throw new Error('explicit_absolute_staging_paths_required');
  output = resolve(output);
  if (existsSync(output)) throw new Error('staging_output_exists');
  for (const tree of ['dist', 'node_modules', 'deploy', 'docs']) if (insidePath(join(sourceRoot, tree), output)) throw new Error('staging_output_inside_source_tree');
  const runtime = JSON.parse(await readFile(join(sourceRoot, 'deploy/runtime.json'), 'utf8'));
  await verifyRuntimeArchive(runtimeArchive, runtime.sha256);
  const packageJson = JSON.parse(await readFile(join(sourceRoot, 'package.json'), 'utf8'));
  if (packageJson.name !== '@sora/sora-pay' || !existsSync(join(sourceRoot, 'dist/relay/cli.js')) || !existsSync(join(sourceRoot, 'node_modules/@polkadot/api/package.json'))) throw new Error('fresh_build_and_installed_dependencies_required');
  const merchant = JSON.parse(await readFile(join(sourceRoot, 'deploy/merchant.polkaswap.json.example'), 'utf8'));
  assertNoSecretFields(merchant); merchant.enabled = false;
  await mkdir(dirname(output), { recursive: true, mode: 0o700 });
  const temporary = await mkdtemp(join(dirname(output), '.sora-pay-stage-'));
  try {
    for (const path of ['dist', 'node_modules', 'deploy', 'package.json', 'yarn.lock', 'LICENSE']) {
      await cp(join(sourceRoot, path), join(temporary, path), { recursive: true, verbatimSymlinks: true, filter: (path) => !path.includes('/node_modules/.cache/') });
    }
    await mkdir(join(temporary, 'docs'));
    for (const path of ['relay.md', 'providers.md', 'staging.md']) await cp(join(sourceRoot, 'docs', path), join(temporary, 'docs', path));
    await mkdir(join(temporary, 'private'), { mode: 0o700 });
    await writeFile(join(temporary, 'private/merchant.json'), JSON.stringify(merchant, null, 2) + '\n', { mode: 0o600 });
    const environment = (await readFile(join(sourceRoot, 'deploy/relay.env.example'), 'utf8')).replaceAll('/Users/administrator/apps/sora-pay', installationRoot);
    await writeFile(join(temporary, 'private/relay.env.example'), environment, { mode: 0o600 });
    const plist = (await readFile(join(sourceRoot, 'deploy/org.sora.sora-pay-relay.plist.example'), 'utf8')).replaceAll('/Users/administrator/apps/sora-pay', installationRoot);
    await writeFile(join(temporary, 'deploy/org.sora.sora-pay-relay.plist.example'), plist, { mode: 0o600 });
    await mkdir(join(temporary, 'runtime'));
    execFileSync('tar', ['-xJf', resolve(runtimeArchive), '-C', join(temporary, 'runtime')], { stdio: 'pipe' });
    if (!existsSync(join(temporary, 'runtime', runtime.directory, 'bin/node'))) throw new Error('runtime_archive_layout_mismatch');
    await chmod(join(temporary, 'deploy/run-relay.sh'), 0o755);
    const manifest = { version: 1, app: { name: packageJson.name, version: packageJson.version }, runtime, installationRoot, merchantEnabled: false, files: await inventory(temporary) };
    await writeFile(join(temporary, 'staging-manifest.json'), JSON.stringify(manifest, null, 2) + '\n', { mode: 0o600 });
    if (existsSync(output)) throw new Error('staging_output_exists');
    await rename(temporary, output);
    return { output, manifestSha256: await fileSha256(join(output, 'staging-manifest.json')), files: manifest.files.length, bytes: manifest.files.reduce((sum, file) => sum + (file.bytes ?? 0), 0), enabled: false, runtimeVersion: runtime.version };
  } catch (error) { await rm(temporary, { recursive: true, force: true }); throw error; }
}

/** Parse only documented staging flags; positional values cannot become shell commands. */
export function stagingOptions(args) {
  const values = {};
  const names = new Map([['--output', 'output'], ['--runtime-archive', 'runtimeArchive'], ['--installation-root', 'installationRoot']]);
  for (let index = 0; index < args.length; index += 2) {
    const name = names.get(args[index]); const value = args[index + 1];
    if (!name || !value || values[name]) throw new Error('usage_stage_relay_output_runtime_archive_installation_root');
    values[name] = value;
  }
  return values;
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  stageRelay(stagingOptions(process.argv.slice(2))).then((report) => console.log(JSON.stringify(report, null, 2))).catch((error) => { console.error(error instanceof Error ? error.message : 'staging_failed'); process.exitCode = 1; });
}
