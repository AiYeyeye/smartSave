import { inertParserResolution } from '../scripts/import-worker-config';
// @vitest-environment node
import { expect,it } from 'vitest';
import { build } from 'vite';
import { mkdtemp,readFile,readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
it('builds real Vite Worker client and executes emitted worker with synthetic input',async()=>{
 const outDir=await mkdtemp(join(tmpdir(),'import-worker-'));
 await build({configFile:false,worker:{plugins:()=>[inertParserResolution()]},build:{outDir,rollupOptions:{input:'import/worker-client.ts',preserveEntrySignatures:'strict'}}});
 const assets=await readdir(join(outDir,'assets'));const workerName=assets.find(n=>n.startsWith('parse-worker-'))!;
 expect(workerName).toBeTruthy();const client=await readFile(join(outDir,'assets',assets.find(n=>!n.startsWith('parse-worker-'))!),'utf8');expect(client).toContain(workerName);
 const code=await readFile(join(outDir,'assets',workerName),'utf8');
 // Node Worker harness supplies only Web Worker messaging, no DOM/network/bookmarks.
 const worker=new Worker(`const {parentPort}=require('node:worker_threads');global.self=global;global.postMessage=m=>parentPort.postMessage(m);${code}\nparentPort.on('message',data=>self.onmessage({data}));`,{eval:true});
 try {
 const response=new Promise<{ok:boolean;result:{items:{rawURL:string}[]}}>((resolve,reject)=>{worker.once('message',resolve);worker.once('error',reject);});
 worker.postMessage({format:'html',bytes:new TextEncoder().encode('<img src="https://evil.test"><a href="https://e.test/?x=1&amp;y=2#中">中</a>').buffer});
 expect((await response).result.items[0]?.rawURL).toBe('https://e.test/?x=1&y=2#中');
 }finally{await worker.terminate();}
},30000);
