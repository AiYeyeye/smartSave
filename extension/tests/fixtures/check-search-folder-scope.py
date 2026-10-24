"""Production App/CSS folder-scoped search with synthetic browser/model boundaries."""
import argparse
import functools
import json
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('preview', type=Path)
parser.add_argument('output', type=Path)
parser.add_argument('--browser', required=True)
args = parser.parse_args()
args.output.mkdir(parents=True, exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(args.preview.resolve())))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/index.html'
checks = []
errors = []
try:
    with sync_playwright() as p:
        browser = p.chromium.launch(executable_path=args.browser, headless=True)
        try:
            page = browser.new_page(viewport={'width': 380, 'height': 900}, reduced_motion='reduce')
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.route('https://**/*', lambda route: route.abort())
            for surface in ['panel', 'options']:
                page.goto(base + f'?semantic-large&folder-scope&{surface}#browse')
                page.evaluate("localStorage.setItem('zhilan.language', 'zh-CN'); dispatchEvent(new StorageEvent('storage', {key:'zhilan.language',newValue:'zh-CN'}))")
                page.get_by_role('searchbox').fill('example.test')
                folder = page.get_by_role('combobox', name='搜索文件夹', exact=True)
                expect(folder).to_have_value('')
                expect(page.locator('.search-hit-open')).to_have_count(203)
                value = folder.locator('option').evaluate_all("options=>options.find(o=>o.value && JSON.parse(o.value).nativeId==='root').value")
                folder.select_option(value)
                expect(page.locator('.search-hit-open')).to_have_count(202)
                page.get_by_role('searchbox').fill('之前收藏的那个做流程图的网站')
                page.get_by_role('button', name='AI 帮我找', exact=True).click()
                expect(page.get_by_role('button', name='继续搜索剩余书签', exact=True)).to_be_visible()
                expect(page.get_by_text('已检查 100 / 203 条 · 匹配 1 条 · 无法确定 1 条', exact=True)).to_be_visible()
                for language in ['zh-CN', 'en']:
                    page.evaluate("language=>{localStorage.setItem('zhilan.language',language);dispatchEvent(new StorageEvent('storage',{key:'zhilan.language',newValue:language}))}", language)
                    label = 'Search folder' if language == 'en' else '搜索文件夹'
                    expect(page.get_by_role('combobox', name=label, exact=True)).to_have_value(value)
                    for width in [320, 380, 480]:
                        page.set_viewport_size({'width': width, 'height': 900})
                        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                        geometry = page.evaluate("""()=>{
                          const box=s=>document.querySelector(s).getBoundingClientRect();
                          return {width:innerWidth,scroll:document.documentElement.scrollWidth,
                            filters:box('.search-filters').bottom,heading:box('.search-results-heading').top,
                            headingBottom:box('.search-results-heading').bottom,rows:box('.search-hit-list').top,
                            fields:[...document.querySelectorAll('.search-filters select')].map(e=>e.getBoundingClientRect().width)};
                        }""")
                        assert geometry['scroll'] <= width + 1, geometry
                        assert geometry['heading'] - geometry['filters'] >= 16, geometry
                        assert geometry['rows'] > geometry['headingBottom'], geometry
                        assert all(field >= 90 for field in geometry['fields']), geometry
                        assert page.evaluate('globalThis.__visualSearchRequests.length') == 2
                        page.screenshot(path=str(args.output / f'{surface}-{language}-{width}.png'), full_page=True)
                page.get_by_role('button', name='Search remaining bookmarks', exact=True).click()
                page.wait_for_function('globalThis.__visualSearchRequests.length === 3')
                page.evaluate('globalThis.__visualFinishSearch()')
                page.wait_for_function('globalThis.__visualSearchRequests.length === 4')
                page.evaluate('globalThis.__visualFinishSearch()')
                expect(page.get_by_text('Checked 203 / 203 · Matches 3 · Uncertain 1', exact=True)).to_be_visible()
                payloads = page.evaluate('globalThis.__visualSearchRequests.map(r=>JSON.parse(r.input[1].content))')
                assert {profile['id'] for profile in payloads[0]['folderProfiles']} == {'design', 'dev'}
                ids = [item['id'] for payload in payloads for item in payload['items']]
                assert len(ids) == len(set(ids)) == 203
                assert 'outside-hit' not in ids and 'OUTSIDE_DRAWING_BOOKMARK' not in json.dumps(payloads)
                page.get_by_role('searchbox').fill('example.test')
                folder = page.get_by_role('combobox', name='Search folder', exact=True)
                dev = folder.locator('option').evaluate_all("options=>options.find(o=>o.value && JSON.parse(o.value).nativeId==='dev').value")
                folder.focus()
                folder.press('ArrowDown')
                folder.press('Enter')
                folder.select_option(dev)
                expect(page.locator('.search-hit-open')).to_have_count(201)
                expect(page.get_by_role('button', name='Search remaining bookmarks', exact=True)).to_have_count(0)
                assert page.evaluate('globalThis.__visualSearchRequests.length') == 4
                page.set_viewport_size({'width': 320, 'height': 900})
                expect(folder).to_be_focused()
                assert '开发手册与长期学习参考资料' in folder.locator('option:checked').inner_text()
                assert page.evaluate('document.documentElement.scrollWidth <= innerWidth + 1')
                page.locator('.search-results').screenshot(path=str(args.output / f'{surface}-long-folder-320.png'))
                checks.append(f'{surface}: global/local subtree filtering, scoped plan and 100/100/3 continuation; bilingual 320/380/480px layout and retained selection')
            assert not errors, errors
            result = {'checks': checks, 'errors': errors, 'browser': browser.version,
                      'scope': 'Production App and CSS; synthetic browser tree and provider responses, disposable profile. No personal bookmarks or real model calls.'}
            (args.output / 'checks.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
            print(json.dumps(result, indent=2))
        finally:
            browser.close()
finally:
    server.shutdown()
