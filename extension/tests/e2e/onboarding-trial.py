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
            self.reply(b'<title>Trial synthetic webpage</title><p>Body must never be sent.</p>', 'text/html')

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
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

folder_title = '收藏标题' if args.language == 'en' else 'Trial destination'
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
        fixture['folder'] = worker.evaluate("""async title => {
          const root=(await chrome.bookmarks.getTree())[0].children[0];
          return (await chrome.bookmarks.create({parentId:root.id,title})).id;
        }""", folder_title)
        before = worker.evaluate('() => chrome.bookmarks.getTree()')
        options = context.new_page()
        options.goto(f'chrome-extension://{extension_id}/options/index.html#ai-services')
        options.get_by_role('button', name='添加服务', exact=True).first.click()
        options.locator('.ai-svc-vendor-card').filter(has_text='自定义端点').click()
        options.get_by_label('显示名称', exact=True).fill('Existing synthetic service')
        options.get_by_label('接口地址', exact=False).fill(origin + '/v1')
        options.get_by_role('button', name='连接', exact=True).click()
        expect(options.get_by_label('使用哪个模型')).to_have_value('')
        expect(options.get_by_role('button', name='保存并继续', exact=True)).to_be_disabled()
        expect(options.get_by_role('dialog').get_by_role('radio')).to_have_count(2)
        pending = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert pending['services'][0]['enabled'] == []
        assert all(not feature.get('modelId') for feature in pending['features'])
        options.get_by_role('radio', name='synthetic-existing-model', exact=True).check()
        expect(options.get_by_label('使用哪个模型')).to_have_value('synthetic-existing-model')
        options.screenshot(path=str(root / 'setup-model.png'), full_page=True)
        options.get_by_role('button', name='保存并继续', exact=True).click()
        options.get_by_role('heading', name='在网页侧栏试一次', exact=True).wait_for()
        options.screenshot(path=str(root / 'setup-trial.png'), full_page=True)
        guide_geometry = []
        language_page = context.new_page()
        language_page.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        for language in ['zh-CN', 'en']:
            language_page.locator('select[aria-label="语言"], select[aria-label="Language"]').select_option(language)
            expect(options.get_by_role('list', name='试分类操作图解' if language == 'zh-CN' else 'Illustrated page-trial steps', exact=True)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                options.set_viewport_size({'width': width, 'height': 900})
                expect(options.locator('.ai-trial-guide [role="img"]')).to_have_count(4)
                options.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                geometry = options.evaluate('''() => {
                  const dialog=document.querySelector('.ai-svc-wizard');
                  const body=document.querySelector('.ai-svc-wizard-body');
                  const pictures=[...document.querySelectorAll('.ai-trial-illustration')];
                  return {width:innerWidth,scroll:document.documentElement.scrollWidth,
                    dialogWidth:dialog.getBoundingClientRect().width,dialogScroll:dialog.scrollWidth,
                    bodyWidth:body.clientWidth,bodyScroll:body.scrollWidth,
                    pictures:pictures.map(p=>({width:p.clientWidth,scroll:p.scrollWidth,
                      height:p.clientHeight,scrollHeight:p.scrollHeight}))};
                }''')
                assert geometry['scroll'] <= width + 1 and geometry['dialogScroll'] <= geometry['dialogWidth'] + 1, geometry
                assert geometry['bodyScroll'] <= geometry['bodyWidth'] + 1, geometry
                assert all(p['scroll'] <= p['width'] + 1 and p['scrollHeight'] <= p['height'] + 1 for p in geometry['pictures']), geometry
                assert options.locator('.ai-trial-guide button').count() == 0
                options.locator('.ai-svc-wizard-body').evaluate('e=>{e.scrollTop=0}')
                options.screenshot(path=str(root / f'setup-trial-guide-{language}-{width}.png'), full_page=True)
                options.locator('.ai-svc-dialog').screenshot(path=str(root / f'setup-trial-guide-{language}-{width}-dialog.png'))
                guide_geometry.append({'language':language,**geometry})
                assert events == [], 'viewing illustrated instructions must not send a model request'
        language_page.get_by_role('radio', name='Dark', exact=True).click()
        options.set_viewport_size({'width':1024,'height':900})
        expect(options.locator('.ai-svc-dialog')).to_have_css('background-color', 'rgb(23, 24, 28)')
        options.screenshot(path=str(root / 'setup-trial-guide-en-dark.png'), full_page=True)
        language_page.get_by_role('radio', name='Light', exact=True).click()
        language_page.locator('select[aria-label="语言"], select[aria-label="Language"]').select_option('zh-CN')
        language_page.close()
        options.set_viewport_size({'width':1024,'height':900})
        options.get_by_role('button', name='完成，稍后试分类', exact=True).click()
        assert events == [], 'onboarding must not silently classify'
        services = worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices")
        assert all(f['modelId'] == 'synthetic-existing-model' for f in services['features'])
        options.get_by_role('button', name='隐私与规则', exact=True).click()
        options.get_by_label('发送完整网址（含查询参数和片段）', exact=True).uncheck()
        options.get_by_role('button', name='保存隐私设置', exact=True).click()
        options.get_by_text('隐私设置已保存；未配置模型不影响浏览。', exact=True).wait_for()
        if args.language == 'en':
            options.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
            options.get_by_label('语言', exact=True).select_option('en')
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
            frame.get_by_role('button', name=ui('设置', 'Settings'), exact=True).wait_for()
            return frame

        widths = []
        for width in (320, 340, 480):
            frame = open_overlay(width)
            frame.get_by_role('button', name=ui('设置', 'Settings'), exact=True).click()
            frame.get_by_role('heading', name=ui('快速设置', 'Quick settings'), exact=True).wait_for()
            frame.get_by_role('button', name=ui('试分类当前网页', 'Try classifying this page'), exact=True).click()
            frame.get_by_role('heading', name=ui('当前网页试分类', 'Try classifying this page'), exact=True).wait_for()
            assert len(events) == 0
            geometry = frame.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert geometry['scroll'] <= geometry['width'] + 1, geometry
            page.screenshot(path=str(root / f'trial-{width}.png'), full_page=True)
            widths.append(geometry)
            if width != 480:
                frame.get_by_role('button', name=ui('收起侧栏', 'Close sidebar'), exact=True).click()
                page.locator('zhilan-sidebar').wait_for(state='detached')

        frame.get_by_role('button', name=ui('发送并试分类', 'Send and try classification'), exact=True).click()
        frame.get_by_text(ui('建议目录：', 'Suggested folder: ') + folder_title, exact=True).wait_for()
        assert len(events) == 1
        event = events[0]
        assert event['model'] == 'synthetic-existing-model'
        assert event['payload']['items'][0]['url'] == origin + '/page'
        assert 'snippet' not in event['payload']
        assert 'must-not-send' not in json.dumps(event)
        assert worker.evaluate('() => chrome.bookmarks.getTree()') == before
        assert worker.evaluate("async()=> (await chrome.storage.local.get('bookmarkSearchKeywords.v1'))['bookmarkSearchKeywords.v1'] ?? []") == []
        assert frame.get_by_role('button', name=ui('确认收藏保存', 'Confirm bookmark save'), exact=True).count() == 0
        page.screenshot(path=str(root / 'trial-result.png'), full_page=True)
        if args.language == 'en':
            options.get_by_label('Language', exact=True).select_option('zh-CN')
            frame.get_by_text('建议目录：' + folder_title, exact=True).wait_for()
            assert len(events) == 1
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
                  'requests': len(events), 'trialNativeTreeUnchanged': True, 'keywordNativeSaveMoveSearchDelete': args.keywords,
                  'tokenUsagePageAndWorker': args.token_usage, 'tokenUsageGeometry': usage_geometry, 'trialGuideGeometry': guide_geometry,
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
