/**
 * The tenets document's adapter contract (§6.4 [52] step 2; D6-3; gap P): a version reads as its Markdown projection
 * (citations as code, never links), compares by tenet id, is never edited (a draft is decided on), names the version it
 * is compared with, sends the accepted version the screen showed with a decision, and reads a 409 as "read it again".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const {
  comparedWith, isTenetsStale, tenetsAdapter, tenetsChanges, tenetsDecisionBody, tenetsDocumentOf, tenetsMarkdown,
} = await import('./tenetsDocument')
const { parseTenetsVersion } = await import('../../../api/engineeringKnowledgeApi')

const LABELS = { summary: 'Summary', why: 'Why:', cites: 'Cites:' }
const tenet = (id: string, title: string, statement: string, citations: string[] = []) =>
  ({ id, title, statement, rationale: '', citations })
const V1 = { summary: 'What we value.', tenets: [tenet('api-compat', 'Keep the API', 'Never break it.'), tenet('tabs', 'Use tabs', 'Tabs.')] }
const V2 = { summary: '', tenets: [tenet('api-compat', 'Keep the API', 'Never break it, nor its codes.'), tenet('tests', 'Test fixes', 'Always.', ['src/a.py:12'])] }
const version = (number: number, status: string, base = 0) => ({ version: {
  version: number, status, current: false, record: number === 1 ? V1 : V2, ids: [], author: 'understander-1', author_kind: 'agent',
  run_id: null, base_version: base, created_at: '2026-11-16T09:00:00Z', decided_by: null, decided_at: null, reason: null,
}, log: [] })
const head = (accepted: number | null) => ({ versions: 2, accepted_version: accepted, accepted_ids: [], accepted_by: null, accepted_at: null })
const title = (n: number) => `Tenets v${String(n)}`

beforeEach(() => { resetFetchApi() })

describe('a tenets version as a document', () => {
  it('projects its record as Markdown: the summary, then each tenet with what it cites as code', () => {
    expect(tenetsMarkdown(V2, LABELS)).toBe(
      '### Keep the API (`api-compat`)\n\nNever break it, nor its codes.\n\n### Test fixes (`tests`)\n\nAlways.\n\nCites: `src/a.py:12`\n')
    expect(tenetsMarkdown(V1, LABELS)).toMatch(/^## Summary\n\nWhat we value\.\n\n### Keep the API/u)
  })

  it('compares by tenet id: changed (and which fields), added, then removed', () => {
    expect(tenetsChanges(V1, V2).map((change) => [change.kind, change.tenet.id])).toStrictEqual(
      [['changed', 'api-compat'], ['added', 'tests'], ['removed', 'tabs']])
    expect(tenetsChanges(V1, V2)[0]).toMatchObject({ fields: ['statement'] })
    expect(tenetsChanges(null, V1).map((change) => change.kind)).toStrictEqual(['added', 'added'])
  })

  it('is compared with the version it was drafted on, else the accepted one, never itself', () => {
    const drafted = parseTenetsVersion(version(2, 'draft', 1)).version
    const unbased = parseTenetsVersion(version(2, 'draft')).version
    expect([comparedWith(drafted, head(null)), comparedWith(unbased, head(1)), comparedWith(unbased, head(2)), comparedWith(unbased, head(null))])
      .toStrictEqual([1, 1, null, null])
  })

  it('is never edited: a draft is decided on, a decided version stays', () => {
    expect(['draft', 'accepted', 'rejected'].map((status) => tenetsAdapter('storefront', status, title, LABELS).permissions.edit))
      .toStrictEqual(['proposalOnly', 'decided', 'decided'])
    expect(tenetsAdapter('storefront', 'draft', title, LABELS)).toMatchObject({ contentType: 'markdown', policy: 'model' })
  })

  it('reads the version again, and one gone as none', async () => {
    const stored = tenetsDocumentOf('storefront', parseTenetsVersion(version(2, 'draft')).version, title(2), LABELS)
    const adapter = tenetsAdapter('storefront', 'draft', title, LABELS)
    routeFetchApi({ 'GET /agents/engineering/tenets/storefront/versions/2': () => version(2, 'accepted') })
    expect((await adapter.load(stored))?.version.status).toBe('accepted')
    routeFetchApi({ 'GET /agents/engineering/tenets/storefront/versions/2': () => { throw new ApiError(404, 'no such version') } })
    expect(await adapter.load(stored)).toBeUndefined()
  })
})

describe('a decision on a draft (gap P)', () => {
  it('names the accepted version the screen showed (0 for none), and the reason only when given', () => {
    expect([tenetsDecisionBody(head(3), '  Too vague.  '), tenetsDecisionBody(head(null), ' ')]).toStrictEqual(
      [{ expected_accepted: 3, reason: 'Too vague.' }, { expected_accepted: 0 }])
  })

  it('reads a 409 as "read it again", anything else as not', () => {
    expect([new ApiError(409, 'the accepted version was 1 and is 2 now: read it again'), new ApiError(400, 'no')].map(isTenetsStale))
      .toStrictEqual([true, false])
  })
})
