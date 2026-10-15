"""Build once, then run the three main production-extension flows sequentially with isolated synthetic data."""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import time

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default=os.environ.get('ZHILAN_BROWSER_EXECUTABLE'))
parser.add_argument('--language', choices=['zh-CN', 'en'], default='en')
args = parser.parse_args()
cases = [
    ('save', 'onboarding-trial.py', ['--keywords']),
    ('organize', 'organize-background.py', []),
    ('undo', 'suspected-duplicates.py', []),
]
if not args.run:
    print('SKIP: pass --run --browser <absolute Chromium executable>. Planned: production build, native save/keywords, background organize, duplicate deletion/undo. No browser was started.')
    raise SystemExit(0)
browser = Path(args.browser or '')
if not args.browser or not browser.is_absolute() or not browser.is_file():
    parser.error('--browser must name an existing absolute Chromium executable; no download or discovery')
node = shutil.which('node')
if not node:
    parser.error('Node.js must be installed before running acceptance')
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-acceptance-'))
report = {'status': 'RUNNING', 'evidence': str(root), 'language': args.language, 'cases': [],
          'scope': 'Isolated Chromium profiles, synthetic bookmarks and loopback providers. Native onCreated classification, explicit organize confirmation and undo. No signed-in account, live-provider quality, physical star/OS gesture, no-debugger lifetime or release-readiness claim.'}
environment = {**os.environ, 'NODE_ENV': 'production', 'PYTHONIOENCODING': 'utf-8'}
environment.pop('VITEST', None)

def save_report():
    (root / 'results.json').write_text(json.dumps(report, indent=2), encoding='utf-8')

def run(name, command):
    started = time.monotonic()
    result = subprocess.run(command, cwd=package, env=environment, capture_output=True, encoding='utf-8', errors='replace')
    (root / (name + '.log')).write_text(result.stdout + '\n' + result.stderr, encoding='utf-8')
    if result.returncode:
        raise RuntimeError(f'{name} exited {result.returncode}; see {root / (name + ".log")}')
    return result.stdout, round(time.monotonic() - started, 2)

def inventory():
    return {str(path.relative_to(package / 'dist')): hashlib.sha256(path.read_bytes()).hexdigest()
            for path in sorted((package / 'dist').rglob('*')) if path.is_file()}

try:
    print('Building production extension…', flush=True)
    run('build', [node, str(package / 'node_modules/vite/bin/vite.js'), 'build'])
    run('validate-build', [node, str(package / 'scripts/validate-build.mjs')])
    report['productionFiles'] = inventory()
    save_report()
    for name, script, extra in cases:
        print(f'Running {name}…', flush=True)
        output, elapsed = run(name, [sys.executable, str(package / 'tests/e2e' / script), '--run', '--browser', str(browser), '--language', args.language, *extra])
        summaries = []
        for line in output.splitlines():
            try:
                item = json.loads(line)
                if isinstance(item, dict) and item.get('status') == 'PASS' and item.get('evidence'):
                    summaries.append(item)
            except json.JSONDecodeError:
                pass
        if len(summaries) != 1:
            raise RuntimeError(f'{name} did not return exactly one PASS evidence record')
        if inventory() != report['productionFiles']:
            raise RuntimeError(f'{name} changed the shared production build')
        report['cases'].append({'name': name, 'seconds': elapsed, 'result': summaries[0]})
        save_report()
        print(f'{name}: PASS ({elapsed}s)', flush=True)
    report['status'] = 'PASS'
except (Exception, KeyboardInterrupt) as error:
    report['status'] = 'FAILED'
    report['error'] = str(error) or 'Interrupted'
finally:
    save_report()
print(json.dumps({'status': report['status'], 'evidence': str(root), 'passedCases': len(report['cases']), 'error': report.get('error')}), flush=True)
raise SystemExit(0 if report['status'] == 'PASS' else 1)
