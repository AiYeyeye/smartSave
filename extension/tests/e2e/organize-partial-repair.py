"""Explicit opt-in: production UI and real worker, isolated bookmarks, synthetic loopback provider."""
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
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic partial repair')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-partial-repair-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
events, fixture = [], {}


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][0]['content'])
        assert payload['task'] == 'organize' and self.path.endswith('/messages')
        ids = [item['id'] for item in payload.get('items', [])]
        events.append({'stage': payload['stage'], 'ids': ids})
        output = {'newFolders': [], 'merges': [], 'moves': []}
        if payload['stage'] == 'bookmarks':
            output['moves'] = [{'itemId': item, 'folderId': 'missing-fixture-destination' if len(ids) == 2 and item == fixture['b'] else fixture['target'], 'reason': 'synthetic classification'} for item in ids]
        body = json.dumps({'type': 'message', 'content': [{'type': 'text', 'text': json.dumps(output)}], 'stop_reason': 'end_turn'}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


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
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture.update(worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const root=await chrome.bookmarks.create({parentId:bar,title:'Partial repair fixture'});
          const source=await chrome.bookmarks.create({parentId:root.id,title:'Source'});
          const target=await chrome.bookmarks.create({parentId:root.id,title:'Target'});
          const a=await chrome.bookmarks.create({parentId:source.id,title:'Retained A',url:'https://example.test/a'});
          const b=await chrome.bookmarks.create({parentId:source.id,title:'Repair B',url:'https://example.test/b'});
          return {root:root.id,source:source.id,target:target.id,a:a.id,b:b.id};
        }"""))
        worker.evaluate("""async origin => chrome.storage.local.set({aiServices:{version:1,revision:'fixture',services:[{
          id:'local',name:'Synthetic provider',serviceType:'Anthropic',kind:'api',detail:'loopback only',baseUrl:origin+'/v1',mode:'anthropic',status:'ok',letter:'A',avatarClass:'av-o',catalog:[{id:'synthetic',ctx:''}],enabled:['synthetic'],timeoutMs:60000,streaming:false
        }],features:[{id:'organize',name:'Organize',desc:'fixture',connId:'local',modelId:'synthetic'}]}})""", origin)
        before = worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root'])
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#organize')
        page.get_by_label('整理范围', exact=True).select_option(fixture['root'])
        page.get_by_text('高级选项', exact=True).click()
        page.get_by_label('每批最多书签', exact=True).fill('100')
        page.get_by_label('建议清理原有空分类和迁移后变空的分类', exact=True).uncheck()
        page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
        page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True).click()
        repair = page.get_by_role('button', name='只补问这 1 条', exact=True)
        expect(repair).to_be_enabled()
        assert len(events) == 2, events
        expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_disabled()
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        geometry = []
        for width in [340, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= measured['width'] + 1, measured
            geometry.append(measured)
            repair.scroll_into_view_if_needed()
            page.screenshot(path=str(root / f'repair-consent-{width}.png'), full_page=True)
        page.reload()
        expect(repair).to_be_enabled()
        assert len(events) == 2, events
        repair.click()
        next_button = page.get_by_role('button', name='下一步：确认操作', exact=True)
        expect(next_button).to_be_enabled()
        assert events == [{'stage': 'folders', 'ids': [fixture['source'], fixture['target']]}, {'stage': 'bookmarks', 'ids': [fixture['a'], fixture['b']]}, {'stage': 'bookmarks', 'ids': [fixture['b']]}], events
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        next_button.click()
        page.get_by_role('button', name='确认并执行 2 项操作', exact=True).click()
        page.get_by_text('状态 completed', exact=False).wait_for()
        for key in ['a', 'b']:
            assert worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0].parentId', fixture[key]) == fixture['target']
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'requests': events, 'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Production JS/CSS/HTML unchanged; copied manifest loopback grant, synthetic provider/bookmarks, no real provider or release readiness claim.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            print(page.url, page.locator('body').inner_text()[-6500:], flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
        server.shutdown()
