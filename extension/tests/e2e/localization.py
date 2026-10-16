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
        expect(page.locator('.search-hit-list .search-hit-open')).to_have_text(['搜索书签'])
        page.locator('summary', has_text='Search shortcuts').click()
        expect(page.get_by_text('Press Alt+Shift+K to open search.', exact=False)).to_contain_text('zl')
        # Exercise the real storage.sync boundary without signing in or sending fixture data to a cloud account.
        preferences.get_by_role('radio', name='Dark', exact=True).check()
        preferences.wait_for_function("async()=> (await chrome.storage.sync.get('zhilan.preference.mode.v1'))['zhilan.preference.mode.v1']?.value==='dark'")
        assert worker.evaluate("async()=>Object.keys(await chrome.storage.sync.get(null)).every(key=>['zhilan.preference.language.v1','zhilan.preference.mode.v1','zhilan.preference.accent.v1'].includes(key))")
        worker.evaluate("()=>chrome.storage.sync.set({'zhilan.preference.accent.v1':{version:1,value:'teal'}})")
        expect(page.locator('.theme-root')).to_have_attribute('data-accent', 'teal')
        expect(preferences.locator('.theme-root')).to_have_attribute('data-accent', 'teal')
        expect(page.get_by_role('searchbox')).to_have_value('搜索书签')
        worker.evaluate("()=>chrome.storage.sync.set({'zhilan.preference.language.v1':{version:1,value:'zh-CN'}})")
        expect(page.get_by_role('searchbox', name='搜索书签')).to_have_value('搜索书签')
        worker.evaluate("()=>chrome.storage.sync.set({'zhilan.preference.language.v1':{version:1,value:'en'}})")
        expect(preferences.get_by_role('heading', name='Appearance', exact=True)).to_be_visible()
        geometry = []
        for width in [320, 340, 480, 1024]:
            for target, name in [(page, 'search'), (preferences, 'appearance')]:
                target.set_viewport_size({'width': width, 'height': 960})
                measured = target.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= measured['width'] + 1, (name, measured)
                geometry.append({'surface': name, **measured})
                target.screenshot(path=str(root / f'{name}-{width}.png'), full_page=True)
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('searchbox', name='搜索书签')).to_have_value('搜索书签')
        expect(page.locator('.search-hit-list .search-hit-open')).to_have_text(['搜索书签'])
        page.reload()
        expect(page.get_by_role('searchbox', name='搜索书签')).to_be_visible()
        # A forged embedded panel must show localized recovery instructions without mounting App.
        preferences.get_by_label('语言', exact=True).select_option('en')
        page.evaluate("""url=>{
          window.__bootClose=0;
          const frame=document.createElement('iframe');frame.id='invalid-overlay';frame.src=url;
          frame.style.cssText='width:320px;height:560px;border:0';
          window.addEventListener('message',event=>{if(event.source===frame.contentWindow&&event.data?.type==='zhilan-overlay-close')window.__bootClose++});
          document.body.append(frame);
        }""", f'chrome-extension://{extension_id}/panel/index.html#overlay=invalid-token')
        boot = page.frame_locator('#invalid-overlay')
        expect(boot.get_by_role('heading', name='Could not start the sidebar', exact=True)).to_be_visible()
        expect(boot.locator('.bookmark-tree')).to_have_count(0)
        page.locator('#invalid-overlay').screenshot(path=str(root / 'overlay-error-320.png'))
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(boot.get_by_role('heading', name='侧栏启动验证未通过', exact=True)).to_be_visible()
        boot.get_by_role('button', name='关闭侧栏', exact=True).click()
        page.wait_for_function('()=>window.__bootClose===1')
        after = worker.evaluate('()=>chrome.bookmarks.getTree()')
        assert before == after
        assert worker.evaluate('()=>chrome.runtime.getManifest().omnibox.keyword') == 'zl'
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'nativeBookmarksUnchanged': True, 'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Unmodified production build; local preference persistence and actual storage.sync get/set/change propagation for the three allowlisted preferences. No signed-in account or cross-device cloud delivery claim. Cross-document switching retains query/native title; English search/appearance at320/340/480/1024. Forged embedded panel shows localized startup failure and sends close only. Other workspaces have separate acceptance fixtures.'}
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
