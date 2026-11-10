import { describe, expect, it } from 'vitest'
import {
  EMPTY_DRAFT, PREFILL_PARAMS, decisionDeepLink, draftFromDecision, draftFromParams, draftToInput, isSubmittable, parseIds,
} from './decisionDraft'
import type { Decision } from '../../../api/decisionSchema'

const DECISION: Decision = {
  documentId: 'd1', title: 'Offline mode', verdict: 'park', rationale: 'Later', successMetric: 'KPI', killCriterion: '',
  feedbackIds: ['fb_1', 'fb_2'], documentIds: ['prd_1'], reviewBy: null, launchedAt: '2026-10-01',
  decidedByName: 'Ana', decidedAt: '2026-10-02', revision: 3, seededPrfaqJobId: null,
}

describe('parseIds', () => {
  it('splits on spaces and commas and de-duplicates', () => {
    expect(parseIds(' fb_1, fb_2 fb_1,,')).toStrictEqual(['fb_1', 'fb_2'])
  })
})

describe('draft round trip', () => {
  it('turns a stored decision into a draft and back into the request body', () => {
    const input = draftToInput(draftFromDecision(DECISION))
    expect(input).toMatchObject({ verdict: 'park', success_metric: 'KPI', review_by: null, launched_at: '2026-10-01' })
    expect(input.evidence).toStrictEqual({ feedback_ids: ['fb_1', 'fb_2'], document_ids: ['prd_1'] })
  })

  it('needs a title and a rationale', () => {
    expect(isSubmittable(EMPTY_DRAFT)).toBe(false)
    expect(isSubmittable({ ...EMPTY_DRAFT, title: 'T', rationale: '  ' })).toBe(false)
    expect(isSubmittable({ ...EMPTY_DRAFT, title: 'T', rationale: 'R' })).toBe(true)
  })
})

describe('decisionDeepLink', () => {
  it('opens the Decisions tab with a prefilled draft that reads back', () => {
    const link = decisionDeepLink('proj 1', { title: 'Fix login', verdict: 'reject', feedbackIds: ['fb_1', 'fb_2'] })
    const [path, query] = link.split('?')
    expect(path).toBe('/projects/proj%201')
    const params = new URLSearchParams(query)
    expect(params.get('tab')).toBe('decisions')
    expect(draftFromParams(params)).toMatchObject({ title: 'Fix login', verdict: 'reject', feedbackIds: 'fb_1 fb_2' })
  })

  it('only opens the editor when the link asks for it, and falls back on an unknown verdict', () => {
    expect(draftFromParams(new URLSearchParams('title=x'))).toBeNull()
    expect(draftFromParams(new URLSearchParams('newDecision=1&verdict=maybe'))?.verdict).toBe('pursue')
  })

  it('lists every parameter it writes, so the page can drop them', () => {
    const params = new URLSearchParams(decisionDeepLink('p', { title: 't', verdict: 'park', rationale: 'r', feedbackIds: ['f'] }).split('?')[1])
    const written = [...params.keys()].filter((key) => key !== 'tab')
    expect(written.every((key) => PREFILL_PARAMS.some((name) => name === key))).toBe(true)
  })
})
