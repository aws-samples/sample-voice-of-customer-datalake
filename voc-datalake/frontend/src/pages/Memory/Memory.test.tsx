/**
 * @fileoverview Memory page: tabs and curator gating, +1, forget through the
 * ConfirmModal, merge of a multi-selection, conflict resolution and imports.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler as Handler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: Memory } = await import('./Memory')

const memory = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
  memory_id: id, scope: 'company', status: 'active', kind: 'product', statement, supporters: 2, source_kind: 'extracted', created_at: '2026-01-01T00:00:00Z', ...extra,
})

const route = (routes: Record<string, Handler>) => routeFetchApi(routes, { missStatus: 403, ignoreQuery: true })

const listRoutes = (items: unknown[]): Record<string, Handler> => ({
  'GET /memory': () => ({ items }),
  'GET /memory/review': () => ({ items: [] }),
})

beforeEach(() => {
  resetFetchApi()
  localStorage.clear()
  adminFlag.isAdmin = true
})

describe('Memory page', () => {
  it('shows the curator tabs to an admin', async () => {
    route(listRoutes([]))
    renderWithQueryClient(<Memory />)
    expect(await screen.findByRole('tab', { name: /needs review/i })).toBeInTheDocument()
    expect(screen.getByRole('tab', { name: /imports/i })).toBeInTheDocument()
  })

  it('hides the curator tabs when the review route refuses a non-admin', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Customers love fast delivery')] }) })
    renderWithQueryClient(<Memory />)
    expect(await screen.findByText('Customers love fast delivery')).toBeInTheDocument()
    expect(screen.queryByRole('tab', { name: /needs review/i })).not.toBeInTheDocument()
  })

  it('+1s a memory', async () => {
    const confirm = vi.fn(() => ({ memory: memory('m1', 'A', { supporters: 3 }) }))
    route({ ...listRoutes([memory('m1', 'A')]), 'POST /memory/m1/confirm': confirm })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('button', { name: '+1' }))
    await waitFor(() => expect(confirm).toHaveBeenCalledWith(undefined))
  })

  it('forgets only after the confirmation dialog', async () => {
    const forget = vi.fn(() => ({ memory: memory('m1', 'A', { status: 'archived' }) }))
    route({ ...listRoutes([memory('m1', 'A')]), 'POST /memory/m1/forget': forget })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('button', { name: 'Forget' }))
    expect(forget).not.toHaveBeenCalledWith(undefined)
    const dialog = await screen.findByRole('dialog')
    await userEvent.click(within(dialog).getByRole('button', { name: 'Forget' }))
    await waitFor(() => expect(forget).toHaveBeenCalledWith(undefined))
  })

  it('merges two selected memories into one statement', async () => {
    const merge = vi.fn((_body: unknown) => ({ memory: memory('m3', 'Merged') }))
    route({ ...listRoutes([memory('m1', 'Short answers', { supporters: 5 }), memory('m2', 'Brief replies')]), 'POST /memory/merge': merge })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('checkbox', { name: /short answers/i }))
    await userEvent.click(screen.getByRole('checkbox', { name: /brief replies/i }))
    await userEvent.click(screen.getByRole('button', { name: /merge selected/i }))
    await userEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Merge' }))
    await waitFor(() => expect(merge).toHaveBeenCalledWith({ ids: ['m1', 'm2'], statement: 'Short answers' }))
  })
})

describe('Memory load failures (F3: a 502 must not read as an empty memory)', () => {
  const failing = (status: number) => () => { throw new Error(`API Error: ${status}`) }

  it('surfaces a failed review queue instead of swallowing it, and retries it', async () => {
    const review = vi.fn(failing(502))
    route({ 'GET /memory': () => ({ items: [] }), 'GET /memory/review': review })
    renderWithQueryClient(<Memory />)
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load the review queue.')
    // The company list itself answered a real, empty 200: that empty state stays.
    expect(await screen.findByText('Nothing remembered here yet.')).toBeInTheDocument()
    const calls = review.mock.calls.length
    await userEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await waitFor(() => expect(review.mock.calls.length).toBeGreaterThan(calls))
  })

  it('stays silent when the review route refuses a non-curator (403 is the gate, not a failure)', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /memory': () => ({ items: [] }), 'GET /memory/review': failing(403) })
    renderWithQueryClient(<Memory />)
    expect(await screen.findByText('Nothing remembered here yet.')).toBeInTheDocument()
    expect(screen.queryByRole('alert')).not.toBeInTheDocument()
  })

  it('shows the load error, not the empty state, when the personal list 502s', async () => {
    route({
      'GET /memory': failing(502),
      'GET /memory/review': () => ({ items: [] }),
    })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('tab', { name: 'Personal' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not load memories.')
    expect(screen.queryByText('Nothing remembered here yet.')).not.toBeInTheDocument()
  })
})

describe('Memory review and imports', () => {
  it('shows a conflict side by side and applies the suggested resolution', async () => {
    const resolve = vi.fn((_body: unknown) => ({ success: true }))
    route({
      'GET /memory': () => ({ items: [] }),
      // memory_handler._review_entry's real wire shape: {memory, linked, suggestion}.
      'GET /memory/review': () => ({ count: 1, items: [{
        memory: memory('new', 'No express shipping in the north', { status: 'conflict', supporters: 1 }),
        linked: [memory('old', 'Express shipping everywhere', { supporters: 6 })],
        suggestion: { action: 'keep', winner_id: 'old', reason: '6 people support it versus 1.' },
      }] }),
      'POST /memory/review/new/resolve': resolve,
    })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('tab', { name: /needs review/i }))
    expect(await screen.findByText('Express shipping everywhere')).toBeInTheDocument()
    expect(screen.getByRole('radio', { name: 'Keep the existing one' })).toHaveAttribute('aria-checked', 'true')
    await userEvent.click(screen.getByRole('button', { name: 'Apply' }))
    // "Keep the existing one" is the server's keep with the OTHER side as winner —
    // its replace would keep the new claim and retire the existing memory.
    await waitFor(() => expect(resolve).toHaveBeenCalledWith({ action: 'keep', winner_id: 'old' }))
  })

  it('submits a pasted page and lists it with its status', async () => {
    const create = vi.fn((_body: unknown) => ({ import_id: 'imp_1' }))
    route({
      ...listRoutes([]),
      'POST /memory/imports': create,
      'GET /memory/imports/imp_1': () => ({ import_id: 'imp_1', title: 'Blog post', status: 'completed', memories_created: 2, created_at: '' }),
    })
    renderWithQueryClient(<Memory />)
    await userEvent.click(await screen.findByRole('tab', { name: /imports/i }))
    await userEvent.type(screen.getByRole('textbox', { name: 'Title' }), 'Blog post')
    await userEvent.type(screen.getByRole('textbox', { name: 'Content' }), 'Shoppers hate late parcels')
    await userEvent.click(screen.getByRole('button', { name: 'Import' }))
    await waitFor(() => expect(create).toHaveBeenCalledWith({ title: 'Blog post', content: 'Shoppers hate late parcels' }))
    expect(await screen.findByText('Memories created: 2')).toBeInTheDocument()
  })
})
