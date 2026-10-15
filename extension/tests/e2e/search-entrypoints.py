"""Isolated production extension acceptance; browser event delivery is instrumented, never OS shortcut certification."""
import argparse
import hashlib
import json
from pathlib import Path
import shutil
import sys
import tempfile
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser-language', choices=['zh-CN', 'en'], default='zh-CN')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic search entrypoints')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-search-entry-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
worker_file = extension / 'service-worker.js'
original = worker_file.read_text(encoding='utf-8')
prelude = """
globalThis.__searchEvents = {};
globalThis.__browserUi = {menus:[],updates:[]};
const createMenu = chrome.contextMenus.create.bind(chrome.contextMenus);
chrome.contextMenus.create=(details,...rest)=>{__browserUi.menus.push(details);return createMenu(details,...rest)};
const updateMenu = chrome.contextMenus.update.bind(chrome.contextMenus);
chrome.contextMenus.update=(id,details,...rest)=>{__browserUi.updates.push({id,...details});return updateMenu(id,details,...rest)};
const defaultSuggestion = chrome.omnibox.setDefaultSuggestion.bind(chrome.omnibox);
chrome.omnibox.setDefaultSuggestion=details=>{__browserUi.suggestion=details;return defaultSuggestion(details)};
for (const [name,event] of Object.entries({command:chrome.commands.onCommand,changed:chrome.omnibox.onInputChanged,
    entered:chrome.omnibox.onInputEntered,cancelled:chrome.omnibox.onInputCancelled})) {
  const add=event.addListener.bind(event);
  event.addListener=listener=>{(globalThis.__searchEvents[name]??=[]).push(listener);add(listener)};
}
globalThis.__fetchCount=0;
const originalFetch=globalThis.fetch;
globalThis.fetch=(...args)=>{globalThis.__fetchCount++;return originalFetch(...args)};
"""
worker_file.write_text(prelude + original, encoding='utf-8')
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking', f'--lang={args.browser_language}'], viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        context.route('https://search-fixture.test/**', lambda route: route.fulfill(body='<h1>Search fixture</h1>', content_type='text/html'))
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        assert worker.evaluate('()=>chrome.runtime.getManifest().omnibox.keyword') == 'zl'
        english = args.browser_language == 'en'
        manifest = worker.evaluate('()=>chrome.runtime.getManifest()')
        assert manifest['name'] == ('Zhilan · Bookmark Assistant' if english else '智栏 · 书签助手'), manifest
        assert manifest['action']['default_title'] == ('Open Zhilan bookmark sidebar' if english else '打开智栏书签侧栏')
        assert manifest['commands']['search-bookmarks']['description'] == ('Search Zhilan bookmarks' if english else '搜索智栏书签')
        browser_ui = worker.evaluate('()=>__browserUi')
        assert browser_ui['suggestion']['description'] == ('Search bookmarks in Zhilan: <match>%s</match>' if english else '在智栏中搜索书签：<match>%s</match>'), browser_ui
        assert any(menu['title'] == ('Save current page with Zhilan' if english else '使用智栏收藏当前页面') for menu in browser_ui['menus']), browser_ui
        assert browser_ui['updates'] == [{'id':'zhilan-save-page','title':('Save current page with Zhilan' if english else '使用智栏收藏当前页面')}], browser_ui
        assert worker.evaluate("()=>chrome.i18n.getMessage('organizeWorking',['3','10'])") == ('Zhilan: analyzed 3/10 bookmarks; you can close the workspace' if english else '智栏：已分析 3/10 条书签，可关闭工作台')
        item = worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          return chrome.bookmarks.create({parentId:bar,title:'重庆大学 & <课程>',url:'https://search-fixture.test/course'});
        }""")
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#browse')
        expect(page.get_by_role('button', name='重庆大学 & <课程>', exact=True)).to_be_visible()
        suggestions = worker.evaluate("""()=>new Promise(resolve=>__searchEvents.changed[0]('cqdx',resolve))""")
        assert len(suggestions) == 1 and '&amp; &lt;课程&gt;' in suggestions[0]['description'], suggestions
        assert worker.evaluate('()=>__fetchCount') == 0
        worker.evaluate("""text=>__searchEvents.entered[0](text,'currentTab')""", suggestions[0]['content'])
        page.wait_for_url('https://search-fixture.test/course')
        with context.expect_page() as opened:
            worker.evaluate("""()=>__searchEvents.entered[0]('cqdx','newForegroundTab')""")
        search = opened.value
        expect(search.get_by_role('searchbox')).to_have_value('cqdx')
        expect(search.get_by_role('searchbox')).to_be_focused()
        expect(search.locator('.search-hit-list button')).to_have_count(1)
        search.wait_for_url('**/index.html#browse')
        assert 'cqdx' not in search.url
        search.get_by_role('button', name='外观', exact=True).click()
        search.keyboard.press('Control+k')
        expect(search.get_by_role('searchbox')).to_be_focused()
        expect(search.get_by_role('searchbox')).to_have_value('cqdx')
        geometry = []
        for width in [340, 480, 1024]:
            search.set_viewport_size({'width': width, 'height': 960})
            measured = search.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= measured['width'] + 1, measured
            geometry.append(measured)
            search.screenshot(path=str(root / f'search-{width}.png'), full_page=True)
        suggestions = worker.evaluate("""()=>new Promise(resolve=>__searchEvents.changed[0]('cqdx',resolve))""")
        worker.evaluate('(id)=>chrome.bookmarks.remove(id)', item['id'])
        with context.expect_page() as opened:
            worker.evaluate("""text=>__searchEvents.entered[0](text,'newForegroundTab')""", suggestions[0]['content'])
        stale = opened.value
        expect(stale.get_by_role('searchbox')).to_have_value('cqdx')
        expect(stale.locator('.search-hit-list button')).to_have_count(0)
        with context.expect_page() as opened:
            worker.evaluate("""()=>__searchEvents.command.forEach(listener=>listener('search-bookmarks'))""")
        command = opened.value
        expect(command.get_by_role('searchbox')).to_be_focused()
        expect(command.get_by_role('searchbox')).to_have_value('')
        commands = worker.evaluate('()=>chrome.commands.getAll()')
        assert any(command['name'] == 'search-bookmarks' and command['shortcut'] == 'Alt+Shift+K' for command in commands), commands
        after = worker.evaluate('()=>chrome.bookmarks.getTree()')
        assert len(before[0]['children'][0]['children']) - len(after[0]['children'][0].get('children', [])) == 1
        assert worker.evaluate('()=>__fetchCount') == 0
        result = {'status': 'PASS', 'browser': context.browser.version, 'browserLanguage':args.browser_language, 'browserUi':browser_ui, 'evidence': str(root), 'geometry': geometry,
                  'commands': commands, 'zeroModelRequests': True, 'productionWorkerSHA256': hashlib.sha256(original.encode()).hexdigest(),
                  'scope': 'Production assets with event-delivery/fetch instrumentation prepended to worker. Real native fixture and trusted UI handoff. Current-tab selection, stale deletion refusal, raw-query transfer and Ctrl+K focus verified. Physical address-bar typing/default OS shortcut registration still requires manual branded-browser acceptance.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            try:
                page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
            except Exception:
                pass
        raise
    finally:
        context.close()
