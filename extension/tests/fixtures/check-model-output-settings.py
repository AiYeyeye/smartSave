"""Real App/settings UI, synthetic storage/model boundaries; no live provider calls."""
import functools
import itertools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

preview, out = (Path(value).resolve() for value in sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        for width, mode in itertools.product([320, 480, 1024], ['openai', 'openai-responses', 'anthropic', 'google']):
            page = browser.new_page(viewport={'width': width, 'height': 900}, accept_downloads=True)
            requests, errors = [], []
            page.on('pageerror', lambda error: errors.append(str(error)))
            def reply(route):
                if route.request.method == 'OPTIONS':
                    route.fulfill(status=204, headers={'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': '*'})
                    return
                requests.append(route.request.post_data_json)
                answer = json.dumps({'assignments': [{'itemId': 'test-bookmark', 'folderId': 'test-docs'}], 'newFolders': []})
                envelope = {
                    'openai': {'choices': [{'message': {'content': answer}, 'finish_reason': 'stop'}]},
                    'openai-responses': {'status': 'completed', 'output_text': answer},
                    'anthropic': {'content': [{'type': 'text', 'text': answer}], 'stop_reason': 'end_turn'},
                    'google': {'candidates': [{'content': {'parts': [{'text': answer}]}, 'finishReason': 'STOP'}]},
                }[mode]
                route.fulfill(status=200, headers={'Access-Control-Allow-Origin': '*'}, content_type='application/json', body=json.dumps(envelope))
            page.route('https://synthetic.invalid/**', reply)
            page.goto(f'http://127.0.0.1:{server.server_port}/index.html?options&model-output-settings#ai-services')
            page.get_by_role('button', name='编辑', exact=True).click()
            page.get_by_label('接口模式', exact=True).select_option(mode)
            field = page.get_by_label('最大输出 tokens', exact=True)
            expect(field).to_have_value('128000')
            field.fill('0')
            expect(page.get_by_role('button', name='保存服务', exact=True)).to_be_disabled()
            expect(page.get_by_role('button', name='测试连接', exact=True)).to_be_disabled()
            field.fill('64000')
            field.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            assert page.get_by_role('dialog').evaluate('e => e.scrollWidth <= e.clientWidth')
            page.screenshot(path=str(out / f'output-limit-{mode}-{width}.png'), animations='disabled')
            page.get_by_role('button', name='测试连接', exact=True).click()
            expect(page.get_by_text('合成分类测试通过：visual', exact=True)).to_be_visible()
            request = requests[-1]
            actual = request.get('generationConfig', {}).get('maxOutputTokens') if mode == 'google' else request[{'openai': 'max_completion_tokens', 'openai-responses': 'max_output_tokens', 'anthropic': 'max_tokens'}[mode]]
            assert actual == 64000
            page.get_by_role('button', name='保存服务', exact=True).click()
            expect(page.get_by_role('dialog')).to_have_count(0)
            page.get_by_role('button', name='编辑', exact=True).click()
            expect(page.get_by_label('最大输出 tokens', exact=True)).to_have_value('64000')
            page.get_by_role('button', name='关闭', exact=True).click()
            page.evaluate("location.hash = 'ai-services/io'")
            with page.expect_download() as download:
                page.get_by_role('button', name='导出 JSON', exact=True).click()
            data = json.loads(Path(download.value.path()).read_text(encoding='utf-8'))
            assert data['services'][0]['maxOutputTokens'] == 64000
            assert 'synthetic-test-key' not in json.dumps(data)
            assert not errors, errors
            checks.append(f'{mode} {width}px: default 128000, invalid input blocks test/save, custom 64000 sent, saved, reopened and exported; no overflow')
            page.close()
    finally:
        browser.close()
        server.shutdown()
(out / 'checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(checks, ensure_ascii=False))
