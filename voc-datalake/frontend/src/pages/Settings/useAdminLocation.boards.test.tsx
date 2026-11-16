/**
 * @fileoverview Administration's place is its path (`/admin/<tab>/<section>[/<boardId>]`, adminPaths.ts): each path
 * opens its tab and section; a path that is not the canonical form of where it leads is replaced in place, the query
 * kept; the query names no place (no old `?tab=&section=&board=` link is redirected); a switch is a history entry,
 * so Back walks it; a board's editor belongs to Boards (a section switch closes it).
 */
import { describe, expect, it } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { TestRouter } from '@test/TestRouter'
import { readAdminAddress } from './adminPaths'
import { useAdminBoard, useAdminLocation } from './useAdminLocation'

function mount(entry: string, isAdmin = true, isPlatformAdmin = false) {
  const wrapper = ({ children }: Readonly<{ children: ReactNode }>) => (
    <TestRouter initialEntries={['/dashboard', entry]} initialIndex={1}>{children}</TestRouter>
  )
  return renderHook(() => {
    const location = useLocation()
    const [boardId, openBoard] = useAdminBoard()
    return { ...useAdminLocation(isAdmin, isPlatformAdmin), boardId, openBoard, at: `${location.pathname}${location.search}`, navigate: useNavigate() }
  }, { wrapper })
}

describe('the path names the place', () => {
  it.each([
    ['/admin', { tab: 'brand', section: null }],
    ['/admin/brand', { tab: 'brand', section: null }],
    ['/admin/sources/radar', { tab: 'sources', section: 'radar' }],
    ['/admin/taxonomy/dimensions', { tab: 'taxonomy', section: 'dimensions' }],
    ['/admin/access/users', { tab: 'access', section: 'users' }],
    ['/admin/system/version', { tab: 'system', section: 'version' }],
  ])('%s opens %o, as it is', (entry, location) => {
    const { result } = mount(entry)
    expect([result.current.location, result.current.at]).toStrictEqual([location, entry])
  })

  it('opens Privacy & access → Workspaces for a platform admin only', () => {
    expect(mount('/admin/access/workspaces', true, true).result.current.at).toBe('/admin/access/workspaces')
    expect(mount('/admin/access/workspaces', true, false).result.current.at).toBe('/admin/access/policies')
  })
})

describe('a path off its form', () => {
  it.each([
    ['/admin/access/workspaces?review=r1', '/admin/access/policies?review=r1'],
    ['/admin/sources', '/admin/sources/plugins'],
    ['/admin/categories', '/admin/brand'],
    ['/admin/nope?q=x', '/admin/brand?q=x'],
    ['/admin/brand/radar', '/admin/brand'],
    ['/admin/access/users/brd_sales', '/admin/access/users'],
  ])('%s is replaced by %s, in place', (entry, expected) => {
    const { result } = mount(entry, true, false)
    expect(result.current.at).toBe(expected)
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at, 'no extra history entry').toBe('/dashboard')
  })

  it('sends a non-admin\'s admin-only section back to what they may see', () => {
    expect(mount('/admin/access/boards/brd_sales', false).result.current.at).toBe('/admin/brand')
  })

  it('reads no place from the query: an old link is General, as it is (no redirect)', () => {
    expect(readAdminAddress({ pathname: '/admin', search: '?tab=access&section=boards&board=brd_1' }, true, false))
      .toStrictEqual({ place: { tab: 'brand', section: null, boardId: null }, replaceWith: null })
  })
})

describe('moves', () => {
  it('pushes a tab and a section, keeping the query, so Back and Forward walk them', () => {
    const { result } = mount('/admin/brand?review=r1')
    const visited: string[] = []
    const step = (move: () => void) => { act(move); visited.push(result.current.at) }
    step(() => { result.current.selectTab('taxonomy') })
    step(() => { result.current.selectSection('dimensions') })
    step(() => { void result.current.navigate(-1) })
    expect(result.current.location).toStrictEqual({ tab: 'taxonomy', section: 'categories' })
    step(() => { void result.current.navigate(-1) })
    step(() => { void result.current.navigate(1) })
    expect(visited).toStrictEqual(['/admin/taxonomy/categories?review=r1', '/admin/taxonomy/dimensions?review=r1',
      '/admin/taxonomy/categories?review=r1', '/admin/brand?review=r1', '/admin/taxonomy/categories?review=r1'])
  })

  it('opens and closes a board\'s editor as history entries; a section switch leaves it', () => {
    const { result } = mount('/admin/access/boards')
    act(() => { result.current.openBoard('brd_sales') })
    expect([result.current.at, result.current.boardId]).toStrictEqual(['/admin/access/boards/brd_sales', 'brd_sales'])
    act(() => { result.current.selectSection('users') })
    expect([result.current.at, result.current.boardId]).toStrictEqual(['/admin/access/users', null])
    act(() => { void result.current.navigate(-1) })
    expect(result.current.boardId).toBe('brd_sales')
    act(() => { result.current.openBoard(null) })
    expect(result.current.at).toBe('/admin/access/boards')
  })

  it('adds no entry when the open tab is chosen again', () => {
    const { result } = mount('/admin/system/logs')
    act(() => { result.current.selectTab('system') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at).toBe('/dashboard')
  })
})
