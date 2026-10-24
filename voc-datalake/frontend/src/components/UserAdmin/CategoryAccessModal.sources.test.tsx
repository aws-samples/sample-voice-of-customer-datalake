/**
 * The Sources half of a user's access: no stored list = the default rule (sent
 * as `sources: null`, which also clears a stored list), "all" sends ['*'], a
 * selection sends exactly those ids, and a restricted source is marked.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { sourcesWire } from '@test/dimensionFixtures'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
import { fetchApi, resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import CategoryAccessModal from './CategoryAccessModal'
import { cognitoUser } from './userAdmin-fixtures'

const viewer = cognitoUser({ username: 'viewer-demo', email: 'viewer@example.com', name: 'Vic' })

function routes(stored: Record<string, unknown>): void {
  routeFetchApi({
    'GET /users/viewer-demo/category-access': () => stored,
    'PUT /users/viewer-demo/category-access': (body) => body,
    'GET /settings/sources': () => sourcesWire,
    'GET /settings/categories': () => ({ categories: [] }),
  })
}

function renderModal() {
  renderWithQueryClient(<CategoryAccessModal user={viewer} onClose={vi.fn()} onSaved={vi.fn()} />)
}

async function saveAndReadBody(user: ReturnType<typeof userEvent.setup>): Promise<unknown> {
  await user.click(screen.getByRole('button', { name: 'Save Changes' }))
  await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/users/viewer-demo/category-access', expect.objectContaining({ method: 'PUT' })))
  return JSON.parse(String(fetchApi.mock.calls.at(-1)?.[1]?.body))
}

beforeEach(() => {
  resetFetchApi()
  routes({ categories: ['*'] })
})

describe('CategoryAccessModal — sources', () => {
  it('starts on the default rule and saves it as sources: null', async () => {
    const user = userEvent.setup()
    routes({ categories: ['*'], sources: null })
    renderModal()
    expect(await screen.findByRole('radio', { name: /Every source that is not restricted/ })).toBeChecked()
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: null })
  })

  it("sends ['*'] for every source including restricted ones", async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(await screen.findByRole('radio', { name: /Every source, restricted ones included/ }))
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: ['*'] })
  })

  it('sends exactly the selected sources, with restricted ones marked', async () => {
    const user = userEvent.setup()
    renderModal()
    await user.click(await screen.findByRole('radio', { name: 'Only selected sources' }))
    expect(screen.getByRole('button', { name: 'Save Changes' })).toBeDisabled()
    expect(await screen.findByText('Restricted')).toBeInTheDocument()
    await user.click(screen.getByRole('checkbox', { name: /Support tickets/ }))
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: ['support_tickets'] })
  })

  it('shows a stored list and can clear it back to the default rule', async () => {
    const user = userEvent.setup()
    routes({ categories: ['*'], sources: ['sales_csv'] })
    renderModal()
    expect(await screen.findByRole('checkbox', { name: /Sales CSV/ })).toBeChecked()
    await user.click(screen.getByRole('radio', { name: /Every source that is not restricted/ }))
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: null })
  })
})

describe('CategoryAccessModal — no hidden leftover (wave 9)', () => {
  it('summarises the stored source list next to the categories', async () => {
    routes({ categories: ['delivery'], sources: ['sales_csv'] })
    renderModal()
    const summary = await screen.findByRole('region', { name: 'Current access' })
    expect(summary).toHaveTextContent('Categories: only Delivery')
    await waitFor(() => expect(summary).toHaveTextContent('Sources: only Sales CSV'))
  })

  it('says the default rule in plain words', async () => {
    routes({ categories: ['*'], sources: null })
    renderModal()
    expect(await screen.findByRole('region', { name: 'Current access' })).toHaveTextContent('Sources: all except restricted ones')
  })

  it('restoring "All categories" still sends the stored source list explicitly', async () => {
    const user = userEvent.setup()
    routes({ categories: ['delivery'], sources: ['sales_csv'] })
    renderModal()
    await user.click(await screen.findByRole('radio', { name: 'All categories' }))
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: ['sales_csv'] })
  })

  it('"Give full access" resets both rules to every category and the default source rule, not restricted sources', async () => {
    const user = userEvent.setup()
    routes({ categories: ['delivery'], sources: ['sales_csv'] })
    renderModal()
    await user.click(await screen.findByRole('button', { name: 'Give full access' }))
    expect(screen.getByRole('button', { name: 'Give full access' })).toBeDisabled()
    expect(await saveAndReadBody(user)).toStrictEqual({ categories: ['*'], sources: null })
  })

  it('"Give full access" is offered again when restricted sources are granted on top of all categories', async () => {
    routes({ categories: ['*'], sources: ['*'] })
    renderModal()
    expect(await screen.findByRole('button', { name: 'Give full access' })).toBeEnabled()
  })
})
