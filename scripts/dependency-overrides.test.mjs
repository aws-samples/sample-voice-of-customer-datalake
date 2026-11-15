/**
 * Pins what the npm `overrides` for minimatch (GHSA-g3hv-75wg-m249) and quick-temp's rimraf
 * promise, read from the committed lockfiles (CHANGELOG 6.05.00 of 2026-11-11):
 *
 * - no installed minimatch in any committed lockfile is in the vulnerable range (>= 7.0.0, < 11.0.1),
 *   except the one copy bundled inside aws-cdk-lib, which npm cannot override;
 * - every glob that resolves to minimatch 11 is glob 14 or newer (glob 10 on minimatch 11 silently
 *   matches nothing);
 * - quick-temp is still the release whose `rimraf.sync` call the rimraf 6 override was checked against.
 *
 * A failure here means an install changed what the overrides cover: re-audit before relaxing the test.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const LOCKFILES = [
  'package-lock.json',
  'tools/kiro-acp-bridge/package-lock.json',
  'voc-datalake/frontend/e2e/package-lock.json',
  'voc-datalake/frontend/package-lock.json',
  'voc-datalake/lambda/stream/package-lock.json',
  'voc-datalake/package-lock.json',
];
/** The one minimatch install npm cannot override (aws-cdk-lib bundles it; alert #226). */
const BUNDLED_EXCEPTION = 'node_modules/aws-cdk-lib/node_modules/minimatch';
/** quick-temp releases whose rimraf use (`rimraf.sync(path)`) works on rimraf 6. */
const AUDITED_QUICK_TEMP = new Set(['0.1.9']);

/** @param {string} file @returns {Record<string, {version?: string, inBundle?: boolean}>} */
function packagesOf(file) {
  const lock = JSON.parse(readFileSync(join(ROOT, file), 'utf8'));
  return lock.packages ?? {};
}

/** @param {string} version @returns {[number, number, number]} */
function parseVersion(version) {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(String(version));
  assert.ok(match, `unparseable version ${version}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/** @param {string} a @param {string} b */
function compareVersions(a, b) {
  const [x, y] = [parseVersion(a), parseVersion(b)];
  for (let i = 0; i < 3; i += 1) {
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

/**
 * The installed copies of one package: [install path, entry]. Link entries (workspace symlinks)
 * carry no version and are not installs, so they are left out.
 * @param {Record<string, {version?: string, link?: boolean}>} packages
 * @param {string} name
 * @returns {Array<[string, {version: string, inBundle?: boolean}]>}
 */
function installsOf(packages, name) {
  return Object.entries(packages).filter(
    ([path, entry]) => path.split('node_modules/').pop() === name && !entry.link && typeof entry.version === 'string',
  );
}

/**
 * The install path Node resolves `name` to from the package at `fromPath`: its own nested
 * node_modules first, then each enclosing node_modules, then the top level.
 */
function resolveFrom(packages, fromPath, name) {
  let base = fromPath;
  for (;;) {
    const candidate = `${base}/node_modules/${name}`;
    if (packages[candidate]) return candidate;
    const cut = base.lastIndexOf('/node_modules/');
    if (cut < 0) break;
    base = base.slice(0, cut);
  }
  return packages[`node_modules/${name}`] ? `node_modules/${name}` : undefined;
}

for (const file of LOCKFILES) {
  test(`${file}: no overridable minimatch is in the vulnerable range`, () => {
    const vulnerable = installsOf(packagesOf(file), 'minimatch')
      .filter(([path]) => path !== BUNDLED_EXCEPTION)
      .filter(([, entry]) => compareVersions(entry.version, '7.0.0') >= 0 && compareVersions(entry.version, '11.0.1') < 0)
      .map(([path, entry]) => `${path}@${entry.version}`);
    assert.deepEqual(vulnerable, []);
  });

  test(`${file}: every glob that resolves to minimatch 11 is glob 14 or newer`, () => {
    const packages = packagesOf(file);
    const broken = installsOf(packages, 'glob')
      .filter(([path]) => {
        const resolved = resolveFrom(packages, path, 'minimatch');
        return resolved !== undefined && compareVersions(packages[resolved].version, '11.0.0') >= 0;
      })
      .filter(([, entry]) => compareVersions(entry.version, '14.0.0') < 0)
      .map(([path, entry]) => `${path}@${entry.version}`);
    assert.deepEqual(broken, []);
  });
}

test('voc-datalake/frontend: quick-temp is the audited release and gets rimraf 6', () => {
  const packages = packagesOf('voc-datalake/frontend/package-lock.json');
  const quickTemp = installsOf(packages, 'quick-temp');
  for (const [path, entry] of quickTemp) {
    assert.ok(AUDITED_QUICK_TEMP.has(entry.version), `${path}@${entry.version} is not an audited quick-temp release`);
    const rimraf = resolveFrom(packages, path, 'rimraf');
    assert.ok(rimraf, `${path} resolves no rimraf`);
    assert.equal(parseVersion(packages[rimraf].version)[0], 6, `${path} resolves ${rimraf}@${packages[rimraf].version}`);
  }
});

test('LOCKFILES lists every committed package-lock.json', () => {
  const committed = execFileSync('git', ['ls-files', '*package-lock.json'], { cwd: ROOT, encoding: 'utf8' })
    .split('\n')
    .filter(Boolean)
    .sort();
  assert.deepEqual([...LOCKFILES].sort(), committed);
});

test('resolveFrom prefers the nested copy, then the top level', () => {
  const packages = {
    'node_modules/minimatch': { version: '11.0.8' },
    'node_modules/a/node_modules/minimatch': { version: '3.1.5' },
    'node_modules/a/node_modules/b': { version: '1.0.0' },
    'node_modules/c': { version: '1.0.0' },
  };
  assert.equal(resolveFrom(packages, 'node_modules/a/node_modules/b', 'minimatch'), 'node_modules/a/node_modules/minimatch');
  assert.equal(resolveFrom(packages, 'node_modules/c', 'minimatch'), 'node_modules/minimatch');
  assert.equal(resolveFrom(packages, 'node_modules/c', 'missing'), undefined);
});

test('compareVersions orders by major, minor, then patch', () => {
  assert.ok(compareVersions('10.2.6', '11.0.1') < 0);
  assert.ok(compareVersions('11.0.1', '11.0.1') === 0);
  assert.ok(compareVersions('11.0.8', '11.0.1') > 0);
  assert.ok(compareVersions('9.0.9', '7.0.0') > 0);
});
