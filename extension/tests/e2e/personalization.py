"""Opt-in actual extension review/memory flow; disposable synthetic profile and loopback provider only."""
import argparse
import json
import os
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
parser.add_argument('--browser', default=os.environ.get('CHROMIUM_EXECUTABLE_PATH'))
args = parser.parse_args()
if not args.run:
    print('SKIP: use --run for the disposable personalization browser check')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-personalization-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
manifest_path = extension / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
events = []
release = threading.Event()
assignment_calls = 0


def wait(predicate, timeout=20):
    until = time.monotonic() + timeout
    while time.monotonic() < until:
        if predicate():
            return
        time.sleep(0.05)
    raise AssertionError('Timed out waiting for synthetic background state')


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        global assignment_calls
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append(payload)
        task = payload['task']
        if task == 'organize':
            output = {'moves': [], 'merges': [], 'newFolders': []}
            ids = [item['id'] for item in payload['items']]
            if payload['stage'] == 'analysis':
                output['topics'] = [{'title': 'Tutorials', 'itemIds': ids}]
            elif payload['stage'] == 'folders':
                output['newFolders'] = [{'id': 'learning-draft', 'parentId': payload['rootId'], 'title': 'Learning'}]
            else:
                assignment_calls += 1
                if assignment_calls == 1:
                    output['uncertainIds'] = ids
                else:
                    if assignment_calls == 2:
                        assert release.wait(timeout=45), 'fixture review timed out'
                    output['moves'] = [{'itemId': item_id, 'folderId': 'learning-draft'} for item_id in ids]
        elif task == 'preference-summary':
            output = {'rules': [{'text': 'Prefer learning resources for tutorials.', 'exampleIds': [item['id'] for item in payload['examples']]}]}
        elif task == 'search-batch':
            output = {'matchedIds': [item['id'] for item in payload['items']], 'unmatchedIds': [], 'uncertainIds': []}
        else:
            raise AssertionError(payload)
        data = json.dumps({'choices': [{'finish_reason': 'stop', 'message': {'content': json.dumps(output)}}]}).encode()
        self.send_response(200)
        self.send_header('Content-Type', 'application/json')
        self.send_header('Content-Length', str(len(data)))
        self.end_headers()
        self.wfile.write(data)


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 900}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        worker.evaluate("""async origin => {
          const tree=await chrome.bookmarks.getTree();const bar=tree[0].children[0];
          for(let i=0;i<4;i++) await chrome.bookmarks.create({parentId:bar.id,title:`Synthetic tutorial ${i}`,url:`https://example.test/tutorial-${i}?private=hidden#fragment`});
          await chrome.storage.local.set({modelSecurity:{version:2,settings:{version:1,revision:'personal-privacy',privacy:{fullUrl:false,bodyEnabled:false,excludedFolders:[]}}}});
          await chrome.storage.local.set({aiServices:{version:1,revision:'personal-fixture',services:[{
            id:'personal-service',name:'Synthetic provider',serviceType:'custom',kind:'api',detail:'',baseUrl:origin+'/v1',mode:'openai',status:'ok',letter:'P',avatarClass:'custom',
            catalog:[{id:'personal-model',ctx:'fixture'}],enabled:['personal-model'],streaming:false
          }],features:['search','organize'].map(id=>({id,name:id,desc:'',connId:'personal-service',modelId:'personal-model'}))}});
        }""", origin)
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        page = context.new_page()
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        page.goto(f'chrome-extension://{extension_id}/options/index.html#personalization')
        preferences = page.get_by_role('region', name='个性化偏好', exact=True)
        expect(preferences.get_by_text('暂无', exact=True)).to_be_visible()
        assert '偏好保存在本机' not in preferences.inner_text()
        assert '200 条' not in preferences.inner_text()
        page.get_by_role('button', name='AI 整理', exact=True).click()
        page.get_by_text('高级选项', exact=True).click()
        page.get_by_label('每批最多书签', exact=True).fill('2')
        page.get_by_role('button', name='下一步：生成整理方案', exact=True).click()
        interactive = page.get_by_role('region', name='逐批审核与反馈', exact=True)
        expect(interactive).to_be_visible(timeout=25000)
        uncertain = interactive.get_by_role('region', name='待确认书签', exact=True)
        uncertain.get_by_role('checkbox', name='Synthetic tutorial 0', exact=True).check()
        interactive.get_by_label('目标目录', exact=True).select_option('learning-draft')
        interactive.get_by_role('button', name='确认所选归类', exact=True).click()
        expect(interactive.get_by_text('已审核', exact=True)).to_have_count(1)
        uncertain.get_by_role('checkbox', name='Synthetic tutorial 1', exact=True).check()
        interactive.get_by_label('告诉 AI 哪里不合理', exact=True).fill('Tutorials belong in Learning.')
        interactive.get_by_role('button', name='提交反馈并重新分类', exact=True).click()
        expect(interactive.get_by_text('等待重新分类 1 条', exact=True)).to_be_visible()
        expect(page.locator('.organize-batches')).to_be_visible()
        expect(page.locator('.busy-indicator')).to_have_count(0)
        page.screenshot(path=str(root / 'progress.png'), full_page=True)
        release.set()
        expect(page.get_by_text('完整方案已生成', exact=True)).to_be_visible(timeout=25000)
        feedback_calls = [event for event in events if event.get('userFeedback')]
        assert len(feedback_calls) == 1 and len(feedback_calls[0]['items']) == 1, feedback_calls
        page.get_by_role('button', name='个性化偏好', exact=True).click()
        wait(lambda: worker.evaluate("""async () => {
          const jobs=(await chrome.storage.local.get('correctionLearning.v1'))['correctionLearning.v1'];
          return jobs?.length >= 2 && jobs.every(job=>job.status==='completed');
        }"""))
        expect(page.locator('.personal-preference')).to_have_count(1)
        page.get_by_label('偏好内容', exact=True).fill('a' * 2950)
        page.get_by_role('button', name='保存修改', exact=True).click()
        expect(page.get_by_text('已用 2950 / 3000 字', exact=True)).to_be_visible()
        page.get_by_role('button', name='添加个人规则', exact=True).click()
        page.get_by_label('添加个人规则', exact=True).fill('Keep tutorials separate from product homepages. ' * 3)
        page.get_by_role('button', name='保存个人规则', exact=True).click()
        expect(page.locator('.personal-preference')).to_have_count(1)
        expect(page.get_by_label('偏好内容', exact=True)).to_have_value('Prefer learning resources for tutorials.', timeout=20000)
        compression = [event for event in events if event['task'] == 'preference-summary'][-1]
        assert compression['characterLimit'] == 3000 and len(compression['examples']) == 2, compression
        assert compression['examples'][0]['text'] == 'a' * 2950, compression
        # Native maxlength is UTF-16; the full 3000-character Unicode budget must remain usable.
        page.get_by_label('偏好内容', exact=True).fill('😀' * 3000)
        expect(page.get_by_label('偏好内容', exact=True)).to_have_value('😀' * 3000)
        page.get_by_role('button', name='保存修改', exact=True).click()
        expect(page.get_by_text('已用 3000 / 3000 字', exact=True)).to_be_visible()
        # Edit and scope controls survive language changes in the same mounted settings page.
        first = page.locator('.personal-preference').first
        first.get_by_label('偏好内容', exact=True).fill('Edited personal tutorial preference.')
        locale = context.new_page()
        locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        locale.get_by_label('语言', exact=True).select_option('en')
        expect(first.get_by_label('Preference text', exact=True)).to_have_value('Edited personal tutorial preference.')
        first.get_by_role('button', name='Save changes', exact=True).click()
        geometry = []
        for language in ['en', 'zh-CN']:
            locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
            expect(page.get_by_role('heading', name='Personal preferences' if language == 'en' else '个性化偏好', exact=True)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= width + 1, measured
                geometry.append({'language': language, **measured})
                page.screenshot(path=str(root / f'preferences-{language}-{width}.png'), full_page=True)
            page.get_by_role('button', name='AI organization' if language == 'en' else 'AI 整理', exact=True).click()
            expect(page.get_by_role('region', name='Review batches and give feedback' if language == 'en' else '逐批审核与反馈', exact=True)).to_be_visible()
            for width in [320, 340, 480, 1024]:
                page.set_viewport_size({'width': width, 'height': 900})
                page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll'] <= width + 1, measured
                geometry.append({'surface': 'organize', 'language': language, **measured})
                page.screenshot(path=str(root / f'organize-{language}-{width}.png'), full_page=True)
            page.get_by_role('button', name='Personal preferences' if language == 'en' else '个性化偏好', exact=True).click()
        page.get_by_role('button', name='书签目录', exact=True).click()
        page.get_by_role('searchbox').fill('find learning tutorials')
        page.get_by_role('button', name='AI 帮我找', exact=True).click()
        expect(page.get_by_role('region', name='搜索结果')).to_have_attribute('aria-busy', 'false', timeout=20000)
        search = [event for event in events if event['task'] == 'search-batch'][-1]
        assert any(hint['text'] == 'Edited personal tutorial preference.' for hint in search['personalPreferences']), search
        assert 'private=hidden' not in json.dumps(events), events
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        # Native bookmark manager/API edits use the same background preference owner.
        count = len([event for event in events if event['task'] == 'preference-summary'])
        native = worker.evaluate("""async () => {
          const tree=await chrome.bookmarks.getTree();const bar=tree[0].children[0];
          const item=bar.children.find(node=>node.url);
          const target=await chrome.bookmarks.create({parentId:bar.id,title:'Manual learning'});
          await chrome.bookmarks.move(item.id,{parentId:target.id});return item.id;
        }""")
        wait(lambda: worker.evaluate("""async () => {
          const jobs=(await chrome.storage.local.get('correctionLearning.v1'))['correctionLearning.v1'];
          return jobs?.some(job=>job.id.startsWith('native:') && job.status==='completed');
        }"""))
        assert len([event for event in events if event['task'] == 'preference-summary']) == count + 1
        worker.evaluate("async id => chrome.bookmarks.update(id,{title:'User chosen tutorial name'})", native)
        wait(lambda: worker.evaluate("""async () => {
          const jobs=(await chrome.storage.local.get('correctionLearning.v1'))['correctionLearning.v1'];
          return jobs?.filter(job=>job.id.startsWith('native:') && job.status==='completed').length===2;
        }"""))
        assert len([event for event in events if event['task'] == 'preference-summary']) == count + 2
        assert not errors, errors
        result = {'passed': True, 'requests': len(events), 'geometry': geometry, 'limits': 'Synthetic provider and disposable native bookmarks. No personal profile or final native apply. Actual production JavaScript unchanged.'}
        (root / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'output': str(root), **result}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'failed_output': str(root)}))
        if 'worker' in locals():
            state = worker.evaluate("""async () => {const data=await chrome.storage.local.get(null);
              return Object.fromEntries(Object.entries(data).filter(([key])=>key==='correctionLearning.v1'||key.startsWith('personalization.v1.')));
            }""")
            (root / 'debug.json').write_text(json.dumps({'events': events, 'state': state}, ensure_ascii=False, indent=2), encoding='utf-8')
        if 'page' in locals() and not page.is_closed():
            page.screenshot(path=str(root / 'failure.png'), full_page=True)
            (root / 'failure.html').write_text(page.content(), encoding='utf-8')
        raise
    finally:
        release.set()
        context.close()
        server.shutdown()
