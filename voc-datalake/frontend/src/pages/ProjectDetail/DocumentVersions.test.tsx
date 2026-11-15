/**
 * QA s3 F4: a document had no history in the UI. The Versions list (the document
 * page's History dialog) lists every version newest first, opens one, compares one with the
 * current version, and restores one as a NEW version (selected afterwards).
 * Viewers can open and compare, never restore.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { required } from '../../components/component-spec-fixtures'
import DocumentVersions from './DocumentVersions'
import type { DocumentVersion } from '../../api/projectDetailSchema'
import type { ProjectDocument } from '../../api/types'

const getDocumentVersions = vi.hoisted(() => vi.fn<(projectId: string, documentId: string) => Promise<DocumentVersion[]>>())
const restoreDocumentVersion = vi.hoisted(() => vi.fn<(projectId: string, documentId: string, versionId: string, editId: string) => Promise<ProjectDocument | null>>())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { getDocumentVersions, restoreDocumentVersion } }))

const doc: ProjectDocument = {
  document_id: 'prd_2', document_type: 'prd', title: 'Launch (v2)', base_title: 'Launch', version: 2,
  content: '# Launch\nShip on Friday', created_at: '2026-05-02T10:00:00Z',
}

const version = (n: number, content: string, extra: Partial<DocumentVersion> = {}): DocumentVersion => ({
  version_id: `prd_${String(n)}`, document_id: `prd_${String(n)}`, version: n, title: `Launch (v${String(n)})`,
  content, created_at: `2026-05-0${String(n)}T10:00:00Z`, current: false, edit_kind: null, restored_from_version: null, ...extra,
})

/** The list's rows once `versions` are listed. */
async function listedRows(versions: DocumentVersion[]) {
  getDocumentVersions.mockResolvedValue(versions)
  renderWithQueryClient(<DocumentVersions projectId="proj_1" document={doc} canEdit onSelectDoc={vi.fn()} />)
  return screen.findAllByRole('listitem')
}

async function openVersions(canEdit = true) {
  const onSelectDoc = vi.fn()
  const user = userEvent.setup()
  renderWithQueryClient(<DocumentVersions projectId="proj_1" document={doc} canEdit={canEdit} onSelectDoc={onSelectDoc} />)
  await screen.findByText('v1')
  return { user, onSelectDoc }
}

describe('DocumentVersions', () => {
  beforeEach(() => {
    getDocumentVersions.mockReset()
    restoreDocumentVersion.mockReset()
    getDocumentVersions.mockResolvedValue([
      version(2, '# Launch\nShip on Friday', { current: true, edit_kind: 'edit' }),
      version(1, '# Launch\nShip on Monday'),
    ])
  })

  it('lists every version newest first', async () => {
    renderWithQueryClient(<DocumentVersions projectId="proj_1" document={doc} canEdit onSelectDoc={vi.fn()} />)

    const rows = await screen.findAllByRole('listitem')
    expect(rows.map((row) => within(row).getByText(/^v\d$/).textContent)).toStrictEqual(['v2', 'v1'])
    expect(within(required(rows[0], 'the newest row')).getByText('Current')).toBeInTheDocument()
  })

  it('marks a version saved from "Revise from comments" (edit_kind revise), and only that one', async () => {
    const rows = await listedRows([
      version(3, '# Launch\nShip on Friday', { current: true, edit_kind: 'revise' }),
      version(2, '# Launch\nShip on Tuesday', { edit_kind: 'edit' }),
      version(1, '# Launch\nShip on Monday'),
    ])
    expect(rows.map((row) => within(row).queryByText('Revised from comments') !== null)).toStrictEqual([true, false, false])
    expect(within(required(rows[1], 'the edited row')).getByText('Edited')).toBeInTheDocument()
  })

  it('names the model that wrote a revised version: its label, else its id, else nothing', async () => {
    const rows = await listedRows([
      version(3, 'c', { current: true, edit_kind: 'revise',
        llm_metadata: { model: 'global.example-model', model_label: 'Example Model' } }),
      version(2, 'b', { edit_kind: 'revise', llm_metadata: { model: 'retired-model', model_label: null } }),
      version(1, 'a', { edit_kind: 'revise' }),
    ])
    expect(rows.map((row) => within(row).getByText(/^Revised from comments/).textContent)).toStrictEqual([
      'Revised from comments · Example Model', 'Revised from comments · retired-model', 'Revised from comments',
    ])
  })

  it('compares an earlier version with the current one', async () => {
    const { user } = await openVersions()

    await user.click(screen.getByRole('button', { name: 'Compare v1 with the current version' }))

    const dialog = await screen.findByRole('dialog')
    expect(within(dialog).getByText('1 lines added, 1 lines removed')).toBeInTheDocument()
  })

  it('restores an earlier version as a new one and selects it', async () => {
    const restored = { ...doc, document_id: 'prd_3', version: 3, title: 'Launch (v3)' }
    restoreDocumentVersion.mockResolvedValue(restored)
    const { user, onSelectDoc } = await openVersions()

    await user.click(screen.getByRole('button', { name: 'Restore v1' }))
    await user.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Restore' }))

    await vi.waitFor(() => { expect(onSelectDoc).toHaveBeenCalledWith(restored) })
    expect(restoreDocumentVersion).toHaveBeenCalledWith('proj_1', 'prd_2', 'prd_1', expect.any(String))
  })

  it('lets a viewer open a version but not restore one', async () => {
    const { user } = await openVersions(false)

    expect(screen.queryByRole('button', { name: 'Restore v1' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open v1' }))
    expect(within(await screen.findByRole('dialog')).getByText('Ship on Monday')).toBeInTheDocument()
  })
})
