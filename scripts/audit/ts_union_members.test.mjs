import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { analyzeUnions, wildcard } from './ts_union_members.mjs'
import { fixtureProject, kinds, tempTree } from './ts_audit_fixture.mjs'

const SRC = `
export type Tone = 'ok' | 'warn' | 'aim'
export const TONE_CLASS: Record<Tone, string> = { ok: 'a', warn: 'b', aim: 'c' }
export function toneOf(n: number): Tone { return n > 0 ? 'ok' : 'warn' }
export function isAim(t: Tone) { return t === 'aim' }

export type Phase = 'pending' | 'declining' | 'executing'
let local: 'pending' | 'declining' = 'pending'
export function decline() { local = 'declining'; return local }
export const phaseOf = (busy: boolean): Phase => (busy ? 'executing' : local)

export type Job = 'generate_prd' | 'generate_prfaq' | 'research' | 'legacy_import'
export const jobName = (kind: string) => \`generate_\${kind}\`

export type Wire = 'from_api' | 'from_python_f' | 'orphan'
export interface Row { state: 'open' | 'closed' | 'archived' }
export const row: Row = { state: 'open' }
export const closed = (r: Row) => r.state === 'closed'
`

const backendRoot = (files) => tempTree(files, 'ts-union-backend-')

test('reports never-produced and unused members; quiet on returned, narrower-union, template, backend producers', () => {
  const fx = fixtureProject({ 'src/main.ts': SRC, 'src/main.test.ts': "export const x = 'archived'\n" })
  const root = backendRoot({
    'voc-datalake/lambda/api/h.py': "STATE = 'from_api'\nkind = f'from_python_{x}'\n",
    'voc-datalake/lambda/api/test/test_h.py': "ONLY_IN_TESTS = 'orphan'\n",
    'voc-datalake/plugins/p/manifest.json': '{"x": "research"}',
  })
  try {
    const { unions, findings } = analyzeUnions(fx.def, root)
    assert.equal(unions.length, 5)
    assert.deepEqual(kinds(findings), {
      "fx:src/main.ts#Tone.'aim'": 'never-produced',
      "fx:src/main.ts#Job.'legacy_import'": 'unused-member',
      "fx:src/main.ts#Wire.'orphan'": 'unused-member',
      "fx:src/main.ts#Row.state.'closed'": 'never-produced',
      "fx:src/main.ts#Row.state.'archived'": 'unused-member',
    })
    assert.match(findings.find((f) => f.key.endsWith("'aim'")).detail, /compare 1, key 1/)
  } finally {
    fx.cleanup()
    rmSync(root, { recursive: true, force: true })
  }
})

test('wildcard: static parts are escaped and substitutions match one or more characters', () => {
  assert.ok(wildcard(['generate_', '']).test('generate_prd'))
  assert.ok(!wildcard(['generate_', '']).test('generate_'))
  assert.ok(!wildcard(['a.b', '']).test('axbc'))
})
