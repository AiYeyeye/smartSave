"""Opt-in synthetic history acceptance in a disposable Chromium profile.

Production scripts are unchanged. Only the copied manifest grants history and loopback
access to automate native reads/provider replies. OS permission dialogs are not tested.
"""
import argparse
import json
import os
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
parser.add_argument('--browser', default=os.environ.get('CHROMIUM_EXECUTABLE_PATH'), help='Optional Chromium executable; otherwise use Playwright Chromium')
args = parser.parse_args()
if not args.run:
    print('SKIP: use --run for disposable synthetic history/native-save/browser UI checks')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-history-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
manifest_path = extension / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
assert 'history' in manifest['optional_permissions'] and 'history' not in manifest['permissions']
manifest['optional_permissions'].remove('history')
manifest['permissions'].append('history')
manifest['host_permissions'] = ['http://127.0.0.1/*']
manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
events = []
long_title = 'Synthetic ' + 'Long history title ' * 12


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def reply(self, body, content_type='application/json'):
        data = body if isinstance(body, bytes) else json.dumps(body).encode()
        self.send_response(200)
        self.send_header('Content-Type', content_type)
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def do_GET(self):
        title = long_title if '/long' in self.path else 'Synthetic Flowchart Tool' if '/flow' in self.path else 'Synthetic Reading Article'
        self.reply(f'<title>{title}</title><h1>{title}</h1><p>Private synthetic body, never sent.</p>'.encode(), 'text/html')

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append(payload)
        if payload['task'] == 'history-query':
            output = {'terms': ['Flowchart', '流程图'], 'startDate': None, 'endDate': None, 'domains': []}
        elif payload['task'] == 'history-rank':
            output = {'rankedIds': [item['id'] for item in payload['items'] if 'Flowchart' in item['title']]}
        else:
            raise AssertionError(f'Unexpected model task {payload["task"]}')
        self.reply({'choices': [{'message': {'content': json.dumps(output)}, 'finish_reason': 'stop'}], 'usage': {'prompt_tokens': 100, 'completion_tokens': 20, 'total_tokens': 120}})


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
flow_url = origin + '/flow?private=do-not-send#fragment'
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 900}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        visit = context.new_page()
        visit.goto(flow_url)
        visit.goto(origin + '/article')
        visit.goto(origin + '/long')
        folders = worker.evaluate("""async origin => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const folder=await chrome.bookmarks.create({parentId:bar,title:'History destination'});
          await chrome.bookmarks.create({parentId:folder.id,title:'Synthetic Reading Article',url:origin+'/article'});
          await chrome.storage.local.set({aiServices:{version:1,revision:'history-fixture',services:[{
            id:'history-service',name:'Synthetic history provider',serviceType:'custom',kind:'api',detail:'',baseUrl:origin+'/v1',mode:'openai',status:'ok',letter:'H',avatarClass:'custom',
            catalog:[{id:'history-model',ctx:'fixture'}],enabled:['history-model'],streaming:false
          }],features:[{id:'search',name:'Search',desc:'',connId:'history-service',modelId:'history-model'}]}});
          return folder.id;
        }""", origin)
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#browse')
        page.get_by_role('button', name='历史', exact=True).click()
        expect(page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True)).to_be_visible()
        expect(page.get_by_role('group', name='搜索范围').get_by_role('button')).to_have_count(3)
        page.get_by_role('button', name='Synthetic Reading Article', exact=True).click(button='right')
        expect(page.get_by_role('menuitem', name='已收藏', exact=True)).to_be_disabled()
        page.keyboard.press('Escape')
        assert events == [], events
        page.get_by_role('searchbox').fill('Flowchart')
        expect(page.locator('.history-list li')).to_have_count(1)
        page.get_by_label('时间范围', exact=True).select_option('custom')
        page.get_by_label('开始日期', exact=True).fill('2000-01-01')
        page.get_by_label('结束日期', exact=True).fill('2000-01-02')
        expect(page.get_by_text('当前范围没有匹配记录。', exact=True)).to_be_visible()
        page.get_by_label('时间范围', exact=True).select_option('30')
        page.get_by_role('searchbox').fill('找那个画流程图的网页')
        expect(page.get_by_role('button', name='AI 查历史', exact=True)).to_be_enabled()
        expect(page.locator('.history-ai input[type="checkbox"]')).to_have_count(0)
        assert events == [], events
        page.get_by_role('button', name='AI 查历史', exact=True).click()
        expect(page.get_by_text('已比较', exact=False)).to_be_visible(timeout=20000)
        expect(page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True)).to_be_visible()
        assert [event['task'] for event in events] == ['history-query', 'history-rank'], events
        assert 'do-not-send' not in json.dumps(events) and 'Private synthetic body' not in json.dumps(events)
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        locale = context.new_page()
        locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        geometry = []
        for language in ['zh-CN', 'en']:
            locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
            expect(page.get_by_role('button', name='AI history search' if language == 'en' else 'AI 查历史', exact=True)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= width + 1, measured
                geometry.append({'language': language, **measured})
                page.screenshot(path=str(root / f'history-{language}-{width}.png'), full_page=True)
                page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True).click(button='right')
                menu = page.get_by_role('menu')
                expect(menu).to_be_visible()
                bounds = menu.bounding_box()
                assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width + 1, bounds
                assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= 901, bounds
                page.screenshot(path=str(root / f'history-menu-{language}-{width}.png'), full_page=True)
                page.keyboard.press('Escape')
        assert len(events) == 2, events
        locale.get_by_role('radio', name='Dark', exact=True).click()
        page.set_viewport_size({'width': 340, 'height': 900})
        page.screenshot(path=str(root / 'history-en-dark.png'), full_page=True)
        locale.get_by_label('Language', exact=True).select_option('zh-CN')
        locale.get_by_role('radio', name='浅色', exact=True).click()
        panel = context.new_page()
        panel.goto(f'chrome-extension://{extension_id}/panel/index.html')
        panel.get_by_role('button', name='历史', exact=True).click()
        expect(panel.get_by_role('button', name='Synthetic Flowchart Tool', exact=True)).to_be_visible()
        for width in [320, 380, 480]:
            panel.set_viewport_size({'width': width, 'height': 900})
            measured = panel.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= width + 1, measured
            geometry.append({'surface': 'panel', **measured})
            panel.screenshot(path=str(root / f'history-panel-{width}.png'), full_page=True)
            rows = panel.locator('.history-list > li').evaluate_all('rows => rows.map(row => { const r = row.getBoundingClientRect(); const button = row.querySelector(".search-hit-open"); const icon = button.querySelector("img,svg").getBoundingClientRect(); const title = button.querySelector("span").getBoundingClientRect(); return {height:r.height,iconX:icon.x,titleX:title.x,iconY:icon.y,titleY:title.y}; })')
            assert all(row['height'] <= 44 and row['iconX'] < row['titleX'] and abs(row['iconY'] - row['titleY']) < 10 for row in rows), rows
            panel.set_viewport_size({'width': width, 'height': 360})
            panel.get_by_role('button', name='Synthetic Flowchart Tool', exact=True).click(button='right')
            bounds = panel.get_by_role('menu').bounding_box()
            assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width + 1 and bounds['y'] + bounds['height'] <= 361, bounds
            panel.screenshot(path=str(root / f'history-panel-menu-{width}.png'), full_page=True)
            panel.keyboard.press('Escape')
        assert len(events) == 2, 'Opening the panel must not call a model'
        page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True).click(button='right')
        page.get_by_role('menuitem', name='收藏此网页', exact=True).click()
        expect(page.get_by_role('heading', name='从历史记录收藏', exact=True)).to_be_visible()
        assert len(events) == 2, 'Opening a history save draft must not call a model'
        page.get_by_label('收藏目标目录', exact=True).select_option(folders)
        page.get_by_role('button', name='确认收藏保存', exact=True).click()
        expect(page.get_by_role('button', name='关闭结果', exact=True)).to_be_visible(timeout=15000)
        saved = worker.evaluate('(url)=>chrome.bookmarks.search({url})', flow_url)
        assert len(saved) == 1 and saved[0]['parentId'] == folders, saved
        page.get_by_role('searchbox').fill('Synthetic Reading')
        page.get_by_role('button', name='目录', exact=True).click()
        expect(page.get_by_role('button', name='Synthetic Reading Article', exact=True)).to_have_count(1)
        page.get_by_role('button', name='历史', exact=True).click()
        page.get_by_role('searchbox').fill('Flowchart')
        expect(page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True)).to_be_visible()
        page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True).click(button='right')
        worker.evaluate('(url)=>chrome.history.deleteUrl({url})', flow_url)
        expect(page.get_by_role('button', name='Synthetic Flowchart Tool', exact=True)).to_have_count(0)
        expect(page.get_by_role('menu')).to_have_count(0)
        expect(page.get_by_text('历史记录或权限已变化，结果已清空。请重新查询。', exact=True)).to_be_visible()
        report = {'result':'PASS','geometry':geometry,'modelCalls':len(events),'historyReadDelete':'native','save':'native confirmed original URL','permissionDialogs':'NOT RUN: copied manifest grant','output':str(root)}
        (root / 'result.json').write_text(json.dumps(report, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(report, ensure_ascii=False))
    except Exception:
        print(f'Artifacts: {root}')
        if 'page' in locals():
            page.screenshot(path=str(root / 'failure.png'), full_page=True)
        raise
    finally:
        context.close()
        server.shutdown()
