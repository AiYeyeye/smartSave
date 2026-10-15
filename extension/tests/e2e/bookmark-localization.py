"""Opt-in English bookmark editing in unmodified production dist and a disposable profile."""
import argparse
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
    print('SKIP: pass --run for isolated synthetic bookmark acceptance')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-bookmark-locale-'))

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 340, 'height': 960}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const folder=(await chrome.bookmarks.create({parentId:bar,title:'目标目录'})).id;
          const bookmark=(await chrome.bookmarks.create({parentId:bar,title:'编辑',url:'https://bookmark-locale.test/original'})).id;
          return {bar,folder,bookmark};
        }""")
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/panel/index.html')
        tree = page.get_by_role('list', name='Browser bookmarks', exact=True)
        tree.get_by_role('button', name='Actions for 编辑', exact=True).click()
        geometry = []

        def capture(surface):
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                size = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert size['scroll'] <= width + 1, (surface, size)
                boxes = page.get_by_role('menu').evaluate_all('elements=>elements.map(e=>{const b=e.getBoundingClientRect();return {left:b.left,right:b.right,top:b.top,bottom:b.bottom}})')
                assert all(b['left'] >= 0 and b['right'] <= width + 1 and b['top'] >= 0 and b['bottom'] <= 960 for b in boxes), boxes
                geometry.append({'surface': surface, **size})
                page.screenshot(path=str(root / f'{surface}-{width}.png'), full_page=True)

        capture('menu')
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('menuitem', name='编辑', exact=True)).to_be_visible()
        preferences.get_by_label('语言', exact=True).select_option('en')
        page.get_by_role('menuitem', name='Edit', exact=True).click()
        page.get_by_label('Title', exact=True).fill('删除 <&>')
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_label('标题', exact=True)).to_have_value('删除 <&>')
        assert worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0].title', fixture['bookmark']) == '编辑'
        preferences.get_by_label('语言', exact=True).select_option('en')
        capture('edit')
        page.get_by_role('button', name='Confirm save', exact=True).click()
        expect(tree.get_by_role('button', name='删除 <&>', exact=True)).to_be_visible()
        saved = worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0]', fixture['bookmark'])
        assert saved['title'] == '删除 <&>' and saved['url'] == 'https://bookmark-locale.test/original'
        tree.get_by_role('button', name='Actions for 删除 <&>', exact=True).click()
        page.get_by_role('menuitem', name='Move to…', exact=True).click()
        page.get_by_label('Destination folder', exact=True).select_option(fixture['folder'])
        expect(tree.get_by_role('button', name='删除 <&>', exact=True)).to_have_count(0)
        assert worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0].parentId', fixture['bookmark']) == fixture['folder']
        tree.get_by_role('button', name='目标目录', exact=True).click()
        tree.get_by_role('button', name='Actions for 删除 <&>', exact=True).click()
        page.get_by_role('menuitem', name='Delete', exact=True).click()
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('dialog', name='删除影响确认')).to_contain_text('删除 <&>')
        preferences.get_by_label('语言', exact=True).select_option('en')
        capture('delete-review')
        page.get_by_role('dialog').get_by_role('button', name='Cancel', exact=True).click()
        assert worker.evaluate('async id=>(await chrome.bookmarks.get(id))[0].title', fixture['bookmark']) == '删除 <&>'
        tree.get_by_role('button', name='Actions for 删除 <&>', exact=True).click()
        page.get_by_role('menuitem', name='Delete', exact=True).click()
        page.get_by_role('button', name='Confirm delete', exact=True).click()
        expect(tree.get_by_role('button', name='删除 <&>', exact=True)).to_have_count(0)
        assert worker.evaluate('async id=>(await chrome.bookmarks.getChildren(id)).length', fixture['folder']) == 0
        tree.get_by_role('button', name='Actions for 目标目录', exact=True).click()
        page.get_by_role('menuitem', name='New folder', exact=True).click()
        page.get_by_label('Title', exact=True).fill('New synthetic folder')
        page.get_by_role('button', name='Confirm save', exact=True).click()
        expect(tree.get_by_role('button', name='New synthetic folder', exact=True)).to_be_visible()
        children = worker.evaluate('id=>chrome.bookmarks.getChildren(id)', fixture['folder'])
        assert len(children) == 1 and children[0]['title'] == 'New synthetic folder' and 'url' not in children[0]
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'scope': 'Unmodified production dist, fresh profile and real synthetic native bookmarks. English menu/edit/move/delete/create, cross-document draft and confirmation retention. No provider or existing user profile.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, current in enumerate(context.pages):
            print(current.locator('body').inner_text()[:3000], flush=True)
            current.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
