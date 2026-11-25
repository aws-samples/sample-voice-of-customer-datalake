/**
 * `#slug` of a Documents Library item in the composer (docs/documents-library.md): on any page, `#` lists the
 * library's ready items (its own "Library" group, after a project's documents), the message carries the picked
 * item's id, a large item says so, and off a project page `@` mentions nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClientProvider } from '@tanstack/react-query'
import { createTestQueryClient } from '../../test/query-client'
import { libraryApi } from '../../api/libraryApi'
import { projectsApi } from '../../api/projectsApi'
import Composer from './Composer'
import { useComposerDrafts } from '../store/composerDrafts'

const Q3 = { item_id: 'lib_20261101000000_0000a001', slug: 'q3-market', title: 'Q3 market report', format: 'pdf',
  bytes: 1000, native: true, extracted_chars: 400_000 }

function renderComposer(projectId?: string) {
  const onSend = vi.fn()
  render(
    <QueryClientProvider client={createTestQueryClient()}>
      <Composer threadId="t1" streaming={false} blockedReason={null} webSearchAvailable={false}
        projectId={projectId} libraryEnabled onSend={onSend} onStop={vi.fn()} />
    </QueryClientProvider>,
  )
  return { onSend, box: screen.getByRole('textbox', { name: 'Message the assistant' }) }
}

beforeEach(() => {
  useComposerDrafts.getState().reset()
  vi.spyOn(libraryApi, 'suggest').mockResolvedValue([Q3])
  vi.spyOn(projectsApi, 'getProject').mockResolvedValue({
    project: { project_id: 'proj_1', name: 'Checkout', description: '', status: 'active', created_at: '', updated_at: '',
      persona_count: 0, document_count: 1 },
    personas: [],
    documents: [{ document_id: 'd1', document_type: 'prfaq', title: 'Delivery updates', version: 1, content: '',
      created_at: '2026-01-01T00:00:00Z' }],
  })
})

afterEach(() => {
  vi.restoreAllMocks()
})

describe('Composer library mentions', () => {
  it('offers the library off a project page and sends the picked item as an id', async () => {
    const user = userEvent.setup()
    const { onSend, box } = renderComposer()
    expect(box).toHaveAttribute('placeholder', expect.stringContaining('# for a library document'))
    await user.type(box, 'what does #q3')
    const list = await screen.findByRole('listbox', { name: 'Documents' })
    const group = await within(list).findByRole('group', { name: 'Library' })
    await waitFor(() => expect(within(group).getAllByRole('option')).toHaveLength(1))
    await user.keyboard('{Enter}')
    expect(await screen.findByText(/is large: about 100,000 tokens/u)).toBeInTheDocument()
    await user.type(box, 'say?{Enter}')

    expect(onSend).toHaveBeenCalledWith('what does #q3-market say?', { library: [{ item_id: Q3.item_id }] })
  })

  it('has no @ off a project page, and no @ button', async () => {
    const user = userEvent.setup()
    const { box } = renderComposer()
    await user.type(box, 'ask @Dana')
    expect({ list: screen.queryByRole('listbox'), at: screen.queryByRole('button', { name: 'Mention a persona' }) })
      .toStrictEqual({ list: null, at: null })
  })

  it('lists a project page documents first, then the library', async () => {
    const user = userEvent.setup()
    renderComposer('proj_1')
    await user.type(box(), '#')
    const list = await screen.findByRole('listbox', { name: 'Documents' })
    // Main lists a project's documents ungrouped; the library is the one named group, after them.
    await waitFor(() => expect(within(list).getAllByRole('group').map((group) => group.getAttribute('aria-labelledby')))
      .toStrictEqual([expect.stringContaining('library')]))
    const options = within(list).getAllByRole('option').map((option) => option.textContent)
    expect(options).toStrictEqual([expect.stringContaining('Delivery updates'), expect.stringContaining('Q3 market report')])
  })
})

function box(): HTMLElement {
  return screen.getByRole('textbox', { name: 'Message the assistant' })
}
