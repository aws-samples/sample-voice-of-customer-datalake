/** The Administration navigation model: six tabs, sections, and every pre-5.09 `?tab=` id. */
import { describe, expect, it } from 'vitest'
import { canonicalSearch, resolveAdminLocation, visibleSections, visibleTabs } from './adminTabs'
import type { AdminTabId } from './adminTabs'

describe('resolveAdminLocation', () => {
  it.each([
    ['brand', 'brand', null],
    ['plugins', 'sources', 'plugins'],
    ['integrations', 'sources', 'integrations'],
    ['radar', 'sources', 'radar'],
    ['categories', 'taxonomy', 'categories'],
    ['dimensions', 'taxonomy', 'dimensions'],
    ['users', 'access', 'users'],
    ['ai', 'ai', null],
    ['logs', 'system', 'logs'],
    ['version', 'system', 'version'],
  ])('maps the pre-5.09 ?tab=%s to %s / %s', (old, tab, section) => {
    expect(resolveAdminLocation(old, null, true)).toStrictEqual({ tab, section })
  })

  it.each([
    ['sources', 'inbox', 'sources', 'inbox'],
    ['sources', 'plugins', 'sources', 'plugins'],
    ['sources', null, 'sources', 'plugins'],
    ['sources', 'policies', 'sources', 'plugins'],
    ['sources', 'nope', 'sources', 'plugins'],
    ['taxonomy', 'dimensions', 'taxonomy', 'dimensions'],
    ['access', 'users', 'access', 'users'],
    ['access', 'boards', 'access', 'boards'],
    ['access', null, 'access', 'policies'],
    ['system', null, 'system', 'logs'],
    ['system', 'users', 'system', 'logs'],
  ])('resolves the new ?tab=%s&section=%s to %s / %s', (tab, section, expectedTab, expectedSection) => {
    expect(resolveAdminLocation(tab, section, true)).toStrictEqual({ tab: expectedTab, section: expectedSection })
  })

  it.each([null, 'mcp', 'nope'])('falls back to General for ?tab=%s', (tab) => {
    expect(resolveAdminLocation(tab, null, true)).toStrictEqual({ tab: 'brand', section: null })
  })

  it.each([
    ['users', null, 'brand', null],
    ['sources', null, 'sources', 'plugins'],
    ['version', null, 'system', 'logs'],
    ['radar', null, 'sources', 'plugins'],
    ['sources', 'inbox', 'sources', 'plugins'],
    ['dimensions', null, 'taxonomy', 'categories'],
    ['access', 'boards', 'brand', null],
  ])('keeps a non-admin off admin-only ?tab=%s&section=%s (→ %s / %s)', (tab, section, expectedTab, expectedSection) => {
    expect(resolveAdminLocation(tab, section, false)).toStrictEqual({ tab: expectedTab, section: expectedSection })
  })
})

describe('visibility', () => {
  it('shows admins all six tabs', () => {
    expect(visibleTabs(true)).toStrictEqual(['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'])
  })

  it('hides Privacy & access, whose sections are all admin-only, from a non-admin', () => {
    expect(visibleTabs(false)).toStrictEqual(['brand', 'sources', 'taxonomy', 'ai', 'system'])
  })

  it('leaves a non-admin one open section per sectioned tab', () => {
    const sections: readonly AdminTabId[] = ['sources', 'taxonomy', 'system']
    expect(sections.map((tab) => visibleSections(tab, false))).toStrictEqual([['plugins'], ['categories'], ['logs']])
  })
})

describe('Privacy & access', () => {
  it('lists Boards after Source policies and Users, for admins only', () => {
    expect([visibleSections('access', true), visibleSections('access', false)])
      .toStrictEqual([['policies', 'users', 'boards'], []])
  })
})

describe('canonicalSearch', () => {
  it('names the section only for a tab that has one', () => {
    expect([
      canonicalSearch({ tab: 'brand', section: null }),
      canonicalSearch({ tab: 'system', section: 'version' }),
    ]).toStrictEqual(['tab=brand', 'tab=system&section=version'])
  })
})
