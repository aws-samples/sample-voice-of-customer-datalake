/**
 * The project document adapter's contract (the document component's first adapter): who edits and why not, which
 * version a save is checked against, what the PUT carries (the revision, the Revise pass only for a PRD / PR/FAQ, the
 * title only for a research / custom document), "Save mine anyway" unchecked, a 403 left to the server, and a
 * refused revise read as the save's refusal.
 */
import { renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createQueryWrapper } from '@test/query-client'
import { ApiError } from '../../lib/errors'
import { projectsApi } from '../../api/projectsApi'
import { makeDocument, makeProject } from './project-detail-fixtures'
import { VIEWER_ACCESS } from './projectAccess-fixtures'
import { useProjectDocumentAdapter } from './documentAdapter'
import type { ProjectDocument } from '../../api/types'

vi.mock('../../api/projectsApi', () => ({ projectsApi: { updateDocument: vi.fn(), getProject: vi.fn() } }))

const updateDocument = vi.mocked(projectsApi.updateDocument)
const PRD = makeDocument({ document_id: 'prd_2', document_type: 'prd', title: 'Launch (v2)', content: 'Old', version: 2 })
const NOTES = makeDocument({ document_id: 'doc_1', document_type: 'custom', title: 'Notes', content: 'Old', revision: 4 })

function adapterFor(document: ProjectDocument, project = makeProject()) {
  return renderHook(() => useProjectDocumentAdapter(project, document), { wrapper: createQueryWrapper() }).result.current
}

beforeEach(() => {
  updateDocument.mockReset()
  updateDocument.mockResolvedValue({ document: { ...PRD, version: 3, document_id: 'prd_3' } })
})

describe('useProjectDocumentAdapter', () => {
  it('lets an editor write a document of the canvas, and says why not otherwise', () => {
    expect([
      adapterFor(PRD).permissions.edit,
      adapterFor(PRD, makeProject({ access: VIEWER_ACCESS })).permissions.edit,
      adapterFor(makeDocument({ document_type: 'decision' })).permissions.edit,
    ]).toStrictEqual([true, 'viewer', 'editedElsewhere'])
  })

  it('names a version by its series version or its revision, and renames only a research / custom document', () => {
    expect([adapterFor(PRD).versionOf(PRD), adapterFor(NOTES).versionOf(NOTES)])
      .toStrictEqual([{ token: 'prd_2:2', number: 2 }, { token: 'doc_1:4', number: 4 }])
    expect([adapterFor(PRD).rename === undefined, adapterFor(NOTES).rename === undefined]).toStrictEqual([true, false])
  })

  it('saves a PRD checked against its series version, naming the Revise pass its text keeps', async () => {
    await adapterFor(PRD).save?.({ title: 'Launch (v2)', content: 'New' }, PRD, { checked: true, mark: 'job-7' })

    expect(updateDocument).toHaveBeenCalledWith('proj-123', 'prd_2',
      expect.objectContaining({ content: 'New', expected_revision: 2 }), 'job-7')
    expect(updateDocument.mock.calls[0]?.[2]).not.toHaveProperty('title')
  })

  it('saves mine anyway unchecked, with the title of a custom document and no pass', async () => {
    await adapterFor(NOTES).save?.({ title: 'Renamed', content: 'New' }, NOTES, { checked: false, mark: 'job-7' })

    expect(updateDocument.mock.calls[0]?.[2]).toStrictEqual(expect.objectContaining({ title: 'Renamed', content: 'New' }))
    expect(updateDocument.mock.calls[0]?.[2]).not.toHaveProperty('expected_revision')
    expect(updateDocument.mock.calls[0]).toHaveLength(3)
  })

  it('leaves a 403 to the caller as a failed save, and reads a refused revise as the refusal', async () => {
    const adapter = adapterFor(PRD)
    updateDocument.mockRejectedValueOnce(new ApiError(403, 'Forbidden'))

    await expect(adapter.save?.({ title: 'x', content: 'y' }, PRD, { checked: true, mark: null })).rejects.toThrow('Forbidden')
    expect(adapter.refusalOf?.(new ApiError(400, 'The pass changed', 'revise_refused'))).toStrictEqual({ message: 'The pass changed' })
    expect(adapter.refusalOf?.(new ApiError(400, 'Bad'))).toBeNull()
  })
})
