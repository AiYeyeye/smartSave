"""Opt-in production export acceptance with a disposable profile and synthetic bookmarks."""
import argparse
import hashlib
import html
import json
from pathlib import Path
import sys
import tempfile
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic export acceptance')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-export-locale-'))

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
        '--disable-background-networking'], viewport={'width': 340, 'height': 960}, reduced_motion='reduce', accept_downloads=True)
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async () => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const folder=await chrome.bookmarks.create({parentId:bar,title:'导出书签 {title}'});
          const keep=await chrome.bookmarks.create({parentId:folder.id,title:'确认 <&>',url:'https://export-locale.test/original?a=1&b=2#part'});
          const exclude=await chrome.bookmarks.create({parentId:folder.id,title:'不导出',url:'https://excluded-locale.test/'});
          const empty=await chrome.bookmarks.create({parentId:folder.id,title:'空目录'});
          return {folder,keep,exclude,empty};
        }""")
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#export')
        downloads = []
        page.on('download', lambda download: downloads.append(download.suggested_filename))
        page.get_by_role('checkbox', name='Export 导出书签 {title}', exact=True).check()
        page.get_by_role('checkbox', name='Export 不导出', exact=True).uncheck()
        page.get_by_role('button', name='Collapse 导出书签 {title}', exact=True).click()
        page.get_by_text('Automatically update a JSON file (optional)', exact=True).click()
        page.get_by_role('checkbox', name='I agree to the dedicated file overwrite rules', exact=True).check()
        preferences.get_by_label('Language', exact=True).select_option('zh-CN')
        expect(page.get_by_role('button', name='展开 导出书签 {title}', exact=True)).to_be_visible()
        expect(page.get_by_role('checkbox', name='我同意专用输出覆盖规则', exact=True)).to_be_checked()
        preferences.get_by_label('语言', exact=True).select_option('en')
        page.get_by_role('button', name='Expand 导出书签 {title}', exact=True).click()
        expect(page.get_by_role('checkbox', name='Export 确认 <&>', exact=True)).to_be_checked()
        expect(page.get_by_role('checkbox', name='Export 不导出', exact=True)).not_to_be_checked()
        expect(page.get_by_role('checkbox', name='Export 导出书签 {title}', exact=True)).to_have_attribute('aria-checked', 'mixed')
        geometry = []

        def capture(surface):
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                size = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert size['scroll'] <= width + 1, (surface, size)
                geometry.append({'surface': surface, **size})
                page.screenshot(path=str(root / f'{surface}-{width}.png'), full_page=True)

        capture('selection-and-auto-settings')
        page.get_by_text('Automatically update a JSON file (optional)', exact=True).click()
        page.get_by_role('button', name='Next: choose format', exact=True).click()
        capture('format')
        for format_name, suffix in [('JSON', 'json'), ('HTML', 'html'), ('Markdown', 'md')]:
            page.get_by_role('radio', name=format_name, exact=False).check()
            page.get_by_role('button', name='Next: confirm export', exact=True).click()
            preferences.get_by_label('Language', exact=True).select_option('zh-CN')
            expect(page.get_by_role('button', name=f'下载 {format_name}', exact=True)).to_be_visible()
            preferences.get_by_label('语言', exact=True).select_option('en')
            expect(page.get_by_role('button', name=f'Download {format_name}', exact=True)).to_be_visible()
            assert len(downloads) == ['JSON', 'HTML', 'Markdown'].index(format_name)
            if format_name == 'JSON':
                capture('confirmation')
            with page.expect_download() as event:
                page.get_by_role('button', name=f'Download {format_name}', exact=True).click()
            download = event.value
            assert download.suggested_filename == f'bookmarks.{suffix}'
            target = root / download.suggested_filename
            download.save_as(str(target))
            content = target.read_text(encoding='utf-8')
            if format_name == 'JSON':
                data = json.loads(content)
                assert set(data) == {'format', 'schemaVersion', 'generatedAt', 'roots'}
                nodes = []
                pending = list(data['roots'])
                while pending:
                    node = pending.pop()
                    nodes.append(node)
                    pending.extend(node.get('children', []))
                assert [node['url'] for node in nodes if node['type'] == 'bookmark'] == [fixture['keep']['url']]
                assert any(node['title'] == fixture['folder']['title'] for node in nodes)
                assert any(node['title'] == fixture['empty']['title'] and node['children'] == [] for node in nodes)
            else:
                decoded = html.unescape(content)
                assert fixture['keep']['title'] in decoded and fixture['keep']['url'] in decoded
                assert fixture['empty']['title'] in decoded
            assert fixture['exclude']['url'] not in content
            expect(page.get_by_text(f'{format_name} download started. Check your browser downloads to confirm completion.', exact=True)).to_be_visible()
            if format_name != 'Markdown':
                page.get_by_role('button', name='Back', exact=True).click()
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        assert len(downloads) == 3
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'downloads': downloads, 'scope': 'Unmodified production dist; synthetic native bookmarks. Real manual downloads, original links, leaf exclusion, empty folder, cross-document draft/consent retention and unchanged native tree. Automatic FileSystemHandle behavior remains component-tested only.',
                  'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest()}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            print(page.url, page.locator('body').inner_text()[-6000:], flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
