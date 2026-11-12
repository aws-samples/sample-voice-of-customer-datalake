/**
 * The document page's action bar: the save status (version and time of the stored version,
 * "Unsaved changes", "Saving…"), Save / Discard for editors only, Share for a PR/FAQ or PRD
 * only, Export of the saved version, History (restoring a version selects it, which reloads
 * the canvas) and Delete; the conflict banner under it.
 */
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import enProjectDetail from '../../../../public/locales/en/projectDetail.json'
import enComponents from '../../../../public/locales/en/components.json'
import { makeProject } from '../../../pages/ProjectDetail/project-detail-fixtures'
import { useActionBarRects } from '../../StickyActionBar/actionBarRegistry'
import { canvasState } from './canvas-state-fixtures'
import DocumentActionsBar from './DocumentActionsBar'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

const api = vi.hoisted(() => ({
  getDocumentVersions: vi.fn<(projectId: string, documentId: string) => Promise<DocumentVersion[]>>(),
  restoreDocumentVersion: vi.fn<(projectId: string, documentId: string, versionId: string, editId: string) => Promise<ProjectDocument | null>>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: api }))

const actions = enProjectDetail.canvas.actions
const project = makeProject({ project_id: 'p1' })
const prd: ProjectDocument = {
  document_id: 'prd-3', document_type: 'prd', base_title: 'Launch', version: 3, title: 'Launch (v3)', content: '# Launch',
  created_at: '2026-10-01T00:00:00Z', updated_at: new Date(Date.now() - 2 * 60_000).toISOString(),
}
const custom: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', content: 'text', revision: 4, created_at: '2026-10-01T00:00:00Z',
}

const share = { share: null, createShare: vi.fn(), revokeShare: vi.fn() }

function renderBar({ document = prd, canEdit = true, state = canvasState(), withShare = true } = {}) {
  const onDeleteDoc = vi.fn()
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <DocumentActionsBar project={project} document={document} canEdit={canEdit} state={state}
        share={withShare ? share : null} onDeleteDoc={onDeleteDoc} isDeleting={false} />
    </QueryClientProvider>,
  )
  return { onDeleteDoc, state, user: userEvent.setup() }
}

const status = () => screen.getByRole('status')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('DocumentActionsBar', () => {
  it('says which version is saved and when, with Save and Discard disabled while clean', () => {
    renderBar()
    expect(status()).toHaveTextContent(/^Saved · v3 · 2 min\. ago$/)
    expect(screen.getByRole('button', { name: actions.save })).toBeDisabled()
    expect(screen.getByRole('button', { name: actions.discard })).toBeDisabled()
  })

  it('counts a research / custom document\'s edits as its version', () => {
    renderBar({ document: custom })
    expect(status()).toHaveTextContent(/Saved · v4/)
  })

  it('says "Unsaved changes" and saves or discards while dirty', async () => {
    const { user, state } = renderBar({ state: canvasState({ dirty: true }) })
    expect(status()).toHaveTextContent(actions.status.unsaved)

    await user.click(screen.getByRole('button', { name: actions.save }))
    await user.click(screen.getByRole('button', { name: actions.discard }))

    expect(state.save).toHaveBeenCalledTimes(1)
    expect(state.discard).toHaveBeenCalledTimes(1)
  })

  it('registers Save and Discard as a bottom action bar, so the assistant launcher lifts above them (phone)', async () => {
    const box = { top: 780, bottom: 844, left: 0, right: 390, width: 390, height: 64, x: 0, y: 780 }
    const measured = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ ...box, toJSON: () => box })
    onTestFinished(() => measured.mockRestore())
    function LauncherProbe() {
      return <p data-testid="bars">{useActionBarRects().length}</p>
    }
    render(<LauncherProbe />)
    renderBar({ state: canvasState({ dirty: true }) })

    await waitFor(() => expect(screen.getByTestId('bars')).toHaveTextContent('1'))
    expect(screen.getByRole('button', { name: actions.save }).closest('[data-action-bar]')).not.toBeNull()
  })

  it('says "Saving…" while a save is in flight', () => {
    renderBar({ state: canvasState({ dirty: true, saving: true }) })
    expect(status()).toHaveTextContent(actions.status.saving)
    expect(screen.getByRole('button', { name: actions.status.saving })).toBeDisabled()
  })

  it('shows a viewer no control that writes', () => {
    renderBar({ canEdit: false, state: canvasState({ editable: false }) })
    for (const name of [actions.save, actions.discard, enComponents.reviewShare.open, enProjectDetail.documents.deleteDocument]) {
      expect(screen.queryByRole('button', { name })).not.toBeInTheDocument()
    }
    expect(screen.getByRole('button', { name: actions.history })).toBeInTheDocument()
  })

  it('offers Share for a PR/FAQ or PRD only', () => {
    renderBar()
    expect(screen.getByRole('button', { name: enComponents.reviewShare.open })).toBeInTheDocument()
  })

  it('offers no Share without the comments\' controls (the page passes none for a research / custom document)', () => {
    renderBar({ document: custom, withShare: false })
    expect(screen.queryByRole('button', { name: enComponents.reviewShare.open })).not.toBeInTheDocument()
  })

  it('opens the review-link dialog with the share controls', async () => {
    const { user } = renderBar()
    await user.click(screen.getByRole('button', { name: enComponents.reviewShare.open }))
    expect(screen.getByRole('dialog', { name: enComponents.reviewShare.title })).toBeInTheDocument()
  })

  it('tells a writer with unsaved changes that Export uses the saved version', () => {
    renderBar({ state: canvasState({ dirty: true }) })
    expect(screen.getByText(actions.exportSavedHint)).toBeInTheDocument()
  })

  it('deletes through the page', async () => {
    const { user, onDeleteDoc } = renderBar()
    await user.click(screen.getByRole('button', { name: enProjectDetail.documents.deleteDocument }))
    expect(onDeleteDoc).toHaveBeenCalledTimes(1)
  })

  it('shows the conflict banner under the bar', () => {
    renderBar({ state: canvasState({ conflict: { onLoadLatest: vi.fn(), onSaveAnyway: vi.fn(), saving: false, loading: false } }) })
    expect(screen.getByRole('alert')).toHaveTextContent(enProjectDetail.documentModal.conflict)
  })

  it('holds both of the conflict\'s ways out while a save is on its way, and says so', () => {
    renderBar({ state: canvasState({ conflict: { onLoadLatest: vi.fn(), onSaveAnyway: vi.fn(), saving: true, loading: false } }) })
    const alert = within(screen.getByRole('alert'))
    expect(alert.getByRole('button', { name: enProjectDetail.documentModal.conflictReload })).toBeDisabled()
    expect(alert.getByRole('button', { name: enProjectDetail.canvas.actions.status.saving })).toBeDisabled()
    expect(alert.queryByRole('button', { name: enProjectDetail.documentModal.conflictSaveAnyway })).not.toBeInTheDocument()
  })

  it('History lists the versions; restoring one selects it (the canvas reloads) and closes', async () => {
    const restored = { ...prd, document_id: 'prd-4', version: 4, title: 'Launch (v4)' }
    api.getDocumentVersions.mockResolvedValue([
      { version_id: 'prd-3', document_id: 'prd-3', version: 3, title: 'Launch (v3)', content: '# Launch', created_at: '2026-10-03T00:00:00Z', current: true, edit_kind: null, restored_from_version: null },
      { version_id: 'prd-1', document_id: 'prd-1', version: 1, title: 'Launch (v1)', content: '# Old', created_at: '2026-10-01T00:00:00Z', current: false, edit_kind: null, restored_from_version: null },
    ])
    api.restoreDocumentVersion.mockResolvedValue(restored)
    const { user, state } = renderBar()

    await user.click(screen.getByRole('button', { name: actions.history }))
    const dialog = screen.getByRole('dialog', { name: enProjectDetail.documents.versions.title })
    await user.click(await within(dialog).findByRole('button', { name: 'Restore v1' }))
    await user.click(within(screen.getByRole('dialog', { name: enProjectDetail.documents.versions.restoreTitle }))
      .getByRole('button', { name: enProjectDetail.documents.versions.restore }))

    await vi.waitFor(() => { expect(state.selectDoc).toHaveBeenCalledWith(restored) })
    expect(screen.queryByRole('dialog', { name: enProjectDetail.documents.versions.title })).not.toBeInTheDocument()
  })

  it('gives a decision (edited in its tab) no Save and no History, but Export and Delete', () => {
    renderBar({ document: { ...custom, document_type: 'decision' }, state: canvasState({ editable: false }) })
    expect(screen.queryByRole('button', { name: actions.save })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: actions.history })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: enProjectDetail.documents.deleteDocument })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: enComponents.documentExport.downloadOptions })).toBeInTheDocument()
  })
})
