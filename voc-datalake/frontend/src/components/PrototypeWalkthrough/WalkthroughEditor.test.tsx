/**
 * The walkthrough editor (docs/prototype-builder.md Part 1): the version's steps; a step added by picking an
 * element in the preview; reorder with Alt+Shift+Up / Down; Draft with the assistant marks its steps "check where
 * it points" until re-pointed; Save (a new version, selected); a 409 says the series moved; a version without the
 * runtime says what to do instead.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithQueryClient } from '../../test/query-client'
import { ApiError } from '../../lib/errors'
import type { ProjectDocument } from '../../api/types'
import type { WalkthroughStep } from '../../api/prototypeWalkthroughSchema'
import type { PickedElement, WalkthroughHost } from '../PrototypePins/useWalkthroughHost'
import WalkthroughEditor from './WalkthroughEditor'

const api = vi.hoisted(() => ({
  getPrototypeWalkthrough: vi.fn<(projectId: string, documentId: string) => Promise<WalkthroughStep[]>>(),
  savePrototypeWalkthrough: vi.fn<(projectId: string, documentId: string, steps: readonly WalkthroughStep[], editId: string) => Promise<ProjectDocument | null>>(),
  draftPrototypeWalkthrough: vi.fn<(projectId: string, documentId: string, language: string) => Promise<WalkthroughStep[]>>(),
}))
vi.mock('../../api/projectsApi', () => ({ projectsApi: api }))

const SAVED: WalkthroughStep[] = [
  { title: 'Your order', body: 'When it arrives.', selector: '#order' },
  { title: 'Pay', body: 'Shipping included.', selector: '#pay' },
]
const V3: ProjectDocument = { document_id: 'proto_3', document_type: 'prototype', title: 'Checkout (v3)', version: 3, content: '', created_at: '' }

function host(extra: Partial<WalkthroughHost> = {}): WalkthroughHost {
  return { runtime: true, steps: 2, picking: false, picked: null, onMessage: vi.fn(), show: vi.fn(), preview: vi.fn(), pick: vi.fn(), ...extra }
}

function renderEditor(h: WalkthroughHost = host()) {
  const onSaved = vi.fn<(doc: ProjectDocument) => void>()
  const view = renderWithQueryClient(<WalkthroughEditor projectId="p1" documentId="proto_2" host={h} onSaved={onSaved} onClose={vi.fn()} />)
  const rerender = (next: WalkthroughHost) => {
    view.rerender(<WalkthroughEditor projectId="p1" documentId="proto_2" host={next} onSaved={onSaved} onClose={vi.fn()} />)
  }
  return { onSaved, rerender, user: userEvent.setup() }
}

const titles = () => screen.getAllByLabelText('Title').map((input) => (input instanceof HTMLInputElement ? input.value : ''))
const pick = (seq: number): PickedElement => ({ seq, selector: '#total', anchor: { route: '', bbox: { x: 0.1, y: 0.2, w: 0.3, h: 0.1 } } })

beforeEach(() => {
  vi.clearAllMocks()
  api.getPrototypeWalkthrough.mockResolvedValue(SAVED)
  api.savePrototypeWalkthrough.mockResolvedValue(V3)
})

describe('WalkthroughEditor', () => {
  it('lists the version\'s steps and reorders them with Alt+Shift+Down', async () => {
    renderEditor()
    await vi.waitFor(() => { expect(titles()).toStrictEqual(['Your order', 'Pay']) })
    fireEvent.keyDown(screen.getByTestId('walkthrough-step-1'), { key: 'ArrowDown', altKey: true, shiftKey: true })
    expect(titles()).toStrictEqual(['Pay', 'Your order'])
  })

  it('adds a step from a picked element; it needs its text before Save', async () => {
    const h = host()
    const { rerender, user } = renderEditor(h)
    await vi.waitFor(() => { expect(titles()).toHaveLength(2) })
    await user.click(screen.getByRole('button', { name: 'Add a step' }))
    expect(h.pick).toHaveBeenCalledTimes(1)
    rerender(host({ picked: pick(1) }))
    expect(titles()).toStrictEqual(['Your order', 'Pay', ''])
    expect(screen.getByRole('button', { name: 'Save as a new version' })).toBeDisabled()
  })

  it('saves the steps as a new version and selects it', async () => {
    const { onSaved, user } = renderEditor()
    await vi.waitFor(() => { expect(titles()).toHaveLength(2) })
    await user.type(screen.getAllByLabelText('Title')[0] ?? document.body, '!')
    await user.click(screen.getByRole('button', { name: 'Save as a new version' }))
    await vi.waitFor(() => { expect(onSaved).toHaveBeenCalledWith(V3) })
    expect(api.savePrototypeWalkthrough.mock.calls[0]?.[2]).toStrictEqual([{ ...SAVED[0], title: 'Your order!' }, SAVED[1]])
  })

  it('on a 409 says the prototype changed', async () => {
    api.savePrototypeWalkthrough.mockRejectedValue(new ApiError(409, 'stale'))
    const { user } = renderEditor()
    await vi.waitFor(() => { expect(titles()).toHaveLength(2) })
    await user.type(screen.getAllByLabelText('Text')[1] ?? document.body, ' Now.')
    await user.click(screen.getByRole('button', { name: 'Save as a new version' }))
    expect(await screen.findByRole('alert')).toHaveTextContent('The prototype changed since you opened this version')
  })

  it('drafted steps are marked to check where they point, until re-pointed with the picker', async () => {
    api.draftPrototypeWalkthrough.mockResolvedValue([{ title: 'Drafted', body: 'From the PRD.', anchor: { route: '', bbox: { x: 0.3, y: 0.3, w: 0.4, h: 0.4 } } }])
    const h = host()
    const { rerender, user } = renderEditor(h)
    await user.click(screen.getByRole('button', { name: 'Draft with the assistant' }))
    const step = within(await screen.findByTestId('walkthrough-step-1'))
    expect(step.getByText(/check where this step points/)).toBeInTheDocument()
    await user.click(step.getByRole('button', { name: 'Point step 1 at an element' }))
    rerender(host({ picked: pick(1) }))
    expect(screen.queryByText(/check where this step points/)).toBeNull()
  })

  it('on a version without the runtime, says what to do and offers no picking', async () => {
    renderEditor(host({ runtime: false }))
    expect(await screen.findByText(/made before walkthroughs/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Add a step' })).toBeDisabled()
  })
})
