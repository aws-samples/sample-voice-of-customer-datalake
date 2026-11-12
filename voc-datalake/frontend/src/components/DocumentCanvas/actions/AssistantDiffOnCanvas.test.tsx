/**
 * The assistant's pending `update_document` card for THIS document shows on its page: a banner,
 * Review opens the block diff over the saved text, and Approve / Decline answer the same approval
 * through the card's own path (the tool's executor, then resolveApproval on its conversation);
 * after an approved edit the canvas reloads on the new version.
 */
import { render, screen, within } from '@testing-library/react'
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
import type { ProjectDocument } from '../../../api/types'

const m = vi.hoisted(() => ({
  updateDocument: vi.fn<(projectId: string, documentId: string, body: Record<string, unknown>) => Promise<unknown>>(),
  resolveApproval: vi.fn<(resolution: ApprovalResolution, env: unknown, threadId: string) => void>(),
}))
vi.mock('../../../api/projectsApi', () => ({ projectsApi: { updateDocument: m.updateDocument } }))
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

function renderDiff(state = canvasState()) {
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <MemoryRouter initialEntries={['/projects/p1?tab=documents&doc=doc-1']}>
        <AssistantDiffOnCanvas projectId="p1" document={document} state={state} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  return { state, user: userEvent.setup() }
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

    await user.click(screen.getByRole('button', { name: assistant.review }))
    await user.click(screen.getByRole('button', { name: enTools.card.approve }))

    await vi.waitFor(() => { expect(state.reloadLatest).toHaveBeenCalledTimes(1) })
    const [projectId, documentId, body] = m.updateDocument.mock.calls[0] ?? []
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

  it('warns a writer with unsaved changes what approving does', async () => {
    seedPendingEdit(editArgs)
    const { user } = renderDiff(canvasState({ dirty: true }))
    await user.click(screen.getByRole('button', { name: assistant.review }))
    expect(screen.getByText(assistant.draftNote)).toBeInTheDocument()
  })
})
