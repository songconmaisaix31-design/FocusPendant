#!/usr/bin/env python3
"""Reproduce the supplied LLVISION v1.0.0 Ubuntu 24.04 source patch in place."""
import argparse
import hashlib
import os
from pathlib import Path
import tempfile

ORIGINAL_ARCHIVE_SHA256 = '2e13599014a7509f550aa33f4a9b6a9ddc87ce65070b397576b88cc47c4f3011'
HOST = 'sdk/fusionui-app-sdk/developer_kit_host.py'
INSTALLER = 'sdk/fusionui-app-sdk/developer-kit-tools/install-host-dependencies.sh'
FINGERPRINTS = {
    HOST: ('cc41316ddc8e01f24111ea56fce8602a59f2f85dfc9943737152ab46682a1c3f',
           'e2cc9cef8488b1c4e264702b4653ae527a93869e3be00452bd25df179b07e5f9'),
    INSTALLER: ('ed3ec1261f1bba5b732b4b93ce9a6a718c2f745f3f5748d6de87abfc6d5f73b0',
                '6bca0073335b028810448c76affb5c6e8d423e37ca8477647d7cc075df6d870a'),
}
NOTE = '''# Ubuntu 24.04 compatibility patch

Applied for FocusPendant on 2026-11-07. This is a local source patch to the supplied LLVISION Developer Kit v1.0.0, not a vendor release or vendor certification.

Changes:

- `sdk/fusionui-app-sdk/developer_kit_host.py`: add Ubuntu 24.04 to the supported host list.
- `sdk/fusionui-app-sdk/developer-kit-tools/install-host-dependencies.sh`: use Ubuntu 24.04's t64 package names and accept the 24.04 distro version.
- Root `SHA256SUMS`: update the changed files and include this patch note.

The runtime binaries, package format, host architecture checks, graphics/display checks, dependency checks and actual OS identity remain unchanged. Use the original `bin/irisview` entry point. No external compatibility wrapper is required.

Application builds still require the Kit-declared Node.js 24.13.0 toolchain. The distro patch does not relax that build requirement.
'''


def digest(data):
    return hashlib.sha256(data).hexdigest()


def replace_once(text, before, after):
    if text.count(before) != 1:
        raise ValueError('Unexpected source structure; no files changed')
    return text.replace(before, after, 1)


def atomic_write(file, data):
    mode = file.stat().st_mode & 0o777 if file.exists() else 0o644
    with tempfile.NamedTemporaryFile(dir=file.parent, delete=False) as tmp:
        temporary = Path(tmp.name)
        tmp.write(data)
    try:
        os.chmod(temporary, mode)
        os.replace(temporary, file)
    finally:
        temporary.unlink(missing_ok=True)


def patch(root):
    root = root.expanduser().resolve(strict=True)
    if not (root / 'DEVELOPER_KIT_INFO.json').is_file():
        raise ValueError('Not an IrisView Developer Kit directory')
    planned = {}
    for name, (before_hash, after_hash) in FINGERPRINTS.items():
        data = (root / name).read_bytes()
        actual = digest(data)
        if actual == after_hash:
            planned[name] = data
            continue
        if actual != before_hash:
            raise ValueError(f'Unknown or locally modified source: {name}; no files changed')
        text = data.decode('utf-8')
        if name == HOST:
            text = replace_once(text, 'SUPPORTED_UBUNTU_VERSIONS = ("22.04", "26.04")',
                                'SUPPORTED_UBUNTU_VERSIONS = ("22.04", "24.04", "26.04")')
        else:
            text = replace_once(text, '  ubuntu:26.04)', '  ubuntu:24.04|ubuntu:26.04)')
            text = replace_once(text, 'supports Ubuntu 22.04 and 26.04;',
                                'supports Ubuntu 22.04, 24.04 and 26.04;')
            text = replace_once(text, 'require_command xvfb-run xvfb\n',
                                'require_command xvfb-run xvfb\nrequire_command xauth xauth\nrequire_command xkbcomp x11-xkb-utils\n')
        result = text.encode('utf-8')
        if digest(result) != after_hash:
            raise ValueError(f'Unexpected patch result: {name}; no files changed')
        planned[name] = result
    note_path = root / 'PATCH-UBUNTU24.md'
    if note_path.exists() and note_path.read_bytes() != NOTE.encode():
        raise ValueError('Existing PATCH-UBUNTU24.md differs; no files changed')
    planned['PATCH-UBUNTU24.md'] = NOTE.encode()
    entries = {}
    for line in (root / 'SHA256SUMS').read_text().splitlines():
        checksum, filename = line.split(maxsplit=1)
        filename = filename.removeprefix('*')
        if filename in entries:
            raise ValueError('Duplicate checksum entry; no files changed')
        entries[filename] = checksum
    for name in FINGERPRINTS:
        if entries.get(name) not in FINGERPRINTS[name]:
            raise ValueError(f'Unexpected original checksum: {name}; no files changed')
    for name, data in planned.items():
        entries[name] = digest(data)
    planned['SHA256SUMS'] = ''.join(f'{value}  {name}\n' for name, value in sorted(entries.items())).encode()
    changed = []
    for name, data in planned.items():
        target = root / name
        if not target.exists() or target.read_bytes() != data:
            atomic_write(target, data)
            changed.append(name)
    print('Ubuntu 24.04 patch applied: ' + ', '.join(changed) if changed else 'Ubuntu 24.04 patch already applied; no changes')
    print(f'Verify: cd "{root}" && sha256sum -c SHA256SUMS')


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('kit_directory', type=Path)
    args = parser.parse_args()
    try:
        patch(args.kit_directory)
    except (OSError, ValueError) as exc:
        parser.exit(1, f'ERROR: {exc}\n')
