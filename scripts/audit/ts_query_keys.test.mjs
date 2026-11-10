import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { rmSync } from 'node:fs'
import { scanQueryKeys } from './ts_query_keys.mjs'
import { kinds, tempTree } from './ts_audit_fixture.mjs'

const SPA = 'voc-datalake/frontend/src'

test('reports a key inline in two files and one inline beside its constant; quiet on a page-private key', () => {
  const dir = tempTree({
    [`${SPA}/api/projectQueryKeys.ts`]: "export const projectKey = (id: string) => ['project', id] as const\nexport const USERS_KEY = ['admin-users'] as const\n",
    [`${SPA}/pages/A/A.tsx`]: [
      "useQuery({ queryKey: ['users'], queryFn: f })",
      "void qc.invalidateQueries({ queryKey: ['project', id] })",
      "useQuery({ queryKey: ['page-private', x], queryFn: g })",
      "void qc.invalidateQueries({ queryKey: ['page-private'] })",
      'useQuery({ queryKey: USERS_KEY, queryFn: h })',
    ].join('\n'),
    [`${SPA}/pages/B/B.tsx`]: "qc.setQueryData(['users'], [])\n",
    [`${SPA}/pages/B/B.test.tsx`]: "qc.setQueryData(['page-private'], [])\n",
  })
  try {
    const { findings, sites } = scanQueryKeys(dir)
    assert.deepEqual(kinds(findings), { 'qk:users': 'inline-shared', 'qk:project': 'inline-beside-constant' })
    assert.equal(sites, 6)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
