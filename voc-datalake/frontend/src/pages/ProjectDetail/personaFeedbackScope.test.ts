/**
 * @fileoverview Tests for the shared persona feedback-scope mapping.
 */
import { describe, it, expect } from 'vitest'
import { personaFeedbackScope, personaFeedbackScopeKey } from './personaFeedbackScope'
import { defaultContextConfig } from '../../components/DataSourceWizard/exports'

describe('personaFeedbackScope', () => {
  it('maps the wizard context to the persona request scope', () => {
    expect(personaFeedbackScope({
      ...defaultContextConfig,
      sources: ['webscraper'],
      categories: ['billing'],
      sentiments: ['negative'],
      days: 90,
      feedback: { ...defaultContextConfig.feedback, customFields: { tier: ['Gold'] } },
    })).toStrictEqual({
      sources: ['webscraper'],
      categories: ['billing'],
      sentiments: ['negative'],
      days: 90,
      extraFilters: { cf_tier: ['Gold'] },
    })
  })
})

describe('personaFeedbackScopeKey', () => {
  it('gives the same key when only the selection order differs', () => {
    const a = { ...defaultContextConfig, sources: ['a', 'b'], sentiments: ['negative', 'mixed'] }
    const b = { ...defaultContextConfig, sources: ['b', 'a'], sentiments: ['mixed', 'negative'] }

    expect(personaFeedbackScopeKey(a)).toBe(personaFeedbackScopeKey(b))
  })

  it('gives a different key when the scope differs', () => {
    expect(personaFeedbackScopeKey({ ...defaultContextConfig, days: 30 }))
      .not.toBe(personaFeedbackScopeKey({ ...defaultContextConfig, days: 90 }))
    expect(personaFeedbackScopeKey(defaultContextConfig)).not.toBe(personaFeedbackScopeKey({
      ...defaultContextConfig, feedback: { ...defaultContextConfig.feedback, urgentOnly: true },
    }))
  })

  it('ignores toggles that do not scope the feedback', () => {
    expect(personaFeedbackScopeKey(defaultContextConfig))
      .toBe(personaFeedbackScopeKey({ ...defaultContextConfig, usePersonas: true, selectedPersonaIds: ['p1'] }))
  })
})
