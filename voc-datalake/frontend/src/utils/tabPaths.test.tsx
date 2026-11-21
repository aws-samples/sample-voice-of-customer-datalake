/**
 * A page whose place is its tab (utils/tabPaths.ts, on utils/pathPlace.ts): each tab's path opens it, a path naming no
 * tab is replaced by the first tab's path in place (no history entry, the query kept), the query names no tab (no
 * `?tab=` link of before is read), and a switch is a history entry so Back and Forward walk the tabs.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { pathOf, searchWithout, segmentsUnder } from './pathPlace'
import { readTabAddress, tabPath, useTabPath } from './tabPaths'
import type { TabPage } from './tabPaths'

const PAGE: TabPage<'one' | 'two' | 'three'> = { base: '/things', tabs: ['one', 'two', 'three'] }

function renderAt(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/home', url]} initialIndex={1}>{children}</MemoryRouter>
  )
  return renderHook(() => {
    const [tab, select] = useTabPath(PAGE)
    const location = useLocation()
    return { tab, select, at: `${location.pathname}${location.search}`, navigate: useNavigate() }
  }, { wrapper })
}

describe('the shared address parts', () => {
  it('reads the segments under a page, decoded, and nothing outside it', () => {
    expect([segmentsUnder('/admin', '/admin'), segmentsUnder('/admin', '/admin/access/users/'), segmentsUnder('/admin', '/administration'),
      segmentsUnder('/agents', '/agents/a%20b')]).toStrictEqual([[], ['access', 'users'], null, ['a b']])
    // (pathPlace.ts's own example, 7.63.00: every segment under the base, never a tab's name for them)
    expect(segmentsUnder('/admin', '/admin/access/users/u-1')).toStrictEqual(['access', 'users', 'u-1'])
  })

  it('writes a path with each segment encoded, and a query without some of its parameters', () => {
    expect(pathOf(['agents', 'a/b c'])).toBe('/agents/a%2Fb%20c')
    expect([searchWithout('?board=x&q=1&board=y', ['board']), searchWithout('?board=x', ['board'])]).toStrictEqual(['?q=1', ''])
  })
})

describe('readTabAddress', () => {
  it.each([
    ['/things', '', 'one', null],
    ['/things/two', '', 'two', null],
    ['/things', '?tab=three&q=1', 'one', null],
    ['/things/nope', '?q=1', 'one', { pathname: '/things/one', search: '?q=1' }],
    ['/things/two/extra', '', 'two', { pathname: '/things/two', search: '' }],
    ['/things/two', '?tab=three', 'two', null],
  ])('%s%s opens %s, replaced by %o', (pathname, search, tab, replaceWith) => {
    expect(readTabAddress(PAGE, { pathname, search })).toStrictEqual({ place: tab, replaceWith })
  })

  it('reads nothing outside the page', () => {
    expect(readTabAddress(PAGE, { pathname: '/other', search: '?tab=two' })).toBeNull()
    expect(tabPath(PAGE, 'three')).toBe('/things/three')
  })
})

describe('useTabPath', () => {
  it('replaces a path naming no tab in place, keeping the query', () => {
    const { result } = renderAt('/things/nope?review=fb_1')
    expect([result.current.tab, result.current.at]).toStrictEqual(['one', '/things/one?review=fb_1'])
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at, 'no extra history entry').toBe('/home')
  })

  it('pushes each switch, keeping the query, so Back and Forward walk the tabs', () => {
    const { result } = renderAt('/things?review=fb_1')
    act(() => { result.current.select('two') })
    act(() => { result.current.select('three') })
    expect(result.current.at).toBe('/things/three?review=fb_1')
    act(() => { void result.current.navigate(-1) })
    expect([result.current.tab, result.current.at]).toStrictEqual(['two', '/things/two?review=fb_1'])
    act(() => { void result.current.navigate(1) })
    expect(result.current.tab).toBe('three')
  })

  it('adds no entry when the open tab is chosen again', () => {
    const { result } = renderAt('/things/two')
    act(() => { result.current.select('two') })
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at).toBe('/home')
  })
})
