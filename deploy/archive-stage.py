#!/usr/bin/env python3
"""Create a deterministic inactive staging archive; refuse unmanifested private runtime files."""
import gzip
import hashlib
import json
import os
from pathlib import Path
import sys
import tarfile


def archive_stage(root: Path, output: Path) -> None:
    """Archive only manifest-listed files, with stable ownership and timestamps."""
    root = root.resolve()
    manifest = json.loads((root / 'staging-manifest.json').read_text())
    if manifest.get('version') != 1 or manifest.get('merchantEnabled') is not False:
        raise ValueError('invalid_disabled_manifest')
    expected = {entry['path'] for entry in manifest['files']} | {'staging-manifest.json'}
    actual = set()
    directories = {'.'}
    for directory, subdirs, files in os.walk(root, followlinks=False):
        for name in list(subdirs):
            path = Path(directory) / name
            if path.is_symlink():
                actual.add(path.relative_to(root).as_posix())
                subdirs.remove(name)
            else:
                directories.add(path.relative_to(root).as_posix())
        for name in files:
            actual.add((Path(directory) / name).relative_to(root).as_posix())
    if actual != expected or (root / 'private/relay.env').exists():
        raise ValueError('staging_contains_unmanifested_or_private_files')
    for item in manifest['files']:
        path = root / item['path']
        if item['kind'] == 'symlink':
            if not path.is_symlink() or os.readlink(path) != item['target']:
                raise ValueError('staging_symlink_mismatch')
        else:
            metadata = path.stat()
            if path.is_symlink() or metadata.st_size != item['bytes'] or metadata.st_mode & 0o777 != item['mode']:
                raise ValueError('staging_file_metadata_mismatch')
            with path.open('rb') as content:
                hasher = hashlib.sha256()
                for chunk in iter(lambda: content.read(1024 * 1024), b''):
                    hasher.update(chunk)
                digest = hasher.hexdigest()
            if digest != item['sha256']:
                raise ValueError('staging_file_checksum_mismatch')
    if json.loads((root / 'private/merchant.json').read_text()).get('enabled') is not False:

        raise ValueError('merchant_must_remain_disabled')
    with output.open('xb') as target:
        with gzip.GzipFile(filename='', mode='wb', fileobj=target, mtime=0, compresslevel=6) as compressed:
            with tarfile.open(fileobj=compressed, mode='w', format=tarfile.PAX_FORMAT) as archive:
                for relative in sorted(directories | actual):
                    source = root if relative == '.' else root / relative
                    name = 'sora-pay' if relative == '.' else 'sora-pay/' + relative
                    entry = archive.gettarinfo(str(source), arcname=name)
                    entry.uid = entry.gid = 0
                    entry.uname = entry.gname = ''
                    entry.mtime = 0
                    entry.pax_headers = {}
                    if entry.isfile():
                        with source.open('rb') as content:
                            archive.addfile(entry, content)
                    else:
                        archive.addfile(entry)


if __name__ == '__main__':
    try:
        if len(sys.argv) != 3:
            raise ValueError('usage_archive_stage_root_output')
        archive_stage(Path(sys.argv[1]), Path(sys.argv[2]))
    except Exception as error:
        print(type(error).__name__ + ': staging_archive_failed', file=sys.stderr)
        sys.exit(1)
