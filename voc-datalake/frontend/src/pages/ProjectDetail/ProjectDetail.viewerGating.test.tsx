/**
 * @fileoverview Per-button gating for a viewer, through the page.
 *
 * The tab components each gate themselves on `project.access.can_edit` (or on
 * the `canEdit` the page hands them); this spec is the one that proves the page
 * actually wires that in, so a banner saying "view-only" is never shown above a
 * row of buttons that would all 403.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter, Route, Routes } from 'react-router-dom'
import {
  beforeAll, beforeEach, describe, expect, it, vi,
} from 'vitest'
import type { ProjectDocument } from '../../api/types'
import type { Project, ProjectAccess, ProjectJob, ProjectPersona } from '../../api/projectTypes'
import ProjectDetail from './ProjectDetail'
import { configureApiEndpoint, pageApi as api, stubPageReads } from './page-api-fixtures'
import { EDITOR_ACCESS, VIEWER_ACCESS } from './projectAccess-fixtures'

vi.mock('../../api/projectsApi', () => import('./page-api-fixtures').then((m) => ({ projectsApi: m.pageApi })))

const projectWith = (access: ProjectAccess): Project => ({
  project_id: 'proj-1',
  name: 'Shared project',
  description: '',
  status: 'active',
  created_at: '2026-09-01T10:00:00Z',
  updated_at: '2026-09-01T10:00:00Z',
  persona_count: 1,
  document_count: 1,
  visibility: 'private',
  access,
})

const persona: ProjectPersona = { persona_id: 'p1', name: 'Dana', tagline: 'Power user', created_at: '' }
const document: ProjectDocument = {
  document_id: 'prd-1', document_type: 'prd', title: 'Launch PRD', content: '# PRD', created_at: '2026-09-01T10:00:00Z',
}
const failedJob: ProjectJob = {
  job_id: 'job-1', job_type: 'research', status: 'failed', progress: 100, error: 'boom',
  created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
}

const page = (
  <MemoryRouter initialEntries={['/projects/proj-1']}>
    <Routes><Route path="/projects/:id" element={<ProjectDetail />} /></Routes>
  </MemoryRouter>
)

function renderPage() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  return render(<QueryClientProvider client={client}>{page}</QueryClientProvider>)
}

function stubProject(access: ProjectAccess) {
  api.getProject.mockResolvedValue({ project: projectWith(access), personas: [persona], documents: [document] })
}

/** Every one of these buttons would 403 for a viewer, so none may be offered. */
function expectNoButtons(names: readonly RegExp[]) {
  for (const name of names) expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
}

/** Renders the page, opens `tab` and selects the list row named `row`. */
async function openTabAndSelect(tab: RegExp, row: RegExp) {
  const user = userEvent.setup()
  renderPage()
  await user.click(await screen.findByRole('tab', { name: tab }))
  await user.click(screen.getByRole('button', { name: row }))
  return user
}

describe('ProjectDetail gates write controls on project.access.can_edit', () => {
  beforeAll(configureApiEndpoint)
  beforeEach(() => stubPageReads([failedJob]))

  describe('as a viewer', () => {
    beforeEach(() => stubProject(VIEWER_ACCESS))

    it('shows the read-only banner and disables the Overview write cards', async () => {
      renderPage()
      expect(await screen.findByText(/view-only access/i)).toBeInTheDocument()

      const cards = within(await screen.findByTestId('overview-cards'))
      expect(cards.getByRole('button', { name: /Run Research/i })).toBeDisabled()
      expect(cards.getAllByRole('button', { name: /Generate/i }).every((b) => b.hasAttribute('disabled'))).toBe(true)
      expect(cards.getByRole('button', { name: /Open/i })).toBeEnabled()
    })

    it('offers no Dismiss on a finished job', async () => {
      renderPage()
      await screen.findByText('boom')
      expect(screen.queryByRole('button', { name: /dismiss/i })).not.toBeInTheDocument()
    })

    it('hides Import / Generate / Edit / Delete on the Personas tab', async () => {
      await openTabAndSelect(/personas/i, /@Dana/)

      expectNoButtons([/Import Persona/i, /Generate Personas/i, /Edit persona/i, /Delete persona/i])
    })

    it('hides New Document / Edit / Delete on the Documents tab', async () => {
      await openTabAndSelect(/documents/i, /Launch PRD/)

      expectNoButtons([/New Document/i, /Edit document/i, /Delete document/i])
    })
  })

  describe('as an editor', () => {
    beforeEach(() => stubProject(EDITOR_ACCESS))

    it('shows no banner, enabled Overview cards and a Dismiss on the finished job', async () => {
      renderPage()
      const cards = within(await screen.findByTestId('overview-cards'))
      expect(screen.queryByText(/view-only access/i)).not.toBeInTheDocument()
      expect(cards.getByRole('button', { name: /Run Research/i })).toBeEnabled()
      expect(await screen.findByRole('button', { name: /dismiss/i })).toBeInTheDocument()
    })

    it('keeps the write controls on the Personas and Documents tabs', async () => {
      const user = await openTabAndSelect(/personas/i, /@Dana/)
      expect(screen.getByRole('button', { name: /Generate Personas/i })).toBeInTheDocument()
      expect(screen.getByRole('button', { name: /Edit persona/i })).toBeInTheDocument()

      await user.click(screen.getByRole('tab', { name: /documents/i }))
      expect(screen.getByRole('button', { name: /New Document/i })).toBeInTheDocument()
    })
  })
})
