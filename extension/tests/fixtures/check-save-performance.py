"""Production debug UI with synthetic receipts; no extension-host or live-model acceptance."""
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
    def log_message(self, *_args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        for width in [320, 480, 1024]:
            page = browser.new_page(viewport={'width': width, 'height': 1000})
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'http://127.0.0.1:{server.server_port}/index.html?options')
            page.locator('button').first.wait_for()
            page.evaluate("""async () => {
              const base = {id:'sample',bookmarkId:'b',title:'Synthetic only',url:'https://example.test/',at:Date.now(),fromParentId:'1',fromIndex:0,fromPath:'Bar',model:'Synthetic model · Test connection'};
              await chrome.storage.local.set({nativeSaveReceipts:[
                {...base,status:'moved',toId:'2',toPath:'Tools',timing:{totalMs:1200,prepareMs:200,applyMs:100,model:{ms:900,attempts:1,streaming:true,firstTokenMs:400,generationMs:450,validationMs:50}}},
                {...base,id:'failure',status:'failed',reason:'timeout',ms:60000}
              ]});
            }""")
            page.evaluate("location.hash = 'debug'")
            section = page.get_by_role('region', name='收藏耗时统计', exact=True)
            expect(section.get_by_text('成功 1 条 · 失败 1 条', exact=True)).to_be_visible()
            expect(section.get_by_text('总耗时：中位 1.20 秒 · P90 1.20 秒（1 条）', exact=True)).to_be_visible()
            expect(section.get_by_text('等首字：中位 0.40 秒 · P90 0.40 秒（1 条）', exact=True)).to_be_visible()
            expect(page.get_by_role('switch', name='开启 Debug 日志', exact=True)).not_to_be_checked()
            section.scroll_into_view_if_needed()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'save-performance-{width}.png'), animations='disabled')
            assert not errors, errors
            checks.append(f'{width}px: correct successful-only median/P90 and phase samples with logging off; no overflow or page errors')
            page.close()
    finally:
        browser.close()
        server.shutdown()
(out / 'checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(checks, ensure_ascii=False))
