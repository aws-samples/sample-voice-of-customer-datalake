/**
 * @fileoverview The scope notice, the scoped empty state and `useCanSetUp`, driven by
 * `GET /feedback/access` the way the backend answers it for an admin, a category-restricted
 * viewer, a viewer restricted to nothing and a source-restricted viewer.
 * @module components/ScopeNotice
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { renderHook, screen, waitFor } from '@testing-library/react'
import { renderWithQueryClient, createTestQueryClient } from '@test/query-client'
import { QueryClientProvider } from '@tanstack/react-query'
import type { ReactNode } from 'react'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'

vi.mock('../../api/client', async (importOriginal) => {
  const { clientWithMockedFetchApi, fetchApi: routed } = await import('@test/fetchApiRoutes')
  const mocked = await clientWithMockedFetchApi(importOriginal)
  return { ...mocked, api: { ...mocked.api, getCategoriesConfig: () => routed('/settings/categories') } }
})
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: ScopeNotice } = await import('./ScopeNotice')
const { default: ScopedEmptyState } = await import('./ScopedEmptyState')
const { useCanSetUp } = await import('./useViewerScope')
const { viewerScopeOf, isRestricted } = await import('./viewerScope')

const ALL = { all: true, categories: [], sources_all: true, sources: [], source_rule: 'all', sources_denied: [] }
const ONLY = (...categories: string[]) => ({ ...ALL, all: false, categories, sources_all: false, source_rule: 'deny' })
const CONFIG = {
  categories: [
    { id: 'c1', name: 'technical_support', description: 'Technical support' },
    { id: 'c2', name: 'billing', description: 'Billing' },
  ],
}

function serve(access: unknown): void {
  routeFetchApi({ 'GET /feedback/access': () => access, 'GET /settings/categories': () => CONFIG })
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('viewerScopeOf', () => {
  const access = (categories: { all: boolean; categories: string[] }, sources: { rule: 'all' | 'allow' | 'deny'; denied?: string[] }) =>
    ({ categories, sources: { rule: sources.rule, sources: [], denied: sources.denied ?? [] } })

  it('reads a category list as restricted, even an empty one', () => {
    expect([
      viewerScopeOf(access({ all: false, categories: ['billing'] }, { rule: 'all' })),
      viewerScopeOf(access({ all: false, categories: [] }, { rule: 'all' })),
    ]).toStrictEqual([{ kind: 'categories', categories: ['billing'] }, { kind: 'categories', categories: [] }])
  })

  it('reads an allow list, or a deny rule that names a source, as a source restriction', () => {
    expect([
      viewerScopeOf(access({ all: true, categories: [] }, { rule: 'allow' })).kind,
      viewerScopeOf(access({ all: true, categories: [] }, { rule: 'deny', denied: ['radar_x'] })).kind,
      viewerScopeOf(access({ all: true, categories: [] }, { rule: 'deny' })).kind,
    ]).toStrictEqual(['sources', 'sources', 'all'])
  })

  it('treats an unknown scope as unrestricted', () => {
    expect([isRestricted(null), isRestricted({ kind: 'all' }), isRestricted({ kind: 'sources' })]).toStrictEqual([false, false, true])
  })
})

describe('ScopeNotice', () => {
  it('names the allowed categories by their labels', async () => {
    serve(ONLY('technical_support'))
    renderWithQueryClient(<ScopeNotice />)
    expect(await screen.findByRole('note')).toHaveTextContent('Showing Technical support only — the category you have access to.')
  })

  it('lists several categories in one sentence, sorted by label', async () => {
    serve(ONLY('technical_support', 'billing'))
    renderWithQueryClient(<ScopeNotice />)
    expect(await screen.findByRole('note')).toHaveTextContent('Showing Billing and Technical support only — the categories you have access to.')
  })

  it('says so when the access covers no category, and when only sources are limited', async () => {
    serve(ONLY())
    const { unmount } = renderWithQueryClient(<ScopeNotice />)
    expect(await screen.findByRole('note')).toHaveTextContent("Your access doesn't include any categories yet — ask an administrator.")
    unmount()
    serve({ ...ALL, source_rule: 'allow', sources: ['webscraper'] })
    renderWithQueryClient(<ScopeNotice />)
    expect(await screen.findByRole('note')).toHaveTextContent('Showing reviews from the sources you have access to only.')
  })

  it('renders nothing for an unrestricted viewer', async () => {
    serve(ALL)
    const { container } = renderWithQueryClient(<ScopeNotice />)
    await waitFor(() => expect(container).toBeEmptyDOMElement())
    expect(screen.queryByRole('note')).toBeNull()
  })
})

describe('ScopedEmptyState', () => {
  it('names what a restricted viewer can see and offers no setup action', async () => {
    serve(ALL)
    renderWithQueryClient(<ScopedEmptyState scope={{ kind: 'categories', categories: ['technical_support'] }} />)
    expect(await screen.findByText('You can see reviews in: Technical support. None have arrived yet.')).toBeInTheDocument()
    expect(screen.getByRole('heading', { name: 'No reviews to show yet' })).toBeInTheDocument()
    expect([screen.queryAllByRole('link'), screen.queryAllByRole('button')]).toStrictEqual([[], []])
    expect(screen.queryByText(/workspace is empty/)).toBeNull()
  })

  it('tells a viewer with no category to ask an administrator, and a plain viewer who connects sources', () => {
    serve(ALL)
    const { unmount } = renderWithQueryClient(<ScopedEmptyState scope={{ kind: 'categories', categories: [] }} />)
    expect(screen.getByText("Your access doesn't include any reviews yet — ask an administrator.")).toBeInTheDocument()
    unmount()
    renderWithQueryClient(<ScopedEmptyState scope={{ kind: 'all' }} />)
    expect(screen.getByText('Customer feedback appears here once an administrator connects a source.')).toBeInTheDocument()
  })
})

describe('useCanSetUp', () => {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
  )

  it('is true for an unrestricted administrator only', async () => {
    serve(ALL)
    const admin = renderHook(() => useCanSetUp(), { wrapper })
    await waitFor(() => expect(admin.result.current).toBe(true))
    adminFlag.isAdmin = false
    expect(renderHook(() => useCanSetUp(), { wrapper }).result.current).toBe(false)
  })

  it('is false once the scope says restricted, even under the local dev admin bypass', async () => {
    serve(ONLY('billing'))
    const { result } = renderHook(() => useCanSetUp(), { wrapper })
    await waitFor(() => expect(result.current).toBe(false))
  })
})
