import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync } from 'node:fs'
import {
  IGNORE_FILE,
  NPM_DIRS,
  PIP_TARGETS,
  classify,
  matchIgnore,
  npmFindingGates,
  parseNpmAudit,
  parsePipAudit,
  validateIgnores,
} from './dependency-audit.mjs'

const NPM_REPORT = {
  auditReportVersion: 2,
  vulnerabilities: {
    'left-pad': {
      name: 'left-pad',
      severity: 'high',
      via: [{ source: 1001, name: 'left-pad', title: 'Prototype pollution', url: 'https://github.com/advisories/GHSA-j8r2-6x86-q33q', severity: 'high' }],
    },
    'uses-left-pad': { name: 'uses-left-pad', severity: 'high', via: ['left-pad'] },
    'old-thing': {
      name: 'old-thing',
      severity: 'low',
      via: [
        { source: 1002, name: 'old-thing', title: 'ReDoS', url: 'https://example.invalid/advisory/1002', severity: 'low' },
        { source: 1002, name: 'old-thing', title: 'ReDoS', url: 'https://example.invalid/advisory/1002', severity: 'low' },
      ],
    },
  },
}

test('npm: reads advisories from object via entries only, deduplicated, GHSA id from the url', () => {
  const found = parseNpmAudit(NPM_REPORT)
  assert.deepEqual(found.map((f) => [f.id, f.package, f.severity]), [
    ['GHSA-j8r2-6x86-q33q', 'left-pad', 'high'],
    ['npm-1002', 'old-thing', 'low'],
  ])
})

test('npm: an error report or an unknown report shape is a failure, never an empty result', () => {
  assert.throws(() => parseNpmAudit({ error: { code: 'ENOLOCK' } }), /npm audit failed/)
  assert.throws(() => parseNpmAudit({ auditReportVersion: 1, advisories: {} }), /does not understand/)
  assert.throws(() => parseNpmAudit(null), /npm audit failed/)
})

test('npm gate: production fails at high, development only at critical', () => {
  assert.equal(npmFindingGates({ scope: 'production', severity: 'high' }), true)
  assert.equal(npmFindingGates({ scope: 'production', severity: 'moderate' }), false)
  assert.equal(npmFindingGates({ scope: 'development', severity: 'high' }), false)
  assert.equal(npmFindingGates({ scope: 'development', severity: 'critical' }), true)
  assert.equal(npmFindingGates({ scope: 'production', severity: 'unheard-of' }), true, 'an unknown severity fails closed')
})

test('pip: one finding per advisory and package, aliases kept', () => {
  const found = parsePipAudit({
    dependencies: [
      { name: 'requests', version: '2.20.0', vulns: [
        { id: 'PYSEC-2023-74', fix_versions: ['2.31.0'], aliases: ['CVE-2023-32681', 'GHSA-j8r2-6x86-q33q'] },
        { id: 'PYSEC-2023-74', fix_versions: ['2.31.0'], aliases: ['CVE-2023-32681', 'GHSA-j8r2-6x86-q33q'] },
      ] },
      { name: 'six', version: '1.17.0', vulns: [] },
    ],
  })
  assert.equal(found.length, 1)
  assert.deepEqual(found[0].aliases, ['CVE-2023-32681', 'GHSA-j8r2-6x86-q33q'])
  assert.throws(() => parsePipAudit({}), /does not understand/)
})

const entry = (over = {}) => ({ id: 'GHSA-j8r2-6x86-q33q', package: 'left-pad', reason: 'Only reached by the build script, never at runtime.', expires: '2026-11-30', ...over })

test('ignores: a complete entry inside the window is accepted', () => {
  assert.deepEqual(validateIgnores({ ignores: [entry()] }, '2026-10-30'), { ignores: [entry()], problems: [] })
})

test('ignores: expired, too far ahead, malformed and reasonless entries are problems and ignore nothing', () => {
  const { ignores, problems } = validateIgnores({
    ignores: [entry({ expires: '2026-10-29' }), entry({ expires: '2027-06-01' }), entry({ id: 'SNYK-1' }), entry({ reason: 'ok' }), entry({ expires: 'soon' }), 'x'],
  }, '2026-10-30')
  assert.deepEqual(ignores, [])
  assert.equal(problems.length, 6)
  assert.match(problems[0], /expired on 2026-10-29/)
  assert.match(problems[1], /more than 90 days/)
  assert.match(problems[2], /GHSA, PYSEC or CVE/)
  assert.match(problems[3], /reason/)
  assert.match(problems[4], /YYYY-MM-DD/)
  assert.match(problems[5], /not an object/)
})

test('ignores: an entry expiring today still holds', () => {
  assert.deepEqual(validateIgnores({ ignores: [entry({ expires: '2026-10-30' })] }, '2026-10-30').problems, [])
})

test('ignores: the file must hold an "ignores" list', () => {
  assert.match(validateIgnores({}, '2026-10-30').problems[0], /"ignores" list/)
})

test('matching: same package (pip name normalisation) and the id or one of its aliases', () => {
  const pip = { id: 'PYSEC-2023-74', aliases: ['GHSA-j8r2-6x86-q33q'], package: 'Left_Pad' }
  assert.deepEqual(matchIgnore(pip, [entry()]), entry())
  assert.equal(matchIgnore({ ...pip, package: 'other' }, [entry()]), undefined)
  assert.equal(matchIgnore({ ...pip, aliases: [] }, [entry()]), undefined)
})

test('classify: ignored findings are set aside, the rest split on the gate, used ignores recorded', () => {
  const used = new Set()
  const ignore = entry()
  const result = classify([
    { id: 'GHSA-j8r2-6x86-q33q', aliases: [], package: 'left-pad', gates: true },
    { id: 'GHSA-9wx4-h78v-vm56', aliases: [], package: 'requests', gates: true },
    { id: 'GHSA-gc5v-m9x4-r6x2', aliases: [], package: 'vite', gates: false },
  ], [ignore], used)
  assert.deepEqual([result.failing.length, result.reported.length, result.ignored.length], [1, 1, 1])
  assert.equal(result.ignored[0].until, '2026-11-30')
  assert.equal(used.has(ignore), true)
})

test('the committed ignore file parses and every pip target is a layer or the dev requirements', () => {
  const file = JSON.parse(readFileSync(new URL(`../${IGNORE_FILE}`, import.meta.url), 'utf8'))
  assert.equal(Array.isArray(file.ignores), true)
  assert.equal(NPM_DIRS.includes('voc-datalake/frontend/e2e'), true)
  assert.deepEqual(PIP_TARGETS.filter((t) => !t.gating).map((t) => t.file), ['voc-datalake/requirements-dev.txt'])
})
