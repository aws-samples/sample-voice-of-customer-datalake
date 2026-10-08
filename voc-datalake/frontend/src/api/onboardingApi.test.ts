/**
 * @fileoverview The onboarding preference boundary: drift reads as the
 * first-run default, never as "hidden".
 */
import { describe, it, expect } from 'vitest'
import { DEFAULT_ONBOARDING, normalizeOnboarding } from './onboardingApi'

describe('normalizeOnboarding', () => {
  it('keeps a well-formed answer', () => {
    const raw = {
      state: 'hidden', hidden_until: '2026-10-07T12:00:00+00:00', updated_at: '2026-10-06T12:00:00+00:00', visible: false,
      start_page: 'dashboard', signals: { feedback_present: true, feedback_form_configured: false },
    }
    expect(normalizeOnboarding(raw)).toStrictEqual(raw)
  })

  it('defaults to shown with nothing done, opening on Home', () => {
    // The optional fields are absent, not present-and-undefined.
    expect(DEFAULT_ONBOARDING).toStrictEqual({
      state: 'active', visible: true, start_page: 'home', signals: { feedback_present: false, feedback_form_configured: false },
    })
  })

  it('reads an unknown start page as Home (an older server sends none)', () => {
    expect([normalizeOnboarding({ start_page: 'projects' }).start_page, normalizeOnboarding({ state: 'active' }).start_page])
      .toStrictEqual(['home', 'home'])
  })

  it.each([[null], ['x'], [[]], [{}]])('reads %j as the default', (raw) => {
    expect(normalizeOnboarding(raw)).toStrictEqual(DEFAULT_ONBOARDING)
  })

  it('defaults each drifted field on its own', () => {
    expect(normalizeOnboarding({ state: 'gone', visible: 'no', signals: { feedback_present: 1 } })).toMatchObject({
      state: 'active', visible: true, signals: { feedback_present: false, feedback_form_configured: false },
    })
  })
})
