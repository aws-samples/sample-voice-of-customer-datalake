/** The Administration navigation model: six tabs and their sections, read from the path's tab and section. */
import { describe, expect, it } from 'vitest'
import { resolveAdminLocation, visibleSections, visibleTabs } from './adminTabs'
import type { AdminTabId } from './adminTabs'

describe('resolveAdminLocation', () => {
  it.each([
    ['brand', 'brand', null],
    ['ai', 'ai', null],
    ['plugins', 'brand', null],
    ['categories', 'brand', null],
  ])('reads the tab %s as %s / %s (an id of before 5.09 is no tab any longer)', (tab, expectedTab, section) => {
    expect(resolveAdminLocation(tab, null, true, false)).toStrictEqual({ tab: expectedTab, section })
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
  ])('resolves /admin/%s/%s to %s / %s', (tab, section, expectedTab, expectedSection) => {
    expect(resolveAdminLocation(tab, section, true, false)).toStrictEqual({ tab: expectedTab, section: expectedSection })
  })

  it.each([null, 'mcp', 'nope'])('falls back to General for the tab %s', (tab) => {
    expect(resolveAdminLocation(tab, null, true, false)).toStrictEqual({ tab: 'brand', section: null })
  })

  it.each([
    ['access', 'users', 'brand', null],
    ['sources', null, 'sources', 'plugins'],
    ['system', 'version', 'system', 'logs'],
    ['sources', 'radar', 'sources', 'plugins'],
    ['sources', 'inbox', 'sources', 'plugins'],
    ['taxonomy', 'dimensions', 'taxonomy', 'categories'],
    ['access', 'boards', 'brand', null],
  ])('keeps a non-admin off admin-only /admin/%s/%s (→ %s / %s)', (tab, section, expectedTab, expectedSection) => {
    expect(resolveAdminLocation(tab, section, false, false)).toStrictEqual({ tab: expectedTab, section: expectedSection })
  })
})

describe('visibility', () => {
  it('shows admins all six tabs, platform admin or not', () => {
    expect([visibleTabs(true, false), visibleTabs(true, true)]).toStrictEqual([
      ['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'], ['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'],
    ])
  })

  it('hides Privacy & access, whose sections are all admin-only, from a non-admin', () => {
    expect(visibleTabs(false, false)).toStrictEqual(['brand', 'sources', 'taxonomy', 'ai', 'system'])
  })

  it('leaves a non-admin one open section per sectioned tab', () => {
    const sections: readonly AdminTabId[] = ['sources', 'taxonomy', 'system']
    expect(sections.map((tab) => visibleSections(tab, false, false))).toStrictEqual([['plugins'], ['categories'], ['logs']])
  })
})

describe('Privacy & access', () => {
  it('lists Boards after Source policies and Users, for admins only', () => {
    expect([visibleSections('access', true, false), visibleSections('access', false, false)])
      .toStrictEqual([['policies', 'users', 'boards'], []])
  })

  it('adds Workspaces, the platform console, for a platform admin only (an administrator in platform-admins)', () => {
    expect([visibleSections('access', true, true), visibleSections('access', false, true)])
      .toStrictEqual([['policies', 'users', 'boards', 'workspaces'], []])
  })

  it('sends a deep link to Workspaces back to the tab\'s first section for anyone else', () => {
    expect([resolveAdminLocation('access', 'workspaces', true, true), resolveAdminLocation('access', 'workspaces', true, false)])
      .toStrictEqual([{ tab: 'access', section: 'workspaces' }, { tab: 'access', section: 'policies' }])
  })
})
