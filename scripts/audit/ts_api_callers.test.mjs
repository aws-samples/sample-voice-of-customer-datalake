import { test } from 'node:test'
import { strict as assert } from 'node:assert'
import { analyzeApiCallers } from './ts_api_callers.mjs'
import { fixtureProject, kinds } from './ts_audit_fixture.mjs'

const CLIENT = `
export async function fetchApi<T>(url: string): Promise<T> { return (await fetch(url)).json() as Promise<T> }
export const projectsApi = {
  list: () => fetchApi<string[]>('/projects'),
  create: () => fetchApi<string>('/projects/new'),
  onlyViaDeadDelegate: (id: string) => fetchApi<string>(\`/projects/\${id}/x\`),
}
export const api = {
  list: () => projectsApi.list(),
  deadDelegate: (id: string) => projectsApi.onlyViaDeadDelegate(id),
  nested: { get: (id: string) => fetchApi<string>(\`/n/\${id}\`) },
  formatOnly: (s: string) => s.trim(),
}
export function getThing() { return fetchApi<number>('/thing') }
`

test('reports API functions only specs call (with the route), and delegates of dead ones; quiet on live and non-request', () => {
  const fx = fixtureProject({
    'src/api/client.ts': CLIENT,
    'src/main.ts': "import { api } from './api/client'\nvoid api.list()\nvoid api.nested.get('1')\n",
    'src/api/client.test.ts': "import { projectsApi, getThing } from './client'\nvoid projectsApi.create()\nvoid getThing()\n",
  })
  try {
    const { findings, targets } = analyzeApiCallers(fx.def)
    assert.equal(targets, 8) // fetchApi, 3 projectsApi, api.list, deadDelegate, nested.get, getThing; formatOnly requests nothing
    assert.deepEqual(kinds(findings), {
      'fx:src/api/client.ts#projectsApi.create': 'test-only',
      'fx:src/api/client.ts#projectsApi.onlyViaDeadDelegate': 'test-only',
      'fx:src/api/client.ts#api.deadDelegate': 'uncalled',
      'fx:src/api/client.ts#getThing': 'test-only',
    })
    assert.match(findings.find((f) => f.key.endsWith('#api.deadDelegate')).detail, /route → projectsApi\.onlyViaDeadDelegate \(`\/projects\/\$\{id\}\/x`\)/)
  } finally {
    fx.cleanup()
  }
})
