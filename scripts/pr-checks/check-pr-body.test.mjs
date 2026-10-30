import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { checkPrBody, escapeCommand, parseArgs } from './check-pr-body.mjs'
import { findSection, sections, visibleLines } from './markdown.mjs'
import { addedReleases, compareVersions } from './changelog.mjs'
import { pathOf, proofProblems, siblingProblems } from './fix-rules.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const TEMPLATE = readFileSync(join(ROOT, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8')

const BASE_LOG = '# Changelog\n\n## [Unreleased]\n\n## [5.48.05] - 2026-10-20\n\n### Fixed\n\n- old\n'
const changelogWith = (groups) => BASE_LOG.replace('## [Unreleased]\n', `## [Unreleased]\n\n## [5.49.00] - 2026-10-21\n\n${groups.map((g) => `### ${g}\n\n- x\n`).join('\n')}`)
const TREE = new Set(['voc-datalake/lambda/shared/test/test_clock.py', 'voc-datalake/lambda/shared/clock.py', 'voc-datalake/lambda/api/metrics_handler.py', 'docs/caching.md'])
const CHANGED = new Set(['voc-datalake/lambda/shared/clock.py', 'voc-datalake/lambda/shared/test/test_clock.py', 'CHANGELOG.md'])

function body({ goal = '**Goal:** reports stop losing rows uploaded close to midnight', compat = 'Compatible: no route or stored shape changes', tests = 'bash scripts/validate.sh passed.', sweep = null, release = '5.49.00 (minor)' } = {}) {
  const parts = [
    '## Goal', goal, '## Why it matters', 'Operators saw gaps.', '## Not a goal', 'None.',
    '## What changed', 'symptom -> cause -> change', '## Backwards compatibility', compat, '## Tests', tests,
  ]
  if (sweep !== null) parts.push('## Sibling sweep', sweep)
  parts.push('## Release', release)
  return parts.join('\n\n')
}
const run = (overrides = {}, groups = ['Added']) => checkPrBody({
  body: body(overrides), title: '5.49.00: rows survive midnight', draft: false, author: 'someone',
  changedFiles: CHANGED, headTree: TREE, baseChangelog: BASE_LOG, headChangelog: changelogWith(groups),
})
const FIX_TESTS = 'validate passed.\n\nProof: `voc-datalake/lambda/shared/test/test_clock.py::test_midnight` fails without the fix'
const NONE = 'Siblings: none -- grepped lambda/ for datetime.now in fixtures'

test('the empty template fails on every placeholder, so an untouched template never passes', () => {
  const result = checkPrBody({ body: TEMPLATE, title: '', draft: false, author: 'a' })
  assert.equal(result.status, 'fail')
  assert.ok(result.errors.some((e) => e.startsWith('Goal:')))
  assert.ok(result.errors.some((e) => e.startsWith('Why it matters: the section is empty')))
  assert.ok(result.errors.some((e) => e.startsWith('Backwards compatibility:')))
  assert.ok(!result.errors.some((e) => e.startsWith('missing section')), 'the template carries every required heading')
})

test('a careful non-fix PR passes', () => {
  assert.deepEqual(run().errors, [])
  assert.equal(run().status, 'pass')
})

test('drafts and Dependabot are skipped, not failed', () => {
  assert.equal(checkPrBody({ body: '', draft: true, author: 'a' }).status, 'skip')
  assert.equal(checkPrBody({ body: '', draft: false, author: 'dependabot[bot]' }).status, 'skip')
})

test('headings inside fences or comments do not count; CRLF bodies read the same', () => {
  const fenced = body().replace('## Tests', '```\n## Tests\n```')
  assert.ok(run().errors.length === 0)
  const result = checkPrBody({ body: fenced, title: '5.49.00: x', author: 'a', headChangelog: changelogWith(['Added']), baseChangelog: BASE_LOG })
  assert.ok(result.errors.includes('missing section "## Tests" (headings inside code fences or HTML comments do not count)'))
  const commented = checkPrBody({ body: body().replace('## Release', '<!--\n## Release\n-->'), author: 'a' })
  assert.ok(commented.errors.some((e) => e.includes('"## Release"')))
  const crlf = checkPrBody({ body: body().replaceAll('\n', '\r\n'), title: '5.49.00: x', author: 'a', changedFiles: CHANGED, headTree: TREE, baseChangelog: BASE_LOG, headChangelog: changelogWith(['Added']) })
  assert.deepEqual(crlf.errors, [])
})

test('heading match is a case-insensitive prefix and ### subheadings stay inside a section', () => {
  const all = sections('## TESTS and validation\n\nran\n\n### Deployed\n\nok\n\n## Release\n\nx')
  assert.ok(findSection(all, 'Tests').lines.some((l) => l.includes('### Deployed')))
})

test('fences close only on the same marker, at least as long', () => {
  assert.deepEqual(visibleLines('````\n```\n## Not real\n````\n## Real'), ['', '', '', '', '## Real'])
  assert.deepEqual(visibleLines('a <!-- b\nc --> d'), ['a ', ' d'])
})

test('the goal line must be a real sentence', () => {
  assert.ok(run({ goal: '**Goal:** <one sentence>' }).errors.some((e) => e.startsWith('Goal:')))
  assert.ok(run({ goal: '**Goal:** faster' }).errors.some((e) => e.startsWith('Goal:')))
  assert.ok(run({ goal: 'We want it faster.' }).errors.some((e) => e.startsWith('Goal:')))
  assert.deepEqual(run({ goal: 'Goal: the dashboard loads in under a second' }).errors, [])
})

test('a breaking PR needs Upgrade notes in its release section', () => {
  assert.ok(run({ compat: 'Breaking: GET /x answers 410' }).errors.some((e) => e.includes('Upgrade notes')))
  assert.deepEqual(run({ compat: 'Breaking: GET /x answers 410' }, ['Changed', 'Upgrade notes']).errors, [])
  assert.ok(run({ compat: 'Mostly compatible' }).errors.some((e) => e.startsWith('Backwards compatibility:')))
})

test('the release section and the title must name the version the CHANGELOG adds', () => {
  assert.ok(run({ release: '5.48.06 (patch)' }).errors.some((e) => e.includes('section 5.49.00')))
  assert.ok(run({ release: '5.49.00' }).errors.some((e) => e.includes('bump kind')))
  const titled = checkPrBody({ body: body(), title: 'rows survive', author: 'a', baseChangelog: BASE_LOG, headChangelog: changelogWith(['Added']) })
  assert.ok(titled.errors.some((e) => e.startsWith('Title:')))
})

test('a fix PR (### Fixed in the added release) needs a Proof line and a sibling sweep', () => {
  const result = run({}, ['Fixed'])
  assert.equal(result.isFix, true)
  assert.ok(result.errors.some((e) => e.startsWith('Tests: a fix PR needs')))
  assert.ok(result.errors.some((e) => e.includes('Sibling sweep')))
  assert.deepEqual(run({ tests: FIX_TESTS, sweep: NONE }, ['Fixed']).errors, [])
  assert.equal(run({}, ['Added']).isFix, false, 'an older release\'s Fixed group does not make this PR a fix')
})

test('one Proof line, which may name several tests; a bundled release does not need one per fix', () => {
  const two = 'Proof: `voc-datalake/lambda/shared/test/test_clock.py::a` and `docs/caching.md` fail without the fix'
  assert.deepEqual(run({ tests: two, sweep: NONE }, ['Added', 'Fixed']).errors, [])
  assert.ok(run({ tests: `${FIX_TESTS}\n\nProof: \`docs/caching.md\` fails without the fix`, sweep: NONE }, ['Fixed']).errors.some((e) => e.includes('exactly one')))
  assert.ok(run({ tests: '```\nProof: `x.py` fails without the fix\n```', sweep: NONE }, ['Fixed']).errors.some((e) => e.startsWith('Tests: a fix PR needs')))
})

test('Proof paths must exist and be repository-root paths, with a hint', () => {
  const short = run({ tests: 'Proof: `lambda/shared/test/test_clock.py::t` fails without the fix', sweep: NONE }, ['Fixed']).errors
  assert.ok(short.some((e) => e.includes('did you mean `voc-datalake/lambda/shared/test/test_clock.py`')))
  assert.ok(run({ tests: 'Proof: `test_midnight` fails without the fix', sweep: NONE }, ['Fixed']).errors.some((e) => e.includes('test FILE')))
  assert.ok(run({ tests: 'Proof: it is tested', sweep: NONE }, ['Fixed']).errors.some((e) => e.includes('must read')))
})

test('not provable takes a reason from the closed list and a detail', () => {
  const ok = 'Proof: not provable -- deployed-only: replayed the 23:57 run on the dev stack'
  assert.deepEqual(proofProblems({ lines: [ok] }, { headTree: null }), [])
  assert.deepEqual(proofProblems({ lines: ['**Proof:** not provable \u2014 nondeterministic: ran 50 times, 0 failures'] }, { headTree: null }), [])
  assert.ok(proofProblems({ lines: ['Proof: not provable -- too hard: yes it is'] }, { headTree: null })[0].includes('not a known'))
  assert.ok(proofProblems({ lines: ['Proof: not provable -- test-only:'] }, { headTree: null })[0].includes('needs a detail'))
})

test('sibling entries: changed here must be a changed file, every path must exist', () => {
  const ctx = { headTree: TREE, changedFiles: CHANGED }
  const ok = [
    '- `voc-datalake/lambda/shared/clock.py:12` -- changed here',
    '- `voc-datalake/lambda/api/metrics_handler.py` -- not affected: reads the clock once per request',
    '- `docs` -- follow-up #450',
  ]
  assert.deepEqual(siblingProblems({ lines: ok }, ctx), [])
  const bad = siblingProblems({ lines: ['- `voc-datalake/lambda/api/metrics_handler.py` -- changed here', '- `nope.py` -- follow-up #1', '- `docs/caching.md` -- maybe'] }, ctx)
  assert.ok(bad.some((e) => e.includes('not among the PR\'s changed files')))
  assert.ok(bad.some((e) => e.includes('`nope.py` does not exist')))
  assert.ok(bad.some((e) => e.includes('the status must be')))
})

test('sibling sweep: none needs a reason, and cannot be mixed with entries', () => {
  const ctx = { headTree: null, changedFiles: null }
  assert.ok(siblingProblems({ lines: ['Siblings: none'] }, ctx)[0].includes('needs a reason'))
  assert.ok(siblingProblems({ lines: [NONE, '- `a.py` -- changed here'] }, ctx)[0].includes('not both'))
  assert.ok(siblingProblems({ lines: ['we looked'] }, ctx)[0].includes('list each site'))
  assert.deepEqual(siblingProblems({ lines: ['- `a.py` -- changed here'] }, ctx), [], 'unknown trees skip path checks')
})

test('helpers: path of a test reference, version order, added releases, command escaping, args', () => {
  assert.equal(pathOf('a/b.test.ts > case one'), 'a/b.test.ts')
  assert.equal(pathOf('a/b.py:10:2'), 'a/b.py')
  assert.ok(compareVersions('5.10.00', '5.9.99') > 0)
  assert.deepEqual(addedReleases(BASE_LOG, changelogWith(['Fixed', 'Security'])), [{ version: '5.49.00', groups: ['Fixed', 'Security'] }])
  assert.equal(addedReleases(BASE_LOG, null), null)
  assert.equal(escapeCommand('50%\nx'), '50%25%0Ax')
  assert.deepEqual(parseArgs(['--head-tree', 't.txt']), { 'head-tree': 't.txt' })
  assert.throws(() => parseArgs(['--head-tree']))
})
