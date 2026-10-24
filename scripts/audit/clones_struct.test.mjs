// clones_struct.mjs finds planted renamed / near clones and stays quiet on look-alikes (fixtures in a temp dir).
import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { DEFAULTS, main, scan } from './clones_struct.mjs'
import { EXIT, REPO_ROOT } from './audit_common.mjs'
import { tempTree } from './ts_audit_fixture.mjs'

const COPY_A = `
export function copyText(text: string, key: string) {
  void navigator.clipboard.writeText(text)
  setCopiedKey(key)
  clearTimeout(timerRef.current)
  timerRef.current = setTimeout(() => setCopiedKey(null), 2000)
  return { copied: key, at: Date.now() }
}`
const COPY_B = COPY_A.replace(/copyText/g, 'handleCopy').replace(/setCopiedKey/g, 'setFlag')
  .replace(/timerRef/g, 'timer').replace(/2000/g, '1500').replace(/key/g, 'id')
const NEAR_B = `
export function handleCopy(value: string, id: string) {
  void navigator.clipboard.writeText(value.trim())
  setFlag(id)
  clearTimeout(timer.current)
  timer.current = setTimeout(() => setFlag(null), 1500)
  return { copied: id, at: Date.now() }
}`
/** Same vocabulary, different structure: no timer, an early return. Not a clone. */
const LOOK_ALIKE = `
export function copyIfAllowed(text: string, key: string) {
  if (!navigator.clipboard) return null
  return navigator.clipboard.writeText(text).then(() => key, () => null)
}`
const JSX_A = `export function Empty({ title }: { title: string }) {
  return <div className="card p-6 text-center"><p className="text-sm">{title}</p><button type="button" onClick={go}>{t('x')}</button></div>
}`
const JSX_B = `export function Missing({ label }: { label: string }) {
  return <section role="status" aria-live="polite"><h2>{label}</h2><input type="text" value={v} onChange={set} /></section>
}`

const tree = (files) => tempTree(files, 'clones-ts-')

function run(root, ...extra) {
  const report = join(root, 'report.json')
  const code = main(['src', '--root', root, '--min-nodes', '25', '--json', report,
    '--allowlist', join(root, 'none.json'), ...extra])
  let parsed = null
  try { parsed = JSON.parse(readFileSync(report, 'utf8')) } catch { /* error exits write no report */ }
  return { code, report: parsed }
}

test('a renamed copy (identifiers, members, literals) is one exact function group', () => {
  const { code, report } = run(tree({ 'src/a.ts': COPY_A, 'src/b.ts': COPY_B }))
  assert.equal(code, EXIT.findings)
  assert.equal(report.findings.length, 1)
  assert.equal(report.findings[0].kind, 'function')
  assert.deepEqual(report.findings[0].copies.map((c) => c.name).sort(), ['copyText', 'handleCopy'])
})

test('a copy with a small edit is a near-function cluster, admitted by the threshold', () => {
  const root = tree({ 'src/a.ts': COPY_A, 'src/b.ts': NEAR_B })
  const { code, report } = run(root)
  assert.equal(code, EXIT.findings)
  assert.equal(report.findings[0].kind, 'near-function')
  assert.ok(report.findings[0].similarity >= 0.8 && report.findings[0].similarity < 1)
  const strict = run(root, '--similarity', '0.99').report
  assert.ok(strict.findings.every((g) => g.kind !== 'near-function'))
  assert.deepEqual(strict.findings.map((g) => g.kind), ['statements']) // the identical timer lines still match
})

test('a same-vocabulary look-alike is not a clone', () => {
  assert.equal(run(tree({ 'src/a.ts': COPY_A, 'src/b.ts': LOOK_ALIKE })).code, EXIT.clean)
})

test('JSX with other tags and attributes is not a clone (intrinsic tags and attribute names are kept)', () => {
  assert.equal(run(tree({ 'src/a.tsx': JSX_A, 'src/b.tsx': JSX_B }), '--min-nodes', '10').code, EXIT.clean)
})

test('specs are skipped unless --include-tests', () => {
  const root = tree({ 'src/a.ts': COPY_A, 'src/a.test.ts': COPY_B })
  assert.equal(run(root).code, EXIT.clean)
  assert.equal(run(root, '--include-tests').code, EXIT.findings)
})

test('copies inside one file need --same-file', () => {
  const root = tree({ 'src/a.ts': COPY_A + COPY_B })
  assert.equal(run(root).code, EXIT.clean)
  assert.equal(run(root, '--same-file').code, EXIT.findings)
})

test('an allowlist entry silences a group only when it covers every copy, and needs a reason', () => {
  const root = tree({ 'src/a.ts': COPY_A, 'src/b.ts': COPY_B })
  const allow = join(root, 'allow.json')
  writeFileSync(allow, JSON.stringify({ entries: [{ files: ['src/*.ts'], reason: 'planted pair' }] }))
  assert.equal(run(root, '--allowlist', allow).code, EXIT.clean)
  writeFileSync(allow, JSON.stringify({ entries: [{ files: ['src/a.ts'], reason: 'one side only' }] }))
  assert.equal(run(root, '--allowlist', allow).code, EXIT.findings)
  writeFileSync(allow, JSON.stringify({ entries: [{ files: ['src/*.ts'] }] }))
  assert.equal(run(root, '--allowlist', allow).code, EXIT.error)
})

test('a scan below the file floor is an error', () => {
  assert.equal(run(tree({ 'src/a.ts': COPY_A }), '--min-files', '5').code, EXIT.error)
})

test('vacuity guard: the default scope parses a plausible number of files', () => {
  const { files } = scan(REPO_ROOT, DEFAULTS.paths, { minNodes: 400, window: 3, similarity: 2, sameFile: false })
  assert.ok(files >= DEFAULTS.minFiles, `only ${files} files`)
})
