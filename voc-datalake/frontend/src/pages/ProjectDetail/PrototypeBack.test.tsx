/**
 * Back to vN on a prototype (docs/prototype-builder.md, part 2): one click restores an earlier
 * version as a NEW one through the existing restore route, then selects it. On the newest version
 * the button names the version before it; on an older one, that version itself; with one version
 * there is nothing to go back to.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import PrototypeBackButton from './PrototypeBack'
import { backTarget } from './documentEdit'
import type { ProjectDocument } from '../../api/types'
import { ApiError } from '../../lib/errors'

const restoreDocumentVersion = vi.hoisted(() => vi.fn<(projectId: string, documentId: string, versionId: string, editId: string) => Promise<ProjectDocument | null>>())
vi.mock('../../api/projectsApi', () => ({ projectsApi: { restoreDocumentVersion } }))

const prototype = (n: number, extra: Partial<ProjectDocument> = {}): ProjectDocument => ({
  document_id: `proto_${String(n)}`, document_type: 'prototype', title: `Checkout (v${String(n)})`,
  base_title: 'Checkout', version: n, content: '', created_at: `2026-05-0${String(n)}T10:00:00Z`, ...extra,
})
const v1 = prototype(1)
const v2 = prototype(2)
const v3 = prototype(3)
const otherSeries = prototype(9, { document_id: 'other_9', title: 'Onboarding (v9)', base_title: 'Onboarding' })
const documents = [v1, v3, otherSeries, v2]

function renderButton(document: ProjectDocument, docs: ProjectDocument[] = documents) {
  const onSelectDoc = vi.fn()
  renderWithQueryClient(<PrototypeBackButton projectId="proj_1" document={document} documents={docs} onSelectDoc={onSelectDoc} />)
  return { user: userEvent.setup(), onSelectDoc }
}

describe('backTarget', () => {
  it('goes back from the newest version to the one before it, ignoring other series', () => {
    expect(backTarget(v3, documents)).toStrictEqual({ target: v2, kind: 'back' })
  })

  it('offers an older version itself', () => {
    expect(backTarget(v1, documents)).toStrictEqual({ target: v1, kind: 'restore' })
  })

  it('has nothing to go back to with one version, or without a version number', () => {
    expect(backTarget(v1, [v1])).toBeNull()
    expect(backTarget(prototype(1, { version: undefined }), documents)).toBeNull()
  })

  it('offers no way back to an early JSON screen spec (it has no HTML), but does to inline HTML', () => {
    const spec = prototype(1, { content: '{"title": "Checkout", "screens": []}' })
    const inline = prototype(1, { content: '<!doctype html><html></html>', prototype_format: 'html' })
    expect(backTarget(v2, [spec, v2])).toBeNull()
    expect(backTarget(spec, [spec, v2])).toBeNull()
    expect(backTarget(v2, [inline, v2])).toStrictEqual({ target: inline, kind: 'back' })
  })
})

describe('PrototypeBackButton', () => {
  beforeEach(() => {
    restoreDocumentVersion.mockReset()
  })

  it('restores the version before the newest in one click, and selects the new version', async () => {
    const v4 = prototype(4)
    restoreDocumentVersion.mockResolvedValue(v4)
    const { user, onSelectDoc } = renderButton(v3)

    await user.click(screen.getByRole('button', { name: 'Back to v2' }))

    expect(restoreDocumentVersion).toHaveBeenCalledTimes(1)
    const [projectId, documentId, versionId, editId] = restoreDocumentVersion.mock.calls[0] ?? []
    expect([projectId, documentId, versionId]).toStrictEqual(['proj_1', 'proto_3', 'proto_2'])
    expect(editId).toMatch(/^[\w-]{1,64}$/u)
    await vi.waitFor(() => { expect(onSelectDoc).toHaveBeenCalledWith(v4) })
  })

  it('on an older version restores that version', async () => {
    restoreDocumentVersion.mockResolvedValue(prototype(4))
    const { user } = renderButton(v1)

    await user.click(screen.getByRole('button', { name: 'Restore v1' }))

    expect(restoreDocumentVersion.mock.calls[0]?.[2]).toBe('proto_1')
  })

  it('says that nothing is deleted', () => {
    renderButton(v3)

    expect(screen.getByRole('button', { name: 'Back to v2' })).toHaveAttribute(
      'title', 'Saves v2 again as the newest version. Nothing is deleted.')
  })

  it('says so when the restore fails, and selects nothing', async () => {
    restoreDocumentVersion.mockRejectedValue(new Error('boom'))
    const { user, onSelectDoc } = renderButton(v3)

    await user.click(screen.getByRole('button', { name: 'Back to v2' }))

    expect(await screen.findByRole('alert')).toBeInTheDocument()
    expect(onSelectDoc).not.toHaveBeenCalled()
  })

  const GONE = "This version's HTML is no longer stored, so it cannot be restored"
  const RETRY = "The version couldn't be restored. Try again."

  // A refusal the server explains is shown in its words (trying again cannot help); a server failure, or a
  // refusal without a reason, keeps "try again".
  it.each([
    ['a refusal with its reason', new ApiError(404, GONE), GONE],
    ['a refusal without one', new ApiError(404), RETRY],
    ['a server failure', new ApiError(500, 'Internal error'), RETRY],
  ])('on %s the alert reads its text', async (_case, error, text) => {
    restoreDocumentVersion.mockRejectedValue(error)
    const { user } = renderButton(v3)

    await user.click(screen.getByRole('button', { name: 'Back to v2' }))

    expect(await screen.findByRole('alert')).toHaveTextContent(text)
  })

  it('renders nothing with a single version', () => {
    const { container } = renderWithQueryClient(
      <PrototypeBackButton projectId="proj_1" document={v1} documents={[v1]} onSelectDoc={vi.fn()} />)

    expect(container).toBeEmptyDOMElement()
  })
})
