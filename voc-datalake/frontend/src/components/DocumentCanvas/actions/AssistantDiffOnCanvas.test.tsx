/**
 * The assistant's pending `update_document` card for THIS document shows on its page: a banner,
 * Review opens the block diff over the saved text, and Approve / Decline answer the same approval
 * through the card's own path (the tool's executor, then resolveApproval on its conversation);
 * after an approved edit the canvas reloads on the new version.
 */
import { act, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestQueryClient } from '../../../test/query-client'
import enProjectDetail from '../../../../public/locales/en/projectDetail.json'
import enTools from '../../../../public/locales/en/assistantTools.json'
import { resetExecutions } from '../../../assistant/approvals/executionStore'
import { useThreadStore } from '../../../assistant/store/assistantStore'
import { createThreadState } from '../../../assistant/thread/reducer'
import AssistantDiffOnCanvas from './AssistantDiffOnCanvas'
import { canvasState } from './canvas-state-fixtures'
import type { ApprovalResolution } from '../../../assistant/types'
import type { DocumentVersion } from '../../../api/projectDetailSchema'
import type { ProjectDocument } from '../../../api/types'

const m = vi.hoisted(() => ({
  updateDocument: vi.fn<(projectId: string, documentId: string, body: Record<string, unknown>) => Promise<unknown>>(),
  getDocumentVersions: vi.fn<(projectId: string, documentId: string) => Promise<DocumentVersion[]>>(),
  resolveApproval: vi.fn<(resolution: ApprovalResolution, env: unknown, threadId: string) => void>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: { updateDocument: m.updateDocument, getDocumentVersions: m.getDocumentVersions } }))
vi.mock('../../../assistant/runtime/runtime', () => ({ resolveApproval: m.resolveApproval }))

const assistant = enProjectDetail.canvas.actions.assistant
const document: ProjectDocument = {
  document_id: 'doc-1', document_type: 'custom', title: 'Notes', revision: 2, created_at: '2026-10-01T00:00:00Z',
  content: '# Notes\n\nKeep this.\n\nOld paragraph.',
}
const proposal = '# Notes\n\nKeep this.\n\nNew paragraph.'

function seedPendingEdit(args: Record<string, unknown>, threadId = 't1') {
  const toolCallId = `tc-${threadId}`
  useThreadStore.getState().replace({
    ...createThreadState(threadId),
    messages: [{ id: 'a1', role: 'assistant', toolCalls: [{ id: toolCallId, type: 'function', function: { name: 'update_document', arguments: '' } }] }],
    toolCallArgs: { [toolCallId]: args },
    pendingInterrupts: [{
      id: `approval:${toolCallId}`, toolCallId, message: 'Update the document',
      expiresAt: new Date(Date.now() + 10 * 60_000).toISOString(), metadata: { toolName: 'update_document', risk: 'write', projectId: 'p1' },
    }],
    status: 'awaiting_approval',
  })
}

const editArgs = { project_id: 'p1', document_id: 'doc-1', content: proposal, change_summary: 'Rewrote the last paragraph' }

function renderDiff(state = canvasState(), shown: ProjectDocument = document) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={[`/projects/p1?tab=documents&doc=${shown.document_id}`]}>
        <AssistantDiffOnCanvas projectId="p1" document={shown} state={state} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { state, user: userEvent.setup() }
}

/** Review, then Approve: once the canvas reloaded, the write the approval sent (projectId, documentId, body). */
async function approveReviewed(user: ReturnType<typeof userEvent.setup>, state: ReturnType<typeof canvasState>) {
  await user.click(screen.getByRole('button', { name: assistant.review }))
  await user.click(screen.getByRole('button', { name: enTools.card.approve }))
  await vi.waitFor(() => { expect(state.reloadLatest).toHaveBeenCalledTimes(1) })
  return m.updateDocument.mock.calls[0] ?? []
}

/** The block diff's removed and added blocks, as read. */
function diffBlocks() {
  const diff = screen.getByRole('group', { name: assistant.diffLabel })
  const text = (kind: string) => [...diff.querySelectorAll(`[data-diff="${kind}"]`)].map((block) => block.textContent)
  return { removed: text('del'), added: text('add') }
}

beforeEach(() => {
  vi.clearAllMocks()
  resetExecutions()
  useThreadStore.getState().reset()
})

describe('AssistantDiffOnCanvas', () => {
  it('shows nothing when no suggestion targets this document', () => {
    seedPendingEdit({ ...editArgs, document_id: 'doc-other' })
    renderDiff()
    expect(screen.queryByText(assistant.banner)).not.toBeInTheDocument()
  })

  it('says the assistant suggests changes; Review shows the block diff over the saved text', async () => {
    seedPendingEdit(editArgs)
    const { user } = renderDiff()

    const banner = screen.getByRole('region', { name: assistant.banner })
    expect(within(banner).getByText('Rewrote the last paragraph')).toBeInTheDocument()
    await user.click(within(banner).getByRole('button', { name: assistant.review }))

    const diff = within(banner).getByRole('group', { name: assistant.diffLabel })
    const block = (kind: string) => {
      const found = diff.querySelector(`[data-diff="${kind}"]`)
      return { text: found?.textContent, className: found?.className ?? '' }
    }
    expect([block('del').text, block('add').text]).toStrictEqual([
      `${assistant.removed}: Old paragraph.`, `${assistant.added}: New paragraph.`,
    ])
    expect([block('del').className.includes('line-through'), block('del').className.includes('bg-danger-subtle'),
      block('add').className.includes('bg-ok-subtle')]).toStrictEqual([true, true, true])
    expect(within(banner).getByRole('button', { name: assistant.hide })).toHaveAttribute('aria-expanded', 'true')
  })

  it('points Review at the diff only while the diff is on screen', async () => {
    seedPendingEdit(editArgs)
    const { user } = renderDiff()
    const toggle = screen.getByRole('button', { name: assistant.review })
    expect(toggle).not.toHaveAttribute('aria-controls')

    await user.click(toggle)

    const controlled = toggle.getAttribute('aria-controls') ?? ''
    expect(globalThis.document.getElementById(controlled)).toBe(screen.getByRole('group', { name: assistant.diffLabel }))
  })

  it('Approve runs the card\'s own write and answers the same approval, then reloads the canvas', async () => {
    m.updateDocument.mockResolvedValue({ document: { ...document, content: proposal, revision: 3 } })
    seedPendingEdit(editArgs)
    const { user, state } = renderDiff()

    const [projectId, documentId, body] = await approveReviewed(user, state)
    expect([projectId, documentId, body?.content, typeof body?.edit_id]).toStrictEqual(['p1', 'doc-1', proposal, 'string'])
    const [resolution, , threadId] = m.resolveApproval.mock.calls[0] ?? []
    expect([resolution?.interruptId, resolution?.toolCallId, resolution?.outcome.status, threadId])
      .toStrictEqual(['approval:tc-t1', 'tc-t1', 'executed', 't1'])
  })

  it('Decline answers the approval as declined and writes nothing', async () => {
    seedPendingEdit(editArgs)
    const { user, state } = renderDiff()

    await user.click(screen.getByRole('button', { name: assistant.review }))
    await user.click(screen.getByRole('button', { name: enTools.card.decline }))
    await user.type(screen.getByRole('textbox', { name: enTools.card.reasonLabel }), 'Keep the old one')
    await user.click(screen.getByRole('button', { name: enTools.card.confirmDecline }))

    expect(m.resolveApproval).toHaveBeenCalledWith(
      expect.objectContaining({ interruptId: 'approval:tc-t1', outcome: { status: 'declined', reason: 'Keep the old one' } }),
      expect.anything(), 't1',
    )
    expect(m.updateDocument).not.toHaveBeenCalled()
    expect(state.reloadLatest).not.toHaveBeenCalled()
  })

  describe('a suggestion on another version of the same PRD series', () => {
    const prdV4: ProjectDocument = {
      document_id: 'prd-4', document_type: 'prd', base_title: 'Launch', version: 4, title: 'Launch (v4)',
      content: '# Launch\n\nShip in May.\n\nFour.', created_at: '2026-10-04T00:00:00Z',
    }
    const v3Content = '# Launch\n\nShip in April.'
    const versionRow = (n: number, content: string, current = false): DocumentVersion => ({
      version_id: `prd-${String(n)}`, document_id: `prd-${String(n)}`, version: n, title: `Launch (v${String(n)})`, content,
      created_at: null, current, edit_kind: null, restored_from_version: null,
    })
    const onV3 = { project_id: 'p1', document_id: 'prd-3', content: '# Launch\n\nShip in June.', change_summary: 'Moved the date' }

    beforeEach(() => {
      m.getDocumentVersions.mockResolvedValue([versionRow(4, prdV4.content, true), versionRow(3, v3Content)])
    })

    /** `args` pending on v4's page: the banner's note on another version, then (after Review) the diff's blocks. */
    async function reviewOnV4(args: Record<string, unknown>) {
      seedPendingEdit(args)
      const { user } = renderDiff(canvasState(), prdV4)
      const banner = await screen.findByRole('region', { name: assistant.banner })
      const note = within(banner).getByTestId('assistant-diff-other-version').textContent
      await user.click(within(banner).getByRole('button', { name: assistant.review }))
      return { note, blocks: diffBlocks() }
    }

    it('made on an older version: says so and that approving replaces the changes since, and compares it with THIS page', async () => {
      const { note, blocks } = await reviewOnV4(onV3)

      expect(note).toBe(`Proposed on v3; this page shows v4. ${assistant.replacesSince.replace('{{proposed}}', '3')}`)
      // What approving produces: v4's own edits ("Ship in May.", "Four.") go from the head; v3's text is not the base.
      expect(blocks).toStrictEqual({
        removed: [`${assistant.removed}: Ship in May.`, `${assistant.removed}: Four.`], added: [`${assistant.added}: Ship in June.`],
      })
      expect(m.getDocumentVersions).toHaveBeenCalledExactlyOnceWith('p1', 'prd-4')
    })

    it('made on a newer version: compares it with that version, and says nothing of replacing', async () => {
      m.getDocumentVersions.mockResolvedValue([versionRow(5, '# Launch\n\nShip in May.\n\nFive.', true), versionRow(4, prdV4.content)])
      const { note, blocks } = await reviewOnV4({ ...onV3, document_id: 'prd-5', content: '# Launch\n\nShip in June.\n\nFive.' })

      expect([note, blocks]).toStrictEqual(['Proposed on v5; this page shows v4.',
        { removed: [`${assistant.removed}: Ship in May.`], added: [`${assistant.added}: Ship in June.`] }])
    })

    it('approving it answers the same approval through the card\'s own write (of the version it names)', async () => {
      m.updateDocument.mockResolvedValue({ document: { ...prdV4, document_id: 'prd-5', version: 5, content: onV3.content } })
      seedPendingEdit(onV3)
      const { user, state } = renderDiff(canvasState(), prdV4)

      await screen.findByRole('button', { name: assistant.review })
      const [projectId, documentId, body] = await approveReviewed(user, state)
      expect([projectId, documentId, body?.content]).toStrictEqual(['p1', 'prd-3', onV3.content])
      expect(m.resolveApproval.mock.calls[0]?.[0].outcome.status).toBe('executed')
    })

    it('a suggestion on a document outside the series shows nothing', async () => {
      seedPendingEdit({ ...onV3, document_id: 'prd-other' })
      renderDiff(canvasState(), prdV4)

      await vi.waitFor(() => { expect(m.getDocumentVersions).toHaveBeenCalledWith('p1', 'prd-4') })
      await act(() => Promise.resolve())
      expect(screen.queryByRole('region', { name: assistant.banner })).not.toBeInTheDocument()
    })

    it('a suggestion on the page\'s own version reads no versions and says nothing of another one', () => {
      seedPendingEdit({ ...onV3, document_id: 'prd-4' })
      renderDiff(canvasState(), prdV4)

      expect(screen.getByRole('region', { name: assistant.banner })).toBeInTheDocument()
      expect([screen.queryByTestId('assistant-diff-other-version'), m.getDocumentVersions.mock.calls]).toStrictEqual([null, []])
    })
  })

  it('a research / custom document never reads versions for a suggestion on another document', () => {
    seedPendingEdit({ ...editArgs, document_id: 'doc-other' })
    renderDiff()

    expect(m.getDocumentVersions).not.toHaveBeenCalled()
  })

  it('warns a writer with unsaved changes what approving does', async () => {
    seedPendingEdit(editArgs)
    const { user } = renderDiff(canvasState({ dirty: true }))
    await user.click(screen.getByRole('button', { name: assistant.review }))
    expect(screen.getByText(assistant.draftNote)).toBeInTheDocument()
  })
})
