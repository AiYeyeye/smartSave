// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { checkRelease, releaseGate } from '../checks/release.mjs';
const roots: string[] = [];
afterEach(async () => { await Promise.all(roots.map(root => rm(root, { recursive: true, force: true }))); roots.length = 0; });
async function fixture() {
 const root = await mkdtemp(join(tmpdir(), 'zhilan-release-')); roots.push(root);
 const files: Record<string,string> = {'package.json': JSON.stringify({version:'0.1.0',dependencies:{react:'19.2.8'}}), 'pnpm-lock.yaml':'synthetic lock', 'licenses.json': JSON.stringify({MIT:[{name:'react',license:'MIT',versions:['19.2.8']}]}), 'public/THIRD_PARTY_NOTICES.txt':'react MIT synthetic notice', 'dist/THIRD_PARTY_NOTICES.txt':'react MIT synthetic notice', 'dist/manifest.json':await readFile('public/manifest.json','utf8'), 'dist/service-worker.js':'export {};', 'dist/content-script.js':'(()=>{})();', 'dist/panel/index.html':'<html></html>', 'dist/options/index.html':'<html></html>', 'dist/assets/parse-worker-fixture.js':'const fixture = true;', 'dist/assets/import-client-fixture.js':'export {};'};
 for(const [path,text] of Object.entries(files)) { const file=join(root,path); await mkdir(join(file,'..'),{recursive:true}); await writeFile(file,text); } return root;
}
it('inventories a hermetic complete fixture without promoting it to release', async () => { const result = await checkRelease(await fixture()); expect(result.sourceErrors).toEqual([]); expect(result.artifacts.length).toBeGreaterThan(5); expect(result.lockHash).toMatch(/^[a-f0-9]{64}$/); expect(releaseGate(result)).toContain('user-acceptance: NOT RUN'); });
it.each([['manifest','JSON'], ['reference','ENOENT'], ['unsafe','host_permissions'], ['license','License inventory'], ['secret','Obvious secret'], ['dynamic','Remote/dynamic']])('rejects %s specifically', async (defect, message) => { const root = await fixture(); const path = join(root, 'dist/manifest.json'); const manifest = JSON.parse(await readFile(path, 'utf8')); if (defect === 'manifest') await writeFile(path, '{'); if (defect === 'reference') await rm(join(root, 'dist', manifest.background.service_worker)); if (defect === 'unsafe') { manifest.host_permissions = ['<all_urls>']; await writeFile(path, JSON.stringify(manifest)); } if (defect === 'license') await writeFile(join(root, 'licenses.json'), '{}'); if (defect === 'secret') await writeFile(join(root, 'dist/leak.js'), 'const key="sk-' + 'A'.repeat(32) + '";'); if(defect === 'dynamic') await writeFile(join(root,'dist/leak.js'),'eval("1")'); expect((await checkRelease(root)).sourceErrors.join('\n')).toContain(message); });
it('blocks ready gate even after source checks pass', () => { expect(releaseGate({ sourceErrors: [] })).not.toEqual([]); });
it('hashes changed source, lock and artifact bytes without inventorying its own output', async () => {
 const root = await fixture(); const before = await checkRelease(root);
 await writeFile(join(root, 'release-candidate.json'), 'previous generated result');
 expect((await checkRelease(root)).sourceInventoryHash).toBe(before.sourceInventoryHash);
 await writeFile(join(root, 'pnpm-lock.yaml'), 'different synthetic lock');
 const changed = await checkRelease(root);
 expect(changed.lockHash).not.toBe(before.lockHash);
 expect(changed.sourceInventoryHash).not.toBe(before.sourceInventoryHash);
 expect(changed.artifactInventoryHash).toBe(before.artifactInventoryHash);
 await writeFile(join(root, 'dist/content-script.js'), '(()=>{const changed=true;})();');
 expect((await checkRelease(root)).artifactInventoryHash).not.toBe(before.artifactInventoryHash);
});
it('reports malformed package metadata as source failure rather than losing the inventory', async () => {
 const root = await fixture(); await writeFile(join(root, 'package.json'), '{');
 const result = await checkRelease(root); expect(result.sourceErrors.length).toBeGreaterThan(0); expect(result.artifacts.length).toBeGreaterThan(0);
});
it.each(['csp', 'notice', 'lock', 'classic', 'asset'])('rejects %s corruption', async defect => {
 const root = await fixture();
 if (defect === 'csp') { const path = join(root, 'dist/manifest.json'); const value = JSON.parse(await readFile(path, 'utf8')); value.content_security_policy.extension_pages = "script-src * 'unsafe-eval'"; await writeFile(path, JSON.stringify(value)); }
 if (defect === 'notice') await writeFile(join(root, 'dist/THIRD_PARTY_NOTICES.txt'), 'different');
 if (defect === 'lock') await rm(join(root, 'pnpm-lock.yaml'));
 if (defect === 'classic') await writeFile(join(root, 'dist/content-script.js'), 'export {};');
 if (defect === 'asset') await writeFile(join(root, 'dist/panel/index.html'), '<script src="missing.js"></script>');
 expect((await checkRelease(root)).sourceErrors.length).toBeGreaterThan(0);
});
it('keeps source compatibility and every missing manual as distinct ready blockers', async () => {
 const result = await checkRelease(await fixture());
 expect(result.sourceErrors).toEqual([]); expect(result.compatibilityBlockers).toHaveLength(1);
 const blockers = releaseGate(result);
 expect(blockers).toContain(result.compatibilityBlockers[0]);
 for (const id of ['chrome-restart-reliability','edge-no-page-restart','p2-models','p3-recovery','p4-privacy']) expect(blockers).toContain(`${id}: NOT RUN`);
});
