"""Opt-in production Chromium acceptance. Fresh profile and synthetic native bookmarks only."""
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
    print('SKIP: pass --run for isolated synthetic duplicate cleanup')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-duplicates-'))

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const root=await chrome.bookmarks.create({parentId:bar,title:'Duplicate fixture'});
          const urls=[['Keep A','http://www.example.test/article/?utm_source='+('long-source'.repeat(20))+'#part'],
          ['Delete B','https://example.test/article#part'],['Unselected C','https://www.example.test/article/?utm_campaign=mail#part'],
          ['Different content','https://example.test/article?id=2#part'],['Exact D','https://exact.test/'],['Exact E','https://exact.test/']];
          const items=[]; for(const [title,url] of urls) items.push(await chrome.bookmarks.create({parentId:root.id,title,url}));
          return {root:root.id,items};
        }""")
        before = worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root'])
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#organize')
        page.get_by_role('radio', name='清理重复书签', exact=False).check()
        page.get_by_label('整理范围', exact=True).select_option(fixture['root'])
        page.get_by_role('button', name='下一步：查找重复书签', exact=True).click()
        expect(page.get_by_role('heading', name='精确重复 · 2 条', exact=True)).to_be_visible()
        expect(page.get_by_role('heading', name='疑似重复 · 3 条', exact=True)).to_be_visible()
        assert page.locator('.duplicate-review select').count() == 5
        for select in page.locator('.duplicate-review select').all():
            expect(select).to_have_value('unselected')
        for item in fixture['items'][:3]:
            expect(page.locator('.duplicate-review').get_by_text(item['url'], exact=True)).to_be_visible()
        expect(page.get_by_label('Different content 保留或删除', exact=True)).to_have_count(0)
        page.get_by_label('Delete B 保留或删除', exact=True).select_option('delete')
        expect(page.get_by_role('button', name='生成去重预览', exact=True)).to_be_disabled()
        page.get_by_label('Keep A 保留或删除', exact=True).select_option('keep')
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        geometry = []
        for width in [340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.evaluate('scrollTo(0,0)')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= measured['width'] + 1, measured
            geometry.append(measured)
            page.screenshot(path=str(root / f'duplicate-review-{width}.png'), full_page=True)
        page.get_by_role('button', name='生成去重预览', exact=True).click()
        page.get_by_role('button', name='下一步：确认操作', exact=True).click()
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        page.get_by_role('button', name='确认并执行 1 项操作', exact=True).click()
        page.get_by_text('状态 completed', exact=False).wait_for()
        after = worker.evaluate('async id=>(await chrome.bookmarks.getSubTree(id))[0].children', fixture['root'])
        assert [item['id'] for item in after] == [item['id'] for item in fixture['items'] if item['title'] != 'Delete B']
        assert [item['url'] for item in after] == [item['url'] for item in fixture['items'] if item['title'] != 'Delete B']
        records = worker.evaluate("""async () => {
          const db=await new Promise((r,j)=>{const q=indexedDB.open('zhilan-operations');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
          try{return await new Promise((r,j)=>{const q=db.transaction('operations').objectStore('operations').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}finally{db.close()}
        }""")
        assert len(records) == 1 and records[0]['result']['status'] == 'completed'
        assert fixture['items'][1]['url'] in json.dumps(records[0]['backup'])
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'deleted': fixture['items'][1]['id'], 'remaining': len(after), 'journalBackup': True,
                  'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Unmodified production dist; isolated native fixture, no configured model. Explicit preview/final deletion, retained originals and durable backup verified. Not branded-browser release acceptance.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            print(page.url, page.locator('body').inner_text()[-6000:], flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
