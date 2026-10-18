import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { validateBuild, assertClassicScript } from '../scripts/validate-build.mjs';
const sha = bytes => createHash('sha256').update(bytes).digest('hex');
async function inventory(root, excluded = [], excludeLocalFiles = false) {
  const result = [];
  async function walk(dir) {
    for (const entry of (await readdir(dir, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name))) {
      if (excluded.includes(entry.name)) continue;
      if (excludeLocalFiles && /(?:\.log|\.pyc|\.pyo)$/.test(entry.name)) continue;
      const file = resolve(dir, entry.name);
      if (entry.isSymbolicLink()) throw Error(`Symlink not inventoried: ${relative(root, file)}`);
      if (entry.isDirectory()) await walk(file);
      else {
        const bytes = await readFile(file);
        result.push({
          path: relative(root, file).split(String.fromCharCode(92)).join('/'),
          bytes: bytes.length,
          sha256: sha(bytes),
        });
      }
    }
  }
  await walk(root);
  return result;
}
// 2026-10: the UI is the native side panel; sidePanel.setPanelBehavior / sidePanel.open need Chrome 116.
export const approvedMinimumChromeVersion = 116;
export const manualRequirements = [
  {
    id: 'historical-p1',
    status: 'historical',
    evidence: 'docs/release/status.md#historical-evidence',
    blocking: false,
  },
  ...[
    'chrome-restart-reliability',
    'edge-no-page-restart',
    'p2-models',
    'p3-recovery',
    'p4-privacy',
    'windows-ac01-20-four-themes-performance',
    'approved-minimum-browser-matrix',
    'independent-review',
    'user-acceptance',
  ].map(id => ({ id, status: 'NOT RUN', evidence: null, blocking: true })),
];
export function releaseGate(result) {
  return [
    ...result.sourceErrors,
    ...(result.compatibilityBlockers ?? []),
    ...manualRequirements.filter(item => item.blocking).map(item => `${item.id}: ${item.status}`),
  ];
}
export async function checkRelease(directory) {
  const root = resolve(directory);
  const dist = resolve(root, 'dist');
  const sourceErrors = [];
  const attempt = async fn => {
    try {
      return await fn();
    } catch (error) {
      sourceErrors.push(String(error.message));
    }
  };
  await attempt(() => validateBuild(dist));
  await attempt(async () => assertClassicScript(await readFile(resolve(dist, 'content-script.js'), 'utf8')));
  const artifacts = (await attempt(() => inventory(dist))) ?? [];
  // Private evaluation inputs/reports are local evidence, never distributable source inventory.
  const sourceFiles =
    (await attempt(() =>
      inventory(
        root,
        [
          'node_modules',
          'dist',
          'coverage',
          '__pycache__',
          '.pytest_cache',
          '.local',
          '.local-evaluation',
          'release-candidate.json',
          'audit.json',
        ],
        true,
      ),
    )) ?? [];
  const sourceInventoryHash = sha(JSON.stringify(sourceFiles));
  const artifactInventoryHash = sha(JSON.stringify(artifacts));
  const pkg = await attempt(async () => JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')));
  const lockHash = await attempt(async () => sha(await readFile(resolve(root, 'pnpm-lock.yaml'))));
  await attempt(async () => {
    const pkg = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8'));
    const licenses = Object.values(JSON.parse(await readFile(resolve(root, 'licenses.json'), 'utf8'))).flat();
    const notices = await readFile(resolve(dist, 'THIRD_PARTY_NOTICES.txt'), 'utf8');
    if (notices !== (await readFile(resolve(root, 'public/THIRD_PARTY_NOTICES.txt'), 'utf8')))
      throw Error('License notices differ from source');
    for (const name of Object.keys({ ...pkg.dependencies, ...pkg.devDependencies })) {
      const entry = licenses.find(item => item.name === name);
      if (
        !entry ||
        !/^(MIT|ISC|Apache-2.0|BSD-2-Clause|BSD-3-Clause|0BSD|BlueOak-1.0.0|Python-2.0|\(MIT OR CC0-1.0\))$/.test(
          entry.license,
        )
      )
        throw Error(`License inventory missing/unreviewed: ${name}`);
      if (name in pkg.dependencies && !notices.includes(name)) throw Error(`Runtime notice missing: ${name}`);
    }
  });
  for (const file of artifacts)
    await attempt(async () => {
      const text = await readFile(resolve(dist, file.path), 'utf8');
      if (/sk-[A-Za-z0-9_-]{24,}|AKIA[A-Z0-9]{16}|-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/.test(text))
        throw Error(`Obvious secret marker: ${file.path}`);
      if (
        /\.(js|html|css)$/.test(file.path) &&
        /\beval\s*\(|new\s+Function\s*\(|importScripts\s*\(|<script[^>]+src\s*=\s*["']https?:|@import\s+["']https?:/.test(
          text,
        )
      )
        throw Error(`Remote/dynamic code marker: ${file.path}`);
    });
  const manifest = await attempt(async () => JSON.parse(await readFile(resolve(dist, 'manifest.json'), 'utf8')));
  const compatibilityBlockers =
    manifest && Number(manifest.minimum_chrome_version) < approvedMinimumChromeVersion
      ? [
          `owner01: manifest minimum ${manifest.minimum_chrome_version} is below the approved minimum Chrome ${approvedMinimumChromeVersion}`,
        ]
      : [];
  return {
    compatibilityBlockers,
    manualRequirements,
    format: 'zhilan-local-candidate-v1',
    version: pkg?.version,
    sourceInventoryHash,
    artifactInventoryHash,
    environment: { node: process.version, platform: process.platform, arch: process.arch },
    sourceIdentity: 'source-file SHA256 inventory; no Git commit identity asserted',
    lockHash,
    artifacts,
    sourceFiles,
    sourceErrors,
    coverage:
      'Existing manifest/CSP/static AST reference validator plus classic extractor; direct dependency license metadata and runtime notice presence; obvious secret/dynamic-code markers only. Not a security proof, complete dependency-license audit, browser result or reproducible-build guarantee.',
  };
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const mode = process.argv[2];
  if (!['source', 'ready'].includes(mode)) throw Error('Usage: node checks/release.mjs source|ready');
  const result = await checkRelease(process.cwd());
  await writeFile('release-candidate.json', JSON.stringify(result, null, 2) + '\n');
  const blockers = mode === 'ready' ? releaseGate(result) : result.sourceErrors;
  console.info(
    JSON.stringify(
      {
        mode,
        status: blockers.length ? 'BLOCKED' : 'SOURCE CHECKS PASS (not release ready)',
        blockers,
        inventory: 'release-candidate.json',
        coverage: result.coverage,
      },
      null,
      2,
    ),
  );
  if (blockers.length) process.exitCode = 1;
}
