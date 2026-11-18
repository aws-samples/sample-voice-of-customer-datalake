/**
 * The gate brief's adapter contract (§6.4 [52] step 5; gap N) — the one the Registry's Quality gates and the flow
 * editor's gate inspector share: the owner's Markdown read on the `stored` policy, read only as the template's, named
 * by its digest, its text read on its own (`GET …/gates/briefs/<id>`), a brief this release lacks read as none; and the
 * Registry's addresses, the gates filter and a brief's own page among them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { defined } from '@test/defined'
import { ApiError } from '../../../lib/errors'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { briefFileName, gateBriefAdapter, gateBriefDocumentOf } = await import('./gateBriefAdapter')
const { filterOf, gateBriefPath, readRegistryAddress, registryCardPath, registryPath } = await import('./registryPaths')
const { parseBriefText, parseGates } = await import('../../../api/engineeringRegistryApi')

const BRIEF = { id: 'python-ts', path: 'gates/briefs/python-ts.md', packs: ['python', 'typescript'], digest: 'sha256:b', bytes: 45_627,
  text: '## Python\n\nInstall with uv.\n' }
const BRIEF_PATH = 'GET /agents/engineering/gates/briefs/python-ts'

beforeEach(() => { resetFetchApi() })

describe('a gate brief as a document', () => {
  it('reads the owner\'s Markdown, read only as the template\'s', () => {
    expect(gateBriefAdapter('python-ts')).toMatchObject({ contentType: 'markdown', policy: 'stored',
      permissions: { edit: 'managedByTemplate' } })
  })

  it('is its file name, named by its digest, and its text read on its own', async () => {
    const adapter = gateBriefAdapter('python-ts')
    routeFetchApi({ [BRIEF_PATH]: () => BRIEF })
    const stored = defined(await adapter.load(gateBriefDocumentOf(parseBriefText(BRIEF))), 'brief')
    expect([stored.title, stored.content, adapter.versionOf(stored)]).toStrictEqual(['python-ts.md', BRIEF.text, { token: 'sha256:b' }])
    expect(fetchApi).toHaveBeenCalledWith('/agents/engineering/gates/briefs/python-ts', undefined)
  })

  it('reads a brief this release lacks as none, and a brief without its text as unreadable', async () => {
    routeFetchApi({ [BRIEF_PATH]: () => { throw new ApiError(404, 'no gate brief python-ts') } })
    expect(await gateBriefAdapter('python-ts').load(gateBriefDocumentOf(parseBriefText(BRIEF)))).toBeUndefined()
    expect(() => parseBriefText({ ...BRIEF, text: undefined })).toThrow('The gate brief answer was unreadable')
  })

  it('is listed by the quality gates without its text (gap N), and named by its file', () => {
    const gates = parseGates({ packs: [], briefs: [{ ...BRIEF, text: undefined }], connection: '' })
    expect(gates.briefs).toStrictEqual([{ id: 'python-ts', path: BRIEF.path, packs: BRIEF.packs, digest: 'sha256:b', bytes: 45_627 }])
    expect(briefFileName('gates/briefs/java.md', 'java')).toBe('java.md')
  })
})

describe('the Registry\'s addresses', () => {
  it('names the cards, the quality gates filter, a brief\'s page and a card as paths', () => {
    expect([registryPath({ view: 'cards' }), registryPath({ view: 'gates' }), gateBriefPath('python-ts'), registryCardPath('fixer-careful')])
      .toStrictEqual(['/agents/registry', '/agents/registry/gates', '/agents/registry/gates/briefs/python-ts', '/agents/registry/fixer-careful'])
  })

  it('reads each place from its path, the scope kept in the query', () => {
    expect(['/agents/registry', '/agents/registry/gates', '/agents/registry/gates/briefs/java', '/agents/registry/fixer']
      .map((pathname) => readRegistryAddress({ pathname, search: '?connection=storefront' })?.place)).toStrictEqual([
      { view: 'cards' }, { view: 'gates' }, { view: 'brief', brief: 'java' }, { view: 'card', card: 'fixer' }])
  })

  it('replaces an address it does not name with the nearest place, in place, and leaves another page alone', () => {
    expect(['/agents/registry/gates/x', '/agents/registry/Fixer', '/agents/registry/fixer/extra']
      .map((pathname) => readRegistryAddress({ pathname, search: '?connection=a' })?.replaceWith)).toStrictEqual([
      { pathname: '/agents/registry/gates', search: '?connection=a' }, { pathname: '/agents/registry', search: '?connection=a' },
      { pathname: '/agents/registry/fixer', search: '?connection=a' }])
    expect(readRegistryAddress({ pathname: '/agents/registryx', search: '' })).toBeNull()
  })

  it('puts a card under the cards filter and a brief under the gates', () => {
    expect([filterOf({ view: 'card', card: 'fixer' }), filterOf({ view: 'brief', brief: 'java' })]).toStrictEqual(['cards', 'gates'])
  })
})
