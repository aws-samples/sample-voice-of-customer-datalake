/**
 * @fileoverview Administration's place is its path (7.54.00, adminPaths.ts): `/admin` is the home, `/admin/<tab>` a
 * tab, `/admin/<tab>/<section>` one card of it, `/admin/<tab>/<item>` the board, person or source open on it; a path
 * that is not the canonical form of where it leads is replaced in place, the query kept; no address of before 7.54.00
 * is aliased; the query names no place but the Data sources scope; a move is a history entry, so Back walks it.
 */
import { describe, expect, it, vi } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { TestRouter } from '@test/TestRouter'
import { deploymentSourcePath, readAdminAddress } from './adminPaths'
import { useAdminLocation, useBoardInPath, usePersonInPath, useSourceInPath, useSourceScope } from './useAdminLocation'

// (the Data sources page's plugins: the cards a path may open)
vi.mock('../../plugins', () => ({ getEnabledPlugins: () => [{ id: 'github_issues' }, { id: 'webscraper' }] }))

function mount(entry: string, isAdmin = true, isPlatformAdmin = false) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <TestRouter initialEntries={['/dashboard', entry]} initialIndex={1}>{children}</TestRouter>
  )
  return renderHook(() => {
    const location = useLocation()
    const [boardId, openBoard] = useBoardInPath()
    const [person, openPerson] = usePersonInPath()
    const [scope, setScope] = useSourceScope()
    const { place, selectTab } = useAdminLocation(isAdmin, isPlatformAdmin)
    return {
      place, selectTab, boardId, openBoard, person, openPerson, scope, setScope, source: useSourceInPath(),
      at: `${location.pathname}${location.search}`, navigate: useNavigate(),
    }
  }, { wrapper })
}

describe('the path names the place', () => {
  it.each([
    ['/admin', { tab: null, section: null, item: null }],
    ['/admin/people', { tab: 'people', section: null, item: null }],
    ['/admin/sources/radar', { tab: 'sources', section: 'radar', item: null }],
    ['/admin/categories/dimensions', { tab: 'categories', section: 'dimensions', item: null }],
    ['/admin/boards/participants', { tab: 'boards', section: 'participants', item: null }],
    ['/admin/brand/theme', { tab: 'brand', section: 'theme', item: null }],
    ['/admin/privacy/erasure', { tab: 'privacy', section: 'erasure', item: null }],
    ['/admin/version', { tab: 'version', section: null, item: null }],
  ])('%s opens %o, as it is', (entry, place) => {
    const { result } = mount(entry)
    expect([result.current.place, result.current.at]).toStrictEqual([place, entry])
  })

  it('opens Platform for a platform admin only; anyone else gets the home', () => {
    expect(mount('/admin/platform/deployment-brand', true, true).result.current.at).toBe('/admin/platform/deployment-brand')
    expect(mount('/admin/platform/deployment-brand', true, false).result.current.at).toBe('/admin')
  })

  it('names the board, the person and the source open on their tabs', () => {
    expect([mount('/admin/boards/brd_sales').result.current.boardId, mount('/admin/people/u-1').result.current.person,
      mount('/admin/people/invite').result.current.person, mount('/admin/sources/github_issues').result.current.source])
      .toStrictEqual(['brd_sales', 'u-1', 'invite', 'github_issues'])
  })
})

describe('a path off its form', () => {
  it.each([
    // No alias for the addresses of before 7.54.00: an unknown tab is the home, the query kept.
    ['/admin/access/users?review=r1', '/admin?review=r1'],
    ['/admin/data-sources/github_issues', '/admin'],
    ['/admin/taxonomy/categories', '/admin'],
    ['/admin/system/logs', '/admin'],
    ['/admin/nope?q=x', '/admin?q=x'],
    ['/admin/brand/radar', '/admin/brand'],
    ['/admin/categories/categories', '/admin/categories'],
    ['/admin/logs/more', '/admin/logs'],
    ['/admin/sources/nope', '/admin/sources'],
    ['/admin/sources/github_issues/more', '/admin/sources/github_issues'],
    ['/admin/boards/brd_sales/more', '/admin/boards/brd_sales'],
  ])('%s is replaced by %s, in place', (entry, expected) => {
    const { result } = mount(entry, true, false)
    expect(result.current.at).toBe(expected)
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at, 'no extra history entry').toBe('/dashboard')
  })

  it('sends a non-admin off an admin-only tab or card to what they may see', () => {
    expect([mount('/admin/boards/brd_sales', false).result.current.at, mount('/admin/categories/dimensions', false).result.current.at,
      mount('/admin/sources/radar', false).result.current.at]).toStrictEqual(['/admin', '/admin/categories', '/admin/sources'])
  })

  it('reads no place from the query: an old link is the home, as it is (no redirect)', () => {
    expect(readAdminAddress({ pathname: '/admin', search: '?tab=access&section=boards&board=brd_1' }, true, false))
      .toStrictEqual({ place: { tab: null, section: null, item: null }, replaceWith: null })
  })
})

describe('the Data sources scope (?scope=deployment)', () => {
  it('builds the deployment\'s GitHub Issues card address the readiness fix and the setup guide open', () => {
    expect(deploymentSourcePath('github_issues')).toBe('/admin/sources/github_issues?scope=deployment')
  })

  it('keeps it for a platform admin, with the card and the rest of the query', () => {
    const { result } = mount('/admin/sources/github_issues?review=r1&scope=deployment', true, true)
    expect([result.current.scope, result.current.source, result.current.at])
      .toStrictEqual(['deployment', 'github_issues', '/admin/sources/github_issues?review=r1&scope=deployment'])
  })

  it.each([
    ['a plain administrator', '/admin/sources?scope=deployment', true, false, '/admin/sources'],
    ['an unknown value', '/admin/sources?scope=everything', true, true, '/admin/sources'],
    ['another tab', '/admin/logs?scope=deployment&q=x', true, true, '/admin/logs?q=x'],
  ])('drops it for %s', (_case, entry, isAdmin, isPlatformAdmin, expected) => {
    expect(mount(entry, isAdmin, isPlatformAdmin).result.current.at).toBe(expected)
  })

  it('switches it as a history entry, keeping the card', () => {
    const { result } = mount('/admin/sources/github_issues', true, true)
    act(() => { result.current.setScope('deployment') })
    expect(result.current.at).toBe('/admin/sources/github_issues?scope=deployment')
    act(() => { result.current.setScope('workspace') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.scope).toBe('deployment')
  })
})

describe('moves', () => {
  it('pushes a tab, keeping the query, so Back and Forward walk them', () => {
    const { result } = mount('/admin/brand?review=r1')
    const visited: string[] = []
    const step = (move: () => void) => { act(move); visited.push(result.current.at) }
    step(() => { result.current.selectTab('categories') })
    step(() => { result.current.selectTab(null) })
    step(() => { void result.current.navigate(-1) })
    step(() => { void result.current.navigate(1) })
    expect(visited).toStrictEqual(['/admin/categories?review=r1', '/admin?review=r1', '/admin/categories?review=r1', '/admin?review=r1'])
  })

  it('opens and closes a board\'s editor and a person\'s as history entries', () => {
    const { result } = mount('/admin/boards')
    act(() => { result.current.openBoard('brd_sales') })
    expect([result.current.at, result.current.boardId]).toStrictEqual(['/admin/boards/brd_sales', 'brd_sales'])
    act(() => { result.current.openBoard(null) })
    act(() => { result.current.openPerson('u-1') })
    expect(result.current.at).toBe('/admin/people/u-1')
    act(() => { void result.current.navigate(-2) })
    expect(result.current.boardId).toBe('brd_sales')
  })

  it('adds no entry when the open tab is chosen again', () => {
    const { result } = mount('/admin/logs')
    act(() => { result.current.selectTab('logs') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at).toBe('/dashboard')
  })
})
