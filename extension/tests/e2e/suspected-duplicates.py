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
parser.add_argument('--language', choices=['zh-CN', 'en'], default='zh-CN')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic duplicate cleanup')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-duplicates-'))
def text(zh, en):
    return en if args.language == 'en' else zh

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
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        if args.language == 'en':
            preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#organize')
        page.get_by_role('radio', name=text('清理重复书签', 'Review duplicate bookmarks'), exact=False).check()
        page.get_by_label(text('整理范围', 'Organization scope'), exact=True).select_option(fixture['root'])
        page.get_by_role('button', name=text('下一步：查找重复书签', 'Next: find duplicates'), exact=True).click()
        expect(page.get_by_role('heading', name=text('精确重复 · 2 条', 'Exact duplicates · 2'), exact=True)).to_be_visible()
        expect(page.get_by_role('heading', name=text('疑似重复 · 3 条', 'Possible duplicates · 3'), exact=True)).to_be_visible()
        assert page.locator('.duplicate-review select').count() == 5
        for select in page.locator('.duplicate-review select').all():
            expect(select).to_have_value('unselected')
        for item in fixture['items'][:3]:
            expect(page.locator('.duplicate-review').get_by_text(item['url'], exact=True)).to_be_visible()
        expect(page.get_by_label(text('Different content 保留或删除', 'Keep or delete Different content'), exact=True)).to_have_count(0)
        page.get_by_label(text('Delete B 保留或删除', 'Keep or delete Delete B'), exact=True).select_option('delete')
        expect(page.get_by_role('button', name=text('生成去重预览', 'Preview duplicate cleanup'), exact=True)).to_be_disabled()
        page.get_by_label(text('Keep A 保留或删除', 'Keep or delete Keep A'), exact=True).select_option('keep')
        if args.language == 'en':
            preferences.get_by_label('Language', exact=True).select_option('zh-CN')
            expect(page.get_by_label('Delete B 保留或删除', exact=True)).to_have_value('delete')
            expect(page.get_by_label('Keep A 保留或删除', exact=True)).to_have_value('keep')
            preferences.get_by_label('语言', exact=True).select_option('en')
            expect(page.get_by_label('Keep or delete Delete B', exact=True)).to_have_value('delete')
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        geometry = []
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            page.evaluate('scrollTo(0,0)')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= measured['width'] + 1, measured
            geometry.append(measured)
            page.screenshot(path=str(root / f'duplicate-review-{width}.png'), full_page=True)
        page.get_by_role('button', name=text('生成去重预览', 'Preview duplicate cleanup'), exact=True).click()
        page.get_by_text(text('完整分类树与内容去向', 'Full folder tree and bookmark destinations'), exact=True).click()
        if args.language == 'en':
            page.get_by_text('Folder changes and other operations · 1', exact=True).click()
            expect(page.get_by_text('Reason: Remove possible duplicates after individual review, keeping the explicitly chosen copies.', exact=True)).to_be_visible()
        expect(page.get_by_role('heading', name=text('预计整理后的分类', 'Proposed folders'), exact=True)).to_be_visible()
        expect(page.get_by_text(text('→ 删除重复书签 · 1 条书签', '→ Delete duplicate bookmarks · Bookmarks: 1'), exact=True)).to_be_visible()
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= width + 1, measured
            geometry.append({'surface': 'preview', **measured})
            page.screenshot(path=str(root / f'duplicate-preview-{width}.png'), full_page=True)
        page.get_by_role('button', name=text('下一步：确认操作', 'Next: confirm changes'), exact=True).click()
        assert worker.evaluate('(id)=>chrome.bookmarks.getSubTree(id)', fixture['root']) == before
        page.get_by_role('button', name=text('确认并执行 1 项操作', 'Confirm and apply operations (1)'), exact=True).click()
        page.get_by_text(text('状态 completed', 'Status: completed'), exact=False).wait_for()
        after = worker.evaluate('async id=>(await chrome.bookmarks.getSubTree(id))[0].children', fixture['root'])
        assert [item['id'] for item in after] == [item['id'] for item in fixture['items'] if item['title'] != 'Delete B']
        assert [item['url'] for item in after] == [item['url'] for item in fixture['items'] if item['title'] != 'Delete B']
        records = worker.evaluate("""async () => {
          const db=await new Promise((r,j)=>{const q=indexedDB.open('zhilan-operations');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
          try{return await new Promise((r,j)=>{const q=db.transaction('operations').objectStore('operations').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}finally{db.close()}
        }""")
        assert len(records) == 1 and records[0]['result']['status'] == 'completed'
        assert fixture['items'][1]['url'] in json.dumps(records[0]['backup'])
        # The same real journal powers undo. Locale changes must preserve consent without writing.
        workbench = page.get_by_role('region', name=text('整理工作台', 'Organization workbench'), exact=True)
        workbench.get_by_text(text('恢复与撤销记录', 'Recovery and undo records'), exact=True).click()
        recovery = workbench.get_by_role('region', name=text('备份与恢复', 'Backup and recovery'), exact=True)
        recovery.get_by_role('button', name=text('预览撤销', 'Preview undo'), exact=True).click()
        preview = recovery.get_by_role('region', name=text('恢复预览', 'Recovery preview'), exact=True)
        expect(preview).to_contain_text(fixture['items'][1]['title'])
        expect(preview).to_contain_text(fixture['items'][1]['url'])
        expect(preview).to_contain_text(text('新建的恢复节点会追加到目标目录末尾', 'Newly restored items are appended to the destination folder'))
        preview.get_by_role('checkbox', name=text('确认以上影响范围', 'Confirm the impact shown above'), exact=True).check()
        if args.language == 'en':
            preferences.get_by_label('Language', exact=True).select_option('zh-CN')
            expect(page.get_by_role('checkbox', name='确认以上影响范围', exact=True)).to_be_checked()
            preferences.get_by_label('语言', exact=True).select_option('en')
            expect(preview.get_by_role('checkbox', name='Confirm the impact shown above', exact=True)).to_be_checked()
        assert worker.evaluate('async id=>(await chrome.bookmarks.getSubTree(id))[0].children', fixture['root']) == after
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= width + 1, measured
            geometry.append({'surface': 'recovery-preview', **measured})
            preview.scroll_into_view_if_needed()
            page.screenshot(path=str(root / f'recovery-preview-{width}.png'))
        preview.get_by_role('button', name=text('应用撤销', 'Apply undo'), exact=True).click()
        expect(recovery).to_contain_text(text('执行子计划 completed', 'execution subplan completed'))
        restored = worker.evaluate('async id=>(await chrome.bookmarks.getSubTree(id))[0].children', fixture['root'])
        assert sorted((item['title'], item['url']) for item in restored) == sorted((item['title'], item['url']) for item in fixture['items'])
        assert restored[:-1] == after  # Existing identities and order remain intact.
        assert restored[-1]['id'] != fixture['items'][1]['id']
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'reviewLanguage': args.language, 'crossDocumentSelectionRetained': args.language == 'en',
                  'deleted': fixture['items'][1]['id'], 'remaining': len(after), 'journalBackup': True,
                  'explicitUndoRestored': True, 'undoConsentRetainedAcrossLocale': args.language == 'en',
                  'restoredOrder': 'New identities appended, disclosed before applying; original order not guaranteed.',
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
