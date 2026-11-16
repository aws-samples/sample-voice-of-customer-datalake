/**
 * The project page's place in the address: read from the path (an old link's query as its path will name it), moved
 * to as history entries or in place, and an old link or a path that does not name its place as it should replaced
 * by the place's own path, keeping every other query parameter.
 */
import { act, renderHook } from '@testing-library/react'
import { describe, expect, it } from 'vitest'
import { MemoryRouter, useLocation, useNavigate } from 'react-router-dom'
import type { ReactNode } from 'react'
import { documentPlace, tabPlace } from './projectPaths'
import { useCanonicalProjectPath, useProjectPlace } from './useProjectPlace'

function renderAt(url: string) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={['/projects', url]} initialIndex={1}>{children}</MemoryRouter>
  )
  return renderHook(() => {
    useCanonicalProjectPath()
    const location = useLocation()
    return { ...useProjectPlace(), at: `${location.pathname}${location.search}`, navigate: useNavigate() }
  }, { wrapper })
}

describe('useCanonicalProjectPath', () => {
  it.each([
    ['/projects/p1?tab=documents&doc=d1&view=focus', '/projects/p1/documents/d1/focus'],
    ['/projects/p1?tab=decisions&newDecision=1&title=Go', '/projects/p1/decisions?newDecision=1&title=Go'],
    ['/projects/p1?tab=mcp', '/projects/p1/overview'],
    ['/projects/p1?doc=d1&review=fb_9', '/projects/p1/documents/d1?review=fb_9'],
    ['/projects/p1/chat', '/projects/p1/overview'],
    ['/projects/p1/documents/d1/v/x', '/projects/p1/documents/d1'],
  ])('replaces %s by %s, in place', (from, to) => {
    const { result } = renderAt(from)
    expect(result.current.at).toBe(to)
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at, 'no extra history entry').toBe('/projects')
  })

  it('leaves a path that names its place alone', () => {
    const { result } = renderAt('/projects/p1/documents/d1/v/2?review=fb_9')
    expect([result.current.at, result.current.place]).toStrictEqual([
      '/projects/p1/documents/d1/v/2?review=fb_9', { ...documentPlace('d1'), version: 2 },
    ])
  })
})

describe('useProjectPlace', () => {
  it('moves to a place as a history entry, keeping the query, or in place', () => {
    const { result } = renderAt('/projects/p1/overview?review=fb_9')
    act(() => { result.current.go(tabPlace('personas')) })
    expect(result.current.at).toBe('/projects/p1/personas?review=fb_9')
    act(() => { result.current.go(documentPlace('d2'), { replace: true }) })
    expect(result.current.at).toBe('/projects/p1/documents/d2?review=fb_9')
    act(() => { void result.current.navigate(-1) })
    expect(result.current.at).toBe('/projects/p1/overview?review=fb_9')
  })
})
