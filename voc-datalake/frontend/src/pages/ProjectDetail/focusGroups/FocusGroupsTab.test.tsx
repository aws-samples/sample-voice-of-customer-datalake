/**
 * @fileoverview Project → Focus groups: 2 to 6 personas, a topic, 1–3 rounds, the documents and library items they
 * read, the cost before the start, Start (a new assistant conversation with the group), and the saved groups.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { resetFetchApi, routeFetchApi } from '@test/fetchApiRoutes'
import { makeDocument, makePersona } from '../project-detail-fixtures'
import FocusGroupsTab from './FocusGroupsTab'
import { focusGroupCost } from './focusGroupCost'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const startFocusGroup = vi.hoisted(() => vi.fn(() => Promise.resolve()))
vi.mock('../../../assistant/runtime/runtime', () => ({ startFocusGroup }))
vi.mock('../../../assistant/runtime/useAssistant', () => ({
  useRunEnvironment: () => ({ page: { kind: 'project', path: '/projects/proj_1/focus-groups', projectId: 'proj_1' }, language: 'en', useWebSearch: false }),
}))

const PERSONAS = ['Ada', 'Bea', 'Cy', 'Dee', 'Eli', 'Fay', 'Gus'].map((name, index) => makePersona({ persona_id: `p${String(index + 1)}`, name }))
const DOCUMENTS = [
  makeDocument({ document_id: 'd_prd', title: 'Slots PRD', document_type: 'prd' }),
  makeDocument({ document_id: 'd_proto', title: 'Prototype', document_type: 'prototype' }),
  makeDocument({ document_id: 'd_fg', title: 'Focus group: slots', document_type: 'focus_group', created_at: '2026-11-20T10:00:00Z' }),
]
const LIBRARY_ITEM = {
  item_id: 'lib_20261120000000_0a1b2c3d', slug: 'survey', title: 'Survey', status: 'ready', format: 'pdf', bytes: 10,
  filename: 'survey.pdf', created_at: '2026-11-20T00:00:00Z', updated_at: '2026-11-20T00:00:00Z',
}

beforeEach(() => {
  resetFetchApi()
  startFocusGroup.mockClear()
  routeFetchApi({ 'GET /projects/library': () => ({ items: [LIBRARY_ITEM] }) }, { ignoreQuery: true })
})

function renderTab(personas = PERSONAS, onSelectDoc = vi.fn()) {
  renderWithQueryClient(<FocusGroupsTab personas={personas} documents={DOCUMENTS} onSelectDoc={onSelectDoc} />)
  return { onSelectDoc }
}

describe('the Focus groups tab', () => {
  it('asks for two personas first', () => {
    renderTab([makePersona()])
    expect(screen.getByText(/needs at least 2 personas/)).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Start focus group' })).not.toBeInTheDocument()
  })

  it('starts only with two personas and a topic, then sends the group to a new conversation', async () => {
    const user = userEvent.setup()
    renderTab()
    const start = screen.getByRole('button', { name: 'Start focus group' })
    await user.click(screen.getByRole('checkbox', { name: 'Ada' }))
    await user.type(screen.getByRole('textbox', { name: 'Topic' }), 'Shorter delivery slots?')
    expect(start).toBeDisabled()
    await user.click(screen.getByRole('checkbox', { name: 'Bea' }))
    await user.click(screen.getByRole('button', { name: '3 rounds' }))
    await user.click(screen.getByRole('checkbox', { name: 'Slots PRD' }))
    await user.click(await screen.findByRole('checkbox', { name: '#survey · Survey' }))
    await user.click(start)
    expect(startFocusGroup).toHaveBeenCalledWith('Shorter delivery slots?', {
      persona_ids: ['p1', 'p2'], rounds: 3, documents: [{ document_id: 'd_prd' }],
      library: [{ item_id: 'lib_20261120000000_0a1b2c3d' }],
    }, expect.objectContaining({ page: expect.objectContaining({ projectId: 'proj_1' }) }))
  })

  it('takes at most six personas', async () => {
    const user = userEvent.setup()
    renderTab()
    for (const name of ['Ada', 'Bea', 'Cy', 'Dee', 'Eli', 'Fay']) await user.click(screen.getByRole('checkbox', { name }))
    expect(screen.getByRole('checkbox', { name: 'Gus' })).toBeDisabled()
    expect(screen.getByText('Personas: 6 chosen, at most 6')).toBeInTheDocument()
  })

  it('offers neither prototypes nor saved focus groups as reading', () => {
    renderTab()
    expect(screen.queryByRole('checkbox', { name: 'Prototype' })).not.toBeInTheDocument()
    expect(screen.queryByRole('checkbox', { name: 'Focus group: slots' })).not.toBeInTheDocument()
  })

  it('shows the cost before the start, from the personas and rounds chosen', async () => {
    const user = userEvent.setup()
    renderTab()
    for (const name of ['Ada', 'Bea', 'Cy']) await user.click(screen.getByRole('checkbox', { name }))
    const cost = focusGroupCost(3, 2)
    expect(screen.getByTestId('focus-group-cost')).toHaveTextContent(
      `About ${String(cost.calls)} model calls on the assistant’s model, roughly ${cost.inputTokens.toLocaleString('en')} input and ${cost.outputTokens.toLocaleString('en')} output tokens.`)
  })

  it('lists the saved focus groups and opens one on the Documents tab', async () => {
    const user = userEvent.setup()
    const { onSelectDoc } = renderTab()
    await user.click(screen.getByRole('button', { name: 'Focus group: slots' }))
    await waitFor(() => expect(onSelectDoc).toHaveBeenCalledWith(expect.objectContaining({ document_id: 'd_fg' })))
  })
})
