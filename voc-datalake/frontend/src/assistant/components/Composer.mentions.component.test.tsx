/**
 * @persona / @all / #document in the composer on a project page: typing a trigger opens an
 * accessible list of the project's personas or documents, the keyboard picks, the message
 * carries the picked ids (not text), Escape closes only the list, and other pages have none of it.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { projectsApi } from '../../api/projectsApi'
import Composer from './Composer'
import { useComposerDrafts } from '../store/composerDrafts'
import type { ProjectDetail } from '../../api/projectTypes'

const PROJECT: ProjectDetail = {
  project: {
    project_id: 'proj_1', name: 'Checkout', description: '', status: 'active', created_at: '', updated_at: '', persona_count: 2, document_count: 3,
  },
  personas: [
    { persona_id: 'p1', name: 'Deadline Dana', tagline: '', created_at: '' },
    { persona_id: 'p2', name: 'Value Victor', tagline: '', created_at: '' },
  ],
  documents: [
    { document_id: 'd1', document_type: 'prfaq', title: 'Delivery updates', version: 1, content: '', created_at: '2026-01-01T00:00:00Z' },
    { document_id: 'd2', document_type: 'prfaq', title: 'Delivery updates', version: 2, content: '', created_at: '2026-02-01T00:00:00Z' },
    { document_id: 'proto', document_type: 'prototype', title: 'Clickable checkout', content: '', created_at: '2026-03-01T00:00:00Z' },
  ],
}

function renderComposer(projectId: string | undefined) {
  const onSend = vi.fn()
  const onKeyDownAbove = vi.fn()
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      {/* A parent Escape listener stands in for the panel's own (closes the floating card). */}
      <div onKeyDown={(e) => { if (e.key === 'Escape') onKeyDownAbove() }}>
        <Composer
          threadId="t1" streaming={false} blockedReason={null} webSearchAvailable={false}
          projectId={projectId} onSend={onSend} onStop={vi.fn()}
        />
      </div>
    </QueryClientProvider>,
  )
  return { onSend, onKeyDownAbove, box: screen.getByRole('textbox', { name: 'Message the assistant' }) }
}

beforeEach(() => {
  // Drafts are kept per conversation for the tab's life: start every spec with an empty composer.
  useComposerDrafts.getState().reset()
  vi.spyOn(projectsApi, 'getProject').mockResolvedValue(PROJECT)
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Composer mentions', () => {
  it('offers @all and the personas, and sends the picked persona as an id', async () => {
    const user = userEvent.setup()
    const { onSend, box } = renderComposer('proj_1')
    await user.type(box, '@')
    const list = await screen.findByRole('listbox', { name: 'Personas' })
    await waitFor(() => expect(list.querySelectorAll('[role="option"]')).toHaveLength(3))
    await user.keyboard('{ArrowDown}{Enter}')
    await user.type(box, 'please review{Enter}')

    expect(onSend).toHaveBeenCalledWith('@Deadline Dana please review', { personas: ['p1'] })
  })

  it('tags a document by version, newest first, with no prototype offered', async () => {
    const user = userEvent.setup()
    const { onSend, box } = renderComposer('proj_1')
    await user.type(box, 'compare #')
    const list = await screen.findByRole('listbox', { name: 'Documents' })
    await waitFor(() => expect([...list.querySelectorAll('[role="option"]')].map((o) => o.textContent))
      .toStrictEqual(['Delivery updates (v2)', 'Delivery updates (v1)']))
    await user.keyboard('{Tab}{Enter}')

    expect(onSend).toHaveBeenCalledWith('compare #Delivery updates (v2) ', { documents: [{ document_id: 'd2', version: 2 }] })
  })

  it('points the textbox at the active option for screen readers', async () => {
    const user = userEvent.setup()
    const { box } = renderComposer('proj_1')
    await user.type(box, '@')
    await screen.findByRole('option', { name: /Deadline Dana/ })
    await user.keyboard('{ArrowDown}')
    const active = box.getAttribute('aria-activedescendant') ?? ''
    const list = box.getAttribute('aria-controls') ?? ''
    expect({ autocomplete: box.getAttribute('aria-autocomplete'), list: document.getElementById(list)?.getAttribute('role'), activeText: document.getElementById(active)?.textContent })
      .toStrictEqual({ autocomplete: 'list', list: 'listbox', activeText: 'Deadline Dana' })
  })

  it('closes only the list on Escape, and Enter then sends the text as typed', async () => {
    const user = userEvent.setup()
    const { onSend, onKeyDownAbove, box } = renderComposer('proj_1')
    await user.type(box, '@Dea')
    await screen.findByRole('listbox')
    await user.keyboard('{Escape}')
    expect({ list: screen.queryByRole('listbox'), panelClosed: onKeyDownAbove.mock.calls.length }).toStrictEqual({ list: null, panelClosed: 0 })
    await user.keyboard('{Enter}')
    expect(onSend).toHaveBeenCalledWith('@Dea', undefined)
  })

  it('opens the list from the @ button for touch keyboards, and removing the chip drops the mention', async () => {
    const user = userEvent.setup()
    const { onSend, box } = renderComposer('proj_1')
    await user.click(screen.getByRole('button', { name: 'Mention a persona' }))
    await user.click(await screen.findByRole('option', { name: /Value Victor/ }))
    await user.click(screen.getByRole('button', { name: 'Remove @Value Victor' }))
    await user.type(box, 'hi{Enter}')
    expect(onSend).toHaveBeenCalledWith('@Value Victor hi', undefined)
  })

  it('has no mentions off a project page', async () => {
    const user = userEvent.setup()
    const { onSend, box } = renderComposer(undefined)
    await user.type(box, '@all hi{Enter}')
    expect({
      list: screen.queryByRole('listbox'), button: screen.queryByRole('button', { name: 'Mention a persona' }), fetched: vi.mocked(projectsApi.getProject).mock.calls.length,
    }).toStrictEqual({ list: null, button: null, fetched: 0 })
    expect(onSend).toHaveBeenCalledWith('@all hi', undefined)
  })
})
