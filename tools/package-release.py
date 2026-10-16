"""Build and package only production extension assets; no publishing or credentials."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import subprocess
import zipfile

ROOT = Path(__file__).resolve().parents[1]
PACKAGE = ROOT / 'extension'


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--candidate', action='store_true', help='Source-checked candidate; not release approval')
    args = parser.parse_args()
    node = shutil.which('node')
    if not node:
        raise SystemExit('Node.js >=22.12 is required')
    # Always rebuild production: integration tests may have left test-mode assets in dist.
    for command in [
        [node, 'node_modules/vite/bin/vite.js', 'build'],
        [node, 'scripts/validate-build.mjs'],
        [node, 'checks/release.mjs', 'source' if args.candidate else 'ready'],
    ]:
        subprocess.run(command, cwd=PACKAGE, check=True)
    dist = PACKAGE / 'dist'
    manifest = json.loads((dist / 'manifest.json').read_text(encoding='utf-8'))
    inventory = json.loads((PACKAGE / 'release-candidate.json').read_text(encoding='utf-8'))
    if (dist / 'LICENSE.txt').read_bytes() != (ROOT / 'LICENSE').read_bytes():
        raise SystemExit('Project license differs from packaged license')
    files = sorted(path for path in dist.rglob('*') if path.is_file())
    expected = {entry['path']: entry['sha256'] for entry in inventory['artifacts']}
    if {path.relative_to(dist).as_posix() for path in files} != set(expected):
        raise SystemExit('Distribution changed after inventory')
    for path in files:
        name = path.relative_to(dist).as_posix()
        if path.is_symlink() or any(parent.is_symlink() for parent in path.parents if parent != dist.parent):
            raise SystemExit('Symlinks are not allowed')
        if path.suffix not in {'.js', '.css', '.html', '.json', '.txt', '.png'}:
            raise SystemExit(f'Unexpected production asset type: {name}')
        if hashlib.sha256(path.read_bytes()).hexdigest() != expected[name]:
            raise SystemExit(f'Artifact changed after validation: {name}')
    output = ROOT / 'release'
    output.mkdir(exist_ok=True)
    suffix = '-candidate' if args.candidate else ''
    archive = output / f'zhilan-{manifest["version"]}{suffix}.zip'
    # Fixed ZIP metadata makes identical input bytes produce identical archives.
    with zipfile.ZipFile(archive, 'w', compression=zipfile.ZIP_DEFLATED, compresslevel=9) as target:
        for path in files:
            entry = zipfile.ZipInfo(path.relative_to(dist).as_posix(), date_time=(2026, 1, 1, 0, 0, 0))
            entry.compress_type = zipfile.ZIP_DEFLATED
            entry.external_attr = 0o100644 << 16
            target.writestr(entry, path.read_bytes())
    with zipfile.ZipFile(archive) as target:
        if target.testzip() is not None or 'manifest.json' not in target.namelist():
            raise SystemExit('ZIP verification failed')
    digest = hashlib.sha256(archive.read_bytes()).hexdigest()
    archive.with_suffix('.zip.sha256').write_text(f'{digest}  {archive.name}\n', encoding='utf-8')
    print(f'{archive.relative_to(ROOT)}: {len(files)} files, SHA256 {digest}')
    print('Candidate only; manual release gates remain open.' if args.candidate else 'Ready gate passed; no upload performed.')


if __name__ == '__main__':
    try:
        main()
    except subprocess.CalledProcessError as error:
        raise SystemExit(f'Packaging stopped: validation exited {error.returncode}; no new ZIP was created.') from None
