"""Validate the public Git index (or --ref tree), without reading private archives.

This is a publication boundary and obvious-credential check, not a complete secret audit.
"""
import argparse
from pathlib import Path, PurePosixPath
import re
import subprocess

ROOT = Path(__file__).resolve().parents[1]
PUBLIC_DIRS = {'.github', 'docs', 'extension', 'tools'}
PUBLIC_ROOT_FILES = {
    '.gitattributes', '.gitignore', 'AGENTS.md', 'AGENTS.zh-CN.md',
    'README.md', 'README.en.md', 'LICENSE', 'CONTRIBUTING.md',
    'CODE_OF_CONDUCT.md', 'SECURITY.md', 'SUPPORT.md', 'CHANGELOG.md',
}
PRIVATE_PARTS = {'.local', '.local-evaluation', '.trellis', '.agents', '.codex',
                 'node_modules', 'dist', 'coverage', '__pycache__', '.pytest_cache'}
PRIVATE_SUFFIXES = {'.docx', '.pptx', '.xlsx', '.zip', '.bundle', '.log', '.pyc', '.pem', '.key', '.p12', '.pfx'}
PRIVATE_DOC_PREFIXES = ('docs/research/', 'docs/store/', 'docs/media/store-', 'docs/PRD-', 'docs/design-brief-', 'docs/智栏文件测试/')
PRIVATE_FILES = {'extension/release-candidate.json', 'extension/audit.json'}
SECRET_PATTERNS = {
    'private key': re.compile(rb'-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----\s*[A-Za-z0-9+/=]{40,}'),
    'provider token': re.compile(rb'\b(?:sk-(?:proj-|ant-)?|ghp_|github_pat_)[A-Za-z0-9_-]{28,}\b'),
    'AWS access key': re.compile(rb'\bAKIA[0-9A-Z]{16}\b'),
}


def path_errors(name):
    path = PurePosixPath(name)
    errors = []
    if len(path.parts) == 1:
        if name not in PUBLIC_ROOT_FILES:
            errors.append('unclassified root file')
    elif path.parts[0] not in PUBLIC_DIRS:
        errors.append('non-public root directory')
    if PRIVATE_PARTS.intersection(path.parts):
        errors.append('private or generated directory')
    if path.suffix.lower() in PRIVATE_SUFFIXES:
        errors.append('private attachment, credential, log or archive')
    if path.name.startswith('.env') and path.name not in {'.env.example', '.env.sample'}:
        errors.append('local environment file')
    if name in PRIVATE_FILES or name.startswith(PRIVATE_DOC_PREFIXES):
        errors.append('internal document or generated report')
    return errors


def content_errors(data):
    # Binary files are handled by path/asset checks, not a text heuristic.
    if b'\0' in data:
        return []
    return [label for label, pattern in SECRET_PATTERNS.items() if pattern.search(data)]


def git(*args, input=None):
    return subprocess.check_output(['git', *args], cwd=ROOT, input=input)


def entries(ref=None):
    command = ['ls-tree', '-rz', '--full-tree', ref] if ref else ['ls-files', '--stage', '-z']
    result = []
    for record in git(*command).split(b'\0'):
        if not record:
            continue
        meta, path = record.split(b'\t', 1)
        mode, second, third = meta.decode().split()
        if ref:
            if second != 'blob':
                raise ValueError('Submodules are not part of the public source layout')
            oid = third
        else:
            if third != '0':
                raise ValueError('Resolve index conflicts before publication')
            oid = second
        if mode not in {'100644', '100755'}:
            raise ValueError('Only regular files are allowed: ' + path.decode('utf-8'))
        result.append((path.decode('utf-8'), oid))
    return result


def check(ref=None):
    tracked = entries(ref)
    if not tracked:
        raise ValueError('No tracked public files')
    oids = list(dict.fromkeys(oid for _, oid in tracked))
    response = git('cat-file', '--batch', input=('\n'.join(oids) + '\n').encode())
    blobs = {}
    offset = 0
    for oid in oids:
        end = response.index(b'\n', offset)
        header = response[offset:end].split()
        if len(header) != 3 or header[1] != b'blob':
            raise ValueError('Cannot read staged file blob')
        size = int(header[2])
        blobs[oid] = response[end + 1:end + 1 + size]
        offset = end + 2 + size
    errors = []
    for name, oid in tracked:
        errors += [f'{name}: {message}' for message in path_errors(name)]
        errors += [f'{name}: possible {message}; inspect locally' for message in content_errors(blobs[oid])]
    return len(tracked), errors


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--ref', help='Check a committed Git tree instead of the index')
    args = parser.parse_args()
    count, errors = check(args.ref)
    if errors:
        raise SystemExit('\n'.join(errors))
    print(f'PASS: {count} public files; path policy and obvious credential scan ({args.ref or "index"})')


if __name__ == '__main__':
    main()
