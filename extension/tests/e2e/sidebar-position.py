"""Disposable production UI acceptance for directory-position persistence.

Synthetic bookmarks and loopback pages only. A temporary worker wrapper exposes the real toolbar
handler for the overlay test; it does not claim an OS toolbar gesture or native SidePanel UI test.
"""
import argparse
import json
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
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic acceptance')
    raise SystemExit(0)
root = Path(tempfile.mkdtemp(prefix='zhilan-position-'))
extension = root / 'extension'
shutil.copytree(Path(__file__).resolve().parents[2] / 'dist', extension)
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
manifest['background']['service_worker'] = 'acceptance-worker.js'
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
(extension / 'acceptance-events.js').write_text("""
const add=chrome.action.onClicked.addListener.bind(chrome.action.onClicked);
chrome.action.onClicked.addListener=listener=>{globalThis.acceptanceToolbar=listener;add(listener)};
""", encoding='utf-8')
(extension / 'acceptance-worker.js').write_text("import './acceptance-events.js'; import './service-worker.js';", encoding='utf-8')


class Site(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_GET(self):
        self.send_response(200)
        self.send_header('Content-Type', 'text/html; charset=utf-8')
        self.end_headers()
        self.wfile.write(b'<html><body><h1>Synthetic destination</h1></body></html>')


server = ThreadingHTTPServer(('127.0.0.1', 0), Site)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
profile = root / 'profile'
(profile / 'Default').mkdir(parents=True)
stamp = str(int((time.time() + 11644473600) * 1000000))
children = [{'type': 'url', 'id': str(i+20), 'name': f'Synthetic bookmark {i:03}', 'url': origin+f'/bookmark/{i}',
             'date_added': stamp} for i in range(300)]
folder = {'type': 'folder', 'id': '10', 'name': 'Long nested folder', 'date_added': stamp, 'date_modified': stamp, 'children': children}
roots = {key: {'type': 'folder', 'id': str(i+1), 'name': name, 'date_added': stamp, 'date_modified': stamp,
               'children': [folder] if i == 0 else []}
         for i, (key, name) in enumerate([('bookmark_bar', 'Bookmarks bar'), ('other', 'Other bookmarks'), ('synced', 'Mobile bookmarks')])}
(profile / 'Default' / 'Bookmarks').write_text(json.dumps({'version': 1, 'roots': roots}), encoding='utf-8')


def wait(check):
    deadline = time.monotonic() + 25
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise AssertionError('condition timed out')


with sync_playwright() as playwright:
    def launch():
        return playwright.chromium.launch_persistent_context(str(profile), executable_path=args.browser, headless=True,
            args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
            viewport={'width': 420, 'height': 720})

    context = launch()
    checks = []
    errors = []
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        url = f'chrome-extension://{extension_id}/panel/index.html'

        def saved():
            return worker.evaluate("async()=>Object.entries(await chrome.storage.local.get(null)).find(([key])=>key.startsWith('tree.position.v1.'))?.[1]")

        def assert_anchor(surface, record):
            wait(lambda: surface.locator('#main').evaluate('(e)=>e.scrollTop') > 100)
            row = surface.locator(f'[data-node-id="{record["anchor"]}"]')
            expect(row).to_be_attached()
            wait(lambda: abs(row.evaluate("e=>e.getBoundingClientRect().top-document.querySelector('#main').getBoundingClientRect().top")-record['offset']) < 2)

        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(url)
        page.get_by_role('button', name='Long nested folder', exact=True).click()
        expect(page.get_by_role('button', name='Synthetic bookmark 299', exact=True)).to_be_attached()
        page.locator('#main').evaluate('e=>e.scrollTop=4105')
        wait(lambda: saved() and saved()['scrollTop'] > 4000)
        with context.expect_page() as opened:
            page.get_by_role('button', name='Synthetic bookmark 110', exact=True).click()
        destination = opened.value
        destination.wait_for_url(origin+'/bookmark/110')
        record = saved()
        page.close()
        page = context.new_page()
        page.goto(url)
        assert_anchor(page, record)
        page.screenshot(path=str(root/'reopened-directory.png'), full_page=True)
        checks.append('Click bookmark, destroy panel document and reopen at the same row and relative offset')

        page.get_by_role('button', name='设置', exact=True).click()
        page.get_by_role('button', name='返回书签', exact=True).click()
        assert_anchor(page, record)
        page.get_by_role('searchbox').fill('Synthetic bookmark 001')
        page.get_by_role('searchbox').fill('')
        assert_anchor(page, record)
        checks.append('Settings and search do not overwrite directory position with zero')
        page.close()
        context.close()
        context = launch()
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        page = context.new_page()
        page.goto(url)
        assert_anchor(page, record)
        checks.append('Browser/profile restart restores expanded ancestors and position')

        # Invoke the registered production handler, using loopback permission only in this disposable manifest.
        site = context.new_page()
        site.set_viewport_size({'width':1024,'height':760})
        site.goto(origin+'/host')
        tab_id = worker.evaluate("async origin=>(await chrome.tabs.query({url:origin+'/host'}))[0].id", origin)

        def toggle():
            worker.evaluate('async id=>globalThis.acceptanceToolbar(await chrome.tabs.get(id))', tab_id)

        # Playwright omits extension OOPIFs inside the production closed shadow root from page.frames().
        # Read their actual DOM through a scoped CDP target; do not change the production shadow boundary.
        cdp = context.browser.new_browser_cdp_session()
        replies = {}
        message_ids = iter(range(1, 2147483647))
        cdp.on('Target.receivedMessageFromTarget', lambda event: replies.update({(event['sessionId'], message['id']): message})
               if 'id' in (message := json.loads(event['message'])) else None)

        def frame():
            return next((item for item in cdp.send('Target.getTargets')['targetInfos']
                         if item['type'] == 'iframe' and item['url'].startswith(url)), None)

        def attach(target):
            return cdp.send('Target.attachToTarget', {'targetId':target['targetId'],'flatten':False})['sessionId']

        def evaluate(session, expression):
            message_id = next(message_ids)
            cdp.send('Target.sendMessageToTarget', {'sessionId':session,'message':json.dumps({
                'id':message_id,'method':'Runtime.evaluate','params':{'expression':expression,'returnByValue':True}})})
            deadline = time.monotonic()+10
            while (session, message_id) not in replies:
                if time.monotonic()>deadline:
                    raise AssertionError('iframe evaluation timed out')
                site.wait_for_timeout(10)
            reply = replies.pop((session,message_id))
            assert 'error' not in reply and 'exceptionDetails' not in reply.get('result',{}), reply
            return reply['result']['result'].get('value')

        def overlay_anchor(session, record):
            def restored():
                return evaluate(session, """(() => {
                  const host=document.querySelector('#main');
                  const row=document.querySelector('[data-node-id="%s"]');
                  return host && row && Math.abs(row.getBoundingClientRect().top-host.getBoundingClientRect().top-(%s))<2;
                })()""" % (record['anchor'],record['offset']))
            wait(restored)

        toggle()
        panel = attach(wait(frame))
        overlay_anchor(panel, record)
        evaluate(panel, "document.querySelector('#main').scrollTop=6107")
        wait(lambda: saved()['scrollTop'] > 6000)
        record = saved()
        toggle()
        wait(lambda: frame() is None)
        toggle()
        panel = attach(wait(frame))
        overlay_anchor(panel, record)
        checks.append('Actual production overlay iframe destruction/recreation retains position')
        for language, width in [('en', 320), ('zh-CN', 480)]:
            locale = context.new_page()
            locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
            locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
            locale.close()
            worker.evaluate('width=>chrome.storage.local.set({overlayWidth:width})', width)
            toggle()
            wait(lambda: frame() is None)
            toggle()
            panel = attach(wait(frame))
            overlay_anchor(panel, record)
            site.screenshot(path=str(root/f'overlay-{language}-{width}.png'), full_page=True)
        def bookmark_contents(nodes):
            return [{**{key:node[key] for key in ['id','parentId','index','title','url'] if key in node},
                     **({'children':bookmark_contents(node['children'])} if 'children' in node else {})} for node in nodes]
        # Chromium may update visit/group timestamps on open/restart; identity, content and order must stay intact.
        assert bookmark_contents(worker.evaluate('()=>chrome.bookmarks.getTree()')) == bookmark_contents(before)
        assert not errors, errors
        result = {'status':'PASS','evidence':str(root),'checks':checks,'errors':errors,
            'limits':'Synthetic loopback toolbar-event wrapper; actual production overlay/App/storage. Native SidePanel OS chrome and real user profile not exercised. No model calls or bookmark mutations.'}
        (root/'results.json').write_text(json.dumps(result,ensure_ascii=False,indent=2),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False))
    except Exception:
        print('EVIDENCE='+str(root),flush=True)
        print('FRAMES='+str([(p.url,[f.url for f in p.frames]) for p in context.pages]),flush=True)
        print('TARGETS='+str(context.browser.new_browser_cdp_session().send('Target.getTargets')),flush=True)
        for index, item in enumerate(context.pages):
            if not item.is_closed():
                item.screenshot(path=str(root/f'failure-{index}.png'),full_page=True)
        raise
    finally:
        context.close()
        server.shutdown()
