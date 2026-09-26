import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';

const checker = new URL('../../deploy/check-package.py', import.meta.url).pathname;

/** Exercise actual tar members with Python's standard library; fixtures contain no real credentials. */
function checkFixture(scenario: string): void {
  const program = `
import importlib.util, io, json, pathlib, sys, tarfile, tempfile
spec = importlib.util.spec_from_file_location('check_package', sys.argv[1])
module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(module)
entries = {name: b'public fixture' for name in module.REQUIRED | module.DEPLOY}
entries['package.json'] = json.dumps({'name': '@sora/sora-pay', 'version': '0.1.0', 'license': 'Apache-2.0'}).encode()
entries['LICENSE'] = b'Apache License\\nVersion 2.0'
def verify(values):
    with tempfile.TemporaryDirectory(prefix='sora-pay-package-test-') as directory:
        target = pathlib.Path(directory) / 'package.tgz'
        with tarfile.open(target, 'w:gz') as archive:
            for name, content in values.items():
                item = tarfile.TarInfo('package/' + name)
                item.size = len(content)
                archive.addfile(item, io.BytesIO(content))
        return module.check_package(target)
def reject(values):
    try:
        verify(values)
    except ValueError:
        return
    raise AssertionError('unsafe package was accepted')
${scenario}
`;
  assert.doesNotThrow(() => execFileSync('python3', ['-B', '-c', program, checker], { stdio: 'pipe' }));
}

test('public package check accepts required modules, snapshots, examples and root Apache license', () => {
  checkFixture("assert verify(entries)['valid'] is True");
});

test('public package check rejects nested staging readmes/licenses, private files and internal reports', () => {
  checkFixture("for unsafe in ['output/staging/runtime/LICENSE', 'output/staging/README.md', 'private/relay.env', 'deploy/relay.env', 'docs/mof-readiness-2026-09-25.md', 'packages/relay/private/record.ts']:\n    reject({**entries, unsafe: b'fixture'})");
});

test('public package check rejects missing snapshots/examples, storage runbook or a missing/incorrect root license', () => {
  checkFixture("for missing in ['packages/providers/data/japan-post-ems.json', 'packages/providers/data/mufg-usdjpy.json', 'examples/basic/index.html', 'examples/polkaswap/README.md', 'docs/mof-capacity-policy.md', 'LICENSE']:\n    reject({key: value for key, value in entries.items() if key != missing})\nreject({**entries, 'LICENSE': b'Incorrect license'})");
});
