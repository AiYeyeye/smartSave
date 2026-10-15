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
            rows = page.locator('.search-hit-list button')
            expect(rows).to_have_count(3)
            for row in rows.all():
                text = row.inner_text()
                assert 'https://' not in text and '根目录' not in text and '\n' not in text
                assert row.get_attribute('title') == text
                assert row.evaluate('e => e.getBoundingClientRect().height') >= 44
                assert row.evaluate('e => getComputedStyle(e).whiteSpace') == 'nowrap'
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'search-{width}.png'), full_page=True, animations='disabled')
            checks.append(f'{width}px: no idle save CTA; 3 title-only single-line results; >=44px targets; no overflow')
        page.set_viewport_size({'width': 380, 'height': 900})
        for width in [320, 380, 480]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base + '?semantic')
            page.get_by_role('searchbox').fill('之前收藏的那个做流程图的网站')
            expect(page.locator('.search-hit-list button')).to_have_count(0)
            page.get_by_role('button', name='AI 帮我找', exact=True).click()
            expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_visible()
            assert page.evaluate('globalThis.__visualTreeConnections.filter(x => x === "zhilan.tree.v1").length') == 1
            requests = page.evaluate('globalThis.__visualSearchRequests')
            assert len(requests) == 1
            assert len(json.loads(requests[0]['input'])['items']) == 3
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'semantic-{width}.png'), full_page=True, animations='disabled')
            page.evaluate('globalThis.__visualTreeState({status: "loading"})')
            expect(page.get_by_role('button', name='diagrams.net', exact=True)).to_be_disabled()
            page.get_by_role('searchbox').fill('MDN')
            expect(page.locator('.search-hit-list button')).to_have_count(1)
            page.evaluate('globalThis.__visualTreeState({status: "error", message: "合成连接中断"})')
            expect(page.locator('.search-hit-list button')).to_have_count(1)
            page.screenshot(path=str(out / f'cached-search-{width}.png'), full_page=True, animations='disabled')
            page.get_by_role('region', name='搜索结果').get_by_role('button', name='重试读取', exact=True).click()
            expect(page.locator('.search-hit-list button')).to_be_enabled()
            assert page.evaluate('globalThis.__visualTreeConnections.filter(x => x === "zhilan.tree.v1").length') == 2
            checks.append(f'{width}px: zero keyword hits -> AI result from full catalog; one shared port; cached search while loading/error; explicit recovery')
        page.set_viewport_size({'width': 380, 'height': 900})
        page.goto(base + '?pending')
        title = page.get_by_label('收藏标题', exact=True)
        expect(title).to_be_visible()
        title.fill('保留的手写草稿')
        page.get_by_role('button', name='设置', exact=True).click()
        expect(page.get_by_role('region', name='收藏确认卡')).to_be_hidden()
        page.get_by_role('button', name='返回书签', exact=True).click()
        expect(title).to_have_value('保留的手写草稿')
        checks.append('Explicitly captured session still renders SaveCard and retains edited title across settings')
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
        expect(page.get_by_text('正在等待 AI 返回整理建议', exact=False)).to_be_visible()
        expect(page.locator('.busy-spinner:visible')).to_have_count(1)
        page.screenshot(path=str(out / 'organize-waiting.png'), full_page=True, animations='disabled')
        page.get_by_role('button', name='停止当前任务', exact=True).click()
        expect(page.locator('.busy-spinner:visible')).to_have_count(0)
        expect(page.get_by_role('button', name='上一步', exact=True)).to_be_enabled()
        checks.append('Actual organize controller/model boundary shows analysis wait state; cancel immediately releases controls')
        assert not errors, errors
        result = {'checks': checks, 'browser': browser.version, 'errors': errors,
                  'scope': 'Production App/CSS, shared tree client, local/semantic search, move and organize controllers; synthetic Chrome tree/capture/mutation and model replies. Semantic recall wiring verified, not live-provider search quality. No real bookmark writes or external model calls.'}
        (out / 'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True, indent=2))
    finally:
        if errors:
            print(json.dumps({'errors': errors}, ensure_ascii=True))
        browser.close()
        server.shutdown()
