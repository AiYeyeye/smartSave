"""Production localization smoke test in a fresh profile; synthetic native bookmarks, no AI service."""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated localization acceptance')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-locale-'))
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          await chrome.bookmarks.create({parentId:bar,title:'搜索书签',url:'https://locale-fixture.test/original'});
        }""")
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        expect(preferences.get_by_role('heading', name='Appearance', exact=True)).to_be_visible()
        expect(preferences.locator('html')).to_have_attribute('lang', 'en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#browse')
        expect(page.get_by_role('searchbox', name='Search bookmarks')).to_be_visible()
        page.get_by_role('searchbox').fill('搜索书签')
        expect(page.locator('.search-hit-list button')).to_have_text(['搜索书签'])
        page.locator('summary', has_text='Search shortcuts').click()
        expect(page.get_by_text('Press Alt+Shift+K to open search.', exact=False)).to_contain_text('zl')
        geometry = []
        for width in [340, 480, 1024]:
            for target, name in [(page, 'search'), (preferences, 'appearance')]:
                target.set_viewport_size({'width': width, 'height': 960})
                measured = target.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= measured['width'] + 1, (name, measured)
                geometry.append({'surface': name, **measured})
                target.screenshot(path=str(root / f'{name}-{width}.png'), full_page=True)
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('searchbox', name='搜索书签')).to_have_value('搜索书签')
        expect(page.locator('.search-hit-list button')).to_have_text(['搜索书签'])
        page.reload()
        expect(page.get_by_role('searchbox', name='搜索书签')).to_be_visible()
        after = worker.evaluate('()=>chrome.bookmarks.getTree()')
        assert before == after
        assert worker.evaluate('()=>chrome.runtime.getManifest().omnibox.keyword') == 'zl'
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'nativeBookmarksUnchanged': True, 'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Unmodified production build; local preference persistence, cross-document switching, native-title preservation and English search/appearance at 340/480/1024. Other workspaces are not yet fully localized.'}
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
