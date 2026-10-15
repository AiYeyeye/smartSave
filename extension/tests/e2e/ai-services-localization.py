"""Opt-in English AI-service acceptance with a loopback provider and disposable profile.

Only the copied manifest grants loopback access. All production scripts are unchanged.
"""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--advanced', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated English AI-service acceptance')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-ai-locale-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
events = []
model = '已连接'


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        events.append({'method': 'GET', 'path': self.path})
        data = json.dumps({'data': [{'id': model}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_POST(self):
        events.append({'method': 'POST', 'path': self.path})
        self.send_error(500, 'Unexpected generation during configuration')


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
for file in (package / 'dist').rglob('*'):
    if file.is_file() and file.name != 'manifest.json':
        assert file.read_bytes() == (extension / file.relative_to(package / 'dist')).read_bytes()

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#ai-services')
        page.get_by_role('button', name='Add service', exact=True).first.click()
        page.get_by_placeholder('Filter services').fill('Custom endpoint')
        page.locator('.ai-svc-vendor-card').filter(has_text='Custom endpoint').click()
        page.get_by_label('Display name', exact=True).fill('已连接')
        page.get_by_label('Endpoint URL', exact=True).fill(origin + '/v1')
        geometry = []

        def capture(surface):
            expect(page.locator('.ai-svc-toast')).to_have_count(0)
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= measured['width'] + 1, (surface, measured)
                dialogs = page.get_by_role('dialog').evaluate_all('''elements => elements.map(element => {
                  const box = element.getBoundingClientRect();
                  const style = getComputedStyle(element);
                  return {left:box.left,right:box.right,width:box.width,minWidth:style.minWidth,
                    scroll:element.scrollWidth,client:element.clientWidth};
                })''')
                assert all(dialog['left'] >= 0 and dialog['right'] <= width + 1 and
                           dialog['scroll'] <= dialog['client'] + 1 for dialog in dialogs), (surface, dialogs)
                bodies = page.locator('.ai-svc-dialog-body,.ai-svc-edit-body').evaluate_all(
                    'elements=>elements.map(e=>({scroll:e.scrollWidth,client:e.clientWidth}))')
                assert all(body['scroll'] <= body['client'] + 1 for body in bodies), (surface, bodies)
                if surface == 'advanced-models':
                    assert page.locator('.ai-svc-wizard-models .ai-svc-mid').first.bounding_box()['width'] > 50
                geometry.append({'surface': surface, **measured})
                page.screenshot(path=str(root / f'{surface}-{width}.png'), full_page=True)

        capture('connect')
        page.get_by_role('button', name='Connect', exact=True).click()
        expect(page.get_by_label('Model to use', exact=True)).to_have_value(model)
        expect(page.get_by_role('heading', name='Set up 已连接', exact=True)).to_be_visible()
        capture('quick-setup')
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_label('使用哪个模型', exact=True)).to_have_value(model)
        preferences.get_by_label('语言', exact=True).select_option('en')
        if args.advanced:
            page.locator('summary', has_text='Advanced: models and feature assignments').click()
            page.get_by_role('button', name='Open advanced setup', exact=True).click()
            capture('advanced-models')
            page.get_by_role('button', name='Next', exact=True).click()
            expect(page.get_by_label('Model for Smart save', exact=True)).to_have_value(model)
            capture('advanced-assignments')
            page.get_by_role('button', name='Done', exact=True).click()
        else:
            page.get_by_role('button', name='Save and continue', exact=True).click()
        expect(page.get_by_role('heading', name='Try it in the webpage sidebar', exact=True)).to_be_visible()
        capture('trial-instructions')
        page.get_by_role('button', name='Done, try later', exact=True).click()
        page.get_by_role('button', name='Connected', exact=True).click()
        page.get_by_role('button', name='Edit', exact=True).click()
        expect(page.get_by_label('Name', exact=True)).to_have_value('已连接')
        page.get_by_label('Maximum output tokens', exact=True).fill('64000')
        page.get_by_label('Request timeout (ms)', exact=True).fill('45000')
        capture('edit')
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_label('最大输出 tokens', exact=True)).to_have_value('64000')
        expect(page.get_by_label('请求超时（毫秒）', exact=True)).to_have_value('45000')
        expect(page.get_by_label('名称', exact=True)).to_have_value('已连接')
        preferences.get_by_label('语言', exact=True).select_option('en')
        page.get_by_role('button', name='Save service', exact=True).click()
        page.get_by_role('button', name='Feature models', exact=True).click()
        page.locator('.ai-svc-picker-trigger').first.click()
        expect(page.get_by_role('option', name='已连接 Discovered', exact=True)).to_be_visible()
        capture('feature-picker')
        page.get_by_role('option', name='已连接 Discovered', exact=True).click()
        page.get_by_role('button', name='Import / export', exact=True).click()
        expect(page.get_by_role('button', name='Export JSON', exact=True)).to_be_visible()
        capture('service-export')
        with page.expect_download() as pending:
            page.get_by_role('button', name='Export JSON', exact=True).click()
        exported = json.loads(Path(pending.value.path()).read_text(encoding='utf-8'))
        assert exported['services'][0]['name'] == '已连接'
        services = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert all(feature['modelId'] == model for feature in services['features'])
        assert services['services'][0]['name'] == '已连接'
        assert services['services'][0]['maxOutputTokens'] == 64000
        assert services['services'][0]['timeoutMs'] == 45000
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        assert events == [{'method': 'GET', 'path': '/v1/models'}], events
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry, 'advanced': args.advanced,
                  'nativeBookmarksUnchanged': True, 'requests': events, 'rawNamesAndModelIdsPreserved': True,
                  'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Unmodified production scripts; copied manifest grants loopback. English connect, quick setup, trial instructions, edit, feature picker and service export; cross-document draft retention. No live provider or native writes.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, current in enumerate(context.pages):
            try:
                print(current.locator('body').inner_text()[:4000], flush=True)
                current.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
            except Exception:
                pass
        raise
    finally:
        context.close()
        server.shutdown()
