/**
 * @fileoverview Company page: admins edit the vision/objectives, everyone else
 * reads them; the design-system tab paints swatches; the caller's own
 * objectives moved to Account.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { Route, Routes, useLocation } from 'react-router-dom'
import { adminFlag, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { at } from '@test/defined'

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

  // Live finding: an empty context showed "Last updated … by e2e-admin" over empty fields.
  it('says "Not set yet" with one action when nothing is written, and no "Last updated"', async () => {
    const EMPTY_SAVED = { vision: '', objectives: [], updated_at: '2026-10-01T00:00:00Z', updated_by_username: 'e2e-admin' }
    route({ 'GET /settings/company-context': () => EMPTY_SAVED })
    renderAt()

    expect(await screen.findByText('Not set yet')).toBeInTheDocument()
    expect(screen.queryByText(/Last updated/)).not.toBeInTheDocument()
    await userEvent.click(screen.getByRole('button', { name: 'Write the vision and objectives' }))
    expect(screen.getByRole('button', { name: 'Add objective' })).toBeInTheDocument()
  })

  it('tells a reader an administrator has not written it yet', async () => {
    adminFlag.isAdmin = false
    route({ 'GET /settings/company-context': () => ({ vision: '', objectives: [] }) })
    renderAt()

    expect(await screen.findByText('An administrator has not written the company vision and objectives yet.')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Write the vision and objectives' })).not.toBeInTheDocument()
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
    expect(screen.getByRole('link', { name: 'Administration → Sources → Integrations' })).toHaveAttribute('href', '/admin?tab=sources&section=integrations')
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

describe('Company — a blank or reverted objective is not an unsaved change', () => {
  const saveButton = () => screen.getByRole('button', { name: /save changes/i })
  const last = (elements: HTMLElement[]) => at(elements, elements.length - 1)

  /** The admin editor with one stored objective, after Add objective. */
  async function withAddedObjective() {
    route({ 'GET /settings/company-context': () => COMPANY })
    renderAt()
    await screen.findByRole('textbox', { name: 'Objective title' })
    await userEvent.click(screen.getByRole('button', { name: /add objective/i }))
  }

  it('adding then removing an empty objective leaves Save disabled', async () => {
    await withAddedObjective()
    await userEvent.click(last(screen.getAllByRole('button', { name: /remove objective/i })))
    expect(saveButton()).toBeDisabled()
  })

  it('an added blank objective alone is not a change (Save drops blank rows)', async () => {
    await withAddedObjective()
    expect(screen.getAllByRole('textbox', { name: 'Objective title' })).toHaveLength(2)
    expect(saveButton()).toBeDisabled()
  })

  it('the control: typing a title into the new objective enables Save', async () => {
    await withAddedObjective()
    await userEvent.type(last(screen.getAllByRole('textbox', { name: 'Objective title' })), 'New goal')
    expect(saveButton()).toBeEnabled()
  })
})

describe('Company — my objectives moved to Account', () => {
  it('the subtitle links to Account → My objectives instead of promising them here', async () => {
    route({ 'GET /settings/company-context': () => COMPANY })
    renderAt()
    expect(await screen.findByRole('link', { name: 'My objectives' })).toHaveAttribute('href', '/account?tab=objectives')
    expect(screen.queryByText(/plus your own objectives/i)).not.toBeInTheDocument()
  })

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
