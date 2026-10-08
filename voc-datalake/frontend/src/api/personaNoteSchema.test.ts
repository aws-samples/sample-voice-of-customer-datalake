import { describe, it, expect, vi, beforeEach } from 'vitest'

const m = vi.hoisted(() => ({ fetchApi: vi.fn() }))
vi.mock('./client', () => ({ fetchApi: m.fetchApi }))

import { normalizeAddPersonaNoteResponse } from './personaNoteSchema'
import { projectsApi } from './projectsApi'

describe('normalizeAddPersonaNoteResponse', () => {
  it('keeps the note fields the route returns', () => {
    expect(normalizeAddPersonaNoteResponse({
      success: true,
      note: { note_id: 'note_1', text: 'Insight', author: 'alice', created_at: '2026-01-01T00:00:00Z', tags: [] },
    })).toStrictEqual({
      success: true,
      note: { note_id: 'note_1', text: 'Insight', author: 'alice', created_at: '2026-01-01T00:00:00Z' },
    })
  })

  it('degrades malformed fields instead of throwing', () => {
    // The caught field comes back as an explicit `undefined` ("not readable").
    expect(normalizeAddPersonaNoteResponse({ success: 'yes', note: { note_id: 7 } })).toStrictEqual({
      success: false,
      note: { note_id: undefined },
    })
  })

  it('answers success false for a non-object body', () => {
    expect(normalizeAddPersonaNoteResponse(null)).toStrictEqual({ success: false })
  })
})

describe('projectsApi.addPersonaNote', () => {
  beforeEach(() => {
    m.fetchApi.mockReset()
  })

  it('POSTs the note to the persona notes route and normalises the reply', async () => {
    m.fetchApi.mockResolvedValue({ success: true, note: { note_id: 'note_1' } })

    const result = await projectsApi.addPersonaNote('proj_1', 'p1', { text: 'Insight', author: 'alice' })

    expect(m.fetchApi).toHaveBeenCalledWith('/projects/proj_1/personas/p1/notes', {
      method: 'POST',
      body: JSON.stringify({ text: 'Insight', author: 'alice' }),
    })
    expect(result.note?.note_id).toBe('note_1')
  })
})
