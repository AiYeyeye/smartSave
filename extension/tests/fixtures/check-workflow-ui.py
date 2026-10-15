"""Real App/CSS in a disposable browser; native APIs and task data are synthetic."""
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
base = f'http://127.0.0.1:{server.server_port}/index.html?options'
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        page = browser.new_page(viewport={'width': 380, 'height': 900})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**/*', lambda route: route.abort())

        def capture(name, width):
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth'), name
            primary = page.locator('.workflow-workbench:not([hidden]) button.primary:visible').first
            assert primary.evaluate('e => e.getBoundingClientRect().height') >= 44, name
            page.screenshot(path=str(out / f'{name}-{width}.png'), full_page=True, animations='disabled')
            checks.append(f'{name} at {width}px: no overflow, >=44px primary action')

        for width in [320, 380, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(base + '#export')
            expect(page.get_by_role('checkbox', name='导出 Figma — 把想法变成作品', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='下一步：选择格式')).to_be_disabled()
            capture('export-content', width)
            page.get_by_role('checkbox', name='导出 设计与灵感', exact=True).check()
            page.get_by_role('checkbox', name='导出 Figma 设计资源（重复收藏）', exact=True).uncheck()
            expect(page.get_by_role('checkbox', name='导出 设计与灵感', exact=True)).to_have_js_property('indeterminate', True)
            page.get_by_role('button', name='下一步：选择格式').click()
            capture('export-format', width)
            page.get_by_role('button', name='下一步：确认导出').click()
            expect(page.get_by_role('button', name='下载 HTML')).to_be_enabled()
            capture('export-confirm', width)
            page.get_by_role('button', name='上一步').click()
            page.get_by_role('radio', name='JSON', exact=False).check()
            page.get_by_role('button', name='下一步：确认导出').click()
            with page.expect_download() as download:
                page.get_by_role('button', name='下载 JSON').click()
            data = json.loads(Path(download.value.path()).read_text(encoding='utf-8'))
            assert '重复收藏' not in json.dumps(data, ensure_ascii=False)
            assert '把想法变成作品' in json.dumps(data, ensure_ascii=False)
            page.goto(base + '#organize')
            expect(page.get_by_role('heading', name='想整理哪个目录？')).to_be_visible()
            capture('organize-scope', width)
            page.get_by_label('整理范围', exact=True).select_option('root')
            page.get_by_role('radio', name='清理重复书签', exact=False).check()
            page.get_by_role('button', name='下一步：查找重复书签').click()
            page.get_by_label('Figma — 把想法变成作品 保留或删除', exact=True).select_option('keep')
            page.get_by_label('Figma 设计资源（重复收藏） 保留或删除', exact=True).select_option('delete')
            page.get_by_role('button', name='生成去重预览').click()
            expect(page.get_by_role('button', name='下一步：确认操作')).to_be_enabled()
            capture('organize-review', width)
            page.get_by_role('button', name='下一步：确认操作').click()
            capture('organize-confirm', width)
            page.goto(base + '#import')
            expect(page.get_by_role('button', name='下一步：选择目标目录')).to_be_disabled()
            capture('import-file', width)
            page.get_by_label('导入格式', exact=True).select_option('txt')
            page.get_by_label('导入文件', exact=True).set_input_files({'name': '书签示例.txt', 'mimeType': 'text/plain', 'buffer': b'https://example.test/a'})
            expect(page.get_by_role('button', name='下一步：选择目标目录')).to_be_enabled()
            page.get_by_role('button', name='下一步：选择目标目录').click()
            page.get_by_label('导入目标根', exact=True).select_option('root')
            capture('import-target', width)
            page.goto(base + '&import-preview#import')
            page.get_by_text('继续以前的导入任务', exact=True).click()
            page.get_by_role('button', name='读取导入任务列表').click()
            page.get_by_role('button', name='加载任务').click()
            expect(page.get_by_role('heading', name='检查分类结果')).to_be_visible()
            capture('import-review', width)

        page.get_by_role('button', name='外观', exact=True).click()
        page.get_by_role('radio', name='深色', exact=True).check()
        page.get_by_role('button', name='导入书签', exact=False).click()
        capture('import-review-dark', 1024)
        assert not errors, errors
        result = {'checks': checks, 'browser': browser.version, 'errors': errors,
                  'scope': 'Production App and CSS, actual parser Worker and downloaded JSON; synthetic native tree/lease/checkpoint. No real bookmark writes or external providers.'}
        (out / 'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True, indent=2))
    finally:
        if errors:
            print(json.dumps({'errors': errors, 'body': page.locator('body').inner_text()}, ensure_ascii=True))
        browser.close()
        server.shutdown()
