"""Production App/controller/transport with synthetic Chrome and phased SSE; no real writes."""
import functools
import json
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
from playwright.sync_api import expect, sync_playwright

preview, out = (Path(v).resolve() for v in sys.argv[1:3])
out.mkdir(parents=True, exist_ok=True)
class QuietHandler(SimpleHTTPRequestHandler):
    def log_message(self, *_args): pass
server = ThreadingHTTPServer(('127.0.0.1', 0), functools.partial(QuietHandler, directory=str(preview)))
threading.Thread(target=server.serve_forever, daemon=True).start()
checks = []
with sync_playwright() as p:
    browser = p.chromium.launch(executable_path='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe', headless=True)
    try:
        page = browser.new_page(viewport={'width': 380, 'height': 900})
        page.clock.install()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.route('https://**/*', lambda route: route.abort())
        def count(): return page.evaluate('globalThis.__visualSearchRequests.length')
        def finish(value='false', request_index=None):
            previous = count()
            suffix = '' if request_index is None else f', {request_index}'
            page.evaluate(f'globalThis.__visualFinishOrganize({value}{suffix})')
            return previous
        def await_request(n): page.wait_for_function('(n) => globalThis.__visualSearchRequests.length === n', arg=n)
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 900})
            page.goto(f'http://127.0.0.1:{server.server_port}/index.html?options&organize-stream&organize-taxonomy&organize-batches&width={width}#organize')
            page.get_by_label('整理范围', exact=True).select_option('root')
            expect(page.locator('.organize-advanced')).not_to_have_attribute('open', '')
            page.get_by_text('高级选项', exact=True).click()
            expect(page.get_by_label('每批最多书签', exact=True)).to_have_value('100')
            page.get_by_label('每批最多书签', exact=True).fill('0')
            expect(page.get_by_text('请输入大于或等于 1 的有效整数。', exact=True)).to_be_visible()
            page.get_by_label('每批最多书签', exact=True).fill('10')
            page.get_by_label('分类方式', exact=True).select_option('custom')
            expect(page.get_by_role('button', name='下一步：生成整理方案', exact=True)).to_be_disabled()
            page.get_by_label('分类要求', exact=True).fill('分成写作、画图、编程；分类名称使用中文。')
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'custom-batch-{width}.png'), full_page=True, animations='disabled')
            page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
            expect(page.get_by_text('正在生成的建议', exact=True)).to_be_visible()
            expect(page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True)).to_be_disabled()
            finish()
            confirm = page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True)
            expect(confirm).to_be_enabled()
            expect(page.get_by_role('list', name='整理后分类树', exact=True)).not_to_be_visible()
            page.get_by_text('完整分类树与内容去向', exact=True).click()
            expect(page.get_by_role('list', name='整理后分类树', exact=True)).to_contain_text('写作工具')
            assert count() == 1
            first = page.evaluate('JSON.parse(globalThis.__visualSearchRequests[0].input)')
            assert first['stage'] == 'folders' and all('url' not in i for i in first['items'])
            assert first['preference']['style'] == 'custom'
            assert page.evaluate('globalThis.__visualSubmitted.length') == 0
            adjustments = page.get_by_role('region', name='详细调整方案', exact=True)
            expect(adjustments).to_be_visible()
            assert adjustments.evaluate('e => parseFloat(getComputedStyle(e).borderTopWidth) >= 2')
            reason = adjustments.locator('.organize-reason').first
            reject = reason.get_by_role('button', name='不再建议', exact=True)
            expect(reject).to_be_visible()
            assert reason.evaluate('e => { const p=e.querySelector("p").getBoundingClientRect(), b=e.querySelector("button").getBoundingClientRect(); return b.x >= p.right && b.width < 100 && b.height >= 44; }')
            checks.append(f'{width}px: distinct adjustment section; compact rejection action to the right of reason, >=44px target')
            page.screenshot(path=str(out / f'folder-review-{width}.png'), full_page=True, animations='disabled')
            confirm.click()
            await_request(3)
            progress = page.get_by_role('region', name='分阶段整理进度', exact=True)
            # Two independent requests; finish the later batch first, without merging it out of order.
            finish(request_index=2)
            expect(progress).to_contain_text('已完成 0 / 3 批，已分析 10 / 23 条书签')
            expect(page.get_by_label('选择 move:figma', exact=True)).to_have_count(0)
            expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_disabled()
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'first-batch-{width}.png'), full_page=True, animations='disabled')
            # Completed out-of-order results survive pause. Resume a + c, without asking b again.
            page.get_by_role('button', name='暂停后续批次', exact=True).click()
            expect(page.get_by_role('button', name='继续未完成批次', exact=True)).to_be_enabled()
            before = count()
            page.get_by_role('button', name='继续未完成批次', exact=True).click()
            await_request(before + 2)
            requests = page.evaluate('globalThis.__visualSearchRequests.map(r => JSON.parse(r.input))')
            assert requests[before]['items'] == requests[1]['items']
            assert requests[before + 1]['items'] != requests[2]['items']
            assert all(r.get('omittedItemsUnchanged') is True for r in requests[1:])
            # a truncates into two halves while c remains in flight; cached b is retained.
            finish('"output-limit"', before)
            await_request(before + 3)
            assert page.evaluate('JSON.parse(globalThis.__visualSearchRequests.at(-1).input).items.length') == 5
            finish(request_index=before + 2)
            await_request(before + 4)
            expect(progress).to_contain_text('已完成 1 / 4 批，已分析 15 / 23 条书签')
            finish(request_index=before + 3)
            expect(progress).to_contain_text('已完成 3 / 4 批，已分析 20 / 23 条书签')
            finish('true', before + 1)
            expect(page.get_by_role('alert', name='整理未完成', exact=True)).to_contain_text('已保留 3 批结果')
            expect(page.get_by_role('button', name='继续未完成批次', exact=True)).to_be_enabled()
            page.screenshot(path=str(out / f'resumable-error-{width}.png'), full_page=True, animations='disabled')
            before = count()
            page.get_by_role('button', name='继续未完成批次', exact=True).click()
            await_request(before + 1)
            finish()
            expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_enabled()
            expect(progress).to_contain_text('已完成 4 / 4 批，已分析 23 / 23 条书签')
            page.get_by_text('完整分类树与内容去向', exact=True).click()
            page.screenshot(path=str(out / f'target-review-{width}.png'), full_page=True, animations='disabled')
            page.get_by_text('完整分类树与内容去向', exact=True).click()
            page.locator('summary').filter(has_text='目录变更与其他操作').click()
            groups = page.get_by_role('region', name='按目标目录审核', exact=True)
            expect(groups).to_be_visible()
            group_choice = groups.get_by_role('checkbox', name='采纳', exact=False).first
            group_choice.uncheck()
            expect(page.get_by_label('选择 delete:design', exact=True)).not_to_be_checked()
            expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_enabled()
            group_choice.check()
            # Restoring moves does not silently reselect dependent cleanup.
            expect(page.get_by_label('选择 delete:design', exact=True)).not_to_be_checked()
            page.get_by_label('选择 delete:design', exact=True).check()
            checks.append(f'{width}px: advanced options collapsed; full tree disclosed; target groups support bulk choice; dependent cleanup stays unselected until explicitly restored')
            groups.locator('details').evaluate_all('(items) => items.forEach(e => e.open = true)')
            expect(page.get_by_label('选择 create:writing', exact=True)).to_be_disabled()
            expect(page.get_by_label('选择 delete:design', exact=True)).to_be_checked()
            after = page.get_by_role('list', name='整理后分类树', exact=True)
            expect(after).not_to_contain_text('设计与灵感')
            page.get_by_role('button', name='整理前', exact=True).click()
            expect(page.get_by_role('list', name='整理前分类树', exact=True)).to_contain_text('设计与灵感')
            page.get_by_role('button', name='整理后', exact=True).click()
            page.get_by_label('选择 move:figma', exact=True).uncheck()
            expect(page.get_by_label('选择 delete:design', exact=True)).not_to_be_checked()
            page.get_by_label('选择 move:figma', exact=True).check()
            page.get_by_role('button', name='下一步：确认操作', exact=True).click()
            assert page.evaluate('globalThis.__visualSubmitted.length') == 0
            assert page.evaluate('document.documentElement.scrollWidth <= innerWidth')
            page.screenshot(path=str(out / f'complete-{width}.png'), full_page=True, animations='disabled')
            checks.append(f'{width}px: two parallel requests; out-of-order completion retained across pause; ordered sparse-output merge; adaptive half-batches with other work in flight; retained results after error; final cleanup dependencies and before/after; no overflow or writes')
            # Changing the folder plan discards dependent batch results, without another model call.
            page.get_by_role('button', name='上一步', exact=True).click()
            page.get_by_role('button', name='更改文件夹方案并重新分析书签', exact=True).click()
            expect(page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True)).to_be_enabled()
            expect(page.get_by_label('选择 create:writing', exact=True)).to_be_enabled()
            expect(page.get_by_label('选择 move:figma', exact=True)).to_have_count(0)
            checks.append(f'{width}px: changing taxonomy clears dependent bookmark suggestions and unlocks folder selection')
        page.clock.run_for(1_800_000)
        expect(page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True)).to_be_enabled()
        expect(page.locator('.organize-footer')).not_to_contain_text('超过 10 分钟')
        before = count()
        page.get_by_role('button', name='确认分类，开始分批整理书签', exact=True).click()
        await_request(before + 2)
        finish(request_index=before)
        await_request(before + 3)
        finish(request_index=before + 1)
        finish(request_index=before + 2)
        expect(page.get_by_role('button', name='下一步：确认操作', exact=True)).to_be_enabled()
        page.clock.run_for(1_800_000)
        page.get_by_role('button', name='下一步：确认操作', exact=True).click()
        assert page.evaluate('globalThis.__visualSubmitted.length') == 0
        checks.append('Folder review and completed plan remain actionable after thirty minutes each; no write before final confirmation')
        assert not errors, errors
    except Exception:
        print(json.dumps({'errors': errors, 'body': page.locator('body').inner_text()}, ensure_ascii=True))
        raise
    finally:
        browser.close()
        server.shutdown()
(out / 'checks.json').write_text(json.dumps(checks, ensure_ascii=False, indent=2), encoding='utf-8')
print(json.dumps(checks, ensure_ascii=False))
