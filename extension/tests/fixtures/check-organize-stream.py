"""Production App/worker/controller/transport with synthetic Chrome and SSE; no native writes."""
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

preview, out = (Path(value).resolve() for value in sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)


class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args):
        pass


server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        page = browser.new_page(viewport={'width': 380, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**/*', lambda route: route.abort())

        def requests():
            return page.evaluate('globalThis.__visualSearchRequests.map(r => JSON.parse(r.input[1].content))')

        def finish(index):
            page.wait_for_function('(n) => globalThis.__visualSearchRequests.length > n', arg=index)
            page.evaluate('(n) => globalThis.__visualFinishOrganize(false, n)', index)

        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(f'http://127.0.0.1:{server.server_port}/index.html?options&organize-stream&organize-taxonomy&organize-batches&organize-revision&width={width}#organize')
            page.get_by_label('整理范围', exact=True).select_option('root')
            page.get_by_text('高级选项', exact=True).click()
            page.get_by_label('每批最多书签', exact=True).fill('10')
            page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
            page.wait_for_function('globalThis.__visualSearchRequests.length === 1')
            expect(page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_disabled()
            expect(page.get_by_text('预计整理后的分类', exact=True)).to_have_count(0)
            page.screenshot(path=str(out / f'analysis-{width}.png'), full_page=True, animations='disabled')
            for index in range(11):
                finish(index)
            expect(page.get_by_text('完整方案已生成', exact=True)).to_be_visible()
            expect(page.get_by_text('待确认书签', exact=True)).to_be_visible()
            expect(page.get_by_role('list', name='整理后分类树', exact=True)).to_contain_text('性能测试')
            sent = requests()
            assert [item['stage'] for item in sent] == ['analysis'] * 3 + ['folders'] + ['bookmarks'] * 3 + ['folders'] + ['bookmarks'] * 3
            analyzed = [item['id'] for request in sent if request['stage'] == 'analysis' for item in request['items']]
            assert len(analyzed) == len(set(analyzed)) == 23
            assert any(topic['title'] == '性能测试' for topic in sent[3]['topicEvidence'])
            assert sum(topic['count'] for topic in sent[3]['topicEvidence']) == 23
            assert all(not item['sampleTitles'] for item in sent[3]['folderSummaries'])
            assert sent[7]['revisionEvidence'] == [{'title': '性能测试', 'count': 1}]
            assert page.evaluate('globalThis.__visualSubmitted.length') == 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'complete-{width}.png'), full_page=True, animations='disabled')
            page.get_by_role('button', name='下一步：确认操作', exact=True).click()
            expect(page.get_by_role('button', name='确认并执行', exact=False)).to_be_enabled()
            assert page.evaluate('globalThis.__visualSubmitted.length') == 0
            checks.append(f'{width}px: 23 bookmarks exhaustively analyzed; final-batch category revision; complete review; uncertainty; zero writes')

        page.goto(f'http://127.0.0.1:{server.server_port}/index.html?options&organize-stream&organize-taxonomy&organize-unfiled#organize')
        page.get_by_label('整理范围', exact=True).select_option('root')
        page.get_by_label('只整理未分类的书签', exact=True).check()
        page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
        for index in range(3):
            finish(index)
        expect(page.get_by_text('完整方案已生成', exact=True)).to_be_visible()
        assert [item['id'] for item in requests()[0]['items']] == ['figma']
        assert requests()[1]['stage'] == 'folders'
        assert page.evaluate('globalThis.__visualSubmitted.length') == 0
        assert not errors, errors
        checks.append('Unfiled-only: direct bookmark analyzed; new categories allowed; no child-folder mutations or native writes')
        (out / 'results.json').write_text(json.dumps({'checks': checks, 'errors': errors}, ensure_ascii=False, indent=2), encoding='utf-8')
        print('\n'.join(checks))
    finally:
        browser.close()
        server.shutdown()
