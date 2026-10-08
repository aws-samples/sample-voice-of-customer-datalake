/**
 * @fileoverview Company page: admins edit the vision/objectives, everyone else
 * reads them; the design-system tab paints swatches; the caller's own
 * objectives moved to Account (todofeatures §6.1).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { Route, Routes, useLocation } from 'react-router-dom'
import { adminFlag, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: Company } = await import('./Company')

const COMPANY = {
  vision: '## Be the most trusted brand',
  objectives: [{ id: 'o1', title: 'Halve late deliveries', description: 'Top complaint', horizon: 'quarter' }],
  updated_at: '2026-10-01T00:00:00Z',
  updated_by_username: 'ada',
}
const DESIGN = {
  tokens: { colors: [{ name: 'primary', value: '#8e48ff' }, { name: 'bad', value: 'not a colour!' }], typography: [], spacing: [], radius: [] },
  guidelines: 'One primary action',
  references: [],
  integrations: { figma: true, github: false },
}

function renderAt(tab?: string) {
  return renderWithQueryClient(
    <TestRouter initialEntries={[tab ? `/company?tab=${tab}` : '/company']}><Company /></TestRouter>,
  )
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Company — vision & objectives', () => {
  it('lets an admin edit and save', async () => {
    const save = vi.fn((body: unknown) => ({ ...COMPANY, ...(typeof body === 'object' ? body : {}) }))
    route({ 'GET /settings/company-context': () => COMPANY, 'PUT /settings/company-context': save })
    renderAt()
    const title = await screen.findByRole('textbox', { name: 'Objective title' })
    await userEvent.clear(title)
    await userEvent.type(title, 'Cut late deliveries by 50%')
    await userEvent.click(screen.getByRole('button', { name: /save changes/i }))
    await waitFor(() => expect(save).toHaveBeenCalledWith({
      vision: COMPANY.vision,
      objectives: [{ id: 'o1', title: 'Cut late deliveries by 50%', description: 'Top complaint', horizon: 'quarter' }],
    }))
  })

  it('is read-only for everyone else', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /settings/company-context': () => COMPANY })
    renderAt()
    expect(await screen.findByText('Halve late deliveries')).toBeInTheDocument()
    expect(screen.getByText('View only')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /save changes/i })).not.toBeInTheDocument()
  })
})

describe('Company — the Save row is a registered action bar the assistant launcher keeps clear of (R3)', () => {
  it.each([undefined, 'design'])('tab %s', async (tab) => {
    route({ 'GET /settings/company-context': () => COMPANY, 'GET /settings/design-system': () => DESIGN })
    renderAt(tab)
    const save = (await screen.findAllByRole('button', { name: /save changes/i })).at(0)
    const bar = save?.closest('[data-action-bar]')
    expect(bar).not.toBeNull()
    expect(bar).toHaveClass('sticky', 'bottom-0')
  })
})

describe('Company — design system', () => {
  it('paints valid swatches, flags invalid ones and points admins to Administration for tokens', async () => {
    route({ 'GET /settings/design-system': () => DESIGN })
    renderAt('design')
    expect(await screen.findByRole('img', { name: 'Color swatch #8e48ff' })).toHaveStyle({ backgroundColor: '#8e48ff' })
    expect(screen.getByRole('img', { name: 'Not a valid color value' })).toBeInTheDocument()
    expect(screen.queryByLabelText(/figma token/i)).not.toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Administration → Integrations' })).toHaveAttribute('href', '/admin?tab=integrations')
  })

  it('shows a reference the API stored as status "error" as Failed, with its reason', async () => {
    // design_references.record_outcome writes status 'error' — it used to fall to "Pending" forever.
    const reason = 'GitHub could not find it (or the token cannot see it)'
    route({ 'GET /settings/design-system': () => ({
      ...DESIGN,
      references: [{ id: 'r1', kind: 'github', title: 'Tokens repo', url: 'https://github.com/acme/ds', status: 'error', error: reason }],
    }) })
    renderAt('design')
    expect(await screen.findByText('Tokens repo')).toBeInTheDocument()
    expect(screen.getByText('Failed')).toBeInTheDocument()
    expect(screen.queryByText('Pending')).not.toBeInTheDocument()
    expect(screen.getByText(reason)).toBeInTheDocument()
  })
})

describe('Company — my objectives moved to Account', () => {
  it('redirects ?tab=mine to /account?tab=objectives', async () => {
    renderWithQueryClient(
      <TestRouter initialEntries={['/company?tab=mine']}>
        <Routes>
          <Route path="/company" element={<Company />} />
          <Route path="/account" element={<LocationProbe />} />
        </Routes>
      </TestRouter>,
    )
    expect(await screen.findByTestId('location')).toHaveTextContent('/account?tab=objectives')
  })
})

function LocationProbe() {
  const location = useLocation()
  return <p data-testid="location">{`${location.pathname}${location.search}`}</p>
}
