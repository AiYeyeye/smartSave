"""Actual popup App/CSS with synthetic Chrome boundaries; no native bookmark writes."""
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

preview = Path(sys.argv[1]).resolve()
out = Path(sys.argv[2]).resolve()
out.mkdir(parents=True, exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
base = f'http://127.0.0.1:{server.server_port}/index.html'
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        page = browser.new_page(viewport={'width': 380, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**/*', lambda route: route.abort())
        for width in [320, 380, 480]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base)
            expect(page.locator('.bookmark-open')).to_have_count(3)
            expect(page.get_by_role('button', name='收藏当前页面', exact=True)).to_have_count(0)
            expect(page.locator('.current-page-capture')).to_have_count(0)
            page.screenshot(path=str(out / f'browse-{width}.png'), full_page=True, animations='disabled')
            page.get_by_role('searchbox').fill('example')
            rows = page.locator('.search-hit-list .search-hit-open')
            expect(rows).to_have_count(3)
            for row in rows.all():
                text = row.inner_text()
                assert 'https://' not in text and '根目录' not in text and '\n' not in text
                assert row.get_attribute('title') == text
                assert row.evaluate('e => e.getBoundingClientRect().height') >= 28
                assert row.evaluate('e => getComputedStyle(e).whiteSpace') == 'nowrap'
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'search-{width}.png'), full_page=True, animations='disabled')
            checks.append(f'{width}px: no idle save CTA; 3 title-only single-line results; >=28px compact rows; no overflow')
        page.set_viewport_size({'width': 380, 'height': 900})
        for width in [320, 380, 480]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base + '?semantic')
            page.get_by_role('searchbox').fill('之前收藏的那个做流程图的网站')
            expect(page.locator('.search-hit-list .search-hit-open')).to_have_count(0)
            page.get_by_role('button', name='AI 帮我找', exact=True).click()
            expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
            assert page.evaluate('globalThis.__visualTreeConnections.filter(x => x === "zhilan.tree.v1").length') == 1
            requests = page.evaluate('globalThis.__visualSearchRequests')
            assert len(requests) == 1
            assert len(json.loads(requests[0]['input'][1]['content'])['items']) == 3
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'semantic-{width}.png'), full_page=True, animations='disabled')
            page.evaluate('globalThis.__visualTreeState({status: "loading"})')
            expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_disabled()
            page.get_by_role('searchbox').fill('MDN')
            expect(page.locator('.search-hit-list .search-hit-open')).to_have_count(1)
            page.evaluate('globalThis.__visualTreeState({status: "error", message: "合成连接中断"})')
            expect(page.locator('.search-hit-list .search-hit-open')).to_have_count(1)
            page.screenshot(path=str(out / f'cached-search-{width}.png'), full_page=True, animations='disabled')
            page.get_by_role('region', name='搜索结果').get_by_role('button', name='重试读取', exact=True).click()
            expect(page.locator('.search-hit-list .search-hit-open')).to_be_enabled()
            assert page.evaluate('globalThis.__visualTreeConnections.filter(x => x === "zhilan.tree.v1").length') == 2
            checks.append(f'{width}px: zero keyword hits -> AI result from full catalog; one shared port; cached search while loading/error; explicit recovery')
        page.set_viewport_size({'width': 380, 'height': 900})
        for width in [320, 380, 480]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base + '?semantic-large')
            page.get_by_role('searchbox').fill('之前收藏的那个做流程图的网站')
            expect(page.locator('.search-hit-list .search-hit-open')).to_have_count(0)
            page.get_by_role('button', name='AI 帮我找', exact=True).click()
            expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
            payloads = page.evaluate('globalThis.__visualSearchRequests.map(r => JSON.parse(r.input[1].content))')
            page.wait_for_function('globalThis.__visualSearchRequests.length === 2')
            expect(page.get_by_role('region', name='搜索结果')).to_have_attribute('aria-busy', 'false')
            expect(page.get_by_role('button', name='继续搜索剩余书签', exact=True)).to_be_visible()
            expect(page.get_by_text('已检查 100 / 203 条 · 匹配 1 条 · 无法确定 1 条', exact=True)).to_be_visible()
            page.screenshot(path=str(out / f'progressive-first-{width}.png'), full_page=True, animations='disabled')
            if width == 320:
                page.evaluate("localStorage.setItem('zhilan.language', 'en'); dispatchEvent(new StorageEvent('storage', {key: 'zhilan.language', newValue: 'en'}))")
                expect(page.get_by_text('Checked 100 / 203 · Matches 1 · Uncertain 1', exact=True)).to_be_visible()
                expect(page.get_by_role('region', name='Search results')).to_have_attribute('aria-busy', 'false')
                expect(page.get_by_role('button', name='Search remaining bookmarks', exact=True)).to_be_visible()
                assert page.evaluate('globalThis.__visualSearchRequests.length') == 2
                page.screenshot(path=str(out / 'progressive-en-320.png'), full_page=True, animations='disabled')
                page.evaluate("localStorage.setItem('zhilan.language', 'zh-CN'); dispatchEvent(new StorageEvent('storage', {key: 'zhilan.language', newValue: 'zh-CN'}))")
            page.get_by_role('button', name='继续搜索剩余书签', exact=True).click()
            page.wait_for_function('globalThis.__visualSearchRequests.length === 3')
            expect(page.get_by_role('region', name='搜索结果')).to_have_attribute('aria-busy', 'true')
            page.evaluate('globalThis.__visualFinishSearch()')
            expect(page.get_by_role('button', name='Flowchart reference second batch', exact=True)).to_be_visible()
            page.wait_for_function('globalThis.__visualSearchRequests.length === 4')
            expect(page.get_by_text('已检查 200 / 203 条 · 匹配 2 条 · 无法确定 1 条', exact=True)).to_be_visible()
            page.evaluate('globalThis.__visualFinishSearch()')
            expect(page.get_by_role('button', name='Flowchart reference final batch', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='AI 帮我找', exact=True)).to_be_enabled()
            expect(page.get_by_role('button', name='深度搜索', exact=True)).to_have_count(0)
            segments = page.evaluate("globalThis.__visualSearchRequests.map(r => JSON.parse(r.input[1].content)).filter(r => r.task === 'search-batch')")
            plan = page.evaluate('JSON.parse(globalThis.__visualSearchRequests[0].input[1].content)')
            assert plan['task'] == 'search-plan' and not plan['items']
            assert {f['id'] for f in plan['folderProfiles']} == {'design', 'dev'}
            assert [len(part['items']) for part in segments] == [100, 100, 3]
            assert all(part['task'] == 'search-batch' for part in segments)
            assert len({item['id'] for part in segments for item in part['items']}) == 203
            page.get_by_text('无法确定是否相关（1）', exact=True).click()
            expect(page.get_by_role('button', name='Archive reference 5', exact=True)).to_be_visible()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'progressive-complete-{width}.png'), full_page=True, animations='disabled')
            checks.append(f'{width}px: folder plan, paused first results and explicit continuation to 100/100/3 coverage; uncertainty accessible; no overflow')
        page.goto(base + '?semantic-large')
        page.get_by_role('searchbox').fill('之前收藏的那个做流程图的网站')
        page.get_by_role('button', name='AI 帮我找', exact=True).click()
        page.wait_for_function('globalThis.__visualSearchRequests.length === 2')
        expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
        page.get_by_role('button', name='继续搜索剩余书签', exact=True).click()
        page.wait_for_function('globalThis.__visualSearchRequests.length === 3')
        page.get_by_role('button', name='取消 AI 搜索', exact=True).click()
        page.evaluate('globalThis.__visualFinishSearch()')
        expect(page.get_by_role('region', name='搜索结果')).to_have_attribute('aria-busy', 'false')
        expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
        expect(page.get_by_role('button', name='Flowchart reference second batch', exact=True)).to_have_count(0)
        assert page.evaluate('globalThis.__visualSearchRequests.length') == 3
        page.screenshot(path=str(out / 'progressive-cancel.png'), full_page=True, animations='disabled')
        page.get_by_role('searchbox').fill('site:app.diagrams.net')
        page.get_by_role('button', name='AI 帮我找', exact=True).click()
        expect(page.get_by_role('region', name='搜索结果')).to_have_attribute('aria-busy', 'false')
        expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
        assert page.evaluate('globalThis.__visualSearchRequests.length') == 3
        checks.append('Cancellation preserves first-batch results and fences late replies; explicit site query completes locally without another request')
        page.goto(base + '?pending')
        expect(page.get_by_label('收藏标题', exact=True)).to_have_count(0)
        expect(page.locator('.receipt')).to_have_count(0)
        page.goto(base + '?save-dialog&pending')
        title = page.get_by_label('收藏标题', exact=True)
        expect(title).to_be_visible()
        title.fill('保留的手写草稿')
        page.evaluate("localStorage.setItem('zhilan.language', 'en'); dispatchEvent(new StorageEvent('storage', {key: 'zhilan.language', newValue: 'en'}))")
        expect(title).to_have_value('保留的手写草稿')
        page.evaluate("localStorage.setItem('zhilan.language', 'zh-CN'); dispatchEvent(new StorageEvent('storage', {key: 'zhilan.language', newValue: 'zh-CN'}))")
        checks.append('Explicit capture lives in a separate save document; sidebar has no save card; language preserves draft')
        page.goto(base + '?interactions')
        page.get_by_role('button', name='Figma — 把想法变成作品 操作', exact=True).click()
        page.get_by_role('menuitem', name='移入…', exact=True).click()
        page.get_by_label('目标目录', exact=True).select_option('dev')
        expect(page.get_by_role('button', name='确认保存', exact=True)).to_have_count(0)
        expect(page.get_by_text('正在移动书签…', exact=True)).to_be_visible()
        page.screenshot(path=str(out / 'moving-380.png'), full_page=True, animations='disabled')
        expect(page.get_by_text('已完成', exact=False)).to_be_visible()
        assert page.evaluate('globalThis.__visualSubmitted.length') == 1
        checks.append('Destination selection submits one move immediately; visible waiting state; no confirmation CTA')
        page.goto(base + '?options&interactions#organize')
        page.get_by_label('整理范围', exact=True).select_option('root')
        page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
        expect(page.get_by_text('正在逐条分析全部书签', exact=True)).to_be_visible()
        expect(page.locator('.busy-spinner:visible')).to_have_count(1)
        page.screenshot(path=str(out / 'organize-waiting.png'), full_page=True, animations='disabled')
        page.get_by_role('button', name='暂停后续批次', exact=True).click()
        expect(page.locator('.busy-spinner:visible')).to_have_count(0)
        expect(page.get_by_role('button', name='上一步', exact=True)).to_be_enabled()
        checks.append('Actual organize controller/model boundary shows analysis wait state; cancel immediately releases controls')
        assert not errors, errors
        result = {'checks': checks, 'browser': browser.version, 'errors': errors,
                  'scope': 'Production App/CSS, shared tree client, local/semantic search, move and organize controllers; synthetic Chrome tree/capture/mutation and model replies. Semantic recall wiring verified, not live-provider search quality. No real bookmark writes or external model calls.'}
        (out / 'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True, indent=2))
    except Exception:
        page.screenshot(path=str(out / 'failure.png'), full_page=True, animations='disabled')
        (out / 'failure.txt').write_text(page.locator('body').inner_text(), encoding='utf-8')
        print(page.locator('body').inner_text()[-3500:])
        raise
    finally:
        if errors:
            print(json.dumps({'errors': errors}, ensure_ascii=True))
        browser.close()
        server.shutdown()
