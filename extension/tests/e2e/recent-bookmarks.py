"""Opt-in production UI/native-date acceptance using only a disposable synthetic profile."""
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
    print('SKIP: use --run to check recent bookmarks in a disposable synthetic profile')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-recent-'))
extension = root / 'extension'
shutil.copytree(package / 'dist', extension)
manifest_path = extension / 'manifest.json'
manifest = json.loads(manifest_path.read_text(encoding='utf-8'))
manifest['host_permissions'] = ['http://127.0.0.1/*']
manifest_path.write_text(json.dumps(manifest), encoding='utf-8')
profile = root / 'profile'
(profile / 'Default').mkdir(parents=True)
now = time.time()


def stamp(days=0):
    return str(int((now - days * 86400 + 11644473600) * 1000000))


children = [{'type': 'url', 'id': str(10+i), 'name': f'Synthetic {name}',
             'url': f'https://example.test/{name}?private=not-for-model#fragment',
             'date_added': stamp(days)}
            for i, (name, days) in enumerate([('Current', 1), ('Reading', 45), ('Reference', 88), ('Drawing tool', 120), ('Earlier', 300), ('Too old', 400)])]
roots = {key: {'type': 'folder', 'id': str(i+1), 'name': name, 'date_added': stamp(), 'date_modified': stamp(),
               'children': children if i == 0 else []}
         for i, (key, name) in enumerate([('bookmark_bar', 'Bookmarks bar'), ('other', 'Other bookmarks'), ('synced', 'Mobile bookmarks')])}
(profile / 'Default' / 'Bookmarks').write_text(json.dumps({'version': 1, 'roots': roots}), encoding='utf-8')
events = []


class Provider(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass

    def do_POST(self):
        raw = json.loads(self.rfile.read(int(self.headers['Content-Length'])))
        payload = json.loads(raw['messages'][1]['content'])
        events.append(payload)
        assert payload['task'] == 'search-batch', payload
        matched = [item['id'] for item in payload['items'] if item['title'] == 'Synthetic Drawing tool']
        output = {'matchedIds': matched, 'unmatchedIds': [item['id'] for item in payload['items'] if item['id'] not in matched], 'uncertainIds': []}
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
    context = playwright.chromium.launch_persistent_context(str(profile), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking'],
        viewport={'width': 1024, 'height': 900}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        before = worker.evaluate('()=>chrome.bookmarks.getTree()')
        native = before[0]['children'][0]['children']
        assert len(native) == 6 and native[3]['dateAdded'] < (now - 119 * 86400) * 1000, native
        worker.evaluate("""async origin => {
          await chrome.storage.local.set({modelSecurity:{version:2,settings:{version:1,revision:'recent-private-url',privacy:{fullUrl:false,bodyEnabled:false,excludedFolders:[]}}}});
          await chrome.storage.local.set({aiServices:{version:1,revision:'recent-fixture',services:[{
            id:'recent-service',name:'Synthetic provider',serviceType:'custom',kind:'api',detail:'',baseUrl:origin+'/v1',mode:'openai',status:'ok',letter:'R',avatarClass:'custom',
            catalog:[{id:'recent-model',ctx:'fixture'}],enabled:['recent-model'],streaming:false
          }],features:[{id:'search',name:'Search',desc:'',connId:'recent-service',modelId:'recent-model'}]}});
        }""", origin)
        locale = context.new_page()
        locale.goto(f'chrome-extension://{extension_id}/options/index.html#appearance')
        geometry = []
        hover_checks = []
        errors = []

        def check_hover(button, scope):
            button.hover()
            page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
            colors = button.evaluate("""el => {
              const style=getComputedStyle(el);
              const canvas=document.createElement('canvas'); canvas.width=canvas.height=1;
              const ctx=canvas.getContext('2d');
              const rgb=value=>{ctx.clearRect(0,0,1,1);ctx.fillStyle=value;ctx.fillRect(0,0,1,1);
                return [...ctx.getImageData(0,0,1,1).data].slice(0,3)};
              const luminance=value=>rgb(value).map(v=>v/255).map(v=>v<=.04045?v/12.92:((v+.055)/1.055)**2.4)
                .reduce((sum,v,i)=>sum+v*[.2126,.7152,.0722][i],0);
              const fg=luminance(style.color), bg=luminance(style.backgroundColor);
              return {color:style.color,background:style.backgroundColor,contrast:(Math.max(fg,bg)+.05)/(Math.min(fg,bg)+.05)};
            }""")
            assert colors['contrast'] >= 3, (scope, colors)
            hover_checks.append({'scope': scope, **colors})

        for surface in ['options', 'panel']:
            page = context.new_page()
            page.on('pageerror', lambda error: errors.append(str(error)))
            page.goto(f'chrome-extension://{extension_id}/{surface}/index.html#browse')
            page.get_by_role('button', name='最近收藏', exact=True).click()
            expect(page.locator('.search-scopes')).to_have_count(1)
            expect(page.locator('.search-scopes button')).to_have_text(['目录', '最近收藏', '历史'])
            expect(page.locator('.bookmark-range-note')).to_have_count(0)
            expect(page.get_by_text('默认查找近 90 天；AI 未找到匹配时自动扩大到近 360 天。', exact=True)).to_have_count(0)
            expect(page.locator('.search-hit-open')).to_have_count(3)
            page.get_by_label('收藏时间', exact=True).select_option('7')
            expect(page.locator('.search-hit-open')).to_have_count(1)
            page.get_by_label('收藏时间', exact=True).select_option('all')
            expect(page.locator('.search-hit-open')).to_have_count(6)
            assert len(events) == (0 if surface == 'options' else 2)
            page.get_by_label('收藏时间', exact=True).select_option('auto')
            page.get_by_role('searchbox').fill('我最近收藏了一个画图工具')
            page.get_by_role('button', name='AI 帮我找', exact=True).click()
            expect(page.get_by_text('已检查 5 / 5 条 · 匹配 1 条 · 无法确定 0 条', exact=True)).to_be_visible(timeout=20000)
            expect(page.get_by_role('button', name='Synthetic Drawing tool', exact=True)).to_be_visible()
            pair = events[-2:]
            assert [len(event['items']) for event in pair] == [3, 2], pair
            ids = [item['id'] for event in pair for item in event['items']]
            assert len(set(ids)) == 5 and all('dateAdded' in item for event in pair for item in event['items'])
            assert 'not-for-model' not in json.dumps(events)
            for language in ['zh-CN', 'en']:
                locale.locator('select[aria-label="语言"],select[aria-label="Language"]').select_option(language)
                label = 'Date saved' if language == 'en' else '收藏时间'
                expect(page.get_by_label(label, exact=True)).to_have_value('auto')
                expect(page.get_by_role('searchbox')).to_have_value('我最近收藏了一个画图工具')
                for width in [320, 340, 480, 1024]:
                    page.set_viewport_size({'width': width, 'height': 900})
                    page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
                    measured = page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                    assert measured['scroll'] <= width + 1, measured
                    tabs = page.locator('.search-scopes button')
                    boxes = tabs.evaluate_all("""buttons=>buttons.map(el=>({top:el.getBoundingClientRect().top,
                      scroll:el.scrollWidth,width:el.clientWidth,pressed:el.getAttribute('aria-pressed')}))""")
                    assert max(b['top'] for b in boxes)-min(b['top'] for b in boxes) <= 1, boxes
                    assert all(b['scroll'] <= b['width']+1 for b in boxes), boxes
                    assert sum(b['pressed']=='true' for b in boxes)==1, boxes
                    check_hover(page.locator('.search-scopes [aria-pressed="true"]'), f'{surface}-{language}-{width}')
                    geometry.append({'surface': surface, 'language': language, **measured})
                    page.screenshot(path=str(root / f'{surface}-{language}-{width}.png'), full_page=True)
                page.get_by_role('button', name='Synthetic Drawing tool', exact=True).click(button='right')
                expect(page.get_by_role('menuitem', name='Edit' if language == 'en' else '编辑', exact=True)).to_be_visible()
                page.keyboard.press('Escape')
            locale.get_by_label('Language', exact=True).select_option('zh-CN')
            # Real idle worker/port lifetimes: keep the same result nodes and list position.
            page.get_by_role('searchbox').fill('')
            expect(page.locator('.search-hit-open')).to_have_count(3)
            page.set_viewport_size({'width': 320, 'height': 900})
            page.screenshot(path=str(root / f'{surface}-recent-idle-320.png'), full_page=True)
            page.evaluate("""()=> {
              window.stableRecentRows=[...document.querySelectorAll('.search-hit-open')];
              window.recentChanges=[];
              const section=document.querySelector('.search-results');
              const top=section.querySelector('.search-hit-list').getBoundingClientRect().top;
              window.recentObserver=new MutationObserver(()=> {
                const rows=[...section.querySelectorAll('.search-hit-open')];
                const y=section.querySelector('.search-hit-list')?.getBoundingClientRect().top;
                if(rows.some((row,i)=>row!==window.stableRecentRows[i] || getComputedStyle(row).opacity!=='1') || Math.abs(y-top)>1)
                  window.recentChanges.push({rows:rows.length,y,top});
              });
              window.recentObserver.observe(section,{childList:true,subtree:true,attributes:true});
            }""")
            if surface == 'panel':
                print('Checking 40 seconds of idle recent-list stability', flush=True)
                page.wait_for_timeout(40000)
            assert page.evaluate('window.recentChanges') == [], page.evaluate('window.recentChanges')
            page.evaluate('window.recentObserver.disconnect()')
            page.close()
        # Verify common selected/primary controls in both modes, all accent palettes.
        page = context.new_page()
        for mode in ['light', 'dark']:
            locale.get_by_role('radio', name='浅色' if mode == 'light' else '深色', exact=True).click()
            for accent in ['靛紫', '海蓝', '青绿', '琥珀', '玫红', '石墨']:
                locale.get_by_role('radio', name=accent, exact=True).locator('..').click()
                page.goto(f'chrome-extension://{extension_id}/options/index.html#token-usage')
                check_hover(page.locator('.token-period [aria-pressed="true"]'), f'token-{mode}-{accent}')
                page.goto(f'chrome-extension://{extension_id}/panel/index.html')
                page.get_by_role('button', name='最近收藏', exact=True).click()
                check_hover(page.locator('.search-scopes [aria-pressed="true"]'), f'recent-{mode}-{accent}')
                page.get_by_role('button', name='历史', exact=True).click()
                check_hover(page.get_by_role('button', name='启用历史查询', exact=True), f'plain-{mode}-{accent}')
        page.close()
        assert len(events) == 4 and not errors, (events, errors)
        assert worker.evaluate('()=>chrome.bookmarks.getTree()') == before
        result = {'passed': True, 'browser': context.browser.version if context.browser else 'Chromium', 'requests': len(events), 'geometry': geometry, 'hoverChecks': hover_checks,
                  'limits': 'Synthetic provider only; native dates seeded in a disposable profile. Production JavaScript unchanged. Physical side-panel host not exercised.'}
        (root / 'result.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
        print(json.dumps({'output': str(root), **result}, ensure_ascii=False))
    except Exception:
        print(json.dumps({'failed_output': str(root)}))
        if 'page' in locals() and not page.is_closed():
            page.screenshot(path=str(root / 'failure.png'), full_page=True)
            (root / 'failure.html').write_text(page.content(), encoding='utf-8')
        raise
    finally:
        context.close()
        server.shutdown()
