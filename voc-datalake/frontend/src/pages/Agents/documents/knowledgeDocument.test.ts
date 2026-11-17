/**
 * The knowledge document's adapter contract (§6.4 [52] step 3): one kind of a package version read as agent text (the
 * `model` policy), never edited (an approved version decided, a draft approved or left), named by its package,
 * version and kind, read again (a 404 or a kind the pack lacks: none); which version opens first, which may be
 * approved, and a 409 as "read it again".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { defined } from '@test/defined'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { approvable, isKnowledgeStale, knowledgeAdapter, knowledgeDocumentOf, versionToReview } = await import('./knowledgeDocument')
const { parseKnowledge, parseKnowledgeVersion } = await import('../../../api/engineeringKnowledgeApi')

const version = (number: number, status: string) => ({ package: '.', version: number, status, created_at: '2026-11-16T09:00:00Z' })
const pkg = (approved: number | null, versions: ReturnType<typeof version>[]) =>
  defined(parseKnowledge({ packages: [{ package: '.', segment: '=2E', approved_version: approved, versions }] }).packages[0], 'package')
/** A document the version has (null throws: the spec expects it). */
function present<T>(value: T | null): T {
  if (value === null) throw new Error('the document is missing')
  return value
}
const answer = (number: number) => ({ connection: 'storefront', version: version(number, 'draft'),
  documents: { architecture: `# Architecture v${String(number)}`, glossary: '# Glossary', wizardry: 'dropped' } })

beforeEach(() => { resetFetchApi() })

describe('a knowledge pack\'s document', () => {
  it('reads one kind of the version as agent text, never edited', () => {
    const adapter = knowledgeAdapter('storefront', '=2E', 'architecture', 'draft', 'Architecture')
    expect(adapter).toMatchObject({ contentType: 'markdown', policy: 'model', permissions: { edit: 'proposalOnly' } })
    expect(knowledgeAdapter('storefront', '=2E', 'architecture', 'approved', 'Architecture').permissions.edit).toBe('decided')
  })

  it('keeps only the seven kinds it knows, and says a kind the pack lacks is none', () => {
    const loaded = parseKnowledgeVersion(answer(2))
    expect(Object.keys(loaded.documents)).toStrictEqual(['architecture', 'glossary'])
    expect(knowledgeDocumentOf('storefront', '=2E', loaded, 'ci', 'CI')).toBeNull()
  })

  it('is named by its package, version and kind, and read again through the package\'s path segment', async () => {
    const stored = present(knowledgeDocumentOf('storefront', '=2E', parseKnowledgeVersion(answer(2)), 'architecture', 'Architecture'))
    const adapter = knowledgeAdapter('storefront', '=2E', 'architecture', 'draft', 'Architecture')
    expect(adapter.versionOf(stored)).toStrictEqual({ token: '=2E/v2/architecture', number: 2 })
    routeFetchApi({ 'GET /agents/engineering/knowledge/storefront/%3D2E/versions/2': () => answer(2) })
    expect((await adapter.load(stored))?.content).toBe('# Architecture v2')
    expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/knowledge/storefront/%3D2E/versions/2', undefined)
  })

  it('reads a version gone as none', async () => {
    const stored = present(knowledgeDocumentOf('storefront', '=2E', parseKnowledgeVersion(answer(2)), 'architecture', 'Architecture'))
    routeFetchApi({ 'GET /agents/engineering/knowledge/storefront/%3D2E/versions/2': () => { throw new ApiError(404, 'no such version') } })
    const adapter = knowledgeAdapter('storefront', '=2E', 'architecture', 'draft', 'Architecture')
    expect(await adapter.load(stored)).toBeUndefined()
  })
})

describe('which version is reviewed and approved', () => {
  it('opens the newest draft above the approved version, else the approved one, else the newest', () => {
    expect([
      versionToReview(pkg(1, [version(1, 'approved'), version(2, 'draft')])),
      versionToReview(pkg(2, [version(1, 'draft'), version(2, 'approved')])),
      versionToReview(pkg(null, [version(1, 'draft')])),
    ]).toStrictEqual([2, 2, 1])
  })

  it('approves only a draft above the approved version (the store refuses an older one)', () => {
    const pack = pkg(2, [version(1, 'draft'), version(2, 'approved'), version(3, 'draft')])
    expect(pack.versions.map((each) => approvable(pack, each))).toStrictEqual([false, false, true])
  })

  it('reads a 409 as "read it again"', () => {
    expect([new ApiError(409, 'the version or the approved one changed meanwhile: read it again'), new Error('x')].map(isKnowledgeStale))
      .toStrictEqual([true, false])
  })
})
