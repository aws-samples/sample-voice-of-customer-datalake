/**
 * @fileoverview When the per-user start page applies: opening the app, not a
 * click on the sidebar's Home link.
 */
import { describe, it, expect } from 'vitest'
import { LANDING_STATE, isLanding } from './landing'

describe('isLanding', () => {
  it.each([
    ['the first entry of the tab (fresh load or typed URL)', { key: 'default', state: null }, true],
    ['the redirect after sign-in', { key: 'k1', state: LANDING_STATE }, true],
    ['a click on the Home link', { key: 'k2', state: null }, false],
    ['another page state', { key: 'k3', state: { from: '/' } }, false],
    ['a landing mark that is not exactly true', { key: 'k4', state: { landing: 'yes' } }, false],
  ])('%s → %s', (_case, location, expected) => {
    expect(isLanding(location)).toBe(expected)
  })
})
