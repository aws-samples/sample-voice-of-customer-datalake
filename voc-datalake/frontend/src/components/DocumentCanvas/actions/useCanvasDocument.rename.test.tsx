/**
 * Renaming a document in place (useCanvasDocument `rename`, useDocumentSave): a research / custom title is saved at
 * once as ONE new version carrying the title alone (no content: the server keeps the stored text, so what was typed
 * and not saved stays the draft), with the revision the canvas holds; the same name saves nothing; a PRD / PR/FAQ
 * title (its series') is never sent; a rename that meets a newer save is the conflict, with the name kept unsaved.
 */
import { screen, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ApiError } from '../../../lib/errors'
import { canvas, custom, mount, prd } from './canvas-document-fixtures'
import type { ProjectDocument } from '../../../api/types'
import type { UpdateDocument } from './canvas-document-fixtures'

const updateDocument = vi.hoisted(() => vi.fn<UpdateDocument>())
vi.mock('../../../api/projectsApi', () => ({ projectsApi: { updateDocument } }))

/** Every PUT answers the version it stored: what it sent over `edited`, one revision on. */
function stores(edited: ProjectDocument) {
  updateDocument.mockImplementation((_projectId, _documentId, body) => Promise.resolve({
    document: {
      ...edited, title: typeof body['title'] === 'string' ? body['title'] : edited.title,
      content: typeof body['content'] === 'string' ? body['content'] : edited.content, revision: (edited.revision ?? 1) + 1,
    },
  }))
}

/** Each PUT's body with its fresh edit id reduced to its type. */
const bodies = () => updateDocument.mock.calls.map(([, , body]) => ({ ...body, edit_id: typeof body['edit_id'] }))

beforeEach(() => { updateDocument.mockReset() })

describe('rename', () => {
  it('saves the title alone at once, with the revision the canvas holds, and the canvas is clean again', async () => {
    stores(custom)
    const { user } = mount(custom)
    await user.click(screen.getByRole('button', { name: 'rename' }))
    await waitFor(() => expect(bodies()).toStrictEqual([{ title: 'Renamed', expected_revision: 4, edit_id: 'string' }]))
    await waitFor(() => expect(screen.getByTestId('dirty')).toHaveTextContent('false'))
    expect(screen.getByRole('textbox', { name: 'title' })).toHaveValue('Renamed')
  })

  it('keeps text typed and not saved as the draft, on top of the renamed version', async () => {
    stores(custom)
    const { user } = mount(custom)
    await user.type(canvas(), '!')
    await user.click(screen.getByRole('button', { name: 'rename' }))
    await waitFor(() => expect(screen.getByTestId('last-saved')).toHaveTextContent('doc-1:stored'))
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    expect(canvas()).toHaveValue('stored!')
    stores({ ...custom, title: 'Renamed', revision: 5 })
    await user.click(screen.getByRole('button', { name: 'save' }))
    await waitFor(() => expect(bodies().at(1)).toStrictEqual({ title: 'Renamed', content: 'stored!', expected_revision: 5, edit_id: 'string' }))
  })

  it('sends nothing for a PRD, whose title is its series\'', async () => {
    const { user } = mount(prd)
    await user.click(screen.getByRole('button', { name: 'rename' }))
    expect([updateDocument.mock.calls.length, screen.getByTestId('dirty').textContent]).toStrictEqual([0, 'false'])
  })

  it('meets a newer save as the conflict, the new name kept unsaved', async () => {
    updateDocument.mockRejectedValue(new ApiError(409, 'stale'))
    const { user } = mount(custom)
    await user.click(screen.getByRole('button', { name: 'rename' }))
    expect(await screen.findByRole('button', { name: 'load latest' })).toBeInTheDocument()
    expect(screen.getByTestId('dirty')).toHaveTextContent('true')
    expect(screen.getByRole('textbox', { name: 'title' })).toHaveValue('Renamed')
  })
})
