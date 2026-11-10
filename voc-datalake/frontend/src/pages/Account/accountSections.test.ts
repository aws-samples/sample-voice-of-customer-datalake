/**
 * Account deep links: `?tab=<id>` opens that tab, every 5.09–5.11
 * `?section=<id>` opens the tab that now holds its card, anything else opens
 * Profile, and a non-canonical query is replaced by its canonical `?tab=` form.
 */
import { describe, it, expect } from 'vitest'
import { ACCOUNT_TAB_IDS, accountRedirect, accountTabPath, resolveAccountTab } from './accountSections'

describe('resolveAccountTab', () => {
  it.each(ACCOUNT_TAB_IDS)('?tab=%s opens that tab', (id) => {
    expect(resolveAccountTab(id, null)).toBe(id)
  })

  it.each([
    ['password', 'profile'], ['signout', 'profile'],
    ['assistant', 'preferences'], ['browser', 'preferences'],
    ['mcp', 'access'], ['access', 'access'], ['briefing', 'briefing'], ['objectives', 'objectives'],
  ])('the old ?section=%s opens %s', (section, expected) => {
    expect(resolveAccountTab(null, section)).toBe(expected)
  })

  it.each([
    [null, null], ['nope', null], [null, 'nope'], [null, 'constructor'], [null, 'toString'],
  ])('tab=%s section=%s opens Profile', (tab, section) => {
    expect(resolveAccountTab(tab, section)).toBe('profile')
  })

  it('prefers a valid ?tab= over a ?section=', () => {
    expect(resolveAccountTab('briefing', 'password')).toBe('briefing')
  })
})

describe('accountRedirect', () => {
  it.each([
    [null, null, null],
    ['briefing', null, null],
    [null, 'browser', '?tab=preferences'],
    ['briefing', 'password', '?tab=briefing'],
    ['nope', null, '?tab=profile'],
  ])('tab=%s section=%s redirects to %s', (tab, section, expected) => {
    expect(accountRedirect(tab, section)).toBe(expected)
  })

  it('builds the links Home and the "Go to settings" buttons use', () => {
    expect([accountTabPath('briefing'), accountTabPath('preferences')]).toStrictEqual(['/account?tab=briefing', '/account?tab=preferences'])
  })
})
