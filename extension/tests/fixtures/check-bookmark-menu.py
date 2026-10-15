"""Production App/CSS with synthetic Chrome boundaries; no native bookmark writes."""
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
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        page = browser.new_page(reduced_motion='reduce')
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('https://**/*', lambda route: route.abort())
        page.add_init_script("""globalThis.__opened = [];
          chrome.tabs = {create: async data => { __opened.push({kind:'tab', ...data}); }};
          chrome.windows = {create: async data => { __opened.push({kind:'window', ...data}); }};
        """)
        for width, height in [(320, 580), (380, 580), (480, 580), (320, 360)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.goto(f'http://127.0.0.1:{server.server_port}/index.html')
            row = page.locator('[data-node-id="figma"]')
            row.click(button='right')
            menu = page.get_by_role('menu')
            expect(menu).to_be_visible()
            expect(page.get_by_role('menuitem', name='在新标签页打开', exact=True)).to_be_focused()
            page.screenshot(path=str(out / f'menu-{width}-{height}.png'), animations='disabled')
            bounds = menu.bounding_box()
            assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width
            assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= height
            for item in menu.get_by_role('menuitem').all():
                size = item.evaluate('e => e.getBoundingClientRect().height')
                assert size >= 43.99, (item.inner_text(), size)
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'menu-{width}-{height}.png'), animations='disabled')
            page.get_by_role('menuitem', name='选择书签', exact=True).click()
            expect(page.get_by_role('checkbox', name='选择 Figma — 把想法变成作品', exact=True)).to_be_checked()
            expect(page.get_by_text('已选 1 项', exact=True)).to_be_visible()
            assert page.evaluate('__opened.length') == 0
            page.get_by_role('button', name='退出选择', exact=True).click()
            row.click(button='right')
            page.keyboard.press('ArrowDown')
            page.keyboard.press('Enter')
            assert page.evaluate('__opened') == [{'kind': 'window', 'url': 'https://example.test/figma', 'type': 'normal', 'focused': True, 'incognito': False}]
            row.click(button='right')
            page.get_by_role('menuitem', name='在无痕窗口中打开', exact=True).click()
            assert page.evaluate('__opened[1].incognito') is True
            row.click(button='right')
            page.keyboard.press('Escape')
            expect(menu).to_have_count(0)
            expect(page.get_by_role('button', name='Figma — 把想法变成作品 操作', exact=True)).to_be_focused()
            checks.append(f'{width}x{height}: bounded menu, 44px items, selection without opening, keyboard/window/incognito commands, Escape focus restoration')
        # Last visible bookmark and dark theme use the same production overlay and tokens.
        page.set_viewport_size({'width': 380, 'height': 580})
        page.evaluate("localStorage.setItem('zhilan.appearance', JSON.stringify({mode:'dark', accent:'indigo'}))")
        page.reload()
        page.locator('[data-node-id="docs"]').click(button='right')
        expect(page.get_by_role('menu')).to_be_visible()
        assert page.get_by_role('menu').evaluate("e => getComputedStyle(e).pointerEvents") == 'auto'
        page.screenshot(path=str(out / 'menu-dark-last-row.png'), animations='disabled')
        page.get_by_role('menuitem', name='编辑', exact=True).click()
        expect(page.get_by_role('textbox', name='标题', exact=True)).to_be_visible()
        title = page.get_by_role('textbox', name='标题', exact=True)
        title.fill('保留中的标题草稿')
        for width, height in [(320, 360), (380, 580), (480, 580)]:
            page.set_viewport_size({'width': width, 'height': height})
            page.locator('[data-node-id="figma-copy"]').click(button='right')
            menu = page.get_by_role('menu')
            expect(menu).to_have_accessible_description('有尚未完成的书签操作，请先完成或取消。')
            for label in ['置顶', '上移', '下移', '删除']:
                expect(page.get_by_role('menuitem', name=label, exact=True)).to_be_disabled()
            bounds = menu.bounding_box()
            assert bounds['x'] >= 0 and bounds['x'] + bounds['width'] <= width
            assert bounds['y'] >= 0 and bounds['y'] + bounds['height'] <= height
            page.screenshot(path=str(out / f'menu-draft-lock-{width}-{height}.png'), animations='disabled')
            page.get_by_role('menuitem', name='返回当前操作', exact=True).click()
            expect(title).to_be_focused()
            expect(title).to_have_value('保留中的标题草稿')
        page.get_by_role('button', name='取消', exact=True).click()
        page.locator('[data-node-id="figma-copy"]').click(button='right')
        for label in ['置顶', '上移', '删除']:
            expect(page.get_by_role('menuitem', name=label, exact=True)).to_be_enabled()
        expect(page.get_by_role('menuitem', name='下移', exact=True)).to_have_attribute('title', '已在当前目录末位。')
        checks.append('Active draft: visible reason, bounded short/narrow menu, return preserves draft/focus, cancel unlocks commands; boundary tooltip remains')
        assert not errors, errors
        result = {'checks': checks, 'browser': browser.version, 'errors': errors,
                  'scope': 'Production App/CSS with synthetic Chrome tree, tab and window APIs. No live browser-profile writes.'}
        (out / 'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True, indent=2))
    finally:
        browser.close()
        server.shutdown()
