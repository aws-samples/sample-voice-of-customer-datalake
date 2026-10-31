import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync } from 'node:fs'
import {
  NPM_DIRS,
  PIP_FILES,
  bumpKind,
  failing,
  newestCycle,
  newestRuntimes,
  parseActionUses,
  parseNpmOutdated,
  parsePinnedTools,
  parseRequirements,
  versionParts,
} from './dependency-freshness.mjs'

test('versionParts reads plain, v-prefixed and short versions', () => {
  assert.deepEqual(versionParts('v4.4.0'), [4, 4, 0])
  assert.deepEqual(versionParts('3.14'), [3, 14])
  assert.deepEqual(versionParts('2.275.0-rc.1'), [2, 275, 0])
  assert.equal(versionParts('latest'), null)
})

test('bumpKind names the highest part that is behind', () => {
  assert.equal(bumpKind('1.2.3', '2.0.0'), 'major')
  assert.equal(bumpKind('1.2.3', '1.3.0'), 'minor')
  assert.equal(bumpKind('1.2.3', '1.2.4'), 'patch')
  assert.equal(bumpKind('1.2.3', '1.2.3'), 'current')
  assert.equal(bumpKind('1.10.0', '1.9.9'), 'current') // numeric, not lexical
  assert.equal(bumpKind('3.12', '3.14'), 'minor')
  assert.equal(bumpKind('22', '24'), 'major')
  assert.equal(bumpKind('1.2', '1.2.0'), 'current')
  assert.equal(bumpKind('x', '1.0.0'), 'unknown')
})

test('parseRequirements keeps pins and floors, drops comments, extras and unversioned lines', () => {
  const text = [
    '# a comment',
    'aws-lambda-powertools[tracer]==3.38.0',
    'pydantic>=2.12.0  # floor',
    'requests~=2.31',
    'lxml',
    '',
  ].join('\n')
  assert.deepEqual(parseRequirements(text), [
    { name: 'aws-lambda-powertools', op: '==', version: '3.38.0' },
    { name: 'pydantic', op: '>=', version: '2.12.0' },
    { name: 'requests', op: '~=', version: '2.31' },
  ])
})

test('parseNpmOutdated compares with latest, not wanted, and skips missing installs', () => {
  const report = {
    vite: { current: '7.3.7', wanted: '7.3.7', latest: '8.3.5' },
    zod: { current: '4.6.5', wanted: '4.6.7', latest: '4.6.7' },
    ghost: { wanted: '1.0.0', latest: '1.0.0' },
    dup: [{ current: '1.0.0', latest: '1.1.0' }, { current: '1.1.0', latest: '1.1.0' }],
  }
  assert.deepEqual(parseNpmOutdated(report, 'voc-datalake'), [
    { area: 'npm', where: 'voc-datalake', name: 'vite', current: '7.3.7', latest: '8.3.5', kind: 'major' },
    { area: 'npm', where: 'voc-datalake', name: 'zod', current: '4.6.5', latest: '4.6.7', kind: 'patch' },
    { area: 'npm', where: 'voc-datalake', name: 'dup', current: '1.0.0', latest: '1.1.0', kind: 'minor' },
  ])
})

test('parseActionUses reads sha-pinned actions with their version comment', () => {
  const text = [
    '      - uses: actions/checkout@11d5960a326750d5838078e36cf38b85af677262 # v4.4.0',
    '      - uses: github/codeql-action/init@0123456789abcdef0123456789abcdef01234567 # v3.29.0',
    '      - uses: ./local-action',
    '      - uses: unpinned/thing@v1',
  ].join('\n')
  assert.deepEqual(parseActionUses(text), [
    { repo: 'actions/checkout', sha: '11d5960a326750d5838078e36cf38b85af677262', version: 'v4.4.0' },
    { repo: 'github/codeql-action', sha: '0123456789abcdef0123456789abcdef01234567', version: 'v3.29.0' },
  ])
})

test('parsePinnedTools reads the workflow env pins', () => {
  const text = "  GITLEAKS_VERSION: 8.30.1\n  ACTIONLINT_VERSION: '1.7.12'\n  OTHER_VERSION: 9.9.9\n"
  assert.deepEqual(parsePinnedTools(text), [
    { name: 'gitleaks', repo: 'gitleaks/gitleaks', version: '8.30.1' },
    { name: 'actionlint', repo: 'rhysd/actionlint', version: '1.7.12' },
  ])
})

test('newestRuntimes picks the highest Python and Node.js runtime CDK knows', () => {
  const known = ['PYTHON_3_9', 'PYTHON_3_14', 'PYTHON_3_13', 'NODEJS_20_X', 'NODEJS_24_X', 'NODEJS_LATEST', 'JAVA_21', 'name']
  assert.deepEqual(newestRuntimes(known), { python: '3.14', nodejs: '24' })
})

test('newestCycle takes the highest cycle, LTS only when asked', () => {
  const cycles = [{ cycle: '25', lts: false, latest: '25.1.0' }, { cycle: '24', lts: '2025-10-28', latest: '24.11.0' },
    { cycle: '22', lts: '2024-10-29', latest: '22.21.0' }]
  assert.equal(newestCycle(cycles).cycle, '25')
  assert.equal(newestCycle(cycles, { lts: true }).cycle, '24')
  assert.equal(newestCycle([{ cycle: '3.9' }, { cycle: '3.14' }, { cycle: '3.13' }]).cycle, '3.14')
})

test('failing keeps the findings at or above the threshold', () => {
  const findings = [{ kind: 'patch' }, { kind: 'minor' }, { kind: 'major' }]
  assert.equal(failing(findings, null).length, 0)
  assert.equal(failing(findings, 'major').length, 1)
  assert.equal(failing(findings, 'minor').length, 2)
  assert.equal(failing(findings, 'patch').length, 3)
})

test('every directory and requirements file the check reads exists', () => {
  for (const dir of NPM_DIRS) assert.ok(existsSync(new URL(`../${dir}/package-lock.json`, import.meta.url)), dir)
  for (const file of PIP_FILES) assert.ok(existsSync(new URL(`../${file}`, import.meta.url)), file)
})
