/**
 * @fileoverview The run workspace's sessions side by side (7.51.00; agentGridModel.ts), against the shared fixture: a
 * grid of two opens with the orchestrator's session and an empty pane, which takes the next agent opened (a lane on
 * the canvas, or the one its picker names); the divider moves by the arrow keys and by a drag; a press in a pane moves to its agent; a
 * closed pane leaves its room to the other, and the last one closed goes back to tabs.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { adminFlag, resetFetchApi, stubResizeObserverForSuite } from '@test/fetchApiRoutes'
import { AGENT, RUN_PATH, renderWorkspace, workspaceRoutes } from '@test/runWorkspaceHarness'
import { restoreProperty } from '@test/originals'

vi.mock('../../../api/client', () => import('@test/fetchApiRoutes').then((m) => m.fetchApiClientModule()))
vi.mock('../../../store/authStore', (importOriginal) =>
  import('@test/fetchApiRoutes').then((m) => m.authStoreWithOriginal(importOriginal)))

stubResizeObserverForSuite()

// (jsdom has no pointer capture: the divider takes it on a press)
const capture = Object.getOwnPropertyDescriptor(Element.prototype, 'setPointerCapture')

beforeEach(() => {
  resetFetchApi()
  adminFlag.isAdmin = true
  workspaceRoutes()
  Object.defineProperty(Element.prototype, 'setPointerCapture', { configurable: true, value: vi.fn() })
})

afterEach(() => {
  window.sessionStorage.clear()
  restoreProperty(Element.prototype, 'setPointerCapture', capture)
})

/** The workspace at the run, as a grid of two. */
async function gridOfTwo() {
  const router = renderWorkspace(RUN_PATH)
  await userEvent.click(within(await screen.findByRole('region', { name: 'The sessions open' })).getByRole('button', { name: 'A grid of 2' }))
  return { router, grid: within(screen.getByRole('group', { name: 'The sessions side by side' })) }
}

describe('the grid of sessions', () => {
  it('opens with the orchestrator\'s session and an empty pane, which takes the agent its picker names', async () => {
    const { router, grid } = await gridOfTwo()
    expect(grid.getByText('Choose an agent for this pane.')).toBeInTheDocument()
    const [, empty] = grid.getAllByLabelText('This pane\'s agent')
    await userEvent.selectOptions(empty ?? document.body, AGENT)
    expect(await grid.findByRole('list', { name: `The thread of ${AGENT}` })).toBeInTheDocument()
    expect(router.state.location.pathname).toBe(RUN_PATH)
  })

  it('puts an agent opened from the canvas in the empty pane, and moves to an agent pressed in its pane', async () => {
    const { router, grid } = await gridOfTwo()
    const [fixer] = await screen.findAllByTestId('run-lane')
    fireEvent.click(fixer ?? document.body)
    await waitFor(() => { expect(router.state.location.pathname).toBe(`${RUN_PATH}/a/${AGENT}`) })
    expect(grid.queryByText('Choose an agent for this pane.')).not.toBeInTheDocument()
    fireEvent.pointerDown(await grid.findByRole('list', { name: 'The thread of coordinator-1' }))
    await waitFor(() => { expect(router.state.location.pathname).toBe(RUN_PATH) })
  })

  it('moves the divider by the arrow keys and by a drag, and takes its pointer on a press', async () => {
    const { grid } = await gridOfTwo()
    const divider = grid.getByRole('separator', { name: 'Move the divider' })
    fireEvent.keyDown(divider, { key: 'ArrowRight' })
    fireEvent.keyDown(divider, { key: 'Enter' })
    expect(divider).toHaveAttribute('aria-valuenow', '55')
    vi.spyOn(divider.parentElement ?? divider, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 400, 300))
    fireEvent.pointerDown(divider, { pointerId: 1 })
    fireEvent.pointerMove(divider, { buttons: 1, movementX: -40 })
    expect(divider).toHaveAttribute('aria-valuenow', '45')
    expect(divider.setPointerCapture).toHaveBeenCalledWith(1)
  })

  it('gives a closed pane\'s room to the other, and goes back to tabs once the last is closed', async () => {
    const { grid } = await gridOfTwo()
    await userEvent.click(grid.getByRole('button', { name: 'Close this pane' }))
    expect(grid.queryByRole('separator')).not.toBeInTheDocument()
    await userEvent.click(grid.getByRole('button', { name: 'Close Orchestrator\'s pane' }))
    expect(await screen.findByRole('tablist', { name: 'Open sessions' })).toBeInTheDocument()
  })
})
