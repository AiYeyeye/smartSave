import { mkdtemp, cp, writeFile, access } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve, join, isAbsolute } from 'node:path';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
// No discovery, download, profile reuse, provider calls, or browser process killing.
if (process.env.ZHILAN_REAL_E2E !== 'I_ACCEPT_ISOLATED_SYNTHETIC_ONLY') {
  console.info('SKIP: real extension harness disabled; no browser acceptance executed.');
} else {
  if (process.platform !== 'win32') throw Error('Unsupported: Windows-only manual harness');
  const executable = process.env.ZHILAN_BROWSER_EXECUTABLE;
  if (!executable || !isAbsolute(executable))
    throw Error('Explicit absolute Chrome/Edge executable required; no discovery');
  await access(executable);
  const root = await mkdtemp(join(tmpdir(), 'zhilan-e2e-'));
  const extension = join(root, 'extension');
  await cp(resolve('dist'), extension, { recursive: true });
  const token = randomUUID();
  await writeFile(
    join(extension, 'synthetic-fixture.html'),
    '<!doctype html><meta charset="utf-8"><title>Zhilan isolated fixture</title><button id="create">Create synthetic fixture tree</button><button id="clean">Remove only unchanged owned fixture</button><pre id="result">NOT RUN</pre><script src="synthetic-fixture.js"></script>',
  );
  await writeFile(
    join(extension, 'synthetic-fixture.js'),
    `const title=${JSON.stringify('Zhilan E2E ' + token)}; let owned; const result=document.querySelector('#result');
 document.querySelector('#create').onclick=async()=>{try {if(owned)throw Error('Already created'); const tree=await chrome.bookmarks.getTree();const parent=tree[0].children.find(n=>!n.url);if(!parent)throw Error('No fixture parent');const folder=await chrome.bookmarks.create({parentId:parent.id,title});owned=folder.id;await chrome.bookmarks.create({parentId:owned,title:'Synthetic example',url:'https://example.invalid/zhilan-e2e'});result.textContent='FIXTURE CREATED; manually inspect production panel. Not AC acceptance.';}catch(e){result.textContent='FAILED: '+e.message;}};
 document.querySelector('#clean').onclick=async()=>{try {if(!owned)throw Error('No owned fixture in this page session');const [folder]=await chrome.bookmarks.getSubTree(owned);if(folder.title!==title||folder.children.length!==1||folder.children[0].url!=='https://example.invalid/zhilan-e2e'||folder.children[0].title!=='Synthetic example')throw Error('Changed fixture: cleanup refused');await chrome.bookmarks.remove(folder.children[0].id);await chrome.bookmarks.remove(owned);owned=undefined;result.textContent='Owned fixture removed; no broad cleanup';}catch(e){result.textContent='FAILED: '+e.message;}};`,
  );
  console.info(
    `MANUAL RUN ONLY. New profile: ${join(root, 'profile')}\nCandidate copy: ${extension}\nLoad unpacked manually if browser ignores flags; open chrome-extension://<actual-id>/synthetic-fixture.html. Do not sign in/import data. Close only this isolated browser yourself. Profile retained for evidence; no automatic deletion. NOT RUN until recorded assertions.`,
  );
  const child = spawn(
    executable,
    [
      `--user-data-dir=${join(root, 'profile')}`,
      '--no-first-run',
      '--disable-sync',
      `--disable-extensions-except=${extension}`,
      `--load-extension=${extension}`,
      'about:blank',
    ],
    { stdio: 'inherit' },
  );
  child.on('error', error => {
    console.error(error.message);
    process.exitCode = 1;
  });
  child.on('exit', () => {
    console.info('Browser exited; harness does not assert extension load or acceptance. Manual evidence required.');
    process.exitCode = 2;
  });
}
