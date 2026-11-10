import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { flagModule, isCalled, main, missingFiles, scan } from './repo_contracts.mjs'

/** A fake repo: one planted instance of every kind next to a legitimate look-alike. */
function fakeRepo() {
  const root = mkdtempSync(join(tmpdir(), 'repo-contracts-'))
  const write = (rel, text) => {
    mkdirSync(dirname(join(root, rel)), { recursive: true })
    writeFileSync(join(root, rel), text)
  }
  write('voc-datalake/lib/stacks/x.ts', [
    "import * as lambda from 'aws-cdk-lib/aws-lambda'",
    "const EMAIL_FROM_CONTEXT_KEY = 'emailFrom'",
    "app.node.tryGetContext('protectData'); app.node.tryGetContext(EMAIL_FROM_CONTEXT_KEY); app.node.tryGetContext('secretKnob')",
    "const status = context.menuStatus",
  ].join('\n'))
  write('voc-datalake/cdk.json', JSON.stringify({ context: {
    '@aws-cdk/aws-lambda:recognizeLayerVersion': true, '@aws-cdk/core:checkSecretUsage': true, '@aws-cdk/aws-ecs:arnFormatIncludesClusterName': true,
  } }))
  write('voc-datalake/cdk.context.json', JSON.stringify({ menuStatus: {}, staleSetting: true }))
  write('docs/deployment.md', 'Pass `-c protectData=true` or `-c emailFrom=a@b`. Run `npm run deploy:api` or `npm --prefix voc-datalake run lint`.\n')
  write('package.json', JSON.stringify({ scripts: { test: 'vitest', 'deploy:api': 'bash scripts/deploy.sh', 'dead-code': 'knip', broken: 'node scripts/gone.mjs' } }))
  write('voc-datalake/package.json', JSON.stringify({ scripts: { lint: 'eslint .', prebuild: 'node x', 'gen:x': 'cd scripts && node used.mjs' } }))
  write('scripts/deploy.sh', 'echo deploy\n')
  write('scripts/orphan.sh', 'echo nobody calls me\n')
  write('voc-datalake/scripts/used.mjs', 'export {}\n')
  write('.github/workflows/ci.yml', 'run: npm run broken && npm run gen:x\n')
  return root
}

test('every kind is reported on its planted instance and on nothing else', () => {
  const root = fakeRepo()
  try {
    const keys = scan(root).findings.map((f) => `${f.kind} ${f.key}`).sort()
    assert.deepEqual(keys, [
      'context-undocumented context:secretKnob',
      'context-unread context:staleSetting',
      'flag-module-unused flag:@aws-cdk/aws-ecs:arnFormatIncludesClusterName',
      'script-file-orphan scripts/orphan.sh',
      'script-missing-file package.json::broken',
      'script-uncalled package.json::dead-code',
    ])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('npm calls are recognised in every spelling, and a longer name is not its prefix', () => {
  assert.ok(isCalled('lint', ['npm --prefix voc-datalake run lint']))
  assert.ok(isCalled('check:mock', ['npm run --silent check:mock']))
  assert.ok(!isCalled('deploy', ['npm run deploy:frontend']))
  assert.ok(!isCalled('lint', ['npm run lint:python']))
})

test('a cd step moves the base a script path resolves from', () => {
  const root = fakeRepo()
  try {
    assert.deepEqual(missingFiles(join(root, 'voc-datalake'), 'cd scripts && node used.mjs'), [])
    assert.deepEqual(missingFiles(root, 'node scripts/used.mjs'), ['scripts/used.mjs'])
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('flag scopes map to the module that would use them', () => {
  assert.equal(flagModule('@aws-cdk/core:target-partitions'), null)
  assert.equal(flagModule('@aws-cdk/customresources:installLatestAwsSdkDefault'), 'aws-cdk-lib/custom-resources')
  assert.equal(flagModule('@aws-cdk-containers/ecs-service-extensions:enableDefaultLogDriver'), '@aws-cdk-containers/ecs-service-extensions')
})

test('a tiny tree trips the vacuity guard (exit 2)', () => {
  const root = fakeRepo()
  try {
    assert.equal(main(['--root', root]), 2)
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('the real tree is clean', () => {
  assert.equal(main([]), 0)
})
