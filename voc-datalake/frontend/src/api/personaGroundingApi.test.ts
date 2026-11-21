import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fetchApi, resetFetchApi } from '@test/fetchApiRoutes'
import { personaGroundingApi } from './personaGroundingApi'

vi.mock('./client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

beforeEach(() => {
  resetFetchApi()
})

describe('personaGroundingApi', () => {
  it('reads a persona\'s freshness leniently', async () => {
    fetchApi.mockResolvedValueOnce({ since: '2026-11-18', count: 'x', count_is_lower_bound: true, extra: 1 })
    await expect(personaGroundingApi.getEvidenceFreshness('p 1', 'a/b')).resolves.toStrictEqual({
      since: '2026-11-18', count: 0, count_is_lower_bound: true, refreshed_at: null, updates: 0 })
    expect(fetchApi).toHaveBeenCalledWith('/projects/p%201/personas/a%2Fb/evidence-freshness', undefined)
  })

  it('refreshes a persona\'s evidence with a POST', async () => {
    fetchApi.mockResolvedValueOnce({ success: true, added: 2, evidence_refreshed_at: '2026-11-21T00:00:00Z' })
    await expect(personaGroundingApi.refreshEvidence('p1', 'x')).resolves.toStrictEqual({ added: 2,
      evidence_refreshed_at: '2026-11-21T00:00:00Z' })
    expect(fetchApi).toHaveBeenCalledWith('/projects/p1/personas/x/evidence/refresh', { method: 'POST' })
  })

  it('saves a focus group as its own document type', async () => {
    fetchApi.mockResolvedValueOnce({ success: true, document: { document_id: 'doc_1', document_type: 'focus_group',
      title: 'Focus group', content: 'x', synthetic: true } })
    const derivation = { persona_ids: ['a', 'b'], feedback_ids: ['f1'], document_ids: [], library_item_ids: [], rounds: 2 }
    const saved = await personaGroundingApi.saveFocusGroup('p1', { title: 'Focus group', content: 'x', derivation })
    expect(saved.document).toMatchObject({ document_id: 'doc_1', document_type: 'focus_group', synthetic: true })
    const [path, options] = fetchApi.mock.calls[0] ?? []
    expect([path, JSON.parse(String(options?.body))]).toStrictEqual(['/projects/p1/documents',
      { title: 'Focus group', content: 'x', derivation, document_type: 'focus_group' }])
  })
})
