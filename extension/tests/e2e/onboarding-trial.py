"""Opt-in production UI onboarding and read-only trial in a disposable Chromium profile.

Only the copied manifest's loopback grant and a toolbar-listener capture prelude differ.
No real keys, provider calls or user bookmarks. Not a release or idle-lifetime test.
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
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
parser.add_argument('--motion', choices=['reduce', 'no-preference'], default='reduce')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for the isolated fixture')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-onboarding-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
events, fixture = [], {}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, value, content_type='application/json'):
        data = value if isinstance(value, bytes) else json.dumps(value).encode()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        if self.path.endswith('/models'):
            self.reply({'data': [{'id': 'synthetic-existing-model'}]})
        else:
            self.reply(b'<title>Trial synthetic webpage</title><p>Body must never be sent.</p>', 'text/html')

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append({'model': raw['model'], 'payload': payload})
        output = {'assignments': [{'itemId': payload['items'][0]['id'], 'folderId': fixture['folder']}], 'newFolders': []}
        self.reply({'choices': [{'message': {'content': json.dumps(output)}}]})


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
worker_file = extension / 'service-worker.js'
production_worker = worker_file.read_bytes()
prelude = b'const originalToolbarListener = chrome.action.onClicked.addListener.bind(chrome.action.onClicked); chrome.action.onClicked.addListener = fn => { globalThis.fixtureToolbar = fn; originalToolbarListener(fn); };\n'
worker_file.write_bytes(prelude + production_worker)
for file in (package / 'dist').rglob('*'):
    if file.is_file() and file.name not in ('manifest.json', 'service-worker.js'):
        assert file.read_bytes() == (extension / file.relative_to(package / 'dist')).read_bytes()

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 900},
        reduced_motion=args.motion,
    )
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture['folder'] = worker.evaluate("""async () => {
          const root=(await chrome.bookmarks.getTree())[0].children[0];
          return (await chrome.bookmarks.create({parentId:root.id,title:'Trial destination'})).id;
        }""")
        before = worker.evaluate('() => chrome.bookmarks.getTree()')
        options = context.new_page()
        options.goto(f'chrome-extension://{extension_id}/options/index.html#ai-services')
        options.get_by_role('button', name='添加服务', exact=True).first.click()
        options.locator('.ai-svc-vendor-card').filter(has_text='自定义端点').click()
        options.get_by_label('显示名称', exact=True).fill('Existing synthetic service')
        options.get_by_label('接口地址', exact=False).fill(origin + '/v1')
        options.get_by_role('button', name='连接', exact=True).click()
        expect(options.get_by_label('使用哪个模型')).to_have_value('synthetic-existing-model')
        options.screenshot(path=str(root / 'setup-model.png'), full_page=True)
        options.get_by_role('button', name='保存并继续', exact=True).click()
        options.get_by_role('heading', name='在网页侧栏试一次', exact=True).wait_for()
        options.screenshot(path=str(root / 'setup-trial.png'), full_page=True)
        options.get_by_role('button', name='完成，稍后试分类', exact=True).click()
        assert events == [], 'onboarding must not silently classify'
        services = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert all(f['modelId'] == 'synthetic-existing-model' for f in services['features'])
        options.get_by_role('button', name='隐私与规则', exact=True).click()
        options.get_by_label('发送完整网址（含查询参数和片段）', exact=True).uncheck()
        options.get_by_role('button', name='保存隐私设置', exact=True).click()
        options.get_by_text('隐私设置已保存；未配置模型不影响浏览。', exact=True).wait_for()
        page = context.new_page()
        page.goto(origin + '/page?private=must-not-send')
        page.bring_to_front()

        def open_overlay(width):
            previous_frames = set(page.frames)
            worker.evaluate("async width => { await chrome.storage.local.set({overlayWidth:width}); const tab=(await chrome.tabs.query({active:true,lastFocusedWindow:true}))[0]; globalThis.fixtureToolbar(tab); }", width)
            page.wait_for_function("document.querySelector('zhilan-sidebar') !== null")
            def fresh_frame(frame):
                return frame not in previous_frames and 'panel/index.html' in frame.url
            if not any(fresh_frame(frame) for frame in page.frames):
                page.wait_for_event('framenavigated', predicate=fresh_frame)
            frame = next(frame for frame in page.frames if fresh_frame(frame))
            frame.get_by_role('button', name='设置', exact=True).wait_for()
            return frame

        widths = []
        for width in (320, 340, 480):
            frame = open_overlay(width)
            frame.get_by_role('button', name='设置', exact=True).click()
            frame.get_by_role('heading', name='快速设置', exact=True).wait_for()
            frame.get_by_role('button', name='试分类当前网页', exact=True).click()
            frame.get_by_role('heading', name='当前网页试分类', exact=True).wait_for()
            assert len(events) == 0
            geometry = frame.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert geometry['scroll'] <= geometry['width'] + 1, geometry
            page.screenshot(path=str(root / f'trial-{width}.png'), full_page=True)
            widths.append(geometry)
            if width != 480:
                frame.get_by_role('button', name='收起侧栏', exact=True).click()
                page.locator('zhilan-sidebar').wait_for(state='detached')

        frame.get_by_role('button', name='发送并试分类', exact=True).click()
        frame.get_by_text('建议目录：Trial destination', exact=True).wait_for()
        assert len(events) == 1
        event = events[0]
        assert event['model'] == 'synthetic-existing-model'
        assert event['payload']['items'][0]['url'] == origin + '/page'
        assert 'snippet' not in event['payload']
        assert 'must-not-send' not in json.dumps(event)
        assert worker.evaluate('() => chrome.bookmarks.getTree()') == before
        assert frame.get_by_role('button', name='确认收藏保存', exact=True).count() == 0
        page.screenshot(path=str(root / 'trial-result.png'), full_page=True)
        page.goto(origin + '/next')
        assert len(events) == 1
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'widths': widths, 'motion': args.motion,
                  'requests': len(events), 'nativeTreeUnchanged': True,
                  'productionWorkerSHA256': hashlib.sha256(production_worker).hexdigest(),
                  'scope': 'Fresh profile; production UI/HTML/CSS unchanged. Worker toolbar listener captured by a prelude; copied manifest grants loopback only. Local synthetic provider; no actual toolbar gesture or live-provider performance claim.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for current in context.pages:
            print(current.url, current.locator('body').inner_text()[:2500], flush=True)
            for frame in current.frames:
                if frame != current.main_frame:
                    print(frame.url, frame.locator('body').inner_text()[:3000], flush=True)
            current.screenshot(path=str(root / ('failure-' + str(context.pages.index(current)) + '.png')), full_page=True)
        raise
    finally:
        context.close()
        server.shutdown()
