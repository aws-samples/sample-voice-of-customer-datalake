/**
 * @fileoverview Administration's place is its address (7.59.00, adminPaths.ts): `/admin/<tab>[/<section>[/<item>]]`,
 * a card the hash; `/admin` opens General; an address that is not the canonical form of where it leads is replaced
 * in place, the query kept: every 7.54.00 address (bookmarks, the backend's links), a section named by the hash, a tab
 * without its section; the query names no place but Source settings' scope; a move is a history entry, so Back walks it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { TestRouter } from '@test/TestRouter'
import { deploymentSourcePath, readAdminAddress } from './adminPaths'
import type { AdminViewer } from './adminTabs'
import { useAdminLocation, useBoardInPath, usePersonInPath, useSourceInPath, useSourceScope } from './useAdminLocation'

// (Source settings' plugins: the cards a path may open)
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [{ id: 'github_issues' }, { id: 'webscraper' }] }))

const ADMIN: AdminViewer = { isAdmin: true, isPlatformAdmin: false, inWorkspace: false, agentsShown: false }
const PLATFORM: AdminViewer = { ...ADMIN, isPlatformAdmin: true, inWorkspace: true }

function mount(entry: string, viewer: AdminViewer = ADMIN) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <TestRouter initialEntries={['/dashboard', entry]} initialIndex={1}>{children}</TestRouter>
  )
  return renderHook(() => {
    const location = useLocation()
    const [boardId, openBoard] = useBoardInPath()
    const [person, openPerson] = usePersonInPath()
    const [scope, setScope] = useSourceScope()
    const { place, selectTab, selectSection } = useAdminLocation(viewer)
    return {
      place, selectTab, selectSection, boardId, openBoard, person, openPerson, scope, setScope, source: useSourceInPath(),
      at: `${location.pathname}${location.search}${location.hash}`, navigate: useNavigate(),
    }
  }, { wrapper })
}

describe('the address names the place', () => {
  it.each([
    ['/admin/general', { tab: 'general', section: null, card: null, item: null }],
    ['/admin/general#theme', { tab: 'general', section: null, card: 'theme', item: null }],
    ['/admin/sources/radar', { tab: 'sources', section: 'radar', card: null, item: null }],
    ['/admin/taxonomy/dimensions', { tab: 'taxonomy', section: 'dimensions', card: null, item: null }],
    ['/admin/access/boards#participants', { tab: 'access', section: 'boards', card: 'participants', item: null }],
    ['/admin/access/policies#erasure', { tab: 'access', section: 'policies', card: 'erasure', item: null }],
    ['/admin/access/users/u-1', { tab: 'access', section: 'users', card: null, item: 'u-1' }],
    ['/admin/ai', { tab: 'ai', section: null, card: null, item: null }],
    ['/admin/system/version', { tab: 'system', section: 'version', card: null, item: null }],
  ])('%s opens %o, as it is', (entry, place) => {
    const { result } = mount(entry)
    expect([result.current.place, result.current.at]).toStrictEqual([place, entry])
  })

  it('opens Workspaces → All workspaces for a platform admin only; anyone else gets General', () => {
    expect(mount('/admin/workspaces/all', PLATFORM).result.current.at).toBe('/admin/workspaces/all')
    expect(mount('/admin/workspaces/all').result.current.at).toBe('/admin/general')
  })

  it('names the board, the person and the source open on their sections', () => {
    expect([mount('/admin/access/boards/brd_sales').result.current.boardId, mount('/admin/access/users/u-1').result.current.person,
      mount('/admin/access/users/invite').result.current.person, mount('/admin/sources/plugins/github_issues').result.current.source])
      .toStrictEqual(['brd_sales', 'u-1', 'invite', 'github_issues'])
  })
})

describe("7.54.00's addresses (bookmarks, in-app and backend links) lead to their new place", () => {
  it.each([
    ['/admin', '/admin/general'],
    ['/admin/people', '/admin/access/users'],
    ['/admin/people/invite', '/admin/access/users/invite'],
    ['/admin/people/u-1?review=r1', '/admin/access/users/u-1?review=r1'],
    ['/admin/sources', '/admin/sources/plugins'],
    ['/admin/sources/github_issues', '/admin/sources/plugins/github_issues'],
    ['/admin/sources/tokens', '/admin/sources/integrations'],
    ['/admin/sources/inbox', '/admin/sources/inbox'],
    ['/admin/logs', '/admin/system/logs'],
    ['/admin/categories', '/admin/taxonomy/categories'],
    ['/admin/categories/dimensions', '/admin/taxonomy/dimensions'],
    ['/admin/boards', '/admin/access/boards'],
    ['/admin/boards/brd_sales', '/admin/access/boards/brd_sales'],
    ['/admin/boards/domains', '/admin/access/boards#domains'],
    ['/admin/boards/participants', '/admin/access/boards#participants'],
    ['/admin/brand', '/admin/general'],
    ['/admin/brand/theme', '/admin/general#theme'],
    ['/admin/privacy', '/admin/access/policies'],
    ['/admin/privacy/erasure', '/admin/access/policies#erasure'],
    ['/admin/version', '/admin/system/version'],
  ])('%s → %s, in place', (entry, expected) => {
    const { result } = mount(entry)
    expect(result.current.at).toBe(expected)
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at, 'no extra history entry').toBe('/dashboard')
  })

  it.each([
    ['/admin/platform', '/admin/workspaces/all'],
    ['/admin/platform/deployment-brand', '/admin/workspaces/deployment-brand'],
    ['/admin/platform/costs', '/admin/workspaces/costs'],
    ['/admin/access/workspaces', '/admin/workspaces/all'],
    ['/admin/data-sources/github_issues', '/admin/sources/plugins/github_issues'],
  ])('%s → %s for a platform admin', (entry, expected) => {
    expect(mount(entry, PLATFORM).result.current.at).toBe(expected)
  })

  it("keeps the readiness fix's link working: the deployment's GitHub Issues card", () => {
    expect(mount('/admin/sources/github_issues?scope=deployment', PLATFORM).result.current.at)
      .toBe('/admin/sources/plugins/github_issues?scope=deployment')
  })
})

describe('an address off its form', () => {
  it.each([
    ['/admin/access#users', '/admin/access/users'],
    ['/admin/access#erasure', '/admin/access/policies#erasure'],
    ['/admin/sources#radar', '/admin/sources/radar'],
    ['/admin/general#nope', '/admin/general'],
    ['/admin/access/users#theme', '/admin/access/users'],
    ['/admin/nope?q=x', '/admin/general?q=x'],
    ['/admin/general/more', '/admin/general'],
    ['/admin/taxonomy/nope', '/admin/taxonomy/categories'],
    ['/admin/system/logs/more', '/admin/system/logs'],
    ['/admin/sources/plugins/nope', '/admin/sources/plugins'],
    ['/admin/access/boards/brd_sales/more', '/admin/access/boards/brd_sales'],
  ])('%s is replaced by %s', (entry, expected) => {
    expect(mount(entry).result.current.at).toBe(expected)
  })

  it('sends anyone else off an admin-only section to what they may see', () => {
    const others: AdminViewer = { ...ADMIN, isAdmin: false }
    expect([mount('/admin/access/boards/brd_sales', others).result.current.at, mount('/admin/taxonomy/dimensions', others).result.current.at,
      mount('/admin/sources/radar', others).result.current.at]).toStrictEqual(['/admin/general', '/admin/taxonomy/categories', '/admin/sources/plugins'])
  })

  it('reads no place from the query: an old ?tab= link is General, the query kept', () => {
    expect(readAdminAddress({ pathname: '/admin/general', search: '?tab=access&section=boards', hash: '' }, ADMIN))
      .toStrictEqual({ place: { tab: 'general', section: null, card: null, item: null }, replaceWith: null })
  })

  it('is no Administration address outside /admin', () => {
    expect(readAdminAddress({ pathname: '/administration', search: '', hash: '' }, ADMIN)).toBeNull()
  })
})

describe("Source settings' scope (?scope=deployment)", () => {
  it("builds the deployment's GitHub Issues card address the readiness fix and the setup guide open", () => {
    expect(deploymentSourcePath('github_issues')).toBe('/admin/sources/plugins/github_issues?scope=deployment')
  })

  it('keeps it for a platform admin, with the card and the rest of the query', () => {
    const { result } = mount('/admin/sources/plugins/github_issues?review=r1&scope=deployment', PLATFORM)
    expect([result.current.scope, result.current.source, result.current.at])
      .toStrictEqual(['deployment', 'github_issues', '/admin/sources/plugins/github_issues?review=r1&scope=deployment'])
  })

  it.each([
    ['a plain administrator', '/admin/sources/plugins?scope=deployment', ADMIN, '/admin/sources/plugins'],
    ['an unknown value', '/admin/sources/plugins?scope=everything', PLATFORM, '/admin/sources/plugins'],
    ['another section', '/admin/system/logs?scope=deployment&q=x', PLATFORM, '/admin/system/logs?q=x'],
  ])('drops it for %s', (_case, entry, viewer, expected) => {
    expect(mount(entry, viewer).result.current.at).toBe(expected)
  })

  it('switches it as a history entry, keeping the card', () => {
    const { result } = mount('/admin/sources/plugins/github_issues', PLATFORM)
    act(() => { result.current.setScope('deployment') })
    expect(result.current.at).toBe('/admin/sources/plugins/github_issues?scope=deployment')
    act(() => { result.current.setScope('workspace') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.scope).toBe('deployment')
  })
})

describe('moves', () => {
  it('pushes a tab and a section, keeping the query, so Back and Forward walk them', () => {
    const { result } = mount('/admin/general?review=r1')
    const visited: string[] = []
    const step = (move: () => void) => { act(move); visited.push(result.current.at) }
    step(() => { result.current.selectTab('taxonomy') })
    step(() => { result.current.selectSection('dimensions') })
    step(() => { void result.current.navigate(-1) })
    step(() => { void result.current.navigate(-1) })
    step(() => { void result.current.navigate(1) })
    expect(visited).toStrictEqual(['/admin/taxonomy/categories?review=r1', '/admin/taxonomy/dimensions?review=r1',
      '/admin/taxonomy/categories?review=r1', '/admin/general?review=r1', '/admin/taxonomy/categories?review=r1'])
  })

  it("opens and closes a board's editor and a person's as history entries", () => {
    const { result } = mount('/admin/access/boards')
    act(() => { result.current.openBoard('brd_sales') })
    expect([result.current.at, result.current.boardId]).toStrictEqual(['/admin/access/boards/brd_sales', 'brd_sales'])
    act(() => { result.current.openBoard(null) })
    act(() => { result.current.openPerson('u-1') })
    expect(result.current.at).toBe('/admin/access/users/u-1')
    act(() => { void result.current.navigate(-2) })
    expect(result.current.boardId).toBe('brd_sales')
  })

  it('adds no entry when the open tab is chosen again', () => {
    const { result } = mount('/admin/ai')
    act(() => { result.current.selectTab('ai') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at).toBe('/dashboard')
  })
})
