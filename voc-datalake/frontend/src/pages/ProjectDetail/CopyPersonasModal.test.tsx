/**
 * @fileoverview "Copy from…" (5.60): the sources (the library, then the caller's other
 * projects), a source's personas with checkboxes, the 20-persona limit, the exact POST
 * body, and a refused copy shown inside the modal.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '@test/query-client'
import { fetchApi, resetFetchApi, routeFetchApi as route } from '@test/fetchApiRoutes'
import { ApiError } from '../../lib/errors'
import { toggledSelection } from './useCopyPersonas'

vi.mock('../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))

const { default: CopyPersonasModal } = await import('./CopyPersonasModal')

const SOURCES = {
  company: [{ persona_id: 'cpersona_1', name: 'Frequent-Flyer Farah', tagline: 'Books Example Air monthly', avatar_url: null }],
  projects: [{ project_id: 'proj_3', name: 'Pricing Experiments', persona_count: 1 }],
}
const PROJ_3 = {
  project: { project_id: 'proj_3', name: 'Pricing Experiments' },
  personas: [{ persona_id: 'persona_4', name: 'Fare-Watching Fern', tagline: 'Waits for the price to drop', created_at: '' }],
  documents: [],
}

function renderModal(copy: (body: unknown) => unknown = () => ({ success: true, personas: [] })) {
  const onClose = vi.fn()
  const onCopied = vi.fn()
  route({
    'GET /projects/proj_1/personas/copy-sources': () => SOURCES,
    'GET /projects/proj_3': () => PROJ_3,
    'POST /projects/proj_1/personas/copy': copy,
  })
  renderWithQueryClient(<CopyPersonasModal projectId="proj_1" onClose={onClose} onCopied={onCopied} />)
  return { onClose, onCopied, user: userEvent.setup() }
}

beforeEach(resetFetchApi)

describe('CopyPersonasModal', () => {
  it('starts on the company library and lists the projects the caller belongs to', async () => {
    renderModal()
    expect(await screen.findByRole('checkbox', { name: /Frequent-Flyer Farah/ })).toBeInTheDocument()
    expect(screen.getByRole('option', { name: 'Pricing Experiments (1 persona)' })).toBeInTheDocument()
    expect(screen.getByText(/Research notes are not copied/)).toBeInTheDocument()
  })

  it('keeps Copy disabled until a persona is ticked', async () => {
    const { user } = renderModal()
    await user.click(await screen.findByRole('checkbox', { name: /Frequent-Flyer Farah/ }))
    expect(screen.getByRole('button', { name: 'Copy 1 persona' })).toBeEnabled()
    await user.click(screen.getByRole('checkbox', { name: /Frequent-Flyer Farah/ }))
    expect(screen.getByRole('button', { name: 'Copy' })).toBeDisabled()
  })

  it('copies from the library with the contract body, then closes', async () => {
    const copy = vi.fn(() => ({ success: true, personas: [{ persona_id: 'persona_new', name: 'Frequent-Flyer Farah' }] }))
    const { onClose, onCopied, user } = renderModal(copy)
    await user.click(await screen.findByRole('checkbox', { name: /Frequent-Flyer Farah/ }))
    await user.click(screen.getByRole('button', { name: 'Copy 1 persona' }))
    await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1))
    expect(copy).toHaveBeenCalledWith({ source: { scope: 'company' }, persona_ids: ['cpersona_1'] })
    expect(onCopied).toHaveBeenCalledWith([expect.objectContaining({ persona_id: 'persona_new' })])
  })

  it("reads a project's personas from the project and names it in the body", async () => {
    const copy = vi.fn(() => ({ success: true, personas: [] }))
    const { user } = renderModal(copy)
    await screen.findByRole('checkbox', { name: /Frequent-Flyer Farah/ })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Copy from' }), 'proj_3')
    await user.click(await screen.findByRole('checkbox', { name: /Fare-Watching Fern/ }))
    await user.click(screen.getByRole('button', { name: 'Copy 1 persona' }))
    await waitFor(() => expect(copy).toHaveBeenCalledWith({ source: { scope: 'project', project_id: 'proj_3' }, persona_ids: ['persona_4'] }))
  })

  it("shows a refused copy's reason in the modal and stays open", async () => {
    const { onClose, user } = renderModal(() => { throw new ApiError(404, 'Source project not found') })
    await user.click(await screen.findByRole('checkbox', { name: /Frequent-Flyer Farah/ }))
    await user.click(screen.getByRole('button', { name: 'Copy 1 persona' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('Source project not found')
    expect(onClose).not.toHaveBeenCalled()
  })

  it('says when the sources cannot be loaded', async () => {
    fetchApi.mockRejectedValue(new Error('API Error: 500'))
    renderWithQueryClient(<CopyPersonasModal projectId="proj_1" onClose={vi.fn()} />)
    expect(await screen.findByRole('alert')).toHaveTextContent("personas couldn't be loaded")
  })
})

describe('toggledSelection (1–20 personas per copy)', () => {
  const twenty = Array.from({ length: 20 }, (_, i) => `p${i}`)

  it('adds and removes one persona', () => {
    expect(toggledSelection(['a'], 'b')).toStrictEqual(['a', 'b'])
    expect(toggledSelection(['a', 'b'], 'a')).toStrictEqual(['b'])
  })

  it('refuses a 21st persona but still lets one be removed', () => {
    expect(toggledSelection(twenty, 'p20')).toBe(twenty)
    expect(toggledSelection(twenty, 'p0')).toHaveLength(19)
  })
})
