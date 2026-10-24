"""Opt-in synthetic acceptance of the save confirmation popup; disposable profile, synthetic bookmarks, loopback provider.

The worker side runs the real bookmarks.onCreated pipeline and the toolbar-popup host. The popup document is then driven
in a 352px tab, because automation cannot click the browser's own star or the toolbar popup itself; physical
star/Ctrl+D presentation in branded Chrome/Edge remains a manual release check.
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
parser.add_argument('--headed', action='store_true')
parser.add_argument('--motion', choices=['reduce', 'no-preference'], default='reduce')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for disposable synthetic acceptance')
    raise SystemExit(0)
root = Path(tempfile.mkdtemp(prefix='zhilan-save-popup-'))
extension = root / 'extension'
shutil.copytree(Path(__file__).resolve().parents[2] / 'dist', extension)
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
events, fixture = [], {}
release = threading.Event()


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append(payload)
        assert payload['task'] == 'save', payload
        assert release.wait(20), 'fixture response was not released'
        assignment = {'itemId': payload['items'][0]['id'], 'folderId': fixture['source']}
        if payload['items'][0]['title'] == 'First synthetic':
            assignment['suggestedTitle'] = 'Suggested synthetic name'
        output = {'assignments': [assignment], 'newFolders': []}
        data = json.dumps({'choices': [{'message': {'content': json.dumps(output)}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'


def wait(check, timeout=30):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise AssertionError('condition timed out')


STATE = """async () => {
  const windows = await chrome.windows.getAll({ populate: true });
  const page = chrome.runtime.getURL('save/index.html');
  const arms = [];
  for (const w of windows) for (const t of w.tabs || []) if ((await chrome.action.getPopup({ tabId: t.id })) === page) arms.push(t.id);
  const popups = await chrome.runtime.getContexts({ contextTypes: ['POPUP'] });
  const queue = (await chrome.storage.session.get('saveConfirm.queue.v1'))['saveConfirm.queue.v1'] || [];
  return { windows: windows.map(w => w.type + ':' + (w.tabs || []).length), arms, popups: popups.length, queue };
}"""

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=not args.headed, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
                                        '--disable-background-networking'], no_viewport=True, reduced_motion=args.motion)
    errors = []
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        reader = worker
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async origin => {
          const bar = (await chrome.bookmarks.getTree())[0].children[0].id;
          const mk = async (parentId, title) => (await chrome.bookmarks.create({ parentId, title })).id;
          const projects = await mk(bar, 'Projects'), web = await mk(projects, 'Web');
          await mk(projects, 'Mobile');
          await chrome.storage.local.set({aiServices:{version:1,revision:'popup-fixture',services:[{
            id:'fixture',name:'Synthetic model',serviceType:'custom',kind:'api',detail:'',baseUrl:origin+'/v1',
            mode:'openai',status:'ok',letter:'F',avatarClass:'custom',catalog:[{id:'synthetic',ctx:'fixture'}],
            enabled:['synthetic'],streaming:false
          }],features:[{id:'save',name:'save',desc:'',connId:'fixture',modelId:'synthetic'}]}});
          return { inbox: await mk(bar, 'Inbox'), source: await mk(web, 'Source'), target: await mk(bar, 'Target') };
        }""", origin)

        def state():
            return reader.evaluate(STATE)

        def create(title, completed=True):
            bookmark = worker.evaluate("""async data => (await chrome.bookmarks.create({parentId:data.parent,
                title:data.title,url:'https://'+data.title.split(' ')[0].toLowerCase()+'.example.test/'})).id""",
                {'parent': fixture['inbox'], 'title': title})
            if completed:
                wait(lambda: worker.evaluate("""async id => (await chrome.storage.local.get('nativeSaveReceipts'))
                    .nativeSaveReceipts?.some(r=>r.bookmarkId===id && r.status!=='classifying')""", bookmark))
            return bookmark

        def get(bookmark):
            return reader.evaluate("async id => (await chrome.bookmarks.get(id))[0]", bookmark)

        # Open the observer before the toolbar popup: opening a new tab afterwards dismisses it by blur.
        probe = context.new_page()
        probe.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        baseline = state()
        first = create('First synthetic', completed=False)
        wait(lambda: len(events) == 1)
        before = state()
        assert not before['queue'] and not before['arms'] and not before['popups'], ('opened before AI completed', before)
        release.set()
        presented = wait(lambda: (lambda s: s if s['queue'] and (s['arms'] or s['popups']) else None)(state()))
        try:
            # The tab is armed just before openPopup resolves; give the popup document a moment to appear.
            presented = wait(lambda: (lambda s: s if s['popups'] else None)(state()), timeout=5)
        except AssertionError:
            presented = state()
        assert presented['windows'] == baseline['windows'], ('a window or tab was created', baseline, presented)
        assert not any(kind.startswith('popup:') for kind in presented['windows']), presented
        mode = 'toolbar popup shown' if presented['popups'] else 'toolbar popup armed (automation could not show it)'
        toolbar_compact = None
        if presented['popups']:
            # The real toolbar popup is not a Playwright page; read its DOM from another extension document.
            view = wait(lambda: probe.evaluate("""() => {
              const view = chrome.extension.getViews({ type: 'popup' })[0];
              const input = view?.document.querySelector('.save-pop-input');
              return input && { value: input.value, heading: view.document.querySelector('.save-pop-status').textContent,
                width: view.document.querySelector('.save-pop').getBoundingClientRect().width };
            }"""))
            assert view['value'] == 'Suggested synthetic name' and view['heading'] == '已收藏 · AI 已归类', view
            assert view['width'] <= 353, view
            def toolbar_height():
                return probe.evaluate("chrome.extension.getViews({type:'popup'})[0]?.innerHeight")

            toolbar_compact = toolbar_height()
            for selector in ['details.save-pop-details > summary', '.save-pop-folder']:
                probe.evaluate("selector => chrome.extension.getViews({type:'popup'})[0].document.querySelector(selector).click()", selector)
                wait(lambda: (toolbar_height() or 0) > toolbar_compact + 40)
                probe.evaluate("selector => chrome.extension.getViews({type:'popup'})[0].document.querySelector(selector).click()", selector)
                wait(lambda: abs((toolbar_height() or 0) - toolbar_compact) <= 1)
            mode += '; real toolbar viewport grows and shrinks with details and folder tree'
        probe.close()

        popup = context.new_page()
        popup.on('pageerror', lambda error: errors.append(str(error)))
        popup.set_viewport_size({'width': 352, 'height': 640})
        popup.goto(f'chrome-extension://{extension_id}/save/index.html')
        name = popup.get_by_role('textbox', name='名称', exact=True)
        expect(name).to_have_value('Suggested synthetic name')
        expect(popup.get_by_role('heading', name='已收藏 · AI 已归类', exact=True)).to_be_visible()
        expect(popup.get_by_role('tree')).to_have_count(0)
        expect(popup.locator('details.save-pop-details')).not_to_have_attribute('open', '')
        width = popup.evaluate('({main: document.querySelector(".save-pop").getBoundingClientRect().width,'
                               ' scroll: document.documentElement.scrollWidth})')
        assert width['main'] <= 353 and width['scroll'] <= 353, width
        # Check intrinsic content height, not viewport height: 100dvh on a wrapper makes a toolbar popup grow-only.
        def height():
            return popup.evaluate('document.querySelector(".theme-root").getBoundingClientRect().height')

        compact_height = height()
        main_height = popup.locator('.save-pop').bounding_box()['height']
        assert abs(compact_height - main_height) <= 1 and compact_height < 350, (compact_height, main_height)
        for selector in ['details.save-pop-details > summary', '.save-pop-folder']:
            for _ in range(2):
                popup.locator(selector).click()
                wait(lambda: height() > compact_height + 40)
                popup.locator(selector).click()
                wait(lambda: abs(height() - compact_height) <= 1)
        popup.locator('.theme-root').screenshot(path=str(root / 'popup-compact.png'))
        popup.get_by_role('button', name='文件夹：Bookmarks bar / Projects / Web / Source').or_(
            popup.get_by_role('button', name='文件夹：书签栏 / Projects / Web / Source')).click()
        for folder in ['Projects', 'Web']:
            expect(popup.get_by_role('treeitem', name=folder, exact=True)).to_have_attribute('aria-expanded', 'true')
        expect(popup.get_by_role('treeitem', name='Source', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(popup.get_by_role('treeitem', name='Mobile', exact=True)).to_be_visible()
        popup.get_by_role('treeitem', name='Target', exact=True).click()
        popup.locator('.theme-root').screenshot(path=str(root / 'popup-tree.png'))
        assert get(first)['parentId'] == fixture['source'], 'folder choice must remain a draft until confirmed'
        name.fill('Draft survives new receipts')
        second, third = create('Second synthetic'), create('Third synthetic')
        expect(popup.get_by_text('1/3', exact=True)).to_be_visible()
        expect(name).to_have_value('Draft survives new receipts')
        # A popup closed by blur reopens from the session draft.
        popup.reload()
        name = popup.get_by_role('textbox', name='名称', exact=True)
        expect(name).to_have_value('Draft survives new receipts')
        expect(popup.get_by_role('treeitem', name='Target', exact=True)).to_have_attribute('aria-selected', 'true')
        locale = context.new_page()
        locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option('en')
        expect(popup.get_by_role('textbox', name='Name', exact=True)).to_have_value('Draft survives new receipts')
        assert popup.evaluate('document.documentElement.scrollWidth') <= 353
        popup.locator('.theme-root').screenshot(path=str(root / 'popup-en.png'))
        locale.get_by_role('radio', name='Dark', exact=True).click()
        popup.locator('.theme-root').screenshot(path=str(root / 'popup-dark.png'), animations='disabled')
        locale.get_by_role('radio', name='Light', exact=True).click()
        locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option('zh-CN')
        name = popup.get_by_role('textbox', name='名称', exact=True)
        # Stop the actual worker while the editor stays open. A new begin on the next click must keep the draft.
        cdp = context.new_cdp_session(popup)
        versions = []
        cdp.on('ServiceWorker.workerVersionUpdated', lambda event: versions.extend(event['versions']))
        cdp.send('ServiceWorker.enable')

        def lifecycle(check):
            def pump():
                popup.wait_for_timeout(20)
                return check()
            return wait(pump, timeout=15)

        running = lifecycle(lambda: next((version for version in reversed(versions)
            if version['scriptURL'] == worker.url and version['runningStatus'] == 'running'), None))
        mark = len(versions)
        cdp.send('ServiceWorker.stopWorker', {'versionId': running['versionId']})
        lifecycle(lambda: any(version['versionId'] == running['versionId'] and version['runningStatus'] == 'stopped'
                              for version in versions[mark:]))
        reader = locale  # The old worker handle is gone; read native state through an unchanged extension page.
        expect(name).to_have_value('Draft survives new receipts')
        expect(popup.get_by_role('treeitem', name='Target', exact=True)).to_have_attribute('aria-selected', 'true')
        expect(popup.get_by_text('收藏入口连接已关闭；请重新打开智栏。', exact=True)).to_have_count(0)
        popup.get_by_role('button', name='保存修改', exact=True).click()
        lifecycle(lambda: any(version['scriptURL'] == running['scriptURL'] and version['runningStatus'] == 'running'
                              for version in versions[mark:]))
        wait(lambda: get(first)['title'] == 'Draft survives new receipts' and get(first)['parentId'] == fixture['target'])
        expect(name).to_have_value('Second synthetic')
        cdp.detach()
        popup.get_by_role('button', name='完成', exact=True).click()
        expect(name).to_have_value('Third synthetic')
        popup.get_by_role('button', name='稍后处理', exact=True).click()
        wait(lambda: popup.is_closed() or popup.get_by_text('没有待确认的收藏。', exact=True).is_visible())
        assert get(second)['title'] == 'Second synthetic' and get(second)['parentId'] == fixture['source']
        assert get(third)['parentId'] == fixture['source'], 'later keeps the bookmark and its classification'
        assert state()['queue'] == []
        sidebar = context.new_page()
        sidebar.on('pageerror', lambda error: errors.append(str(error)))
        sidebar.goto(f'chrome-extension://{extension_id}/panel/index.html')
        expect(sidebar.get_by_role('button', name='待确认 1 项', exact=True)).to_be_visible()
        expect(sidebar.locator('.save-pop-form,.save-correction,.receipt')).to_have_count(0)
        sidebar.get_by_role('button', name='待确认 1 项', exact=True).click()
        wait(lambda: state()['queue'] == [reader.evaluate("""async id => (await chrome.storage.local.get(
            'nativeSaveReceipts')).nativeSaveReceipts.find(r => r.bookmarkId === id).id""", third)])
        final = state()
        assert not any(kind.startswith('popup:') for kind in final['windows']), final
        assert not errors, errors
        result = {'status': 'PASS', 'evidence': str(root), 'browser': context.browser.version if context.browser else '',
                  'presentation': mode,
                  'checks': ['nothing presented before AI completed', 'presented after the native event without creating '
                             'a window or tab', 'compact 352px popup document, details collapsed',
                             'details and folder tree each return to compact height after repeated collapse',
                             'real tree opens on the current folder with every ancestor expanded',
                             'folder choice and name stay drafts until confirmed', 'queued saves show 1/N and keep the draft',
                             'reload restores the session draft', 'bilingual and dark layouts without horizontal scroll',
                             'real worker stop/restart with editor open; one click saves the retained name/folder draft',
                             'one combined name+folder write', 'no-op confirm and later keep bookmarks',
                             'sidebar has only the launcher, which re-queues pending receipts'],
                  'errors': errors, 'motion': args.motion,
                  'compact_content_height': compact_height, 'compact_toolbar_height': toolbar_compact,
                  'limits': 'Disposable profile, synthetic bookmarks/local provider; the popup document runs in a tab. '
                            'No physical star/Ctrl+D gesture, toolbar anchoring or branded Chrome/Edge claim.'}
        (root / 'result.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False))
    except Exception:
        for index, page in enumerate(context.pages):
            if not page.is_closed():
                page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
                (root / f'failure-{index}.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
        print(json.dumps({'evidence': str(root), 'errors': errors}))
        raise
    finally:
        release.set()
        context.close()
        server.shutdown()
