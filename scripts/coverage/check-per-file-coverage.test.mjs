import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  EPSILON, evaluate, initBaseline, main, normalisePath, parseArgs, parseBaseline, parseReport, rateOf, shrinkBaseline,
} from './check-per-file-coverage.mjs'

const REPO = '/repo'
const PY = { repoRoot: REPO, base: 'voc-datalake' }
const pyReport = (files) => JSON.stringify({
  meta: { format: 3 },
  files: Object.fromEntries(Object.entries(files).map(([path, [covered, total]]) => [path, { summary: { covered_lines: covered, num_statements: total } }])),
})
const vitestReport = (files) => JSON.stringify({
  total: { lines: { total: 1, covered: 1 } },
  ...Object.fromEntries(Object.entries(files).map(([path, [covered, total]]) => [path, { lines: { covered, total, pct: 0 } }])),
})
const filesOf = (entries) => new Map(Object.entries(entries).map(([path, [covered, total]]) => [path, { covered, total }]))
const baseline = (...rows) => `# header\n${rows.join('\n')}\n`

test('rates are truncated to two decimals, never rounded up', () => {
  assert.equal(rateOf(2, 3), 66.66)
  assert.equal(rateOf(799, 1000), 79.9)
  assert.equal(rateOf(7999, 10000), 79.99)
  assert.equal(rateOf(5, 5), 100)
})

test('report paths become repo-relative POSIX paths, relative ones against the base', () => {
  assert.equal(normalisePath('lambda/api/x.py', PY), 'voc-datalake/lambda/api/x.py')
  assert.equal(normalisePath('/repo/voc-datalake/frontend/src/a.ts', { repoRoot: REPO, base: 'voc-datalake/frontend' }), 'voc-datalake/frontend/src/a.ts')
  assert.equal(normalisePath('./lambda/../plugins/p.py', PY), 'voc-datalake/plugins/p.py')
})

test('a report path outside the repository cannot run', () => {
  assert.throws(() => normalisePath('/elsewhere/a.ts', PY), /outside the repository/)
  assert.throws(() => normalisePath('../../x.py', PY), /outside the repository/)
})

test('reads coverage.py JSON (statements) and vitest json-summary (lines)', () => {
  assert.deepEqual(parseReport('py', pyReport({ 'lambda/a.py': [3, 4] }), PY), new Map([['voc-datalake/lambda/a.py', { covered: 3, total: 4 }]]))
  const fe = parseReport('vitest', vitestReport({ '/repo/f/src/a.tsx': [1, 2] }), { repoRoot: REPO, base: 'f' })
  assert.deepEqual(fe, new Map([['f/src/a.tsx', { covered: 1, total: 2 }]]))
})

test('malformed reports fail closed', () => {
  assert.throws(() => parseReport('py', '{not json', PY), /not valid JSON/)
  assert.throws(() => parseReport('py', '[]', PY), /not a JSON object/)
  assert.throws(() => parseReport('py', '{"totals": {}}', PY), /no "files" object/)
  assert.throws(() => parseReport('vitest', '{"/repo/a.ts": {"lines": {"covered": 1, "total": 1}}}', PY), /no "total" entry/)
  assert.throws(() => parseReport('py', pyReport({}), PY), /lists no files/)
  assert.throws(() => parseReport('vitest', vitestReport({}), PY), /lists no files/)
  assert.throws(() => parseReport('py', pyReport({ 'a.py': [5, 4] }), PY), /no valid covered\/total/)
  assert.throws(() => parseReport('py', pyReport({ 'a.py': [1.5, 4] }), PY), /no valid covered\/total/)
  assert.throws(() => parseReport('py', '{"files": {"a.py": {}}}', PY), /no valid covered\/total/)
  assert.throws(() => parseReport('xml', pyReport({ 'a.py': [1, 1] }), PY), /unknown --format/)
  assert.throws(() => parseReport('py', pyReport({ 'a.py': [1, 1], './a.py': [1, 1] }), PY), /twice/)
})

test('baseline rows parse; comments and blank lines are not rows', () => {
  const rows = parseBaseline('# rule\n\na/b.py 12.50   # 1/8\nc.ts 0\n')
  assert.deepEqual(rows.map(({ path, rate }) => [path, rate]), [['a/b.py', 12.5], ['c.ts', 0]])
})

test('malformed, unsorted and duplicated baselines cannot run', () => {
  assert.throws(() => parseBaseline('a.py\n'), /line 1 is not/)
  assert.throws(() => parseBaseline('a.py abc\n'), /line 1 is not/)
  assert.throws(() => parseBaseline('a.py 101\n'), /line 1 is not/)
  assert.throws(() => parseBaseline('/abs/a.py 10\n'), /line 1 is not/)
  assert.throws(() => parseBaseline('a\\b.py 10\n'), /line 1 is not/)
  assert.throws(() => parseBaseline('b.py 10\na.py 10\n'), /out of order/)
  assert.throws(() => parseBaseline('a.py 10\na.py 20\n'), /repeats/)
})

test('(a) an unlisted file below the floor fails; one at the floor passes', () => {
  const result = evaluate(filesOf({ 'new.py': [79, 100], 'ok.py': [80, 100] }), [], 80)
  assert.deepEqual(result.belowFloor, ['new.py: 79.00% (79/100) is below the 80% floor'])
  assert.deepEqual([result.regressed, result.stale], [[], []])
})

test('(b) a listed file under its recorded rate fails, within EPSILON it passes', () => {
  assert.equal(EPSILON, 0.1)
  const rows = parseBaseline('old.py 50.00\n')
  assert.deepEqual(evaluate(filesOf({ 'old.py': [4990, 10000] }), rows, 80).regressed, [])
  assert.deepEqual(evaluate(filesOf({ 'old.py': [60, 100] }), rows, 80).regressed, [])
  assert.deepEqual(evaluate(filesOf({ 'old.py': [49, 100] }), rows, 80).regressed, ['old.py: 49.00% (49/100) fell below its recorded 50.00%'])
})

test('(c) stale rows: graduated, vanished, and nothing to measure', () => {
  const rows = parseBaseline('empty.py 10\ngone.py 10\nup.py 10\n')
  const result = evaluate(filesOf({ 'empty.py': [0, 0], 'up.py': [80, 100] }), rows, 80)
  assert.deepEqual([...result.stalePaths].sort(), ['empty.py', 'gone.py', 'up.py'])
  assert.equal(result.stale.length, 3)
  assert.deepEqual([result.belowFloor, result.regressed], [[], []])
})

test('a file with nothing to measure is never below the floor', () => {
  assert.deepEqual(evaluate(filesOf({ 'types.ts': [0, 0] }), [], 80).belowFloor, [])
})

test('shrinking deletes only the stale rows and keeps every other line verbatim', () => {
  const text = '# rule\n#   indented comment\n\na.py 10.00   # 1/10\nb.py 20   #  odd spacing kept\n'
  assert.equal(shrinkBaseline(text, new Set(['a.py'])), '# rule\n#   indented comment\n\nb.py 20   #  odd spacing kept\n')
  assert.equal(shrinkBaseline(text, new Set()), text)
})

test('a first baseline lists the files under the floor, sorted, with truncated rates and counts', () => {
  const text = initBaseline(filesOf({ 'z.py': [1, 3], 'a.py': [2, 3], 'ok.py': [9, 10], 'empty.py': [0, 0] }), 80, 'REFRESH')
  assert.match(text, /^# Per-file coverage baseline/)
  assert.match(text, /^# {3}REFRESH$/m)
  assert.deepEqual(parseBaseline(text).map(({ line }) => line), ['a.py 66.66   # 2/3', 'z.py 33.33   # 1/3'])
})

test('options: --suite supplies every value and cannot be mixed with explicit ones', () => {
  const suites = { _comment: 'x', py: { format: 'py', report: 'r.json', base: 'voc-datalake', baseline: 'b.txt', floor: 80 } }
  assert.deepEqual(parseArgs(['--suite', 'py'], suites), { suite: 'py', format: 'py', report: 'r.json', base: 'voc-datalake', baseline: 'b.txt', floor: 80 })
  assert.throws(() => parseArgs(['--suite', 'py', '--floor', '10'], suites), /drop --floor/)
  assert.throws(() => parseArgs(['--suite', 'nope'], suites), /unknown --suite/)
  assert.throws(() => parseArgs(['--suite', '_comment'], suites), /unknown --suite/)
  assert.throws(() => parseArgs(['--format', 'py', '--report', 'r', '--baseline', 'b'], {}), /--floor is required/)
  assert.throws(() => parseArgs(['--format', 'py', '--report', 'r', '--baseline', 'b', '--floor', '0'], {}), /percentage/)
  assert.throws(() => parseArgs(['--init', '--update-baseline'], {}), /exclusive/)
  assert.throws(() => parseArgs(['--prune-graduated', '--update-baseline'], {}), /exclusive/)
  assert.throws(() => parseArgs(['--prune-graduated', '--init'], {}), /exclusive/)
  assert.throws(() => parseArgs(['--accept-new'], {}), /unknown or incomplete option/)
  assert.throws(() => parseArgs(['--report'], {}), /unknown or incomplete option/)
})

/** A throwaway repository with a coverage.py report; returns helpers to run main() against it. */
function fixtureRepo(files) {
  const repoRoot = mkdtempSync(join(tmpdir(), 'coverage-gate-'))
  mkdirSync(join(repoRoot, 'voc-datalake'))
  writeFileSync(join(repoRoot, 'report.json'), pyReport(files))
  const lines = []
  const run = (...extra) => main(
    ['--format', 'py', '--report', 'report.json', '--base', 'voc-datalake', '--baseline', 'baseline.txt', '--floor', '80', ...extra],
    { repoRoot, log: (line) => lines.push(line), error: (line) => lines.push(line) },
  )
  const baselineFile = join(repoRoot, 'baseline.txt')
  return { repoRoot, run, lines, baselineFile, cleanup: () => rmSync(repoRoot, { recursive: true, force: true }) }
}

test('end to end: --init once, the check passes, a second --init refuses', () => {
  const repo = fixtureRepo({ 'lambda/low.py': [1, 4], 'lambda/high.py': [9, 10] })
  try {
    assert.equal(repo.run('--init'), 0)
    assert.match(readFileSync(repo.baselineFile, 'utf8'), /^voc-datalake\/lambda\/low\.py 25\.00 {3}# 1\/4$/m)
    assert.equal(repo.run(), 0)
    assert.equal(repo.run('--init'), 2)
    assert.match(repo.lines.at(-1), /--init refuses/)
  } finally {
    repo.cleanup()
  }
})

/** Rows of a baseline with one regressed, one vanished and one graduated file (MIXED_REPORT below). */
const DOWN_ROW = 'voc-datalake/lambda/down.py 50.00   # 5/10'
const GONE_ROW = 'voc-datalake/lambda/gone.py 10.00   # 1/10'
const UP_ROW = 'voc-datalake/lambda/up.py 10.00   # 1/10'
const MIXED_REPORT = { 'lambda/up.py': [9, 10], 'lambda/down.py': [1, 10], 'lambda/new.py': [1, 10] }

/** The two findings MIXED_REPORT always leaves: a new file under the floor and a regressed baselined one. */
function assertMixedFindings(lines) {
  assert.ok(lines.some((line) => line.includes('new.py: 10.00% (1/10) is below the 80% floor')))
  assert.ok(lines.some((line) => line.includes('down.py: 10.00% (1/10) fell below its recorded 50.00%')))
}

test('end to end: --update-baseline only deletes, and a remaining regression still fails', () => {
  const repo = fixtureRepo(MIXED_REPORT)
  try {
    writeFileSync(repo.baselineFile, baseline(DOWN_ROW, GONE_ROW, UP_ROW))
    assert.equal(repo.run(), 1)
    assert.equal(repo.run('--update-baseline'), 1)
    assert.equal(readFileSync(repo.baselineFile, 'utf8'), baseline(DOWN_ROW))
    assertMixedFindings(repo.lines)
  } finally {
    repo.cleanup()
  }
})

test('end to end: --prune-graduated deletes only rows that reach the floor, names them and then passes', () => {
  const repo = fixtureRepo({ 'lambda/up.py': [9, 10], 'lambda/low.py': [3, 10] })
  try {
    const before = baseline('voc-datalake/lambda/low.py 30.00   # 3/10', 'voc-datalake/lambda/up.py 10.00   # 1/10')
    writeFileSync(repo.baselineFile, before)
    assert.equal(repo.run('--prune-graduated'), 0)
    assert.equal(readFileSync(repo.baselineFile, 'utf8'), baseline('voc-datalake/lambda/low.py 30.00   # 3/10'))
    assert.ok(repo.lines.some((line) => /removed 1 graduated row\(s\).*commit this change/.test(line)))
    assert.ok(repo.lines.includes('  voc-datalake/lambda/up.py'))
  } finally {
    repo.cleanup()
  }
})

test('end to end: --prune-graduated keeps every other stale row and finding failing', () => {
  const repo = fixtureRepo(MIXED_REPORT)
  try {
    writeFileSync(repo.baselineFile, baseline(DOWN_ROW, GONE_ROW, UP_ROW))
    assert.equal(repo.run('--prune-graduated'), 1)
    assert.equal(readFileSync(repo.baselineFile, 'utf8'), baseline(DOWN_ROW, GONE_ROW))
    assert.ok(repo.lines.some((line) => line.includes('gone.py: not in the report')))
    assertMixedFindings(repo.lines)
  } finally {
    repo.cleanup()
  }
})

test('end to end: --prune-graduated writes nothing when no row graduated', () => {
  const repo = fixtureRepo({ 'lambda/low.py': [3, 10] })
  try {
    const before = baseline('voc-datalake/lambda/low.py 30.00   # 3/10')
    writeFileSync(repo.baselineFile, before)
    assert.equal(repo.run('--prune-graduated'), 0)
    assert.equal(readFileSync(repo.baselineFile, 'utf8'), before)
    assert.ok(!repo.lines.some((line) => line.includes('graduated row')))
  } finally {
    repo.cleanup()
  }
})

test('end to end: a missing report or baseline cannot run, and --init writes nothing on a bad report', () => {
  const repo = fixtureRepo({ 'lambda/a.py': [1, 1] })
  try {
    assert.equal(repo.run(), 2)
    assert.match(repo.lines.at(-1), /cannot read the baseline/)
    writeFileSync(join(repo.repoRoot, 'report.json'), '{}')
    assert.equal(repo.run('--init'), 2)
    assert.equal(existsSync(repo.baselineFile), false)
    rmSync(join(repo.repoRoot, 'report.json'))
    assert.equal(repo.run('--init'), 2)
    assert.match(repo.lines.at(-1), /cannot read the report/)
  } finally {
    repo.cleanup()
  }
})

test('the shipped suite configuration is complete and every floor is a percentage', () => {
  const suites = JSON.parse(readFileSync(new URL('./suites.json', import.meta.url), 'utf8'))
  for (const name of ['python', 'frontend', 'stream']) {
    const options = parseArgs(['--suite', name], suites)
    assert.ok(options.floor > 0 && options.floor <= 100, name)
    assert.equal(options.baseline, `scripts/coverage/baselines/${name}.txt`)
  }
})
