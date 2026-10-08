/**
 * @fileoverview The Projects list's Edit button and dialog.
 *
 * Edit is offered on `access.can_edit` (fail closed: a card without access gets
 * none), visibility only on `access.can_manage`. Saving sends only what changed —
 * PUT /projects/{id} for name/description, PUT /projects/{id}/visibility for
 * visibility — updates the card at once and rolls it back when the save fails.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import {
  beforeEach, describe, expect, it, vi,
} from 'vitest'
import { TestRouter } from '../../test/TestRouter'
import { EDITOR_ACCESS, VIEWER_ACCESS } from '../ProjectDetail/projectAccess-fixtures'
import type { Project, ProjectAccess } from '../../api/projectTypes'

const api = vi.hoisted(() => ({
  getProjects: vi.fn(),
  createProject: vi.fn(),
  deleteProject: vi.fn(),
  updateProject: vi.fn(),
  setVisibility: vi.fn(),
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: api }))
vi.mock('../../store/configStore', () => import('@test/page-mocks').then((m) => m.configStoreHookMock({
  config: { apiEndpoint: 'https://api.example.com' },
})))

import Projects from './Projects'

const OWNER_ACCESS: ProjectAccess = { role: 'owner', can_view: true, can_edit: true, can_manage: true }

function project(id: string, name: string, access?: ProjectAccess): Project {
  return {
    project_id: id,
    name,
    description: `About ${name}`,
    status: 'active',
    created_at: '2026-01-15T10:00:00Z',
    updated_at: '2026-01-15T10:00:00Z',
    persona_count: 0,
    document_count: 0,
    visibility: 'private',
    ...(access === undefined ? {} : { access }),
  }
}

const OWNED = project('p-own', 'Owned project', OWNER_ACCESS)
const EDITABLE = project('p-edit', 'Editable project', EDITOR_ACCESS)
const VIEW_ONLY = project('p-view', 'View-only project', VIEWER_ACCESS)
const NO_ACCESS_FIELD = project('p-legacy', 'Legacy project')

function renderList(projects: Project[]) {
  api.getProjects.mockResolvedValue({ projects })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(
    <QueryClientProvider client={client}>
      <TestRouter initialEntries={['/projects']}><Projects /></TestRouter>
    </QueryClientProvider>,
  )
  return userEvent.setup()
}

const editButton = (name: string) => screen.queryByRole('button', { name: `Edit project ${name}` })
const dialog = () => screen.getByRole('dialog', { name: 'Edit Project' })
const saveButton = () => within(dialog()).getByRole('button', { name: 'Save' })

/** Renders `projects`, waits for the cards and opens the Edit dialog of `target`. */
async function openEdit(projects: Project[], target: Project) {
  const user = renderList(projects)
  await screen.findByText(target.name)
  const button = editButton(target.name)
  if (button === null) throw new Error(`no Edit button on ${target.name}`)
  await user.click(button)
  return user
}

async function rename(user: ReturnType<typeof userEvent.setup>, name: string) {
  const input = within(dialog()).getByLabelText('Project Name')
  await user.clear(input)
  if (name !== '') await user.type(input, name)
}

describe('Projects list: Edit', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    api.updateProject.mockResolvedValue({ success: true })
    api.setVisibility.mockResolvedValue({ success: true, visibility: 'public' })
  })

  it('offers Edit only on cards the caller can edit', async () => {
    renderList([OWNED, EDITABLE, VIEW_ONLY, NO_ACCESS_FIELD])
    await screen.findByText(OWNED.name)

    expect([OWNED, EDITABLE, VIEW_ONLY, NO_ACCESS_FIELD].map((p) => editButton(p.name) !== null))
      .toStrictEqual([true, true, false, false])
  })

  it('opens a dialog prefilled with the project, and Cancel closes it without a request', async () => {
    const user = await openEdit([OWNED], OWNED)

    expect(within(dialog()).getByLabelText('Project Name')).toHaveValue(OWNED.name)
    expect(within(dialog()).getByLabelText('Description')).toHaveValue(OWNED.description)
    await user.click(within(dialog()).getByRole('button', { name: 'Cancel' }))
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('closes on Escape without a request', async () => {
    const user = await openEdit([OWNED], OWNED)
    await user.keyboard('{Escape}')
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('saves only the changed fields, trimmed, and closes', async () => {
    const user = await openEdit([EDITABLE], EDITABLE)
    expect(saveButton()).toBeDisabled() // nothing changed yet

    await rename(user, '  Renamed project  ')
    await user.click(saveButton())

    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(api.updateProject).toHaveBeenCalledExactlyOnceWith(EDITABLE.project_id, { name: 'Renamed project' })
    expect(api.setVisibility).not.toHaveBeenCalled()
  })

  it('shows the new name on the card while the save is in flight, then refetches the list', async () => {
    const finishers: Array<(value: { success: boolean }) => void> = []
    api.updateProject.mockReturnValue(new Promise((resolve) => { finishers.push(resolve) }))
    const user = await openEdit([EDITABLE], EDITABLE)
    await rename(user, 'Renamed project')
    await user.click(saveButton())

    // Optimistic: the card heading changes before the server has answered.
    expect(await screen.findByRole('heading', { name: 'Renamed project' })).toBeInTheDocument()
    const listReadsBefore = api.getProjects.mock.calls.length
    api.getProjects.mockResolvedValue({ projects: [{ ...EDITABLE, name: 'Renamed project' }] })
    for (const finish of finishers) finish({ success: true })
    await waitFor(() => expect(api.getProjects.mock.calls.length).toBeGreaterThan(listReadsBefore))
    expect(screen.getByRole('heading', { name: 'Renamed project' })).toBeInTheDocument()
  })

  it('refuses a blank name: the field says why and Save stays disabled', async () => {
    const user = await openEdit([OWNED], OWNED)
    await rename(user, '')

    const input = within(dialog()).getByLabelText('Project Name')
    expect(input).toHaveAttribute('aria-invalid', 'true')
    expect(input).toHaveAccessibleDescription('Enter a project name.')
    expect(saveButton()).toBeDisabled()
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('lets a manager change visibility, through the visibility route only', async () => {
    const user = await openEdit([OWNED], OWNED)
    await user.click(within(dialog()).getByRole('radio', { name: /Public/ }))
    await user.click(saveButton())

    await waitFor(() => expect(api.setVisibility).toHaveBeenCalledExactlyOnceWith(OWNED.project_id, 'public'))
    expect(api.updateProject).not.toHaveBeenCalled()
  })

  it('shows an editor no visibility choice, only why', async () => {
    await openEdit([EDITABLE], EDITABLE)
    expect(within(dialog()).queryByRole('radio')).not.toBeInTheDocument()
    expect(within(dialog()).getByText(/Only the project's owner or an admin/)).toBeInTheDocument()
  })

  it('keeps the dialog open with an alert and restores the card when the save fails', async () => {
    api.updateProject.mockRejectedValue(new Error('API Error: 403'))
    const user = await openEdit([EDITABLE], EDITABLE)
    await rename(user, 'Never saved')
    await user.click(saveButton())

    expect(await within(dialog()).findByRole('alert')).toHaveTextContent('Could not save the project')
    // The optimistic card value is rolled back to the server's.
    await waitFor(() => expect(screen.getAllByText(EDITABLE.name).length).toBeGreaterThan(0))
    expect(screen.queryAllByRole('heading', { name: 'Never saved' })).toHaveLength(0)
  })
})
