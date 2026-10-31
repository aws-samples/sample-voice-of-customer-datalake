/**
 * @fileoverview Knowledge → Company → Personas (5.60): the company persona library.
 * `?tab=personas` deep-links it; admins (`can_edit`) get generate / import / edit /
 * delete, everyone else reads; an empty library explains how it is filled.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { TestRouter } from '@test/TestRouter'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'

vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))
vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: Company } = await import('./Company')

const FARAH = {
  persona_id: 'cpersona_1', name: 'Frequent-Flyer Farah', tagline: 'Books Example Air every month',
  created_at: '2026-10-01T00:00:00Z', research_notes: [],
}

function library(personas: unknown[], canEdit: boolean) {
  route({
    'GET /company-personas': () => ({ personas, can_edit: canEdit }),
    'GET /company-personas/jobs': () => ({ jobs: [] }),
    'DELETE /company-personas/cpersona_1': () => ({ success: true }),
  })
}

function renderPersonasTab() {
  return renderWithQueryClient(<TestRouter initialEntries={['/company?tab=personas']}><Company /></TestRouter>)
}

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Company → Personas', () => {
  it('opens on the Personas tab from ?tab=personas', async () => {
    library([FARAH], true)
    renderPersonasTab()
    expect(screen.getByRole('tab', { name: /Personas/ })).toHaveAttribute('aria-selected', 'true')
    expect(await screen.findByRole('button', { name: 'Frequent-Flyer Farah' })).toBeInTheDocument()
  })

  it('gives an admin generate and import, and no project-only "Copy from…"', async () => {
    library([FARAH], true)
    renderPersonasTab()
    expect(await screen.findByRole('button', { name: /Generate Personas/ })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Import Persona/ })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Copy from/ })).not.toBeInTheDocument()
  })

  it('lets a reader view a persona without any write control', async () => {
    library([FARAH], false)
    const user = userEvent.setup()
    renderPersonasTab()
    await user.click(await screen.findByRole('button', { name: 'Frequent-Flyer Farah' }))
    expect(screen.getByRole('heading', { level: 2, name: 'Frequent-Flyer Farah' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Generate Personas|Import Persona|Edit persona|Delete persona/ })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Promote to company' })).not.toBeInTheDocument()
  })

  it('deletes through the confirmation, on the library route', async () => {
    library([FARAH], true)
    const user = userEvent.setup()
    renderPersonasTab()
    await user.click(await screen.findByRole('button', { name: 'Frequent-Flyer Farah' }))
    await user.click(screen.getByRole('button', { name: 'Delete persona' }))
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: 'Delete' }))
    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/company-personas/cpersona_1', expect.objectContaining({ method: 'DELETE' })))
  })

  it('explains an empty library to an admin', async () => {
    library([], true)
    renderPersonasTab()
    expect(await screen.findByRole('heading', { name: 'No company personas yet' })).toBeInTheDocument()
    expect(screen.getByText(/promote a persona from a project/)).toBeInTheDocument()
  })

  it('tells a reader who fills an empty library', async () => {
    library([], false)
    renderPersonasTab()
    expect(await screen.findByText(/An administrator fills it/)).toBeInTheDocument()
  })

  it('says when the library cannot be read', async () => {
    route({ 'GET /company-personas/jobs': () => ({ jobs: [] }) })
    renderPersonasTab()
    expect(await screen.findByRole('alert')).toHaveTextContent("The company personas couldn't be loaded.")
  })

  it('imports pasted text into the library and closes the dialog', async () => {
    route({
      'GET /company-personas': () => ({ personas: [FARAH], can_edit: true }),
      'GET /company-personas/jobs': () => ({ jobs: [] }),
      'POST /company-personas/import': () => ({ success: true, job_id: 'job_1', status: 'running', message: '' }),
    })
    const user = userEvent.setup()
    renderPersonasTab()
    await user.click(await screen.findByRole('button', { name: /Import Persona/ }))
    await user.click(screen.getByRole('button', { name: /Paste content/i }))
    await user.type(screen.getByRole('textbox', { name: 'Paste Persona Content' }), 'A frequent flyer who books every month')
    await user.click(within(screen.getByRole('dialog')).getByRole('button', { name: /Import Persona/i }))

    await waitFor(() => expect(fetchApi).toHaveBeenCalledWith('/company-personas/import', expect.objectContaining({ method: 'POST' })))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  })

})
