#!/usr/bin/env python3
"""Check a public package without extracting files or reading private runtime records."""
import json
from pathlib import Path, PurePosixPath
import sys
import tarfile

ROOT_FILES = {'LICENSE', 'README.md', 'package.json'}
DOCS = {'docs/relay.md', 'docs/providers.md', 'docs/staging.md'}
DEPLOY = {f'deploy/{name}' for name in (
    'archive-stage.py', 'check-package.py', 'check-readiness.mjs',
    'merchant.disabled.json.example', 'merchant.polkaswap.json.example',
    'nginx.conf.example', 'org.sora.sora-pay-relay.plist.example',
    'relay.env.example', 'run-relay.sh', 'runtime.json', 'rehearsal-proxy.mjs',
    'stage-relay.mjs', 'staging-utils.mjs',
)}
SNAPSHOTS = {'packages/providers/data/japan-post-ems.json', 'packages/providers/data/mufg-usdjpy.json'}
EXAMPLES = {'examples/basic/index.html', 'examples/polkaswap/README.md'}
REQUIRED = ROOT_FILES | DOCS | SNAPSHOTS | EXAMPLES | {
    f'dist/{package}/index{extension}'
    for package in ('core', 'widget', 'relay', 'providers')
    for extension in ('.js', '.d.ts')
}


def public_path(path: str) -> bool:
    """Only root-scoped release trees and named public deployment files are publishable."""
    parts = PurePosixPath(path).parts
    if any(part.startswith('.') or part in {'private', 'output', 'node_modules', 'runtime'} for part in parts):
        return False
    if path in ROOT_FILES | DOCS | DEPLOY | SNAPSHOTS | EXAMPLES:
        return True
    if parts and parts[0] == 'dist' and len(parts) >= 3:
        return parts[1] in {'core', 'widget', 'relay', 'providers'} and path.endswith(('.js', '.js.map', '.d.ts', '.d.ts.map'))
    if parts and parts[0] == 'packages' and len(parts) >= 3:
        return parts[1] in {'core', 'widget', 'relay', 'providers'} and path.endswith('.ts')
    return False


def check_package(path: Path) -> dict:
    """Reject unexpected files before reading the public manifest and root license."""
    with tarfile.open(path, 'r:gz') as archive:
        members = {}
        for entry in archive.getmembers():
            if not entry.isfile() or not entry.name.startswith('package/'):
                raise ValueError('invalid_package_entry')
            relative = entry.name[len('package/'):]
            if str(PurePosixPath(relative)) != relative or relative in members or not public_path(relative):
                raise ValueError('unexpected_package_path')
            if entry.size > 64 * 1024 * 1024:
                raise ValueError('oversized_package_entry')
            members[relative] = entry
        if not REQUIRED.issubset(members):
            raise ValueError('required_package_files_missing')
        manifest = json.load(archive.extractfile(members['package.json']))
        if manifest.get('name') != '@sora/sora-pay' or manifest.get('license') != 'Apache-2.0':
            raise ValueError('package_identity_mismatch')
        license_text = archive.extractfile(members['LICENSE']).read().decode('utf8')
        if 'Apache License' not in license_text or 'Version 2.0' not in license_text:
            raise ValueError('root_apache_license_missing')
        return {'valid': True, 'version': manifest.get('version'), 'files': len(members)}


if __name__ == '__main__':
    try:
        if len(sys.argv) != 2:
            raise ValueError('usage_check_package_archive')
        print(json.dumps(check_package(Path(sys.argv[1]))))
    except Exception:
        # File paths or arbitrary archive values could contain private data.
        print('Package verification failed; inspect the public file allowlist.', file=sys.stderr)
        sys.exit(1)
