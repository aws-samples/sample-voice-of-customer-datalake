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
  it('shows admins six tabs, and a platform admin the deployment\'s Data sources after Sources', () => {
    expect([visibleTabs(true, false), visibleTabs(true, true)]).toStrictEqual([
      ['brand', 'sources', 'taxonomy', 'access', 'ai', 'system'],
      ['brand', 'sources', 'data-sources', 'taxonomy', 'access', 'ai', 'system'],
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

describe('Data sources, the deployment\'s (7.50.00)', () => {
  it('opens /admin/data-sources, a page with no section switch, for a platform admin', () => {
    expect(resolveAdminLocation('data-sources', null, true, true)).toStrictEqual({ tab: 'data-sources', section: null })
    expect(visibleSections('data-sources', true, true)).toStrictEqual([])
  })

  it.each([
    ['a plain administrator', true, false],
    ['a non-admin', false, false],
    ['a platform admin outside admins (no Administration at all)', false, true],
  ])('sends %s back to General, and never lists the tab', (_who, isAdmin, isPlatformAdmin) => {
    expect(resolveAdminLocation('data-sources', null, isAdmin, isPlatformAdmin)).toStrictEqual({ tab: 'brand', section: null })
    expect(visibleTabs(isAdmin, isPlatformAdmin)).not.toContain('data-sources')
  })

  it('drops a section named after it, keeping the tab', () => {
    expect(resolveAdminLocation('data-sources', 'plugins', true, true)).toStrictEqual({ tab: 'data-sources', section: null })
  })
})
