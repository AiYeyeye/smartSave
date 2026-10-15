"""Opt-in production import UI/Worker acceptance with synthetic files, provider and bookmarks."""
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
    print('SKIP: pass --run for isolated synthetic import acceptance')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-import-locale-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
events, fixture = [], {}
release = threading.Event()


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][0]['content'])
        assert payload['task'] == 'import-classify'
        events.append({'task': payload['task'], 'ids': [item['id'] for item in payload['items']]})
        assert release.wait(45), 'classification gate timed out'
        output = {'assignments': [{'itemId': item['id'], 'folderId': fixture['root'], 'title': 'Synthetic suggestion'} for item in payload['items']], 'newFolders': []}
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
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 340, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture.update(worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const root=await chrome.bookmarks.create({parentId:bar,title:'导入书签 {title}'});
          const existing=await chrome.bookmarks.create({parentId:root.id,title:'Existing bookmark',url:'https://import-locale.test/existing'});
          return {root:root.id,existing};
        }"""))
        worker.evaluate("""async origin => chrome.storage.local.set({aiServices:{version:1,revision:'fixture',services:[{
          id:'local',name:'Synthetic provider',serviceType:'Anthropic',kind:'api',detail:'loopback only',baseUrl:origin+'/v1',mode:'anthropic',status:'ok',letter:'A',avatarClass:'av-o',catalog:[{id:'synthetic',ctx:''}],enabled:['synthetic'],timeoutMs:60000,streaming:false
        }],features:[{id:'import',name:'Import',desc:'fixture',connId:'local',modelId:'synthetic'}]}})""", origin)
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#import')
        source = '<DL><DT><H3>原目录</H3><DL><DT><A HREF="https://import-locale.test/new?a=1&amp;b=2#part">导入书签 {title}</A><DT><A HREF="https://import-locale.test/unselected">不导入</A><DT><A HREF="https://import-locale.test/existing">重复项</A></DL></DL>'
        page.get_by_label('Import file', exact=True).set_input_files({'name': '确认 {name}.html', 'mimeType': 'text/html', 'buffer': source.encode()})
        expect(page.get_by_text('File read: 3 source items. Choose Next to select a destination folder.', exact=True)).to_be_visible()
        geometry = []

        def capture(surface):
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                size = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert size['scroll'] <= width + 1, (surface, size)
                geometry.append({'surface': surface, **size})
                page.screenshot(path=str(root / f'{surface}-{width}.png'), full_page=True)

        capture('file')
        assert events == []
        page.get_by_role('button', name='Next: choose destination folder', exact=True).click()
        page.get_by_label('Import destination root', exact=True).select_option(fixture['root'])
        page.get_by_role('button', name='Next: classify with AI and preview', exact=True).click()
        expect(page.get_by_role('button', name='Classifying…', exact=True)).to_be_disabled()
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('button', name='正在分类…', exact=True)).to_be_disabled()
        preferences.get_by_label('语言', exact=True).select_option('en')
        expect(page.get_by_role('button', name='Classifying…', exact=True)).to_be_disabled()
        release.set()
        expect(page.get_by_text('Classification finished. Review the full batch preview.', exact=True)).to_be_visible()
        assert len(events) == 1 and len(events[0]['ids']) == 2, events
        page.get_by_label('Edit title for source 0', exact=True).fill('确认 {parent} <&>')
        page.get_by_role('checkbox', name='不导入', exact=True).uncheck()
        page.get_by_label('Change destination for source 0', exact=True).select_option('')
        expect(page.get_by_role('button', name='Next: confirm import', exact=True)).to_be_disabled()
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_label('明确编辑标题 0', exact=True)).to_have_value('确认 {parent} <&>')
        expect(page.get_by_label('明确调整目标 0', exact=True)).to_have_value('')
        expect(page.get_by_role('checkbox', name='不导入', exact=True)).not_to_be_checked()
        preferences.get_by_label('语言', exact=True).select_option('en')
        page.get_by_label('Change destination for source 0', exact=True).select_option(fixture['root'])
        page.get_by_text('Task and skipped-item details', exact=True).click()
        expect(page.get_by_text('Task and skipped-item details', exact=True).locator('..')).to_contain_text('https://import-locale.test/existing')
        capture('review')
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        page.get_by_role('button', name='Next: confirm import', exact=True).click()
        expect(page.get_by_text('Selected: 1; new bookmarks: 1; required folders: 0', exact=True)).to_be_visible()
        page.get_by_text('View bookmarks and folders to be created', exact=True).click()
        expect(page.get_by_text('View bookmarks and folders to be created', exact=True).locator('..')).to_contain_text('确认 {parent} <&>')
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('button', name='确认并导入书签', exact=True)).to_be_enabled()
        preferences.get_by_label('语言', exact=True).select_option('en')
        capture('confirmation')
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        page.get_by_role('button', name='Confirm and import bookmarks', exact=True).click()
        expect(page.get_by_role('button', name='Import another file', exact=True)).to_be_visible()
        children = worker.evaluate('id=>chrome.bookmarks.getChildren(id)', fixture['root'])
        assert len(children) == 2 and children[0] == fixture['existing']
        assert children[1]['title'] == '确认 {parent} <&>' and children[1]['url'] == 'https://import-locale.test/new?a=1&b=2#part'
        assert len(events) == 1
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'requests': events, 'nativeCreated': 1,
                  'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Production JS/CSS/HTML unchanged; copied-manifest loopback grant. Actual parser Worker, synthetic provider and real native synthetic import. Locale changes retain source/edit/selection/preview without implicit writes. No real-provider or existing user-profile acceptance.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            print(page.url, page.locator('body').inner_text()[-6000:], flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        release.set()
        context.close()
        server.shutdown()
