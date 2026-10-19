"""Check release-document links, contact/license consistency and PNG dimensions."""
import json
from pathlib import Path
import re
import struct
import subprocess
from urllib.parse import unquote, urlsplit

ROOT = Path(__file__).resolve().parents[1]
errors = []
tracked = set(subprocess.check_output(['git', 'ls-files', '-z'], cwd=ROOT).decode('utf-8').split('\0'))
files = list(ROOT.glob('*.md')) + list((ROOT / 'docs').rglob('*.md'))
files += list((ROOT / 'extension').glob('README*.md'))
files += [ROOT / 'extension/options/ai-services/README.md', ROOT / 'extension/import/dependencies.md']
for path in files:
    content = path.read_text(encoding='utf-8')
    content = re.sub(r'```.*?```', '', content, flags=re.S)
    links = re.findall(r'\]\(([^)]+)\)', content)
    links += re.findall(r'(?:href|src)=["\']([^"\']+)["\']', content)
    for link in links:
        link = link.strip().split(' "')[0].strip('<>')
        parsed = urlsplit(link)
        if parsed.scheme or parsed.netloc or not parsed.path:
            continue
        target = (path.parent / unquote(parsed.path)).resolve()
        if not target.exists():
            errors.append(f'{path.relative_to(ROOT)}: missing local target {link}')
        elif not target.is_relative_to(ROOT):
            errors.append(f'{path.relative_to(ROOT)}: link leaves the repository: {link}')
        else:
            relative = target.relative_to(ROOT).as_posix()
            public = relative in tracked or (target.is_dir() and any(name.startswith(relative + '/') for name in tracked))
            if not public or any(part in {'.local', '.trellis', '.agents', '.codex'} for part in target.relative_to(ROOT).parts):
                errors.append(f'{path.relative_to(ROOT)}: target is not public: {link}')

manifest = json.loads((ROOT / 'extension/public/manifest.json').read_text(encoding='utf-8'))
package = json.loads((ROOT / 'extension/package.json').read_text(encoding='utf-8'))
author = re.fullmatch(r'([^<>]+) <([^<>]+)>', package.get('author', ''))
if not author:
    raise SystemExit('package author must identify the public maintainer and contact email')
maintainer_name, contact_email = author.groups()
if package.get('license') != 'PolyForm-Noncommercial-1.0.0':
    errors.append('package license is not PolyForm-Noncommercial-1.0.0')
if (ROOT / 'LICENSE').read_bytes() != (ROOT / 'extension/public/LICENSE.txt').read_bytes():
    errors.append('Project and shipped licenses differ')
for name in ['docs/privacy.md', 'docs/privacy.en.md', 'docs/privacy.html', 'SECURITY.md']:
    text = (ROOT / name).read_text(encoding='utf-8')
    if maintainer_name not in text or contact_email not in text:
        errors.append(f'{name}: publisher/contact missing')


def check_png(path, width, height):
    if not path.exists():
        errors.append(f'Missing image: {path.relative_to(ROOT)}')
        return
    data = path.read_bytes()
    if data[:8] != b'\x89PNG\r\n\x1a\n' or struct.unpack('>II', data[16:24]) != (width, height):
        errors.append(f'Unexpected image dimensions: {path.relative_to(ROOT)}')


for size in [16, 32, 48, 128]:
    value = manifest.get('icons', {}).get(str(size))
    if not value:
        errors.append(f'Manifest icon {size} missing')
    else:
        check_png(ROOT / 'extension/public' / value, size, size)
for name in ['01-bookmarks', '02-search', '03-organize', '04-export', '05-privacy']:
    check_png(ROOT / f'docs/media/screenshots/{name}.png', 1280, 800)
if not (ROOT / 'docs/media/zhilan-quick-tour.mp4').exists():
    errors.append('Demo MP4 missing')
if errors:
    raise SystemExit('\n'.join(errors))
print(f'PASS: {len(files)} document links, licenses, contact fields and media dimensions')
