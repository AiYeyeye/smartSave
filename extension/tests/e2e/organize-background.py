"""Production UI/worker in a fresh Chromium profile. Loopback provider and synthetic bookmarks only.

Requires Python Playwright and --run. The copied manifest grants loopback solely for this fixture;
all JS/CSS/HTML remain production bytes. This is not a no-debugger idle-lifetime measurement.
"""
import argparse
import hashlib
import json
import os
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright
sys.stdout.reconfigure(encoding='utf-8')

parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--language', choices=['zh-CN', 'en'], default='zh-CN')
parser.add_argument('--browser', default=os.environ.get('ZHILAN_BROWSER_EXECUTABLE', 'C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'))
parser.add_argument('--output')
args = parser.parse_args()
def text(zh, en):
    return en if args.language == 'en' else zh
if not args.run:
    print('SKIP: pass --run to test an isolated synthetic extension profile')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-organize-host-'))
extension, profile = root / 'extension', root / 'profile'
shutil.copytree(package / 'dist', extension)
events, fixture = [], {}
gate = threading.Event()
cycle = 1


class Provider(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass  # Browser restart deliberately tears down keep-alive fixture sockets.

    def do_POST(self):
        global gate
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][0]['content'])
        if payload.get('task') != 'organize' or not self.path.endswith('/messages'):
            self.send_error(400)
            return
        stage = payload.get('stage')
        ids = [item['id'] for item in payload.get('items', [])]
        run, wait = cycle, gate
        events.append({'cycle': run, 'stage': stage, 'ids': ids, 'state': 'started'})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def frame(value):
            data = ('event: ' + value['type'] + '\ndata: ' + json.dumps(value) + '\n\n').encode()
            self.wfile.write(f'{len(data):X}\r\n'.encode() + data + b'\r\n')
            self.wfile.flush()

        try:
            frame({'type': 'message_start', 'message': {'content': []}})
            if stage == 'bookmarks' and fixture['a'] in ids:
                assert wait.wait(50), 'fixture gate expired'
            output = {'newFolders': [], 'merges': [], 'moves': [
                {'itemId': item, 'folderId': fixture['target']} for item in ids
            ] if stage == 'bookmarks' else []}
            frame({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            frame({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': json.dumps(output)}})
            frame({'type': 'content_block_stop', 'index': 0})
            frame({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}})
            frame({'type': 'message_stop'})
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
            events.append({'cycle': run, 'stage': stage, 'ids': ids, 'state': 'finished'})
        except (OSError, AssertionError):
            events.append({'cycle': run, 'stage': stage, 'ids': ids, 'state': 'interrupted'})


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
for file in (package / 'dist').rglob('*'):
    if file.is_file() and file.name != 'manifest.json':
        assert file.read_bytes() == (extension / file.relative_to(package / 'dist')).read_bytes()

read_tasks = """async () => {
 const db=await new Promise((r,j)=>{const q=indexedDB.open('zhilan-operations');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
 try{return await new Promise((r,j)=>{const q=db.transaction('organizeCheckpoints').objectStore('organizeCheckpoints').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}finally{db.close()}
}"""


def wait_for(check, seconds=20):
    until = time.monotonic() + seconds
    while time.monotonic() < until:
        value = check()
        if value:
            return value
        time.sleep(0.1)
    raise AssertionError('fixture condition timed out')


with sync_playwright() as playwright:
    def launch():
        return playwright.chromium.launch_persistent_context(
            str(profile), executable_path=args.browser, headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking', f'--lang={args.language}'],
            viewport={'width': 1024, 'height': 900},
        )

    context = launch()
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
        extension_id = worker.url.split('/')[2]
        # Verify the real action API inheritance contract used by the sole renderer (old Chrome typings omit null).
        badge_contract = worker.evaluate("""async () => {
          const tab=await chrome.tabs.create({url:'about:blank',active:false});
          const original={text:await chrome.action.getBadgeText({}),color:await chrome.action.getBadgeBackgroundColor({})};
          try {
            await chrome.action.setBadgeText({text:'审'});
            await chrome.action.setBadgeBackgroundColor({color:'#16A34A'});
            await chrome.action.setBadgeText({tabId:tab.id,text:'●'});
            await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:'#6155A6'});
            const pending=await chrome.action.getBadgeText({tabId:tab.id});
            await chrome.action.setBadgeText({tabId:tab.id,text:null});
            await chrome.action.setBadgeBackgroundColor({tabId:tab.id,color:await chrome.action.getBadgeBackgroundColor({})});
            return {pending,inherited:await chrome.action.getBadgeText({tabId:tab.id}),color:await chrome.action.getBadgeBackgroundColor({tabId:tab.id})};
          } finally {
            await chrome.action.setBadgeText({text:original.text});
            await chrome.action.setBadgeBackgroundColor({color:original.color});
            await chrome.tabs.remove(tab.id);
          }
        }""")
        assert badge_contract == {'pending': '●', 'inherited': '审', 'color': [22, 163, 74, 255]}, badge_contract
        fixture.update(worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const root=await chrome.bookmarks.create({parentId:bar,title:'Organizer isolated fixture'});
          const source=await chrome.bookmarks.create({parentId:root.id,title:'Source'});
          const target=await chrome.bookmarks.create({parentId:root.id,title:'不再建议'});
          const a=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic A',url:'https://example.test/a'});
          const b=await chrome.bookmarks.create({parentId:source.id,title:'Synthetic B',url:'https://example.test/b'});
          return {root:root.id,source:source.id,target:target.id,a:a.id,b:b.id};
        }"""))
        worker.evaluate("""async origin => {await chrome.storage.local.set({debugSettings:{enabled:true},aiServices:{version:1,revision:'isolated-provider',services:[{
          id:'local',name:'Isolated provider',serviceType:'Anthropic',kind:'api',detail:'loopback only',baseUrl:origin+'/v1',
          mode:'anthropic',status:'ok',letter:'A',avatarClass:'av-o',catalog:[{id:'synthetic',ctx:''}],enabled:['synthetic'],timeoutMs:60000,streaming:true
        }],features:[{id:'organize',name:'Organize',desc:'fixture',connId:'local',modelId:'synthetic'}]}})}""", origin)
        before = worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root'])
        if args.language == 'en':
            preferences = context.new_page()
            preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
            preferences.get_by_label('语言', exact=True).select_option('en')
            preferences.close()

        def open_ui():
            page = context.new_page()
            page.goto(f'chrome-extension://{extension_id}/options/index.html#organize')
            page.get_by_role('heading', name=text('整理书签', 'Organize bookmarks'), exact=True).wait_for()
            return page

        scope_geometry = []
        def generate(page):
            page.get_by_label(text('整理范围', 'Organization scope'), exact=True).select_option(fixture['root'])
            page.get_by_text(text('高级选项', 'Advanced options'), exact=True).click()
            page.get_by_label(text('每批最多书签', 'Bookmarks per batch'), exact=True).fill('1')
            page.get_by_label(text('建议清理原有空分类和迁移后变空的分类', 'Suggest removing empty folders, including those emptied by moves'), exact=True).uncheck()
            if cycle == 1:
                for width in [320, 340, 480, 1024]:
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                    assert measured['scroll'] <= width + 1, measured
                    scope_geometry.append(measured)
                    page.screenshot(path=str(root / f'scope-{width}.png'), full_page=True)
            page.get_by_role('button', name=text('下一步：生成整理方案', 'Next: generate plan'), exact=True).click()
            page.get_by_role('button', name=text('确认分类，开始分批整理书签', 'Confirm folders and start bookmark batches'), exact=True).click()

        page = open_ui()
        generate(page)
        wait_for(lambda: any(e['stage'] == 'bookmarks' and fixture['b'] in e['ids'] and e['state'] == 'finished' for e in events))
        wait_for(lambda: any(any(b['status'] == 'accepted' for b in task['batches']) for task in worker.evaluate(read_tasks)))
        first_id = worker.evaluate(read_tasks)[0]['id']
        page.close()
        wait_for(lambda: worker.evaluate('()=>chrome.action.getBadgeText({})') == '50%')
        gate.set()
        wait_for(lambda: any(task['id'] == first_id and task['stage'] == 'complete' for task in worker.evaluate(read_tasks)))
        wait_for(lambda: worker.evaluate('()=>chrome.action.getBadgeText({})') == text('审', '?'))
        assert worker.evaluate('()=>chrome.action.getTitle({})') == text('智栏：分析完成，整理建议待审核', 'Zhilan: analysis complete; suggestions ready for review')
        count = len([e for e in events if e['state'] == 'started'])
        page = open_ui()
        wait_for(lambda: worker.evaluate('()=>chrome.action.getBadgeText({})') == '')
        review_label = text('查看并调整 2 条书签', 'Review and adjust bookmarks (2)')
        choice_label = text(f'选择 move:{fixture["a"]}', f'Select move:{fixture["a"]}')
        page.get_by_text(review_label, exact=True).click()
        expect(page.get_by_label(choice_label, exact=True)).to_be_checked()
        page.get_by_label(choice_label, exact=True).click()
        expect(page.get_by_label(choice_label, exact=True)).not_to_be_checked()
        if args.language == 'en':
            preferences = context.new_page()
            preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
            preferences.get_by_label('Language', exact=True).select_option('zh-CN')
            expect(page.get_by_label(f'选择 move:{fixture["a"]}', exact=True)).not_to_be_checked()
            preferences.get_by_label('语言', exact=True).select_option('en')
            expect(page.get_by_label(choice_label, exact=True)).not_to_be_checked()
            expect(page.get_by_label(f'Destination for move:{fixture["a"]}', exact=True)).to_have_value(fixture['target'])
            preferences.close()
        expect(page.get_by_role('button', name=text('下一步：确认操作', 'Next: confirm changes'), exact=True)).to_be_enabled()
        page.close()
        page = open_ui()
        page.get_by_text(review_label, exact=True).click()
        expect(page.get_by_label(choice_label, exact=True)).not_to_be_checked()
        assert len([e for e in events if e['state'] == 'started']) == count
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        page.screenshot(path=str(root / 'restored-review.png'), full_page=True)
        page.get_by_text(text('完整分类树与内容去向', 'Full folder tree and bookmark destinations'), exact=True).click()
        expect(page.get_by_role('heading', name=text('预计整理后的分类', 'Proposed folders'), exact=True)).to_be_visible()
        expect(page.locator('.organize-classification-tree').get_by_text('不再建议', exact=True)).to_be_visible()
        geometry = []
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= width + 1, measured
            geometry.append(measured)
            page.screenshot(path=str(root / f'review-{width}.png'), full_page=True)

        # A second task is interrupted with B durable and A still pending.
        cycle = 2
        gate = threading.Event()
        page.get_by_role('button', name=text('上一步', 'Back'), exact=True).click()
        generate(page)
        wait_for(lambda: any(e['cycle'] == 2 and e['stage'] == 'bookmarks' and fixture['b'] in e['ids'] and e['state'] == 'finished' for e in events))
        task = wait_for(lambda: next((t for t in worker.evaluate(read_tasks) if t['id'] != first_id and any(b['status'] == 'accepted' for b in t['batches'])), None))
        stable = [batch['id'] for batch in task['batches']]
        context.close()
        gate.set()
        gate = threading.Event()
        gate.set()
        context = launch()
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker', timeout=15000)
        wait_for(lambda: worker.evaluate('()=>chrome.action.getBadgeText({})') == text('停', 'Ⅱ'))
        assert text('智栏：整理已暂停', 'Zhilan: organization paused') in worker.evaluate('()=>chrome.action.getTitle({})')
        page = open_ui()
        resume = page.get_by_role('button', name=text('继续未完成批次', 'Continue unfinished batches'), exact=True)
        expect(resume).to_be_enabled()
        previous = len([e for e in events if e['state'] == 'started'])
        assert previous == count + 3
        resume.click()
        page.get_by_text(review_label, exact=True).wait_for()
        assert len([e for e in events if e['state'] == 'started']) == previous + 1
        restored = next(t for t in worker.evaluate(read_tasks) if t['id'] == task['id'])
        assert [batch['id'] for batch in restored['batches']] == stable
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        page.get_by_role('button', name=text('下一步：确认操作', 'Next: confirm changes'), exact=True).click()
        page.get_by_role('button', name=text('确认并执行 2 项操作', 'Confirm and apply operations (2)'), exact=True).click()
        page.get_by_text(text('整理已完成，可从恢复记录核对或撤销。', 'Organization complete. Review or undo it in recovery records.'), exact=True).first.wait_for()
        submitted = next(t for t in worker.evaluate(read_tasks) if t['id'] == task['id'])['submission']['requestId']
        after = worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root'])
        target = next(n for n in after[0]['children'] if n['id'] == fixture['target'])
        assert {n['id'] for n in target['children']} == {fixture['a'], fixture['b']}
        page.close()
        page = open_ui()
        page.get_by_text(text('整理已完成，可从恢复记录核对或撤销。', 'Organization complete. Review or undo it in recovery records.'), exact=True).first.wait_for()
        assert submitted in page.locator('body').inner_text()
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == after
        page.screenshot(path=str(root / 'submitted-result.png'), full_page=True)
        result = {'status': 'PASS', 'browser': context.browser.version, 'taskId': task['id'], 'requestId': submitted,
                  'reviewLanguage': args.language, 'geometry': geometry, 'scopeGeometry': scope_geometry, 'crossDocumentSelectionRetained': args.language == 'en',
                  'events': events, 'evidence': str(root), 'manifestDelta': {'host_permissions': ['http://127.0.0.1/*']},
                  'productionWorkerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'badge': 'PASS: closed-page progress, unread review, visible acknowledgement, restart-paused reminder',
                  'badgeContract': badge_contract,
                  'scope': 'Fresh synthetic profile; production UI/worker bytes; loopback provider only. Debugger attached; not an idle-lifetime or branded-browser acceptance.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        if args.output:
            output = Path(args.output)
            output.parent.mkdir(parents=True, exist_ok=True)
            output.write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print(json.dumps({'tasks': [{'id': t['id'], 'stage': t['stage'], 'status': t['status'], 'revision': t['revision'], 'selection': t['selection']} for t in worker.evaluate(read_tasks)], 'events': events}), flush=True)
        print(json.dumps(worker.evaluate("async()=>{const d=await chrome.storage.local.get('debugTrail');return d.debugTrail?.filter(e=>['invalidated','cancel-requested','call-end'].includes(e.event)).map(({src,event,t,detail})=>({src,event,t,detail:{cause:detail.cause,stage:detail.stage,status:detail.status,reason:detail.reason}}))}")), flush=True)
        if context.pages:
            print(context.pages[-1].locator('body').inner_text(), flush=True)
            context.pages[-1].screenshot(path=str(root / 'failure.png'), full_page=True)
        print('EVIDENCE=' + str(root), flush=True)
        raise
    finally:
        context.close()
        server.shutdown()
