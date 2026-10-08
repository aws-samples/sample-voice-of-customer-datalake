/**
 * Page context mapping, plus coverage against the real route table: every
 * protected route must have a pattern, or the assistant would call it "other".
 */
import { describe, it, expect } from 'vitest'
import { renderHook } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '@test/TestRouter'
import { routes } from '../../routes'
import { PAGE_PATTERNS, pageContextFromLocation } from './pageContext'
import { usePageContext } from './usePageContext'
import type { ReactNode } from 'react'

describe('pageContextFromLocation', () => {
  it.each([
    ['/', '', { kind: 'home', path: '/' }],
    ['/dashboard', '', { kind: 'dashboard', path: '/dashboard' }],
    ['/feedback/f-1', '', { kind: 'feedback', path: '/feedback/f-1', feedbackId: 'f-1' }],
    ['/projects', '', { kind: 'projects', path: '/projects' }],
    ['/projects/p1', '?tab=personas', { kind: 'project', path: '/projects/p1', projectId: 'p1', tab: 'personas' }],
    ['/feedback-forms', '', { kind: 'feedback-forms', path: '/feedback-forms' }],
    ['/settings', '?tab=a%20b', { kind: 'settings', path: '/settings' }],
    ['/nowhere', '', { kind: 'other', path: '/nowhere' }],
  ])('%s%s', (pathname, search, expected) => {
    expect(pageContextFromLocation({ pathname, search })).toStrictEqual(expected)
  })

  it('drops over-long ids', () => {
    expect(pageContextFromLocation({ pathname: `/projects/${'x'.repeat(200)}`, search: '' })).not.toHaveProperty('projectId')
  })

  it('has a pattern for every protected route in routes.tsx', () => {
    const layout = routes.find((r) => r.path === '/')
    const childPaths = (layout?.children ?? []).map((c) => (c.index === true ? '' : c.path ?? ''))
    expect(childPaths.length).toBeGreaterThan(10)
    const known = new Set(PAGE_PATTERNS.map((p) => p.route))
    // '*' is the catch-all NotFound route, not a page: the assistant reports it as "other".
    expect(childPaths.filter((p) => p !== '*' && !known.has(p))).toStrictEqual([])
  })
})

describe('usePageContext', () => {
  it('titles a project page from the cached project, without fetching', () => {
    const client = new QueryClient()
    client.setQueryData(['project', 'p1'], { project: { name: 'Checkout revamp' }, personas: [], documents: [] })
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>
        <TestRouter initialEntries={['/projects/p1?tab=documents']}>{children}</TestRouter>
      </QueryClientProvider>
    )
    const { result } = renderHook(() => usePageContext(), { wrapper })
    expect(result.current).toStrictEqual({ kind: 'project', path: '/projects/p1', projectId: 'p1', tab: 'documents', title: 'Checkout revamp' })
  })

  it('has no title when the project is not cached', () => {
    const wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={new QueryClient()}>
        <TestRouter initialEntries={['/projects/p2']}>{children}</TestRouter>
      </QueryClientProvider>
    )
    const { result } = renderHook(() => usePageContext(), { wrapper })
    expect(result.current).toStrictEqual({ kind: 'project', path: '/projects/p2', projectId: 'p2' })
  })
})
