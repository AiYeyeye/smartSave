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
        '--disable-background-networking'], viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        context.route('https://search-fixture.test/**', lambda route: route.fulfill(body='<h1>Search fixture</h1>', content_type='text/html'))
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        assert worker.evaluate('()=>chrome.runtime.getManifest().omnibox.keyword') == 'zl'
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
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
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
