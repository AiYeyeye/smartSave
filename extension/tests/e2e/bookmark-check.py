"""Opt-in bookmark-check acceptance: disposable profile, synthetic local HTTP fixtures only."""
import argparse
import hashlib
import json
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path
import shutil
import sys
import tempfile
import threading
import time
from playwright.sync_api import expect, sync_playwright

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default='C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for isolated synthetic bookmark checks')
    raise SystemExit(0)
root = Path(tempfile.mkdtemp(prefix='zhilan-check-'))
production = Path(__file__).resolve().parents[2] / 'dist'
extension = root / 'extension'
shutil.copytree(production, extension)
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
# Headless Chromium cannot show the optional host prompt. Only this disposable copy pregrants it.
manifest['host_permissions'] = ['http://*/*', 'https://*/*']
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
requests = []
slow = threading.Event()
class Handler(BaseHTTPRequestHandler):
    def log_message(self, *_):
        pass
    def do_HEAD(self):
        self.respond()
    def do_GET(self):
        self.respond()
    def respond(self):
        requests.append((self.command, self.path))
        if self.path.startswith('/slow'):
            slow.wait(10)
        code = 404 if self.path.startswith('/missing') else 403 if self.path == '/restricted' else 302 if self.path == '/redirect' else 200
        self.send_response(code)
        if code == 302:
            self.send_header('Location', '/must-not-follow')
        self.send_header('Content-Length', '0')
        self.end_headers()
server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
port = server.server_address[1]

with sync_playwright() as playwright:
    context = playwright.chromium.launch_persistent_context(str(root / 'profile'), executable_path=args.browser, headless=True,
        args=[f'--disable-extensions-except={extension}', f'--load-extension={extension}', '--disable-background-networking',
              '--no-proxy-server', '--host-resolver-rules=MAP *.check.test 127.0.0.1'],
        viewport={'width': 1024, 'height': 900}, reduced_motion='reduce')
    try:
        worker = context.service_workers[0] if context.service_workers else context.wait_for_event('serviceworker')
        extension_id = worker.url.split('/')[2]
        fixture = worker.evaluate("""async port => {
          const roots=(await chrome.bookmarks.getTree())[0].children;
          const folder=await chrome.bookmarks.create({parentId:roots[0].id,title:'检查演示'});
          const urls=[['正常网页','/ok'],['失效网页','/missing'],['需要登录','/restricted'],['网页跳转','/redirect']];
          const items=[];for(const [title,path] of urls) items.push(await chrome.bookmarks.create({parentId:folder.id,title,url:`http://web.check.test:${port}${path}`}));
          const duplicate=await chrome.bookmarks.create({parentId:roots[1].id,title:'重复网页',url:items[0].url});
          const local=await chrome.bookmarks.create({parentId:folder.id,title:'本机地址',url:'http://127.0.0.1/private'});
          return {folder:folder.id,items,duplicate,local};
        }""", port)
        page = context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#check')
        # Let unrelated new-bookmark routing settle, then establish a cross-root duplicate fixture.
        page.wait_for_timeout(1500)
        page.evaluate("async id=>{const roots=(await chrome.bookmarks.getTree())[0].children;await chrome.bookmarks.move(id,{parentId:roots[1].id})}",fixture['duplicate']['id'])
        def state():
            return page.evaluate("async()=>{const r=await chrome.runtime.sendMessage({type:'bookmarkCheck',action:'get'});if(r.status!=='ok')throw Error(r.reason);return r.state}")
        def wait_state(predicate):
            until=time.monotonic()+30
            while time.monotonic()<until:
                value=state()
                if predicate(value): return value
                page.wait_for_timeout(100)
            raise AssertionError(state())
        expect(page.get_by_role('heading', name='书签检查', exact=True)).to_be_visible()
        expect(page.locator('.check-help')).not_to_have_attribute('open', '')
        before=page.evaluate('()=>chrome.bookmarks.getTree()')
        page.get_by_role('button', name='立即检查', exact=True).click()
        checked=wait_state(lambda s:s.get('job',{}).get('status')=='completed')
        expect(page.get_by_role('button',name='重新检查',exact=True)).to_be_visible()
        verdicts={item['nativeId']:item['result']['status'] for item in checked['job']['items']}
        assert [verdicts[item['id']] for item in fixture['items']]==['ok','broken','review','review'], verdicts
        assert verdicts[fixture['local']['id']]=='skipped'
        assert requests.count(('HEAD','/ok'))==1 and not any(path=='/must-not-follow' for _,path in requests)
        after=page.evaluate('()=>chrome.bookmarks.getTree()')
        (root/'native-before.json').write_text(json.dumps(before,indent=2,ensure_ascii=False),encoding='utf-8')
        (root/'native-after.json').write_text(json.dumps(after,indent=2,ensure_ascii=False),encoding='utf-8')
        assert after==before
        geometry=[]
        for language in ['zh-CN','en']:
            if language=='en': page.get_by_label('语言',exact=True).select_option('en')
            for width in [320,340,480,1024]:
                page.set_viewport_size({'width':width,'height':900})
                page.evaluate('()=>new Promise(r=>requestAnimationFrame(()=>requestAnimationFrame(r)))')
                measured=page.evaluate('({width:innerWidth,scroll:document.documentElement.scrollWidth})')
                assert measured['scroll']<=width+1, measured
                geometry.append({'language':language,**measured})
                page.screenshot(path=str(root/f'links-{language}-{width}.png'),full_page=True)
        page.get_by_label('Language',exact=True).select_option('zh-CN')
        page.set_viewport_size({'width':1024,'height':900})
        page.get_by_role('radio',name='快速切换为深色',exact=True).check()
        expect(page.locator('.theme-root')).to_have_attribute('data-mode','dark')
        page.evaluate('()=>new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))')
        page.wait_for_timeout(250)
        dark=page.evaluate("()=>({mode:document.querySelector('.theme-root').dataset.mode, root:getComputedStyle(document.querySelector('.theme-root')).getPropertyValue('--surface'), row:getComputedStyle(document.querySelector('.check-row')).backgroundColor})")
        (root/'dark-style.json').write_text(json.dumps(dark),encoding='utf-8')
        assert dark['row']=='rgb(23, 24, 28)', dark
        page.screenshot(path=str(root/'links-dark.png'),full_page=True)
        page.get_by_role('radio',name='快速切换为浅色',exact=True).check()
        expect(page.locator('.theme-root')).to_have_attribute('data-mode','light')
        page.get_by_role('tab',name='重复收藏',exact=False).click()
        expect(page.get_by_role('heading',name='精确重复 · 2 条',exact=True)).to_be_visible()
        page.get_by_label('检查范围',exact=True).select_option(fixture['folder'])
        expect(page.get_by_text('未发现重复收藏',exact=True)).to_be_visible()
        page.get_by_label('检查范围',exact=True).select_option('')
        page.get_by_label('正常网页 保留或删除',exact=True).select_option('keep')
        page.get_by_label('重复网页 保留或删除',exact=True).select_option('delete')
        page.get_by_label('语言',exact=True).select_option('en')
        expect(page.get_by_label('Keep or delete 重复网页',exact=True)).to_have_value('delete')
        page.get_by_label('Language',exact=True).select_option('zh-CN')
        for width in [320,1024]:
            page.set_viewport_size({'width':width,'height':900})
            assert page.evaluate('document.documentElement.scrollWidth')<=width+1
            page.screenshot(path=str(root/f'duplicates-{width}.png'),full_page=True)
        page.get_by_role('button',name='删除所选 1 项',exact=True).click()
        expect(page.get_by_role('dialog')).to_be_visible()
        assert page.evaluate('()=>chrome.bookmarks.getTree()')==before
        page.get_by_role('button',name='确认删除',exact=True).click()
        expect(page.get_by_text('未发现重复收藏',exact=True)).to_be_visible()
        page.get_by_role('button',name='导出与备份',exact=True).click()
        page.get_by_text('备份与恢复记录',exact=True).click()
        recovery=page.get_by_role('region',name='备份与恢复',exact=True)
        recovery.get_by_role('button',name='预览撤销',exact=True).click()
        preview=recovery.get_by_role('region',name='恢复预览',exact=True)
        # Exact-URL duplicates retain the existing conservative recovery conflict rule.
        expect(preview).to_contain_text('same-url-is-not-identity-review-required')
        expect(preview.get_by_role('button',name='应用撤销',exact=True)).to_be_disabled()
        preview.get_by_role('button',name='取消预览',exact=True).click()
        page.get_by_role('button',name='书签检查',exact=True).click()
        page.get_by_role('tab',name='失效链接',exact=True).click()
        page.get_by_role('button',name='立即检查',exact=True).click()
        wait_state(lambda s:s['job']['status']=='completed')
        page.get_by_role('checkbox',name='选择收藏：失效网页',exact=True).check()
        page.get_by_role('button',name='删除所选 1 项',exact=True).click()
        page.get_by_role('button',name='确认删除',exact=True).click()
        expect(page.get_by_role('checkbox',name='选择收藏：失效网页',exact=True)).to_have_count(0)
        page.get_by_role('button',name='导出与备份',exact=True).click()
        recovery.get_by_role('button',name='刷新恢复记录',exact=True).click()
        expect(recovery.get_by_role('button',name='预览撤销',exact=True)).to_have_count(2)
        recovery.get_by_role('button',name='预览撤销',exact=True).first.click()
        expect(preview).to_contain_text('失效网页')
        preview.get_by_role('checkbox',name='确认以上影响范围',exact=True).check()
        preview.get_by_role('button',name='应用撤销',exact=True).click()
        expect(recovery).to_contain_text('执行子计划 completed')
        page.get_by_role('button',name='书签检查',exact=True).click()
        pending=page.evaluate("async ({folder,port})=>chrome.bookmarks.create({parentId:folder,title:'慢速演示',url:`http://slow.check.test:${port}/slow`})",{'folder':fixture['folder'],'port':port})
        page.get_by_role('button',name='重新检查',exact=True).click()
        wait_state(lambda s:s.get('job',{}).get('status')=='running')
        page.get_by_role('button',name='暂停检查',exact=True).click()
        wait_state(lambda s:s['job']['status']=='paused')
        page.reload()
        expect(page.get_by_role('button',name='继续检查',exact=True)).to_be_visible()
        page.get_by_role('button',name='继续检查',exact=True).click()
        wait_state(lambda s:s['job']['status']=='running')
        # Stop the actual extension worker while its read-only job is unfinished.
        cdp=context.new_cdp_session(page)
        versions=[]
        cdp.on('ServiceWorker.workerVersionUpdated',lambda event:versions.extend(event['versions']))
        cdp.send('ServiceWorker.enable')
        until=time.monotonic()+5
        while not any(v.get('scriptURL')==worker.url and v.get('runningStatus')=='running' for v in versions):
            assert time.monotonic()<until
            page.wait_for_timeout(20)
        running=next(v for v in reversed(versions) if v.get('scriptURL')==worker.url and v.get('runningStatus')=='running')
        mark=len(versions)
        cdp.send('ServiceWorker.stopWorker',{'versionId':running['versionId']})
        until=time.monotonic()+5
        while not any(v.get('scriptURL')==worker.url and v.get('runningStatus')=='stopped' for v in versions[mark:]):
            assert time.monotonic()<until
            page.wait_for_timeout(20)
        # Close the view entirely while a slow request is running; worker owns the task.
        page.close()
        slow.set()
        page=context.new_page()
        page.goto(f'chrome-extension://{extension_id}/options/index.html#check')
        wait_state(lambda s:s['job']['status']=='completed')
        expect(page.get_by_role('button',name='重新检查',exact=True)).to_be_visible()
        page.get_by_role('checkbox',name='每周自动检查',exact=True).check()
        wait_state(lambda s:s['weekly'])
        alarm=page.evaluate("()=>chrome.alarms.get('zhilan.bookmark-check.weekly.v1')")
        assert alarm['periodInMinutes']==10080
        previous=state()['job']['id']
        page.evaluate("()=>chrome.alarms.create('zhilan.bookmark-check.weekly.v1',{when:Date.now()+1000,periodInMinutes:10080})")
        wait_state(lambda s:s['job']['id']!=previous and s['job']['status']=='completed')
        page.get_by_role('checkbox',name='每周自动检查',exact=True).uncheck()
        wait_state(lambda s:not s['weekly'])
        assert page.evaluate("()=>chrome.alarms.get('zhilan.bookmark-check.weekly.v1')") is None
        sidebar=context.new_page()
        sidebar.goto(f'chrome-extension://{extension_id}/panel/index.html')
        with context.expect_page() as opened:
            sidebar.get_by_role('button',name='检查',exact=True).click()
        expect(opened.value).to_have_url(f'chrome-extension://{extension_id}/options/index.html#check')
        result={'status':'PASS','evidence':str(root),'browser':context.browser.version,'geometry':geometry,
                'manualCheck':True,'weeklyAlarm':True,'pauseReloadResume':True,'viewClosure':True,'workerRestart':True,'crossRootDuplicates':True,
                'explicitDeletionAndUndo':True,'sidebarEntry':True,'requests':requests,
                'workerSHA256':hashlib.sha256((production/'service-worker.js').read_bytes()).hexdigest(),
                'limit':'Production JS/CSS, disposable manifest pregrants optional website access; browser permission prompt and branded-browser release matrix not verified.'}
        (root/'results.json').write_text(json.dumps(result,indent=2,ensure_ascii=False),encoding='utf-8')
        print(json.dumps(result,ensure_ascii=False),flush=True)
    except Exception:
        print('EVIDENCE='+str(root),flush=True)
        for index,p in enumerate(context.pages):
            if p.url.startswith('chrome-extension:'):
                print(p.url,p.locator('body').inner_text()[-6000:],flush=True)
                p.screenshot(path=str(root/f'failure-{index}.png'),full_page=True)
        raise
    finally:
        slow.set()
        context.close()
        server.shutdown()
