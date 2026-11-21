/** The micro-feedback response (7.66.00): ids only, never who answered; the verdict a choice; the text bounded. */
import { describe, expect, it } from 'vitest'
import { MAX_MISSING_CHARS, microFeedbackResponse, feedbackPageOf } from './microFeedbackPayload'

const INPUT = {
  verdict: 'down' as const, missing: '  The PRD missed the pricing feedback  ', action: 'prd' as const,
  pathname: '/projects/p_7f3a/documents/doc_1', appVersion: '7.66.0', workspaceRole: 'editor',
  uiLanguage: 'de-DE', formLanguages: ['en', 'de'],
}

describe('microFeedbackResponse', () => {
  it('sends the verdict, the trimmed text and ids only', () => {
    expect(microFeedbackResponse(INPUT)).toStrictEqual({
      answers: { q_verdict: { code: 'down' }, q_missing: 'The PRD missed the pricing feedback' },
      hidden: { action: 'prd', page: 'projects', app_version: '7.66.0', workspace_role: 'editor' },
      language: 'de',
    })
  })

  it('carries nothing that names the person, the workspace or the document', () => {
    const sent = JSON.stringify(microFeedbackResponse(INPUT))
    for (const leak of ['p_7f3a', 'doc_1', 'sub', 'email', 'user', 'workspace_id', 'http']) expect(sent).not.toContain(leak)
  })

  it('leaves out a blank text and a language the form does not have', () => {
    expect(microFeedbackResponse({ ...INPUT, missing: '   ', uiLanguage: 'ja', workspaceRole: null })).toStrictEqual({
      answers: { q_verdict: { code: 'down' } },
      hidden: { action: 'prd', page: 'projects', app_version: '7.66.0', workspace_role: 'none' },
    })
  })

  it('bounds the text at 500 characters', () => {
    const response = microFeedbackResponse({ ...INPUT, missing: 'x'.repeat(MAX_MISSING_CHARS + 20) })
    expect(response.answers.q_missing).toHaveLength(MAX_MISSING_CHARS)
  })
})

describe('feedbackPageOf', () => {
  it.each([['/', 'home'], ['', 'home'], ['/agents/engineering/run_1', 'agents'], ['/feedback-forms/new', 'feedback-forms'],
    ['/P_1/x', 'other'], ['/ünï', 'other']])('%s is %s', (pathname, page) => {
    expect(feedbackPageOf(pathname)).toBe(page)
  })
})
