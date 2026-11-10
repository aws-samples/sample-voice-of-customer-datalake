/**
 * @fileoverview 5.60 company personas on the persona detail: "Promote to company" is
 * for an admin who can edit the project, never inside the library; it posts the
 * promote route, refreshes the library list and links to it. A copied persona says
 * where it came from.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { createTestQueryClient, renderWithQueryClient } from '@test/query-client'
import { adminFlag, fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { COMPANY_PERSONA_SCOPE, projectPersonaScope } from './personaScope'
import type { PersonaScope } from './personaScope'
import type { ProjectPersona } from '../../api/projectTypes'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../store/authStore', () => import('@test/fetchApiRoutes').then((m) => m.authStoreModule()))

const { default: PersonaDetailView } = await import('./PersonaDetailView')

const DANA: ProjectPersona = { persona_id: 'persona_1', name: 'Deadline-Driven Dana', tagline: 'Orders late', created_at: '' }
const PROMOTE = 'POST /projects/proj_1/personas/persona_1/promote'

function renderDetail(persona: ProjectPersona, { scope = projectPersonaScope('proj_1'), canEdit = true }: { scope?: PersonaScope; canEdit?: boolean } = {}) {
  const client = createTestQueryClient()
  const invalidate = vi.spyOn(client, 'invalidateQueries')
  renderWithQueryClient(
    <MemoryRouter>
      <PersonaDetailView scope={scope} persona={persona} canEdit={canEdit}
        onEdit={vi.fn()} onDelete={vi.fn()} onSaveNotes={vi.fn()} isDeleting={false} isSavingNotes={false} />
    </MemoryRouter>,
    client,
  )
  return { invalidate }
}

const promoteButton = () => screen.queryByRole('button', { name: 'Promote to company' })

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
})

describe('Promote to company', () => {
  it('is offered to an admin who can edit the project', () => {
    renderDetail(DANA)
    expect(promoteButton()).toBeInTheDocument()
  })

  it('is not offered to a non-admin editor', () => {
    adminFlag.isAdmin = false
    renderDetail(DANA)
    expect(promoteButton()).not.toBeInTheDocument()
  })

  it('is not offered to an admin on a project they can only view', () => {
    renderDetail(DANA, { canEdit: false })
    expect(promoteButton()).not.toBeInTheDocument()
  })

  it('is never offered inside the company library', () => {
    renderDetail(DANA, { scope: COMPANY_PERSONA_SCOPE })
    expect(promoteButton()).not.toBeInTheDocument()
  })

  it('posts the promote route, refreshes the library and links to it', async () => {
    route({ [PROMOTE]: () => ({ success: true, persona: { ...DANA, persona_id: 'persona_new' } }) })
    const user = userEvent.setup()
    const { invalidate } = renderDetail(DANA)
    await user.click(screen.getByRole('button', { name: 'Promote to company' }))
    expect(await screen.findByRole('link', { name: 'Open the library' })).toHaveAttribute('href', '/company?tab=personas')
    expect(fetchApi).toHaveBeenCalledWith('/projects/proj_1/personas/persona_1/promote', expect.objectContaining({ method: 'POST' }))
    await waitFor(() => expect(invalidate).toHaveBeenCalledWith({ queryKey: ['company-personas'] }))
  })

  it('says the promote failed when the request is refused without a reason', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    const user = userEvent.setup()
    renderDetail(DANA)
    await user.click(screen.getByRole('button', { name: 'Promote to company' }))
    expect(await screen.findByRole('alert')).toHaveTextContent("couldn't be copied to the company library")
  })
})

describe('Copied from', () => {
  it('names the source project and the day', () => {
    renderDetail({ ...DANA, copied_from: { scope: 'project', project_id: 'proj_2', project_name: 'Mobile App Redesign', persona_id: 'persona_3', copied_at: '2026-10-18T09:00:00Z' } })
    expect(screen.getByTestId('persona-copied-from')).toHaveTextContent(/^Copied from Mobile App Redesign on Oct 18, 2026$/)
  })

  it('names the company library', () => {
    renderDetail({ ...DANA, copied_from: { scope: 'company', persona_id: 'cpersona_1', copied_at: '2026-10-18T09:00:00Z' } })
    expect(screen.getByTestId('persona-copied-from')).toHaveTextContent(/^Copied from the company library on/)
  })

  it('leaves out a date it cannot read, and an unnamed project reads generically', () => {
    renderDetail({ ...DANA, copied_from: { scope: 'project', persona_id: 'p', copied_at: '' } })
    expect(screen.getByTestId('persona-copied-from')).toHaveTextContent(/^Copied from another project$/)
  })

  it('says nothing on a persona that is not a copy', () => {
    renderDetail(DANA)
    expect(screen.queryByTestId('persona-copied-from')).not.toBeInTheDocument()
  })
})
