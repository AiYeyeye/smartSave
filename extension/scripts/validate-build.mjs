import { readFile, access, readdir } from 'node:fs/promises';
import { resolve, dirname, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'acorn';
import { z } from 'zod';

const manifestSchema = z.object({
  manifest_version: z.literal(3),
  default_locale: z.literal('zh_CN'),
  name: z.literal('__MSG_extensionName__'),
  description: z.literal('__MSG_extensionDescription__'),
  permissions: z.tuple([
    z.literal('bookmarks'),
    z.literal('storage'),
    z.literal('alarms'),
    z.literal('activeTab'),
    z.literal('scripting'),
    z.literal('contextMenus'),
    z.literal('favicon'),
    z.literal('sidePanel'),
  ]),
  // identity is optional and requested only when the user starts an OAuth sign-in (e.g. OpenRouter).
  optional_permissions: z.tuple([z.literal('identity'), z.literal('history')]),
  background: z.object({ service_worker: z.string(), type: z.literal('module') }),
  // The bookmark UI is the browser side panel (full height); the toolbar button opens it.
  side_panel: z.object({ default_path: z.literal('panel/index.html') }),
  options_ui: z.object({ page: z.string() }),
  action: z.object({ default_popup: z.never().optional(), default_title: z.string() }),
  host_permissions: z.never().optional(),
  optional_host_permissions: z.tuple([z.literal('https://*/*'), z.literal('http://*/*')]),
  content_security_policy: z.object({
    extension_pages: z.literal("script-src 'self'; object-src 'self'; connect-src https: http:"),
  }),
  content_scripts: z.never().optional(),
  // Only the panel document is exposed, for the click-injected overlay sidebar frame; trust still requires the
  // one-time overlay token (see background/overlay-host.ts).
  web_accessible_resources: z.tuple([
    z.object({ resources: z.tuple([z.literal('panel/index.html')]), matches: z.tuple([z.literal('<all_urls>')]) }),
  ]),
});

function rejectDynamicImports(node) {
  if (!node || typeof node !== 'object') return;
  if (node.type === 'ImportExpression') throw new Error('Runtime import is forbidden');
  for (const value of Object.values(node)) {
    if (Array.isArray(value)) value.forEach(rejectDynamicImports);
    else if (value && typeof value === 'object') rejectDynamicImports(value);
  }
}

/** Browser catalogs are shipped assets, including those used only by manifest or action APIs. */
export async function validateLocales(root, manifest) {
  const catalogSchema = z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), z.object({ message: z.string().min(1) }));
  const catalogs = await Promise.all(
    ['zh_CN', 'en'].map(async locale =>
      catalogSchema.parse(JSON.parse(await readFile(resolve(root, '_locales', locale, 'messages.json'), 'utf8'))),
    ),
  );
  const [source, english] = catalogs;
  if (JSON.stringify(Object.keys(source).sort()) !== JSON.stringify(Object.keys(english).sort()))
    throw new Error('Browser locale keys differ');
  for (const key of Object.keys(source)) {
    const slots = message =>
      [...message.matchAll(/\$[1-9]/g)]
        .map(match => match[0])
        .sort()
        .join(',');
    if (slots(source[key].message) !== slots(english[key].message))
      throw new Error(`Browser locale substitutions differ: ${key}`);
  }
  for (const match of JSON.stringify(manifest).matchAll(/__MSG_(\w+)__/g))
    if (!Object.hasOwn(source, match[1])) throw new Error(`Missing browser locale message: ${match[1]}`);
}

export function assertClassicScript(code) {
  const ast = parse(code, { ecmaVersion: 'latest', sourceType: 'script' });
  rejectDynamicImports(ast);
}

/** Store/action icons must be local PNGs with their declared pixel dimensions. */
export async function validateIcons(root, manifest) {
  for (const size of [16, 32, 48, 128]) {
    const path = manifest.icons?.[size];
    if (typeof path !== 'string' || !path.endsWith('.png')) throw new Error(`Missing PNG icon: ${size}`);
    const file = resolve(root, path);
    if (relative(root, file).startsWith('..')) throw new Error('Icon escapes distribution');
    const bytes = await readFile(file);
    if (
      bytes.length < 24 ||
      !bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10])) ||
      bytes.readUInt32BE(16) !== size ||
      bytes.readUInt32BE(20) !== size
    )
      throw new Error(`Invalid PNG icon dimensions: ${size}`);
    if (size !== 128 && manifest.action?.default_icon?.[size] !== path)
      throw new Error(`Action icon differs from extension icon: ${size}`);
  }
}

export async function validateBuild(directory) {
  const root = resolve(directory);
  const manifest = manifestSchema.parse(JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8')));
  // Use the raw manifest too: command descriptions must be checked, not stripped by the schema.
  const rawManifest = JSON.parse(await readFile(resolve(root, 'manifest.json'), 'utf8'));
  await validateLocales(root, rawManifest);
  await validateIcons(root, rawManifest);
  const visited = new Set();
  async function check(file) {
    if (relative(root, file).startsWith('..')) throw new Error('Asset escapes distribution');
    if (visited.has(file)) return;
    visited.add(file);
    await access(file);
    const text = await readFile(file, 'utf8');
    if (file.endsWith('.html')) {
      for (const match of text.matchAll(/(?:src|href)="([^"]+)"/g)) {
        await check(resolve(dirname(file), match[1]));
      }
    } else if (file.endsWith('.js')) {
      const ast = parse(text, { ecmaVersion: 'latest', sourceType: 'module' });
      rejectDynamicImports(ast);
      for (const node of ast.body) {
        if (
          node.type === 'ImportDeclaration' ||
          node.type === 'ExportAllDeclaration' ||
          node.type === 'ExportNamedDeclaration'
        ) {
          if (node.source) await check(resolve(dirname(file), node.source.value));
        }
      }
    }
  }
  const assets = await readdir(resolve(root, 'assets'));
  const parserWorkers = assets.filter(name => /^parse-worker-.*\.js$/.test(name));
  const parserClients = assets.filter(name => /^import-client-.*\.js$/.test(name));
  if (parserWorkers.length !== 1 || parserClients.length !== 1)
    throw new Error('Missing import Worker/client build contract');
  for (const name of [...parserWorkers, ...parserClients]) await check(resolve(root, 'assets', name));
  for (const entry of [
    manifest.background.service_worker,
    manifest.options_ui.page,
    manifest.side_panel.default_path,
    'save/index.html',
  ]) {
    await check(resolve(root, entry));
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  await validateBuild(process.argv[2] ?? 'dist');
  console.info('MV3 distribution references and static modules validated (not browser runtime evidence).');
}
