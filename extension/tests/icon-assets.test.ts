// @vitest-environment node
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, expect, it } from 'vitest';
import { validateIcons } from '../scripts/validate-build.mjs';

const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.map(root => rm(root, { recursive: true, force: true })));
  roots.length = 0;
});
async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'zhilan-icons-'));
  roots.push(root);
  await mkdir(join(root, 'icons'));
  for (const size of [16, 32, 48, 128])
    await writeFile(join(root, `icons/icon-${size}.png`), await readFile(`public/icons/icon-${size}.png`));
  return { root, manifest: JSON.parse(await readFile('public/manifest.json', 'utf8')) };
}
it('ships every store and toolbar icon at the declared dimensions', async () => {
  const { root, manifest } = await fixture();
  await expect(validateIcons(root, manifest)).resolves.toBeUndefined();
});
it('rejects missing, wrong-sized and out-of-distribution icon references', async () => {
  const { root, manifest } = await fixture();
  manifest.icons['128'] = 'icons/missing.png';
  await expect(validateIcons(root, manifest)).rejects.toThrow(/ENOENT/);
  manifest.icons['128'] = 'icons/icon-16.png';
  await expect(validateIcons(root, manifest)).rejects.toThrow(/dimensions/);
  manifest.icons['128'] = '../outside.png';
  await expect(validateIcons(root, manifest)).rejects.toThrow(/escapes/);
});
it('rejects absent icon declarations and action icons that differ', async () => {
  const { root, manifest } = await fixture();
  await expect(validateIcons(root, { ...manifest, icons: undefined })).rejects.toThrow(/Missing PNG/);
  manifest.action.default_icon['16'] = 'icons/icon-48.png';
  await expect(validateIcons(root, manifest)).rejects.toThrow(/Action icon/);
});
