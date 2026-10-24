/**
 * @fileoverview Live findings on the Memory list:
 * - after "Remember" the new memory did not appear (the list refetch can still
 *   answer the old page) — it shows at once now;
 * - the saved text silently changed (digits → "[redacted]") — the dialog names
 *   what will be hidden before saving, and the card says so after;
 * - a nonsense search said "Nothing remembered here yet." and offered "Load more";
 * - typing sent one request per keystroke (now one per typed query, 300 ms);
 * - raw ids (`technical_support`) inside a statement;
 * - a personal memory offered "+1" to yourself.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import type { RouteHandler } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: MemoryList } = await import('./MemoryList')

const memory = (id: string, statement: string, extra: Record<string, unknown> = {}) => ({
  memory_id: id, scope: 'company', status: 'active', kind: 'product', statement, supporters: 2,
  source_kind: 'extracted', created_at: '2026-01-01T00:00:00Z', retention: 'decay', ...extra,
})

const route = (routes: Record<string, RouteHandler>) => routeFetchApi(routes, { missStatus: 403, ignoreQuery: true })
const listCalls = () => fetchApi.mock.calls.filter(([endpoint, options]) => endpoint.startsWith('/memory?') && options?.method === undefined)

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Add memory', () => {
  it('opens a dialog, and the new memory shows at once even when the refetch still has the old page', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Older')] }), 'POST /memory': () => ({ memory: memory('m2', 'Shoppers compare prices') }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    const dialog = screen.getByRole('dialog', { name: 'Remember for the whole company' })
    await user.type(within(dialog).getByRole('textbox'), 'Shoppers compare prices')
    await user.click(within(dialog).getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Shoppers compare prices')).toBeInTheDocument()
    expect(screen.getByText('Older')).toBeInTheDocument()
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })

  it('names what will be hidden before saving, and the saved card says so', async () => {
    route({ 'GET /memory': () => ({ items: [] }), 'POST /memory': () => ({ memory: memory('m2', 'Call [redacted] for refunds') }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    await user.type(within(screen.getByRole('dialog')).getByRole('textbox'), 'Call +34 600 123 456 for refunds')
    expect(screen.getByRole('status')).toHaveTextContent(/hidden when it is saved.*\+34 600 123 456/)
    await user.click(screen.getByRole('button', { name: 'Remember' }))
    expect(await screen.findByText('Some details were hidden for privacy.')).toBeInTheDocument()
  })

  it('explains the chosen lifetime in one sentence', async () => {
    route({ 'GET /memory': () => ({ items: [] }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await user.click(await screen.findByRole('button', { name: 'Add memory' }))
    await user.selectOptions(screen.getByRole('combobox', { name: /Retention/ }), 'decay')
    expect(screen.getByRole('combobox', { name: /Retention/ })).toHaveAccessibleDescription(/after 90 days with no use/)
  })
})

describe('Memory search', () => {
  it('says no memory matches and offers no "Load more" when the search finds nothing', async () => {
    route({ 'GET /memory': () => ({ items: [], next_cursor: 'more' }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.type(await screen.findByRole('searchbox'), 'zzqx')
    expect(await screen.findByText('No memories match "zzqx".', {}, { timeout: 3000 })).toBeInTheDocument()
    expect(fetchApi.mock.calls.filter(([endpoint]) => endpoint.includes('q=zzqx'))).toHaveLength(5)
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument()
    expect(screen.queryByText('Nothing remembered here yet.')).not.toBeInTheDocument()
  })

  it('sends one request per typed query, not one per keystroke', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    route({ 'GET /memory': () => ({ items: [] }) })
    const user = userEvent.setup({ advanceTimers: vi.advanceTimersByTime })
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    await waitFor(() => expect(listCalls()).toHaveLength(1))
    await user.type(screen.getByRole('searchbox'), 'refund')
    await act(() => vi.advanceTimersByTimeAsync(350))
    await waitFor(() => expect(listCalls().map(([endpoint]) => endpoint)).toStrictEqual(['/memory?scope=personal', '/memory?scope=personal&q=refund']))
    vi.useRealTimers()
  })
})

describe('Memory card', () => {
  it('reads a raw category id inside the statement as words', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Most complaints are about technical_support delays')] }) })
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    expect(await screen.findByText('Most complaints are about Technical support delays')).toBeInTheDocument()
  })

  it('never offers "+1" or a supporter count on your own personal memory', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'I like short answers', { scope: 'personal' })] }) })
    renderWithQueryClient(<MemoryList scope="personal" canCurate={false} />)
    expect(await screen.findByText('I like short answers')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /supporter/ })).not.toBeInTheDocument()
    expect(screen.queryByText('People who said or confirmed this')).not.toBeInTheDocument()
  })
})

/** Wave 4 live findings: "Any status" never listed a forgotten memory; +1 on your own memory did nothing visible. */
describe('Memory status filter and +1 feedback', () => {
  const listByStatus = (endpoint: string) => {
    const status = new URLSearchParams(endpoint.split('?')[1] ?? '').get('status') ?? 'active'
    return Promise.resolve({ items: [memory(`m-${status}`, `A ${status} memory`, { status })] })
  }

  it('"All statuses" reads every status, archived (forgotten) included; the default is Active', async () => {
    fetchApi.mockImplementation((endpoint) => (endpoint.startsWith('/memory?') ? listByStatus(endpoint) : Promise.reject(new Error('API Error: 403'))))
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    expect(await screen.findByText('A active memory')).toBeInTheDocument()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Status filter' }), 'All statuses')
    expect(await screen.findByText('A archived memory')).toBeInTheDocument()
    expect(screen.getByText('A proposed memory')).toBeInTheDocument()
  })

  it('says so when the server did not count the +1 (you already back it)', async () => {
    route({ 'GET /memory': () => ({ items: [memory('m1', 'Mine')] }), 'POST /memory/m1/confirm': () => ({ ...memory('m1', 'Mine'), counted: false }) })
    const user = userEvent.setup()
    renderWithQueryClient(<MemoryList scope="company" canCurate />)
    await user.click(await screen.findByRole('button', { name: 'I agree — count me as a supporter' }))
    expect(await screen.findByRole('status')).toHaveTextContent('You already back this memory')
    expect(screen.getByRole('button', { name: '+1' })).toBeDisabled()
  })
})
