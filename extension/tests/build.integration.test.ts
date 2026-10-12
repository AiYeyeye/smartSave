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
    expect(manifest.permissions).toEqual([
      'bookmarks',
      'storage',
      'activeTab',
      'scripting',
      'contextMenus',
      'favicon',
      'sidePanel',
    ]);
    expect(manifest.optional_permissions).toEqual(['identity']);
    expect(manifest.side_panel).toEqual({ default_path: 'panel/index.html' });
    expect(manifest.web_accessible_resources).toEqual([{ resources: ['panel/index.html'], matches: ['<all_urls>'] }]);
    expect(manifest.action.default_popup).toBeUndefined();
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

it('ships one token table with light, dark and accent variants', async () => {
  const css = await readFile('ui/theme.css', 'utf8');
  for (const token of [
    '--page: #f4f5f7;',
    '--page: #0f1013;',
    '--accent: #5b5bd6;',
    ".theme-root[data-mode='dark']",
    ".theme-root[data-accent='blue']",
    ".theme-root[data-accent='graphite']",
  ])
    expect(css).toContain(token);
  // Light tokens are declared once on .theme-root; dark mode overrides them in a single block.
  expect(css.match(/^\.theme-root\[data-mode='dark'\] \{/gm)).toHaveLength(1);
  expect(css).toContain(':focus-visible');
  expect(css).toContain('prefers-reduced-motion');
  // System mode is resolved in ThemeProvider (matchMedia) so the popup and options page agree.
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
