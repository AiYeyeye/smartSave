"""Real components/CSS, inert Chrome storage, disposable browser; not host E2E."""
import json
import os
import sys
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

preview = Path(sys.argv[1]).resolve()
out = Path(__file__).resolve().parents[3] / '.trellis/tasks/09-10-zhilan-ui-onboarding-redesign/research/soft-ui'
out.mkdir(parents=True, exist_ok=True)
chrome = Path(os.environ.get('LOCALAPPDATA', 'C:/Users/Administrator/AppData/Local')) / 'ms-playwright/chromium-1234/chrome-win64/chrome.exe'
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path=str(chrome), headless=True)
    try:
        page = browser.new_page(viewport={'width': 320, 'height': 900})
        errors = []
        requests = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.route('http://**/*', lambda route: (requests.append(route.request.url), route.abort()))
        page.route('https://**/*', lambda route: (requests.append(route.request.url), route.abort()))
        checks = []
        for width in [320, 380, 480]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto((preview / 'index.html').as_uri())
            expect(page.get_by_role('button', name='搜索', exact=True)).to_be_visible()
            expect(page.locator('.bookmark-open')).to_have_count(2)
            page.screenshot(path=str(out / f'browse-{width}.png'))
            page.get_by_role('button', name='搜索', exact=True).click()
            field = page.get_by_role('searchbox')
            expect(field).to_be_focused()
            assert field.evaluate('e => getComputedStyle(e).boxShadow') == 'none'
            assert field.evaluate('e => getComputedStyle(e).outlineWidth') == '0px'
            assert page.locator('.search').evaluate('e => getComputedStyle(e).borderTopWidth') == '0px'
            page.screenshot(path=str(out / f'search-{width}.png'))
            page.get_by_role('button', name='更多操作').click()
            page.get_by_role('menuitem', name='设置', exact=True).click()
            expect(page.get_by_role('heading', name='设置', level=1)).to_be_visible()
            expect(page.locator('.brand-kicker')).to_have_count(0)
            expect(page.get_by_text('个性化与智能', exact=True)).to_have_count(0)
            for card in page.locator('.settings-card').all():
                assert card.evaluate('e => e.getBoundingClientRect().height') >= 44
                assert card.evaluate('e => getComputedStyle(e).borderTopWidth') == '0px'
            page.screenshot(path=str(out / f'settings-{width}.png'))
            page.get_by_role('button', name='AI 模型', exact=True).click()
            expect(page.get_by_label('模型服务', exact=True)).to_be_visible()
            assert page.locator('#main').evaluate('e => e.scrollWidth <= e.clientWidth')
            page.screenshot(path=str(out / f'model-{width}.png'))
            page.get_by_text('数据发送与密钥安全', exact=True).click()
            expect(page.get_by_text('密钥默认仅当前页面会话使用。', exact=False)).to_be_visible()
            page.get_by_role('button', name='返回设置').click()
            page.get_by_role('button', name='外观', exact=True).click()
            colors = []
            for name in ['轻盈原生', '温润纸感', '清爽文具（默认）', '深色精密']:
                page.get_by_role('radio', name=name, exact=True).check()
                colors.append(page.locator('.theme-root').evaluate('e => getComputedStyle(e).backgroundColor'))
            assert len(set(colors)) == 4
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            checks.append(f'{width}px: real tree/search/settings/model; no double focus/borders, disclosure, four themes, no overflow')
        page.set_viewport_size({'width': 320, 'height': 900})
        page.goto((preview / 'index.html').as_uri() + '?pending')
        title = page.get_by_label('收藏标题', exact=True)
        expect(title).to_be_visible()
        title.fill('保留的手写草稿')
        page.get_by_role('button', name='更多操作').click()
        page.get_by_role('menuitem', name='设置', exact=True).click()
        expect(page.get_by_role('region', name='收藏确认卡')).to_be_hidden()
        page.screenshot(path=str(out / 'settings-pending-save-320.png'))
        page.get_by_role('button', name='返回书签').click()
        expect(title).to_have_value('保留的手写草稿')
        checks.append('Full App: pending SaveCard hidden in settings and draft retained on return')
        page.get_by_role('button', name='更多操作').click()
        page.get_by_role('menuitem', name='设置', exact=True).click()
        page.get_by_role('button', name='外观', exact=True).click()
        page.emulate_media(reduced_motion='reduce')
        button = page.get_by_role('button', name='返回设置')
        button.hover()
        assert button.evaluate('e => getComputedStyle(e).transform') == 'none'
        assert button.evaluate('e => getComputedStyle(e).transitionDuration') == '0s'
        assert not errors, errors
        assert not requests, requests
        result = {'checks': checks, 'reduced_motion': True, 'errors': errors, 'http_requests': requests, 'browser': browser.version, 'scope': 'Full production App/CSS; runtime/storage/permissions mocked, not extension-host/provider acceptance.'}
        (out / 'checks.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=True, indent=2))
    finally:
        browser.close()
