// @vitest-environment node
import { readFile, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { describe, expect, it } from 'vitest';
import { build } from 'vite';
import { contentScriptConfig } from '../scripts/content-script-config';
import { validateBuild, assertClassicScript } from '../scripts/validate-build.mjs';

describe('MV3 distribution contract', () => {
  it('builds both pages and a static module worker with approved read-only permissions', async () => {
    execFileSync(process.execPath, ['node_modules/vite/bin/vite.js', 'build'], { cwd: process.cwd() });
    await expect(validateBuild('dist')).resolves.toBeUndefined();
    const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
    expect(manifest.permissions).toEqual(['bookmarks', 'storage', 'activeTab', 'scripting', 'contextMenus', 'favicon']);
    expect(manifest.side_panel).toBeUndefined();
    expect(manifest.web_accessible_resources).toBeUndefined();
    expect(manifest.action.default_popup).toBe('panel/index.html');
    expect(manifest.host_permissions).toBeUndefined();
    expect(manifest.optional_host_permissions).toEqual(['https://*/*', 'http://*/*']);
    expect(manifest.content_security_policy.extension_pages).toContain('connect-src https: http:');
    expect(manifest.content_scripts).toBeUndefined();
    expect(manifest.background.type).toBe('module');
  });
  it('rejects missing manifest references rather than claiming a successful package', async () => {
    const empty = await mkdtemp(join(tmpdir(), 'zhilan-empty-'));
    await writeFile(join(empty, 'manifest.json'), await readFile('public/manifest.json'));
    await expect(validateBuild(empty)).rejects.toThrow(/ENOENT/);
  });
  it('bundles a future content script as an IIFE and rejects runtime imports', async () => {
    const output = await mkdtemp(join(tmpdir(), 'zhilan-iife-'));
    await build(contentScriptConfig('tests/fixtures/content-script.ts', output));
    const code = await readFile(join(output, 'content-script.js'), 'utf8');
    expect(() => assertClassicScript(code)).not.toThrow();
    expect(code).toContain('fixture');
    expect(() => assertClassicScript('import("./chunk.js")')).toThrow(/import/i);
    expect(() => assertClassicScript('import x from "./chunk.js"')).toThrow();
  });
});

it('ships approved Soft UI palette with a single theme table and shared density', async () => {
  const css = await readFile('ui/theme.css', 'utf8');
  for (const token of [
    '--bg:#F8FAFC',
    '--bg:#F5F7FB',
    '--bg:#F8F6F0',
    '--bg:#242733',
    '--accent:#6155A6',
    '--row:44px',
    '--radius:24px',
    '--small:16px',
  ])
    expect(css).toContain(token);
  for (const legacy of ['--bg:#F7F8FA', '--bg:#F6F3EC', '--bg:#F8F9FC', '--bg:#181A1F'])
    expect(css).not.toContain(legacy);
  expect(css.match(/--row:/g)).toHaveLength(1);
  expect(css).toContain(':focus-visible');
  expect(css).toContain('prefers-reduced-motion');
  expect(css).not.toContain('prefers-color-scheme');
});
it('ships the real on-demand extractor as a classic IIFE with no default injection or bound shortcut', async () => {
  const code = await readFile('dist/content-script.js', 'utf8');
  expect(() => assertClassicScript(code)).not.toThrow();
  expect(code).toContain('1500');
  expect(code).not.toContain('storage');
  const manifest = JSON.parse(await readFile('dist/manifest.json', 'utf8'));
  expect(manifest.commands['save-current-page'].suggested_key).toBeUndefined();
  expect(manifest.content_scripts).toBeUndefined();
});
