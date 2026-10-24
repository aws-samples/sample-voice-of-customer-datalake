/**
 * @fileoverview Wire boundaries of the memory, company-context, design-system
 * and user-flag APIs: lenient normalizers (a drifted row costs itself, never the
 * list), the PUT bodies the SPA sends, and the routes each call hits.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'

const fetchApi = vi.fn<(endpoint: string, options?: RequestInit) => Promise<unknown>>()
vi.mock('./client', () => ({ fetchApi: (endpoint: string, options?: RequestInit) => fetchApi(endpoint, options) }))

const { memoryApi, memoryListQuery, normalizeMemoryPage, normalizeReview, resolveRequest } = await import('./memoryApi')
const { companyContextBody, myContextBody, normalizeCompanyContext, normalizeMyContext } = await import('./companyContextApi')
const { designSystemApi, isPaintableColor, normalizeCreatedReference, normalizeDesignSystem, normalizeIntegrations, uploadRejection } = await import('./designSystemApi')
const { readUserFlags, userFlagsApi } = await import('./userFlagsApi')

beforeEach(() => {
  fetchApi.mockReset()
})

describe('memoryApi normalizers', () => {
  it('keeps good rows, drops junk and defaults a sparse legacy row', () => {
    const page = normalizeMemoryPage({
      items: [{ memory_id: 'm1', statement: 'Legacy' }, 'junk', { statement: 'no id' }],
      next_cursor: 'c2',
    })
    expect(page.items.map((m) => m.memory_id)).toStrictEqual(['m1'])
    expect(page.items[0]).toMatchObject({ status: 'proposed', kind: 'other', supporters: 0, retention: 'decay', tombstoned: false })
    expect(page.next_cursor).toBe('c2')
  })

  it('reads supporters stored as a string and never negative', () => {
    const page = normalizeMemoryPage({ items: [{ memory_id: 'a', supporters: '3' }, { memory_id: 'b', supporters: -2 }] })
    expect(page.items.map((m) => m.supporters)).toStrictEqual([3, 0])
  })

  it('reads a malformed page as empty', () => {
    expect(normalizeMemoryPage('nope')).toStrictEqual({ items: [] })
  })

  it('keeps review entries with their conflicts and drops a bad suggestion', () => {
    const entries = normalizeReview({ items: [
      { memory: { memory_id: 'new' }, conflicts: [{ memory_id: 'old', supporters: 6 }], aligned_objectives: ['NPS'], suggested_resolution: { action: 'nonsense' } },
      { memory: 'broken' },
    ] })
    expect(entries).toHaveLength(1)
    expect(entries[0]?.conflicts[0]?.supporters).toBe(6)
    expect(entries[0]?.suggested_resolution).toBeUndefined()
  })
})

describe('memoryApi requests', () => {
  it('builds the list query and omits empty filters', () => {
    expect(memoryListQuery({ scope: 'company', q: '  late ', status: 'active' })).toBe('scope=company&status=active&q=late')
    expect(memoryListQuery({ scope: 'personal', q: '' })).toBe('scope=personal')
  })

  it.each([
    ['keep', { action: 'keep', winner_id: 'new' }],
    // "Keep the existing one": the server's keep with the other side winning (its
    // own replace keeps the REVIEWED item — see resolveRequest).
    ['replace', { action: 'keep', winner_id: 'old' }],
    ['merge', { action: 'merge', statement: 'Both true' }],
    ['keep_both', { action: 'keep_both' }],
  ] as const)('shapes the %s resolution', (action, expected) => {
    expect(resolveRequest(action, { memory_id: 'new' }, { memory_id: 'old' }, '  Both true ')).toStrictEqual(expected)
  })

  it('turns a bare 202 import answer into a queued record', async () => {
    fetchApi.mockResolvedValue({ import_id: 'imp_1' })
    const record = await memoryApi.createImport({ title: 'Blog', content: 'text' })
    expect(record).toMatchObject({ import_id: 'imp_1', title: 'Blog', status: 'queued' })
    expect(fetchApi).toHaveBeenCalledWith('/memory/imports', { method: 'POST', body: JSON.stringify({ title: 'Blog', content: 'text' }) })
  })

  it('posts forget to the item route with the id encoded', async () => {
    fetchApi.mockResolvedValue({ memory: { memory_id: 'a/b', status: 'archived' } })
    const item = await memoryApi.forget('a/b')
    expect(fetchApi).toHaveBeenCalledWith('/memory/a%2Fb/forget', { method: 'POST' })
    expect(item?.status).toBe('archived')
  })
})

describe('companyContextApi', () => {
  it('normalizes objectives and drops rows without an id', () => {
    const context = normalizeCompanyContext({ vision: '# V', objectives: [{ id: 'o1', title: 'T', horizon: 'weird' }, { title: 'no id' }] })
    expect(context.objectives).toStrictEqual([{ id: 'o1', title: 'T', description: '', horizon: 'long' }])
  })

  it('sends only titled objectives, and `due` only for dated ones', () => {
    const body = companyContextBody({ vision: 'v', objectives: [
      { id: 'a', title: ' Grow ', description: '', horizon: 'quarter', due: '2027-01-01' },
      { id: 'b', title: 'Ship', description: '', horizon: 'date', due: '2027-01-01' },
      { id: 'c', title: '  ', description: '', horizon: 'long', due: undefined },
    ] })
    expect(body.objectives).toStrictEqual([
      { id: 'a', title: 'Grow', description: '', horizon: 'quarter' },
      { id: 'b', title: 'Ship', description: '', horizon: 'date', due: '2027-01-01' },
    ])
  })

  it('reads numeric KPI targets as text and drops unnamed KPIs on save', () => {
    const context = normalizeMyContext({ objectives: [{ id: 'p', title: 'Mine', kpis: [{ name: 'NPS', target: 50 }, { name: '', target: '1' }] }] })
    expect(context.objectives[0]?.kpis).toStrictEqual([{ name: 'NPS', target: '50' }])
    expect(myContextBody({ objectives: [{ id: 'p', title: 'Mine', description: '', due: undefined, kpis: [{ name: ' ', target: '1', unit: undefined }] }] }).objectives[0]?.kpis).toStrictEqual([])
  })
})

describe('designSystemApi', () => {
  it('defaults a malformed design system and an unknown reference status', () => {
    const ds = normalizeDesignSystem({ references: [{ id: 'r', kind: 'figma', title: 'F', status: '???' }, { id: 'x', kind: 'video' }] })
    expect(ds.references).toStrictEqual([{ id: 'r', kind: 'figma', title: 'F', status: 'pending' }])
    expect(ds.integrations).toStrictEqual({ figma: false, github: false })
  })

  it.each([
    [{ reference: { id: 'r', kind: 'html', title: 'H' }, upload: { url: 'https://s3.example/put', headers: { 'Content-Type': 'text/html' } } }],
    [{ reference: { id: 'r', kind: 'html', title: 'H' }, presigned_url: 'https://s3.example/put', headers: { 'Content-Type': 'text/html' } }],
  ])('reads the presigned PUT in either shape', (raw) => {
    expect(normalizeCreatedReference(raw).upload).toStrictEqual({ url: 'https://s3.example/put', headers: { 'Content-Type': 'text/html' } })
  })

  it('rejects wrong types and oversize files per upload kind', () => {
    expect(uploadRejection('screenshot', { type: 'image/gif', size: 1 })).toBe('type')
    expect(uploadRejection('html', { type: 'text/html', size: 3 * 1024 * 1024 })).toBe('size')
    expect(uploadRejection('screenshot', { type: 'image/png', size: 1024 })).toBeNull()
  })

  it.each([['#8e48ff', true], ['rgb(1, 2, 3)', true], ['oklch(60% 0.2 280)', true], ['purple', true], ['url(x)', false], ['red; background: x', false]])(
    'paints %s only when it is a colour value', (value, paintable) => {
      expect(isPaintableColor(value)).toBe(paintable)
    },
  )

  it('reads integrations from the envelope and sends tokens write-only', async () => {
    fetchApi.mockResolvedValue({ integrations: { figma: true } })
    await expect(designSystemApi.saveIntegrations({ figma_token: 't' })).resolves.toStrictEqual({ figma: true, github: false })
    expect(fetchApi).toHaveBeenCalledWith('/settings/design-system/integrations', { method: 'PUT', body: '{"figma_token":"t"}' })
    expect(normalizeIntegrations({ github: true })).toStrictEqual({ figma: false, github: true })
  })
})

describe('userFlagsApi', () => {
  it('reads absent or malformed flags as false', () => {
    expect(readUserFlags({ username: 'a' })).toStrictEqual({ fallback_owner: false, memory_reviewer: false })
    expect(readUserFlags({ flags: { fallback_owner: 'yes', memory_reviewer: true } })).toStrictEqual({ fallback_owner: false, memory_reviewer: true })
  })

  it('PUTs only the changed flag', async () => {
    fetchApi.mockResolvedValue({ flags: { memory_reviewer: true } })
    await userFlagsApi.save('vic viewer', { memory_reviewer: true })
    expect(fetchApi).toHaveBeenCalledWith('/users/vic%20viewer/flags', { method: 'PUT', body: '{"memory_reviewer":true}' })
  })
})
