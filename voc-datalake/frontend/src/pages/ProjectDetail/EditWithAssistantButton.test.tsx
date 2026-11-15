/**
 * Edit with the assistant (docs/prototype-builder.md, part 2): in a prototype preview's header, for editors only;
 * it opens the one assistant panel on a new conversation with a starter drafted and nothing sent. The prototype
 * reaches the panel as the page context's documentId (pageContext.test.tsx), which the chip names "Editing: …".
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { MemoryRouter } from 'react-router-dom'
import { renderWithQueryClient } from '@test/query-client'
import DocumentsTab from './DocumentsTab'
import { documentsTabStubs, makeProject } from './project-detail-fixtures'
import { EDITOR_ACCESS, VIEWER_ACCESS } from './projectAccess-fixtures'
import { useAssistantUiStore, useThreadStore } from '../../assistant/store/assistantStore'
import type { ProjectDocument } from '../../api/types'

const prototype: ProjectDocument = {
  document_id: 'proto_3', document_type: 'prototype', title: 'Checkout flow (v3)', base_title: 'Checkout flow', version: 3,
  prototype_format: 'html', content: '<!doctype html><html><body>Checkout</body></html>', created_at: '2026-11-13T10:00:00Z',
}

function renderPane(access: typeof EDITOR_ACCESS) {
  const project = makeProject({ project_id: 'proj_1', name: 'Checkout', description: '', access })
  renderWithQueryClient(
    <MemoryRouter>
      <DocumentsTab project={project} documents={[prototype]} selectedDoc={prototype} onSelectDoc={vi.fn()} {...documentsTabStubs()} />
    </MemoryRouter>,
  )
}

const button = () => screen.queryByRole('button', { name: 'Edit with the assistant' })

describe('Edit with the assistant', () => {
  beforeEach(() => {
    useAssistantUiStore.getState().reset()
    useThreadStore.getState().reset()
  })

  it('opens the assistant panel with a starter drafted, not sent', async () => {
    renderPane(EDITOR_ACCESS)

    await userEvent.setup().click(screen.getByRole('button', { name: 'Edit with the assistant' }))

    const ui = useAssistantUiStore.getState()
    expect({ open: ui.open, draft: ui.pendingDraft?.text }).toStrictEqual({ open: true, draft: 'Change this prototype: ' })
    expect(useThreadStore.getState().thread.messages).toStrictEqual([])
  })

  it('is not offered to a viewer (a draft is an edit the server refuses them)', () => {
    renderPane(VIEWER_ACCESS)
    expect(button()).not.toBeInTheDocument()
  })
})
