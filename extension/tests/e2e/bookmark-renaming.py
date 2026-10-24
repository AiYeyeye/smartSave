"""Opt-in production extension name suggestions, confirmation and correction-only learning.

Uses a disposable Chromium profile, synthetic bookmarks and a loopback provider.
Only the disposable manifest gains loopback host access; production JavaScript is unchanged.
"""
import argparse
import json
import re
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for disposable synthetic acceptance')
    raise SystemExit(0)
root = Path(tempfile.mkdtemp(prefix='zhilan-renaming-'))
extension = root / 'extension'
shutil.copytree(Path(__file__).resolve().parents[2] / 'dist', extension)
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
events = []
destination = ''
geometry = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append(payload)
        if payload['task'] == 'save':
            output = {'assignments': [{'itemId': payload['items'][0]['id'], 'folderId': destination,
                                       'suggestedTitle': 'Synthetic tool | Diagram editor'}], 'newFolders': []}
        elif payload['task'] == 'rename':
            output = {'suggestions': [{'itemId': item['id'], 'title': 'Synthetic tool | Clear purpose',
                                      'decision': 'rename', 'reason': 'Synthetic metadata supports a short purpose'}
                                     for item in payload['items']]}
        elif payload['task'] == 'preference-summary':
            output = {'rules': [{'text': 'Prefer concise descriptive names for these tools.',
                                 'exampleIds': [item['id'] for item in payload['examples']]}]}
        else:
            raise AssertionError(payload)
        body = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(output)}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(body)))
        self.end_headers()
        self.wfile.write(body)


def wait(check):
    deadline = time.monotonic() + 30
    while time.monotonic() < deadline:
        result = check()
        if result:
            return result
        time.sleep(.1)
    raise AssertionError('condition timed out')


def check_correction(page, locale, root, comparison):
    for language in ['en', 'zh-CN']:
        locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
        if comparison:
            expect(page.get_by_role('textbox', name='Name' if language == 'en' else '名称', exact=True)).to_be_visible()
        else:
            expect(page.get_by_label('Bookmark name' if language == 'en' else '书签名称', exact=True)).to_be_visible()
        # The toolbar popup has a fixed 352px width; the options-page correction adapts to narrow widths.
        for width in ([352, 480] if comparison else [320, 340, 480]):
            page.set_viewport_size({'width': width, 'height': 960})
            measured = page.locator('.save-pop-form' if comparison else '.save-correction').evaluate("""form => {
              const group=form.querySelector('.save-correction-group') || form;
              const input=(form.matches('.save-pop-form') ? group.querySelector('.save-pop-folder') : group.querySelector('input:not([readonly])')).getBoundingClientRect();
              const actions=group.querySelector('.actions,.save-pop-actions').getBoundingClientRect();
              return {width:innerWidth,scroll:document.documentElement.scrollWidth,
                inputCount:form.querySelectorAll('input:not([type=checkbox])').length,
                actionGap:actions.top-input.bottom};
            }""")
            assert measured['scroll'] <= width + 1, measured
            assert measured['inputCount'] == 1, measured
            assert 0 <= measured['actionGap'] <= (20 if comparison else 12), measured
            geometry.append({'surface': 'name-advice' if comparison else 'correction', 'language': language, **measured})
            page.screenshot(path=str(root / f'correction-{comparison}-{language}-{width}.png'), full_page=True)


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser,
        headless=True, args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}',
                            '--disable-background-networking'], viewport={'width': 340, 'height': 960})
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async origin => {
          const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
          const source=(await chrome.bookmarks.create({parentId:bar,title:'Source'})).id;
          const target=(await chrome.bookmarks.create({parentId:bar,title:'Tools'})).id;
          await chrome.storage.local.set({modelSecurity:{version:2,settings:{version:1,revision:'rename-fixture',
            privacy:{fullUrl:false,bodyEnabled:false,excludedFolders:[]}}}});
          await chrome.storage.local.set({aiServices:{version:1,revision:'rename-fixture',services:[{
            id:'fixture',name:'Synthetic model',serviceType:'custom',kind:'api',detail:'',baseUrl:origin+'/v1',
            mode:'openai',status:'ok',letter:'F',avatarClass:'custom',catalog:[{id:'synthetic',ctx:'fixture'}],
            enabled:['synthetic'],streaming:false
          }],features:['save','organize'].map(id=>({id,name:id,desc:'',connId:'fixture',modelId:'synthetic'}))}});
          return {bar,source,target};
        }""", origin)
        destination = fixture['target']
        create = lambda suffix: worker.evaluate("""async data => (await chrome.bookmarks.create({
            parentId:data.parent,title:'Synthetic homepage',url:'https://rename.example.test/'+data.suffix})).id""",
            {'parent': fixture['source'], 'suffix': suffix})
        get = lambda bookmark: worker.evaluate("async id => (await chrome.bookmarks.get(id))[0]", bookmark)
        receipt = lambda bookmark: worker.evaluate("""async id => (await chrome.storage.local.get('nativeSaveReceipts')).nativeSaveReceipts
            ?.find(item=>item.bookmarkId===id && item.suggestedTitle)""", bookmark)
        first = create('first')
        wait(lambda: receipt(first))
        assert get(first)['title'] == 'Synthetic homepage'
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'chrome-extension://{extension_id}/save/index.html')
        expect(page.locator('.save-pop-head h1')).to_have_text(re.compile('^已收藏 · '))
        expect(page.get_by_role('textbox', name='名称', exact=True)).to_have_value('Synthetic tool | Diagram editor')
        page.get_by_role('textbox', name='名称', exact=True).fill('Temporary edit')
        locale = context.new_page()
        locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option('en')
        expect(page.get_by_role('textbox', name='Name', exact=True)).to_have_value('Temporary edit')
        locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option('zh-CN')
        page.get_by_role('textbox', name='名称', exact=True).fill('Synthetic tool | Diagram editor')
        page.screenshot(path=str(root / 'save-name-advice.png'), full_page=True)
        check_correction(page, locale, root, comparison=True)
        # A popup closed and reopened keeps its session draft.
        page.reload()
        expect(page.get_by_role('textbox', name='名称', exact=True)).to_have_value('Synthetic tool | Diagram editor')
        page.get_by_role('button', name='保存修改', exact=True).click()
        wait(lambda: get(first)['title'] == 'Synthetic tool | Diagram editor')
        assert not [event for event in events if event['task'] == 'preference-summary']
        worker.evaluate("""async data => {
          const receipt=(await chrome.storage.local.get('nativeSaveReceipts')).nativeSaveReceipts.find(item=>item.bookmarkId===data.first);
          await chrome.storage.local.set({siteRules:{version:1,rules:[{host:'rename.example.test',includeSubdomains:false,
            folder:{installationId:receipt.installationId,nativeId:data.target,kind:'folder'}}]}});
        }""", {'first': first, 'target': fixture['target']})
        second = create('second')
        wait(lambda: receipt(second))
        # The popup closed itself after its last entry; the next save is presented in a fresh popup document.
        wait(page.is_closed)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'chrome-extension://{extension_id}/save/index.html')
        # An explicit local site rule still obtains read-only name advice.
        expect(page.get_by_role('textbox', name='名称', exact=True)).to_have_value('Synthetic tool | Clear purpose')
        page.get_by_role('textbox', name='名称', exact=True).fill('My short tool name')
        page.get_by_role('button', name='保存修改', exact=True).click()
        wait(lambda: get(second)['title'] == 'My short tool name')
        wait(lambda: len([event for event in events if event['task'] == 'preference-summary']) == 1)
        wait(lambda: worker.evaluate("""async () => {
          const data=await chrome.storage.local.get(null);
          return Object.entries(data).some(([key,value])=>key.startsWith('personalization.v1.') &&
            value.entries.some(item=>item.learnedFrom && item.status==='active'));
        }"""))
        wait(page.is_closed)
        page = context.new_page()
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'chrome-extension://{extension_id}/options/index.html#debug')
        page.get_by_role('button', name='改一下', exact=True).first.click()
        check_correction(page, locale, root, comparison=False)
        page.get_by_label('改到目录', exact=True).select_option(fixture['source'])
        page.get_by_role('button', name='改到这个目录', exact=True).click()
        wait(lambda: get(second)['parentId'] == fixture['source'])
        wait(lambda: len([event for event in events if event['task'] == 'preference-summary']) == 2)
        wait(lambda: worker.evaluate("""async () => (await chrome.storage.local.get('correctionLearning.v1'))['correctionLearning.v1']
          ?.filter(job=>job.status==='completed').length === 2"""))
        preferences = context.new_page()
        preferences.goto(f'chrome-extension://{extension_id}/options/index.html#personalization')
        expect(preferences.locator('.personal-preference textarea')).to_have_value('Prefer concise descriptive names for these tools.')
        preferences.locator('.personal-preference textarea').fill('Draft preference: keep product names.')
        for language in ['en', 'zh-CN']:
            locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
            expect(preferences.get_by_label('Remember and use personal preferences' if language == 'en' else '记住并使用个性化偏好', exact=True)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                preferences.set_viewport_size({'width': width, 'height': 960})
                measured = preferences.locator('.personalization-settings').evaluate("""form => {
                  const toggle=form.querySelector('.personalization-toggle');
                  const checkbox=toggle.querySelector('input').getBoundingClientRect();
                  const label=toggle.querySelector('span').getBoundingClientRect();
                  const toolbar=form.querySelector('.personalization-toolbar');
                  const button=toolbar.querySelector('button').getBoundingClientRect();
                  const count=toolbar.querySelector('span').getBoundingClientRect();
                  return {width:innerWidth,scroll:document.documentElement.scrollWidth,
                    toggleAlignment:Math.abs((checkbox.top+checkbox.height/2)-(label.top+label.height/2)),
                    toolbarAlignment:Math.abs((button.top+button.height/2)-(count.top+count.height/2)),
                    extraLabels:form.querySelectorAll('.personal-preference > p,.personal-preference > label').length};
                }""")
                assert measured['scroll'] <= width + 1, measured
                assert measured['toggleAlignment'] < 2, measured
                assert measured['toolbarAlignment'] < 2, measured
                assert measured['extraLabels'] == 0, measured
                expect(preferences.locator('.personal-preference textarea')).to_have_value('Draft preference: keep product names.')
                geometry.append({'surface': 'preferences', 'language': language, **measured})
                preferences.screenshot(path=str(root / f'preferences-{language}-{width}.png'), full_page=True)
        preferences.close()
        before_hidden_route = [get(first), get(second)]
        calls_before_hidden_route = len(events)
        page.goto(f'chrome-extension://{extension_id}/options/index.html#rename')
        for language in ['en', 'zh-CN']:
            locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
            expected_title = 'Bookmarks' if language == 'en' else '书签目录'
            expect(page.get_by_role('heading', name=expected_title, exact=True, level=1)).to_be_visible()
            expect(page.locator('.rename-workbench')).to_have_count(0)
            nav = page.get_by_role('navigation', name='Settings navigation' if language == 'en' else '设置导航')
            rename_title = 'AI bookmark renaming' if language == 'en' else 'AI 书签改名'
            expect(nav.get_by_role('button', name=rename_title, exact=True)).to_have_count(0)
            organize_title = 'AI organization' if language == 'en' else 'AI 整理'
            nav.get_by_role('button', name=organize_title, exact=True).click()
            expect(page.get_by_role('heading', name=organize_title, exact=True, level=1)).to_be_visible()
            page.evaluate("location.hash = '#rename'")
            expect(page.get_by_role('heading', name=expected_title, exact=True, level=1)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 960})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= width + 1, measured
                geometry.append({'surface': 'rename-disabled', 'language': language, **measured})
                page.screenshot(path=str(root / f'rename-disabled-{language}-{width}.png'), full_page=True)
        assert [get(first), get(second)] == before_hidden_route
        assert len(events) == calls_before_hidden_route
        assert not errors, errors
        result = {'status': 'PASS', 'evidence': str(root), 'calls': [event['task'] for event in events],
                  'geometry': geometry, 'scope': 'Synthetic provider, actual production extension and native bookmarks; no real-provider accuracy or user-profile changes.'}
        (root / 'results.json').write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding='utf-8')
        print(json.dumps(result, ensure_ascii=False), flush=True)
    except Exception:
        print('EVIDENCE=' + str(root), flush=True)
        for index, current in enumerate(context.pages):
            print(current.url, current.locator('body').inner_text()[:3000], flush=True)
            current.screenshot(path=str(root / f'failure-{index}.png'), full_page=True)
        raise
    finally:
        context.close()
        server.shutdown()
