/** The Administration navigation model (7.54.00): a home, nine tabs in four groups by frequency, their cards. */
import { describe, expect, it } from 'vitest'
import { ADMIN_GROUPS, resolveAdminLocation, visibleGroups, visibleSections } from './adminTabs'
import { adminPath, adminTabSegment } from './adminPaths'

describe('the groups', () => {
  it('orders the tabs by how often they are needed: Everyday, Regularly, Set up once, Rare', () => {
    expect(ADMIN_GROUPS.map((group) => [group.id, group.tabs])).toStrictEqual([
      ['everyday', ['people', 'sources', 'logs']],
      ['regular', ['categories', 'boards']],
      ['once', ['ai', 'brand']],
      ['rare', ['privacy', 'platform']],
    ])
  })

  it('shows Platform to a platform admin only', () => {
    expect([visibleGroups(true, true).at(-1)?.tabs, visibleGroups(true, false).at(-1)?.tabs]).toStrictEqual([
      ['privacy', 'platform'], ['privacy'],
    ])
  })

  it('leaves a non-admin Data sources, Logs, Categories, AI models and Brand & appearance', () => {
    expect(visibleGroups(false, false)).toStrictEqual([
      { id: 'everyday', tabs: ['sources', 'logs'] }, { id: 'regular', tabs: ['categories'] }, { id: 'once', tabs: ['ai', 'brand'] },
    ])
  })
})

describe('the cards a path may name', () => {
  it.each([
    ['sources', ['inbox', 'radar', 'tokens'], []],
    ['categories', ['dimensions'], []],
    ['boards', ['domains', 'participants'], []],
    ['brand', ['theme'], ['theme']],
    ['privacy', ['erasure'], []],
    ['people', [], []],
  ] as const)('%s: %o for an admin, %o for anyone else', (tab, admin, others) => {
    expect([visibleSections(tab, true, false), visibleSections(tab, false, false)]).toStrictEqual([admin, others])
  })

  it('gives the deployment brand of Platform to a platform admin only', () => {
    expect([visibleSections('platform', true, true), visibleSections('platform', true, false)]).toStrictEqual([['deployment-brand'], []])
  })
})

describe('resolveAdminLocation', () => {
  it.each([
    [null, null, { tab: null, section: null }],
    ['people', null, { tab: 'people', section: null }],
    ['categories', 'dimensions', { tab: 'categories', section: 'dimensions' }],
    ['categories', 'nope', { tab: 'categories', section: null }],
    ['brand', 'radar', { tab: 'brand', section: null }],
  ])('reads /admin/%s/%s as %o', (tab, section, expected) => {
    expect(resolveAdminLocation(tab, section, true, false)).toStrictEqual(expected)
  })

  it.each(['access', 'taxonomy', 'system', 'data-sources', 'general', 'nope'])('opens the home for %s, no alias', (tab) => {
    expect(resolveAdminLocation(tab, 'users', true, true)).toStrictEqual({ tab: null, section: null })
  })
})

describe('paths', () => {
  it.each([
    [{ tab: null, section: null }, null, '/admin'],
    [{ tab: 'people', section: null }, null, '/admin/people'],
    [{ tab: 'people', section: null }, 'invite', '/admin/people/invite'],
    [{ tab: 'boards', section: null }, 'brd_sales', '/admin/boards/brd_sales'],
    [{ tab: 'boards', section: 'domains' }, 'brd_sales', '/admin/boards/domains'],
    [{ tab: 'logs', section: null }, 'nothing-open-on-logs', '/admin/logs'],
  ] as const)('%o with %s is %s', (location, item, path) => {
    expect(adminPath(location, item)).toBe(path)
  })

  it('reads the tab segment ("" for the home, null outside)', () => {
    expect([adminTabSegment('/admin'), adminTabSegment('/admin/people/u-1'), adminTabSegment('/administration')])
      .toStrictEqual(['', 'people', null])
  })
})
