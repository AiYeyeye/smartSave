"""Opt-in production UI sidebar onboarding and ordinary bookmark saves in a disposable Chromium profile.

Only the copied manifest and a static event-listener wrapper differ; production assets are unchanged.
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
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
parser.add_argument('--motion', choices=['reduce', 'no-preference'], default='reduce')
parser.add_argument('--language', choices=['zh-CN', 'en'], default='zh-CN')
parser.add_argument('--keywords', action='store_true', help='Also verify native-save keyword enrichment and cleanup')
parser.add_argument('--token-usage', action='store_true', help='Verify actual page/worker usage receipts and the settings dashboard')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for the isolated fixture')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-onboarding-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
events, fixture = [], {}
learning_events = []


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
            self.reply({'data': [{'id': 'a-unselected-first-model'}, {'id': 'synthetic-existing-model'}]})
        else:
            self.reply(b'<title>Synthetic webpage</title><p>Body must never be sent.</p>', 'text/html')

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        if payload.get('task') == 'preference-summary':
            # A later manual move legitimately learns a preference; it is not another save request.
            learning_events.append(payload)
            output = {'rules': [{'text': 'Keep this synthetic site in the bookmarks bar.',
                                'exampleIds': [item['id'] for item in payload['examples']]}]}
            self.reply({'choices': [{'message': {'content': json.dumps(output)}}]})
            return
        assert payload.get('task') == 'save', payload
        events.append({'model': raw['model'], 'payload': payload})
        output = {'assignments': [{'itemId': payload['items'][0]['id'], 'folderId': fixture['folder'], 'keywords': ['diagramming', '流程图', '工作流']}], 'newFolders': []}
        usage = {'prompt_tokens': 1000, 'completion_tokens': 50, 'total_tokens': 1050} if len(events) == 1 else {'prompt_tokens': 200, 'completion_tokens': 20, 'total_tokens': 220}
        self.reply({'choices': [{'message': {'content': json.dumps(output)}}], **({'usage': usage} if args.token_usage else {})})


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
def ui(chinese, english):
    return english if args.language == 'en' else chinese

def wait_for(check):
    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        if check():
            return
        time.sleep(0.1)
    raise AssertionError('keyword fixture condition timed out')

folder_title = '收藏标题' if args.language == 'en' else 'Synthetic destination'
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
production_worker = (extension / 'service-worker.js').read_bytes()
manifest['background']['service_worker'] = 'fixture-worker.js'
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
(extension / 'fixture-events.js').write_text("""
const add = chrome.commands.onCommand.addListener.bind(chrome.commands.onCommand);
globalThis.fixtureCommands = [];
chrome.commands.onCommand.addListener = fn => { globalThis.fixtureCommands.push(fn); add(fn); };
""", encoding='utf-8')
(extension / 'fixture-worker.js').write_text("import './fixture-events.js'; import './service-worker.js';", encoding='utf-8')
for file in (package / 'dist').rglob('*'):
    if file.is_file() and file.name != 'manifest.json':
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
        fixture['folder'] = worker.evaluate("""async title => {
          const root=(await chrome.bookmarks.getTree())[0].children[0];
          return (await chrome.bookmarks.create({parentId:root.id,title})).id;
        }""", folder_title)
        before = worker.evaluate('() => chrome.bookmarks.getTree()')
        wait_for(lambda: worker.evaluate("async()=> (await chrome.storage.local.get('sidebarOnboarding.v1'))['sidebarOnboarding.v1']?.pending===true"))
        panel = context.new_page()
        panel.goto(f'chrome-extension://{extension_id}/panel/index.html')
        expect(panel.get_by_role('heading', name='开始使用智栏', exact=True)).to_be_visible()
        guide_geometry, widths = [], []
        language_page = context.new_page()
        language_page.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        for language in ['zh-CN', 'en']:
            language_page.locator('select[aria-label="语言"], select[aria-label="Language"]').select_option(language)
            title = '新手操作步骤' if language == 'zh-CN' else 'Getting started'
            expect(panel.get_by_role('list', name=title, exact=True)).to_be_visible()
            for width in [320, 340, 480]:
                panel.set_viewport_size({'width': width, 'height': 900})
                panel.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                expect(panel.locator('.onboarding-steps li')).to_have_count(4)
                geometry = panel.evaluate("""() => {
                  const guide=document.querySelector('.onboarding-steps');
                  return {width:innerWidth,scroll:document.documentElement.scrollWidth,
                    guideWidth:guide.clientWidth,guideScroll:guide.scrollWidth,
                    minTarget:Math.min(...[...guide.querySelectorAll('button')].map(e=>e.getBoundingClientRect().height))};
                }""")
                assert geometry['scroll'] <= width+1 and geometry['guideScroll'] <= geometry['guideWidth']+1, geometry
                assert geometry['minTarget'] >= 44, geometry
                panel.screenshot(path=str(root/f'onboarding-{language}-{width}.png'), full_page=True)
                guide_geometry.append({'language':language,**geometry})
                assert events == [] and learning_events == [], 'instructions must not send a model request'
        language_page.get_by_role('radio', name='Dark', exact=True).click()
        panel.screenshot(path=str(root/'onboarding-en-dark.png'), full_page=True)
        language_page.get_by_role('radio', name='Light', exact=True).click()
        language_page.get_by_label('Language', exact=True).select_option('zh-CN')
        panel.get_by_role('button', name='去搜索', exact=True).click()
        expect(panel.get_by_role('searchbox')).to_be_focused()
        panel.get_by_role('button', name='知道了，开始使用', exact=True).click()
        wait_for(lambda: worker.evaluate("async()=> (await chrome.storage.local.get('sidebarOnboarding.v1'))['sidebarOnboarding.v1']?.pending===false"))
        panel.close()
        panel = context.new_page()
        panel.goto(f'chrome-extension://{extension_id}/panel/index.html')
        expect(panel.get_by_role('button', name='设置', exact=True)).to_be_visible()
        expect(panel.locator('.onboarding-steps')).to_have_count(0)
        panel.get_by_role('button', name='设置', exact=True).click()
        expect(panel.get_by_role('button', name='试分类当前网页', exact=True)).to_have_count(0)
        panel.get_by_role('button', name='新手操作步骤', exact=True).click()
        expect(panel.get_by_role('heading', name='开始使用智栏', exact=True)).to_be_visible()
        with context.expect_page() as opened:
            panel.get_by_role('button', name='配置 AI', exact=True).click()
        options = opened.value
        options.wait_for_url(f'chrome-extension://{extension_id}/options/index.html#ai-services/add')
        options.locator('.ai-svc-vendor-card').filter(has_text='自定义端点').click()
        options.get_by_label('显示名称', exact=True).fill('Existing synthetic service')
        options.get_by_label('接口地址', exact=False).fill(origin + '/v1')
        options.get_by_role('button', name='连接', exact=True).click()
        expect(options.get_by_label('使用哪个模型')).to_have_value('')
        expect(options.get_by_role('button', name='保存并完成', exact=True)).to_be_disabled()
        expect(options.get_by_role('dialog').get_by_role('radio')).to_have_count(2)
        pending = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert pending['services'][0]['enabled'] == []
        assert all(not feature.get('modelId') for feature in pending['features'])
        options.get_by_role('radio', name='synthetic-existing-model', exact=True).check()
        options.screenshot(path=str(root/'setup-model.png'), full_page=True)
        options.get_by_role('button', name='保存并完成', exact=True).click()
        expect(options.get_by_role('dialog')).to_have_count(0)
        assert events == [] and learning_events == [], 'setup must not silently classify'
        services = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert all(f['modelId'] == 'synthetic-existing-model' for f in services['features'])
        options.get_by_role('button', name='隐私与规则', exact=True).click()
        options.get_by_label('发送完整网址（含查询参数和片段）', exact=True).uncheck()
        options.get_by_role('button', name='保存隐私设置', exact=True).click()
        options.get_by_text('隐私设置已保存；未配置模型不影响浏览。', exact=True).wait_for()
        if args.language == 'en':
            language_page.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(origin + '/page?private=must-not-send')
        # Keep the source browser window inside headless Chromium's default virtual screen.
        page.set_viewport_size({'width':480,'height':800})
        windows_before = worker.evaluate("async()=> (await chrome.windows.getAll({populate:true})).map(w=>w.type+':'+w.tabs.length)")
        worker.evaluate("""async url => {
          const tab=(await chrome.tabs.query({})).find(tab=>tab.url===url);
          globalThis.fixtureCommands.forEach(fn=>fn('save-current-page',tab));
        }""", page.url)
        # The capture opens the toolbar popup, which automation cannot address as a page: verify it through the worker.
        wait_for(lambda: worker.evaluate("""async()=> (await chrome.runtime.getContexts({contextTypes:['POPUP']}))
          .some(context=>context.documentUrl.endsWith('/save/index.html'))"""))
        wait_for(lambda: len(events) == 1)
        assert worker.evaluate("async()=> (await chrome.windows.getAll({populate:true})).map(w=>w.type+':'+w.tabs.length)") == windows_before
        assert len(events) == 1
        event = events[0]
        assert event['model'] == 'synthetic-existing-model'
        assert event['payload']['items'][0]['url'] == origin + '/page'
        assert 'snippet' not in event['payload'] and 'must-not-send' not in json.dumps(event)
        assert worker.evaluate('() => chrome.bookmarks.getTree()') == before
        assert worker.evaluate("async()=> (await chrome.storage.local.get('bookmarkSearchKeywords.v1'))['bookmarkSearchKeywords.v1'] ?? []") == []
        expect(panel.get_by_role('heading', name=ui('收藏当前页面','Save current page'), exact=True)).to_have_count(0)
        if args.language == 'en':
            language_page.get_by_label('Language', exact=True).select_option('zh-CN')
        language_page.close()
        panel.close()
        usage_geometry = []
        if args.token_usage:
            options.goto(f'chrome-extension://{extension_id}/options/index.html#token-usage')
            expect(options.locator('.token-totals dd')).to_have_text(['1,050', '1,000', '50', '1'])
            expect(options.get_by_role('button', name='Token 统计', exact=True)).to_have_attribute('aria-current', 'page')
            ledger = worker.evaluate("async()=> (await chrome.storage.local.get('tokenUsage.v1'))['tokenUsage.v1']")
            assert ledger['recent'][0]['purpose'] == 'save'
            assert ledger['recent'][0]['counts'] == {'input': 1000, 'output': 50, 'total': 1050}
            assert all(key not in json.dumps(ledger) for key in ['must-not-send', 'private=', origin, 'Body must'])
            for width in [320, 340, 480, 1024]:
                options.set_viewport_size({'width': width, 'height': 960})
                options.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                geometry = options.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth,minTarget:Math.min(...[...document.querySelectorAll(".token-period button")].map(e=>e.getBoundingClientRect().height))})')
                assert geometry['scroll'] <= width + 1 and geometry['minTarget'] >= 44, geometry
                usage_geometry.append(geometry)
                options.screenshot(path=str(root / f'token-usage-{width}.png'), full_page=True)
            options.get_by_role('button', name='今日', exact=True).click()
            locale = context.new_page()
            locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
            locale.get_by_label('语言', exact=True).select_option('en')
            expect(options.get_by_role('button', name='Today', exact=True)).to_have_attribute('aria-pressed', 'true')
            expect(options.locator('.token-totals dd')).to_have_text(['1,050', '1,000', '50', '1'])
            options.screenshot(path=str(root / 'token-usage-en.png'), full_page=True)
            locale.get_by_label('Language', exact=True).select_option('zh-CN')
            locale.close()
            options.reload()
            expect(options.locator('.token-totals dd')).to_have_text(['1,050', '1,000', '50', '1'])
        page.goto(origin + '/next')
        assert len(events) == 1
        if args.keywords:
            bookmark = worker.evaluate("""async()=> {
              const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
              return chrome.bookmarks.create({parentId:bar,title:'Synthetic drawing site',url:'https://keyword-fixture.test/site'});
            }""")
            wait_for(lambda: worker.evaluate("async id=> (await chrome.storage.local.get('bookmarkSearchKeywords.v1'))['bookmarkSearchKeywords.v1']?.some(record=>record.nativeId===id)", bookmark['id']))
            assert len(events) == 2, ('keywords must reuse the single native-save model request', events)
            if args.token_usage:
                expect(options.locator('.token-totals dd')).to_have_text(['1,270', '1,200', '70', '2'])
                assert worker.evaluate("async()=> (await chrome.storage.local.get('tokenUsage.v1'))['tokenUsage.v1'].recent.length") == 2
            assert worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0].parentId', bookmark['id']) == fixture['folder']
            options.goto(f'chrome-extension://{extension_id}/options/index.html#browse')
            options.get_by_role('searchbox').fill('diagramming')
            expect(options.locator('.search-hit-list .search-hit-open')).to_have_text(['Synthetic drawing site'])
            worker.evaluate("async id=>{const bar=(await chrome.bookmarks.getTree())[0].children[0].id; await chrome.bookmarks.move(id,{parentId:bar})}", bookmark['id'])
            expect(options.locator('.search-hit-list .search-hit-open')).to_have_text(['Synthetic drawing site'])
            options.set_viewport_size({'width':320,'height':900})
            options.screenshot(path=str(root/'keyword-search-320.png'),full_page=True)
            worker.evaluate('id=>chrome.bookmarks.remove(id)', bookmark['id'])
            expect(options.locator('.search-hit-list .search-hit-open')).to_have_count(0)
            wait_for(lambda: worker.evaluate("async()=> ((await chrome.storage.local.get('bookmarkSearchKeywords.v1'))['bookmarkSearchKeywords.v1'] ?? []).length===0"))
            assert len(events) == 2
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'widths': widths, 'motion': args.motion, 'language': args.language,
                  'saveRequests': len(events), 'manualMoveLearningRequests': len(learning_events),
                  'instructionsAndSavePreviewNativeTreeUnchanged': True, 'keywordNativeSaveMoveSearchDelete': args.keywords,
                  'tokenUsagePageAndWorker': args.token_usage, 'tokenUsageGeometry': usage_geometry, 'sidebarGuideGeometry': guide_geometry,
                  'productionWorkerSHA256': hashlib.sha256(production_worker).hexdigest(),
                  'scope': 'Fresh profile; production UI/HTML/CSS unchanged. Worker command listener captured by a static wrapper; copied manifest grants loopback only. Local synthetic provider; no actual toolbar gesture or live-provider performance claim.'}
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
