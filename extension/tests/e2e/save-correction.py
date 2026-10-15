"""Opt-in real production extension correction + rule consent in an empty Chromium profile.

Uses synthetic native bookmarks only. No provider configuration, network grants or modified build files.
"""
import argparse
import hashlib
import json
from pathlib import Path
import sys
import tempfile
import time
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--language', choices=['zh-CN', 'en'], default='zh-CN')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic bookmarks')
    raise SystemExit(0)
extension = Path(__file__).resolve().parents[2] / 'dist'
root = Path(tempfile.mkdtemp(prefix='zhilan-correction-'))

def ui(chinese, english):
    return english if args.language == 'en' else chinese


def wait_for(check):
    end = time.monotonic() + 20
    while time.monotonic() < end:
        result = check()
        if result:
            return result
        time.sleep(0.1)
    raise AssertionError('fixture condition timed out')


with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(
        str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 340, 'height': 960}, reduced_motion='reduce',
    )
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async title => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const source=(await chrome.bookmarks.create({parentId:bar,title:'Synthetic source'})).id;
          const target=(await chrome.bookmarks.create({parentId:bar,title})).id;
          const bookmark=(await chrome.bookmarks.create({parentId:source,title:'Correct this synthetic bookmark',url:'https://correction.example.test/first'})).id;
          return {source,target,bookmark};
        }""", ui('Chosen destination', '改一下'))
        receipt = wait_for(lambda: worker.evaluate("async id => (await chrome.storage.local.get('nativeSaveReceipts')).nativeSaveReceipts?.find(r=>r.bookmarkId===id && r.status!=='classifying')", fixture['bookmark']))
        assert receipt['status'] == 'skipped'
        assert receipt['installationId']
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        if args.language == 'en':
            preferences.get_by_label('语言', exact=True).select_option('en')
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/panel/index.html')
        page.get_by_role('button', name=ui('改一下', 'Change folder'), exact=True).click()
        page.get_by_label(ui('改到目录', 'Move to folder'), exact=True).select_option(fixture['target'])
        if args.language == 'en':
            preferences.get_by_label('Language', exact=True).select_option('zh-CN')
            expect(page.get_by_label('改到目录', exact=True)).to_have_value(fixture['target'])
            preferences.get_by_label('语言', exact=True).select_option('en')
            expect(page.get_by_label('Move to folder', exact=True)).to_have_value(fixture['target'])
            assert worker.evaluate("async id => (await chrome.bookmarks.get(id))[0].parentId", fixture['bookmark']) == fixture['source']
        page.get_by_role('button', name=ui('改到这个目录', 'Move to this folder'), exact=True).click()
        page.get_by_role('button', name=ui('以后都放这里', 'Always save here'), exact=True).wait_for()
        expect(page.get_by_label(ui('也包含此域名的子域名', 'Also include subdomains'), exact=True)).not_to_be_checked()
        assert worker.evaluate("async id => (await chrome.bookmarks.get(id))[0].parentId", fixture['bookmark']) == fixture['target']
        assert worker.evaluate("async () => (await chrome.storage.local.get('siteRules')).siteRules?.rules ?? []") == []
        geometry = []
        for width in [320, 340, 480, 1024]:
            page.set_viewport_size({'width': width, 'height': 960})
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
            assert measured['scroll'] <= measured['width'] + 1, measured
            geometry.append(measured)
            page.screenshot(path=str(root / f'correction-consent-{width}.png'), full_page=True)
        page.get_by_role('button', name=ui('以后都放这里', 'Always save here'), exact=True).click()
        page.get_by_text(ui('网站规则已保存，可在隐私与规则中修改。', 'Website rule saved. You can change it in Privacy & rules.'), exact=True).wait_for()
        rules = worker.evaluate("async () => (await chrome.storage.local.get('siteRules')).siteRules.rules")
        assert len(rules) == 1 and rules[0]['host'] == 'correction.example.test'
        assert rules[0]['includeSubdomains'] is False and rules[0]['folder']['nativeId'] == fixture['target']
        undo = page.evaluate("id => chrome.runtime.sendMessage({type:'nativeSaveUndo',receiptId:id})", receipt['id'])
        assert undo == {'status': 'refused', 'reason': 'not-undoable'}, undo
        second = worker.evaluate("async source => (await chrome.bookmarks.create({parentId:source,title:'Next synthetic save',url:'https://correction.example.test/second'})).id", fixture['source'])
        followup = wait_for(lambda: worker.evaluate("async id => (await chrome.storage.local.get('nativeSaveReceipts')).nativeSaveReceipts?.find(r=>r.bookmarkId===id && r.status==='moved')", second))
        assert followup['source'] == 'rule'
        assert worker.evaluate("async id => (await chrome.bookmarks.get(id))[0].parentId", second) == fixture['target']
        assert worker.evaluate("async () => (await chrome.storage.local.get('aiServices')).aiServices?.services?.length ?? 0") == 0
        page.goto(f'chrome-extension://{extension_id}/options/index.html#debug')
        page.get_by_text(ui('已手动纠正目录', 'Folder corrected manually'), exact=True).wait_for()
        result = {'status': 'PASS', 'browser': context.browser.version, 'evidence': str(root), 'geometry': geometry,
                  'language': args.language,
                  'followupSource': followup['source'], 'originalUndo': undo,
                  'productionWorkerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
                  'scope': 'Production dist bytes unchanged; fresh profile, real synthetic bookmarks, coordinator and storage. No configured model or provider requests; not a branded-browser release/lifetime test.'}
        (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps(result), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, page in enumerate(context.pages):
            print(page.url, page.locator('body').inner_text()[:4000], flush=True)
            page.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
