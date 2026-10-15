"""No debugger/CDP: production worker, local45s SSE, page closed, then idle worker replacement.

--run creates an isolated profile and dist copy. A fixture driver is appended to options HTML;
production UI/worker JS are unchanged. No actual provider/key/user profile is used.
"""
import argparse
import base64
import hashlib
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
import json
import os
from pathlib import Path
import shutil
import subprocess
import sys
import tempfile
import threading
import time

sys.stdout.reconfigure(encoding='utf-8')
parser = argparse.ArgumentParser()
parser.add_argument('--run', action='store_true')
parser.add_argument('--browser', default=os.environ.get('ZHILAN_BROWSER_EXECUTABLE', 'C:/Users/PC/AppData/Local/ms-playwright/chromium-1208/chrome-win64/chrome.exe'))
parser.add_argument('--output')
args = parser.parse_args()
if not args.run:
    print('SKIP: pass --run for an isolated synthetic no-debugger lifetime test')
    raise SystemExit(0)
package = Path(__file__).resolve().parents[2]
root = Path(tempfile.mkdtemp(prefix='zhilan-organize-lifetime-'))
extension, profile = root / 'extension', root / 'profile'
shutil.copytree(package / 'dist', extension)
started, completed, inspected, inspect_ready = (threading.Event() for _ in range(4))
reports, events = {}, []


class Provider(BaseHTTPRequestHandler):
    protocol_version = 'HTTP/1.1'

    def log_message(self, *_):
        pass

    def handle(self):
        try:
            super().handle()
        except (ConnectionAbortedError, ConnectionResetError, BrokenPipeError):
            pass

    def do_GET(self):
        if self.path != '/inspect':
            self.send_error(404)
            return
        # This request belongs to the inert probe page, never the extension worker.
        inspect_ready.wait(110)
        self.send_response(200)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def do_POST(self):
        raw = self.rfile.read(int(self.headers['Content-Length']))
        if self.path in ['/started', '/report', '/error']:
            value = json.loads(raw)
            reports[self.path] = {'at': time.time(), **value}
            self.send_response(200)
            self.send_header('Content-Length', '0')
            self.end_headers()
            {'/started': started, '/report': inspected, '/error': inspected}[self.path].set()
            return
        payload = json.loads(json.loads(raw)['messages'][0]['content'])
        if self.path != '/v1/messages' or payload.get('task') != 'organize':
            self.send_error(400)
            return
        ids = [item['id'] for item in payload.get('items', [])]
        stage = payload.get('stage')
        events.append({'at': time.time(), 'stage': stage, 'ids': ids, 'state': 'started'})
        self.send_response(200)
        self.send_header('Content-Type', 'text/event-stream')
        self.send_header('Transfer-Encoding', 'chunked')
        self.end_headers()

        def frame(value):
            data = ('event: ' + value['type'] + '\ndata: ' + json.dumps(value) + '\n\n').encode()
            self.wfile.write(f'{len(data):X}\r\n'.encode() + data + b'\r\n')
            self.wfile.flush()

        try:
            frame({'type': 'message_start', 'message': {'content': []}})
            if stage == 'bookmarks' and any(item['title'] == 'Synthetic A' for item in payload['items']):
                time.sleep(45)
            catalog = payload['folderTree'].splitlines()
            target = next(json.JSONDecoder().raw_decode(line.lstrip())[0] for line in catalog if '"Target"' in line)
            output = {'newFolders': [], 'merges': [], 'moves': [
                {'itemId': item, 'folderId': target} for item in ids
            ] if stage == 'bookmarks' else []}
            frame({'type': 'content_block_start', 'index': 0, 'content_block': {'type': 'text', 'text': ''}})
            frame({'type': 'content_block_delta', 'index': 0, 'delta': {'type': 'text_delta', 'text': json.dumps(output)}})
            frame({'type': 'content_block_stop', 'index': 0})
            frame({'type': 'message_delta', 'delta': {'stop_reason': 'end_turn'}})
            frame({'type': 'message_stop'})
            self.wfile.write(b'0\r\n\r\n')
            self.wfile.flush()
            events.append({'at': time.time(), 'stage': stage, 'ids': ids, 'state': 'finished'})
            if stage == 'bookmarks' and any(item['title'] == 'Synthetic A' for item in payload['items']):
                completed.set()
        except OSError:
            events.append({'at': time.time(), 'stage': stage, 'ids': ids, 'state': 'disconnected'})


server = ThreadingHTTPServer(('127.0.0.1', 0), Provider)
threading.Thread(target=server.serve_forever, daemon=True).start()
origin = f'http://127.0.0.1:{server.server_port}'
public_key = subprocess.check_output(['node', '-e', "const{publicKey}=require('node:crypto').generateKeyPairSync('rsa',{modulusLength:1024});process.stdout.write(publicKey.export({type:'spki',format:'der'}).toString('base64'))"], text=True)
extension_id = ''.join(chr(ord('a') + int(char, 16)) for char in hashlib.sha256(base64.b64decode(public_key)).hexdigest()[:32])
manifest = json.loads((extension / 'manifest.json').read_text(encoding='utf-8'))
manifest.update(key=public_key, host_permissions=['http://127.0.0.1/*'])
(extension / 'manifest.json').write_text(json.dumps(manifest), encoding='utf-8')
driver = r'''
const origin=ORIGIN;
const report=(path,value)=>fetch(origin+path,{method:'POST',body:JSON.stringify(value)});
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async check=>{for(let i=0;i<300;i++){const value=check();if(value)return value;await delay(50)}throw Error('fixture UI timeout')};
const button=label=>[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===label&&!b.disabled);
const readTasks=async()=>{const db=await new Promise((r,j)=>{const q=indexedDB.open('zhilan-operations');q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)});
 try{return await new Promise((r,j)=>{const q=db.transaction('organizeCheckpoints').objectStore('organizeCheckpoints').getAll();q.onsuccess=()=>r(q.result);q.onerror=()=>j(q.error)})}finally{db.close()}};
const currentTree=()=>new Promise((resolve,reject)=>{const port=chrome.runtime.connect({name:'zhilan.tree.v1'});const timer=setTimeout(()=>{port.disconnect();reject(Error('tree timeout'))},10000);
 port.onMessage.addListener(raw=>{if(raw.state?.status==='ready'){clearTimeout(timer);port.disconnect();resolve(raw.state.snapshot)}});port.postMessage({version:1,type:'refresh'})});
(async()=>{
 if(location.hash.startsWith('#lifetime-inspect')){
   if(location.hash==='#lifetime-inspect'){
     await fetch(origin+'/inspect');
     location.replace(chrome.runtime.getURL('options/index.html#lifetime-inspect-ready'));
     return;
   }
   const saved=(await chrome.storage.local.get('organizeLifetimeFixture')).organizeLifetimeFixture;
   const tree=await currentTree();const checkpoint=(await readTasks()).find(t=>t.id===saved.taskId);
   await delay(300);
   await report('/report',{userAgent:navigator.userAgent,taskId:checkpoint?.id,stage:checkpoint?.stage,status:checkpoint?.status,
     batches:checkpoint?.batches.map(b=>({id:b.id,status:b.status})),initialEpoch:saved.initialEpoch,currentEpoch:tree.epoch,
     badge:await chrome.action.getBadgeText({}),
     unchanged:JSON.stringify(await chrome.bookmarks.getSubTree(saved.root))===JSON.stringify(saved.before)});
   return;
 }
 await chrome.tabs.create({url:chrome.runtime.getURL('lifetime-probe.html#lifetime-inspect'),active:false});
 const bar=(await chrome.bookmarks.getTree())[0].children[0].id;
 const root=await chrome.bookmarks.create({parentId:bar,title:'Lifetime isolated fixture'});
 const source=await chrome.bookmarks.create({parentId:root.id,title:'Source'});
 await chrome.bookmarks.create({parentId:root.id,title:'Target'});
 await chrome.bookmarks.create({parentId:source.id,title:'Synthetic A',url:'https://example.test/a'});
 await chrome.bookmarks.create({parentId:source.id,title:'Synthetic B',url:'https://example.test/b'});
 await chrome.storage.local.set({aiServices:{version:1,revision:'lifetime-fixture',services:[{
   id:'local',name:'Local fixture',serviceType:'Anthropic',kind:'api',detail:'loopback only',baseUrl:origin+'/v1',mode:'anthropic',
   status:'ok',letter:'A',avatarClass:'av-o',catalog:[{id:'synthetic',ctx:''}],enabled:['synthetic'],timeoutMs:60000,streaming:true
 }],features:[{id:'organize',name:'Organize',desc:'fixture',connId:'local',modelId:'synthetic'}]}});
 const scope=await wait(()=>document.querySelector('[aria-label="整理范围"] option[value="'+root.id+'"]'));
 const select=scope.parentElement;select.value=root.id;select.dispatchEvent(new Event('change',{bubbles:true}));
 document.querySelector('.organize-advanced summary').click();
 const batch=document.querySelector('[aria-label="每批最多书签"]');
 Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(batch,'1');batch.dispatchEvent(new Event('input',{bubbles:true}));batch.dispatchEvent(new Event('change',{bubbles:true}));
 (await wait(()=>button('下一步：生成整理方案'))).click();
 (await wait(()=>button('确认分类，开始分批整理书签'))).click();
 await wait(()=>document.body.textContent.includes('已分析 1 / 2'));
 const checkpoint=(await readTasks()).find(t=>t.root.nativeId===root.id);
 if(!checkpoint.batches.some(b=>b.status==='accepted'))throw Error('out-of-order checkpoint missing');
 const saved={root:root.id,taskId:checkpoint.id,initialEpoch:checkpoint.baseline.epoch,batches:checkpoint.batches.map(b=>b.id),before:await chrome.bookmarks.getSubTree(root.id)};
 await chrome.storage.local.set({organizeLifetimeFixture:saved});
 await report('/started',{taskId:checkpoint.id,initialEpoch:saved.initialEpoch,batches:saved.batches});
 const tab=await chrome.tabs.getCurrent();await chrome.tabs.remove(tab.id);
})().catch(error=>report('/error',{message:error.message}));
'''.replace('ORIGIN', json.dumps(origin))
(extension / 'lifetime-fixture.js').write_text(driver, encoding='utf-8')
(extension / 'lifetime-probe.html').write_text('<!doctype html><script src="lifetime-fixture.js"></script>', encoding='utf-8')
html = extension / 'options/index.html'
html.write_text(html.read_text(encoding='utf-8').replace('</body>', '<script src="../lifetime-fixture.js"></script></body>'), encoding='utf-8')
for file in (package / 'dist').rglob('*'):
    if file.is_file() and file.relative_to(package / 'dist').as_posix() not in ['manifest.json', 'options/index.html']:
        assert file.read_bytes() == (extension / file.relative_to(package / 'dist')).read_bytes()
base = [args.browser, '--headless=new', '--lang=zh-CN', '--no-first-run', '--no-default-browser-check', '--disable-background-networking',
        f'--user-data-dir={profile}', f'--disable-extensions-except={extension}', f'--load-extension={extension}']
flags = subprocess.CREATE_NO_WINDOW if sys.platform == 'win32' else 0
process = subprocess.Popen(base + [f'chrome-extension://{extension_id}/options/index.html#organize'], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, creationflags=flags)
try:
    assert started.wait(25), f'No page-close handshake: {reports}'
    assert completed.wait(55), f'No completed delayed batch: {events}; {reports}'
    assert process.poll() is None, 'isolated browser exited'
    print('Delayed batch finished with the workbench closed; waiting for idle worker release.', flush=True)
    time.sleep(40)
    inspect_ready.set()
    assert inspected.wait(20), f'No final report: {reports}'
    assert '/error' not in reports, reports
    result = reports['/report']
    assert result['taskId'] == reports['/started']['taskId'] and result['stage'] == 'complete' and result['status'] == 'review', result
    assert result['unchanged'] and result['initialEpoch'] != result['currentEpoch'], result
    assert result['badge'] == '审', result
    assert [batch['id'] for batch in result['batches']] == reports['/started']['batches'], result
    assert all(batch['status'] == 'merged' for batch in result['batches']), result
    assert len([e for e in events if e['state'] == 'started']) == 3, events
    result = {'status': 'PASS', 'reports': reports, 'events': events, 'evidence': str(root),
              'workerSHA256': hashlib.sha256((extension / 'service-worker.js').read_bytes()).hexdigest(),
              'scope': 'No debugger/CDP/Playwright. Production UI/worker JS unchanged; fixture driver appended to copied options HTML, copied manifest adds public test key and loopback host grant. Workbench closed; inert fixture probe page makes no extension API call or port connection until inspection. Fresh synthetic profile, no real provider/key/native writes after generation.'}
    (root / 'results.json').write_text(json.dumps(result, indent=2), encoding='utf-8')
    if args.output:
        output = Path(args.output)
        output.parent.mkdir(parents=True, exist_ok=True)
        output.write_text(json.dumps(result, indent=2), encoding='utf-8')
    print(json.dumps(result), flush=True)
finally:
    inspect_ready.set()
    if process.poll() is None:
        process.terminate()
        process.wait(timeout=10)
    server.shutdown()
    print('EVIDENCE=' + str(root), flush=True)
