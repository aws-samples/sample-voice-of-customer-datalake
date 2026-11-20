/** The Administration navigation model (7.59.00): main's six tabs in main's order, the two new ones before System. */
import { describe, expect, it } from 'vitest'
import { cardsOf, hasSections, resolveAdminLocation, sectionOfCard, visibleSections, visibleTabs } from './adminTabs'
import type { AdminViewer } from './adminTabs'
import { adminPath, adminTabSegment } from './adminPaths'

const viewer = (over: Partial<AdminViewer> = {}): AdminViewer => ({
  isAdmin: true, isPlatformAdmin: false, inWorkspace: false, agentsShown: false, ...over,
})
const EVERYONE = viewer({ isPlatformAdmin: true, inWorkspace: true, agentsShown: true })

describe('the tabs', () => {
  it("keeps main's tabs and order, and adds Workspaces and Engineering agents before System", () => {
    expect(visibleTabs(EVERYONE)).toStrictEqual(['general', 'sources', 'taxonomy', 'access', 'ai', 'workspaces', 'agents', 'system'])
  })

  it("shows a plain administrator outside a workspace main's six", () => {
    expect(visibleTabs(viewer())).toStrictEqual(['general', 'sources', 'taxonomy', 'access', 'ai', 'system'])
  })

  it('shows Workspaces inside a workspace or to a platform admin, Engineering agents while Agents is on', () => {
    expect([visibleTabs(viewer({ inWorkspace: true })).includes('workspaces'), visibleTabs(viewer({ isPlatformAdmin: true })).includes('workspaces'),
      visibleTabs(viewer({ agentsShown: true })).includes('agents')]).toStrictEqual([true, true, true])
  })

  it('leaves anyone else General, Sources, Taxonomy, AI models and System', () => {
    expect(visibleTabs(viewer({ isAdmin: false, isPlatformAdmin: true, inWorkspace: true, agentsShown: true })))
      .toStrictEqual(['general', 'sources', 'taxonomy', 'ai', 'system'])
  })
})

describe('the sections', () => {
  it.each([
    ['sources', ['plugins', 'integrations', 'inbox', 'radar'], ['plugins']],
    ['taxonomy', ['categories', 'dimensions'], ['categories']],
    ['access', ['policies', 'users', 'boards'], []],
    ['system', ['logs', 'version'], ['logs']],
    ['general', [], []],
  ] as const)('%s: %o for an administrator, %o for anyone else', (tab, admin, others) => {
    expect([visibleSections(tab, viewer()), visibleSections(tab, viewer({ isAdmin: false }))]).toStrictEqual([admin, others])
  })

  it("gives Workspaces this workspace's settings and members inside one, every workspace to a platform admin", () => {
    expect([visibleSections('workspaces', EVERYONE), visibleSections('workspaces', viewer({ inWorkspace: true })),
      visibleSections('workspaces', viewer({ isPlatformAdmin: true }))]).toStrictEqual([
      ['settings', 'members', 'all', 'deployment-brand'], ['settings', 'members'], ['all', 'deployment-brand'],
    ])
  })

  it('knows which tabs switch sections and where each card is', () => {
    expect([hasSections('general'), hasSections('ai'), hasSections('agents'), hasSections('access')]).toStrictEqual([false, false, false, true])
    expect([cardsOf('general', null), cardsOf('access', 'boards'), cardsOf('agents', null)]).toStrictEqual([
      ['brand', 'theme', 'api'], ['domains', 'participants'], ['hard-cap', 'models', 'connections'],
    ])
    expect([sectionOfCard('access', 'erasure'), sectionOfCard('access', 'participants'), sectionOfCard('general', 'theme')])
      .toStrictEqual(['policies', 'boards', null])
  })
})

describe('resolveAdminLocation', () => {
  it.each([
    [null, null, null, { tab: 'general', section: null, card: null }],
    ['general', null, 'theme', { tab: 'general', section: null, card: 'theme' }],
    ['sources', null, null, { tab: 'sources', section: 'plugins', card: null }],
    ['sources', 'radar', null, { tab: 'sources', section: 'radar', card: null }],
    ['access', 'policies', 'erasure', { tab: 'access', section: 'policies', card: 'erasure' }],
    ['access', 'users', 'erasure', { tab: 'access', section: 'users', card: null }],
    ['taxonomy', 'nope', null, { tab: 'taxonomy', section: 'categories', card: null }],
    ['ai', 'radar', 'theme', { tab: 'ai', section: null, card: null }],
    ['people', null, null, { tab: 'general', section: null, card: null }],
  ])('reads %s / %s #%s as %o', (tab, section, card, expected) => {
    expect(resolveAdminLocation(tab, section, card, viewer())).toStrictEqual(expected)
  })

  it("sends a hidden tab to General and a hidden section to the tab's first", () => {
    expect([resolveAdminLocation('workspaces', 'all', null, viewer()), resolveAdminLocation('sources', 'radar', null, viewer({ isAdmin: false }))])
      .toStrictEqual([{ tab: 'general', section: null, card: null }, { tab: 'sources', section: 'plugins', card: null }])
  })
})

describe('paths', () => {
  it.each([
    [{ tab: 'general' }, '/admin/general'],
    [{ tab: 'general', card: 'theme' }, '/admin/general#theme'],
    [{ tab: 'access', section: 'users', item: 'invite' }, '/admin/access/users/invite'],
    [{ tab: 'access', section: 'boards', item: 'brd_sales' }, '/admin/access/boards/brd_sales'],
    [{ tab: 'access', section: 'boards', card: 'domains' }, '/admin/access/boards#domains'],
    [{ tab: 'system', section: 'logs', item: 'nothing-open-on-logs' }, '/admin/system/logs'],
  ] as const)('%o is %s', (target, path) => {
    expect(adminPath(target)).toBe(path)
  })

  it('reads the tab segment ("" for /admin, null outside)', () => {
    expect([adminTabSegment('/admin'), adminTabSegment('/admin/access/users/u-1'), adminTabSegment('/administration')])
      .toStrictEqual(['', 'access', null])
  })
})
