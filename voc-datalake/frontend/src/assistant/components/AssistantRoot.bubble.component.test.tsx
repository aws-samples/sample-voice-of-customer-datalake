/**
 * The draggable launcher (E2E F5): pointer drag clamped to the viewport,
 * arrow-key moves, per-user persistence, the reset affordance, and the bottom
 * safe area — a registered sticky action bar lifts the launcher above it so it
 * never covers the page's Save button.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { render } from '@test/test-utils'
import { useAuthStore } from '../../store/authStore'
import { useAssistantUiStore } from '../store/assistantStore'
import { useBubbleStore } from '../bubble/bubbleStore'
import { ACTION_BAR_GAP, EDGE_MARGIN, KEY_STEP, KEY_STEP_LARGE, LAUNCHER_SIZE } from '../bubble/geometry'
import StickyActionBar from '../../components/StickyActionBar/StickyActionBar'
import AssistantRoot from './AssistantRoot'

const launcher = () => screen.getByTestId('assistant-launcher')
const offsets = () => ({ right: parseFloat(launcher().style.right), bottom: parseFloat(launcher().style.bottom) })

/** jsdom has no PointerEvent; fireEvent needs one that carries pointerId and coordinates. */
class TestPointerEvent extends MouseEvent {
  readonly pointerId: number
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init)
    this.pointerId = init.pointerId ?? 0
  }
}

/** What persist wrote to localStorage (the setup file mocks it) under `key`, parsed. */
function lastStored(key: string): unknown {
  const calls = vi.mocked(localStorage.setItem).mock.calls.filter(([k]) => k === key)
  const last = calls.at(-1)
  return last === undefined ? undefined : JSON.parse(last[1])
}

function signIn(sub: string) {
  useAuthStore.getState().setUser({ username: `${sub}-name`, email: `${sub}@example.com`, groups: [], sub })
}

function setViewport(width: number, height: number) {
  Object.defineProperty(window, 'innerWidth', { configurable: true, value: width })
  Object.defineProperty(window, 'innerHeight', { configurable: true, value: height })
  act(() => {
    window.dispatchEvent(new Event('resize'))
  })
}

/** Render the launcher beside a sticky action bar that measures as `bar` (everything else measures empty). */
function renderBesideActionBar(bar: { x: number; y: number; width: number; height: number }) {
  vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function rect(this: HTMLElement) {
    return DOMRect.fromRect(this.hasAttribute('data-action-bar') ? bar : { x: 0, y: 0, width: 0, height: 0 })
  })
  return render(
    <>
      <StickyActionBar><button type="button">Save</button></StickyActionBar>
      <AssistantRoot />
    </>,
    { initialEntries: ['/'] },
  )
}

function drag(dx: number, dy: number) {
  const el = launcher()
  fireEvent.pointerDown(el, { pointerId: 1, button: 0, clientX: 500, clientY: 500 })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 500 + dx / 2, clientY: 500 + dy / 2 })
  fireEvent.pointerMove(el, { pointerId: 1, clientX: 500 + dx, clientY: 500 + dy })
  fireEvent.pointerUp(el, { pointerId: 1, clientX: 500 + dx, clientY: 500 + dy })
  fireEvent.click(el)
}

beforeAll(() => {
  vi.stubGlobal('PointerEvent', TestPointerEvent)
})

beforeEach(() => {
  vi.mocked(localStorage.setItem).mockClear()
  useBubbleStore.setState({ positions: {} })
  useAssistantUiStore.getState().reset()
  signIn('sub-a')
  setViewport(1440, 900)
})

afterEach(() => {
  vi.mocked(localStorage.getItem).mockReturnValue(null)
  vi.restoreAllMocks()
})

describe('assistant launcher position', () => {
  it('starts in the bottom-right corner and is described as movable', () => {
    render(<AssistantRoot />, { initialEntries: ['/'] })
    expect(offsets()).toStrictEqual({ right: 16, bottom: 16 })
    expect(launcher()).toHaveAccessibleDescription(/arrow keys/i)
  })

  it('drags with the pointer, and the click that ends a drag does not open the panel', () => {
    render(<AssistantRoot />, { initialEntries: ['/'] })
    drag(-200, -100)
    expect(offsets()).toStrictEqual({ right: 216, bottom: 116 })
    expect(useAssistantUiStore.getState().open).toBe(false)
    // A plain click still toggles it.
    fireEvent.click(launcher())
    expect(useAssistantUiStore.getState().open).toBe(true)
  })

  it('captures the pointer on press, so a fast first move off the 48px button still drags', () => {
    // Regression (found in a real browser): capture was taken only after the
    // threshold, and a first move that already left the button never arrived.
    const capture = vi.fn()
    Object.defineProperty(HTMLElement.prototype, 'setPointerCapture', { configurable: true, value: capture })
    try {
      render(<AssistantRoot />, { initialEntries: ['/'] })
      fireEvent.pointerDown(launcher(), { pointerId: 7, button: 0, clientX: 500, clientY: 500 })
      expect(capture).toHaveBeenCalledWith(7)
    } finally {
      Reflect.deleteProperty(HTMLElement.prototype, 'setPointerCapture')
    }
  })

  it('drops the position transition while dragging, so it follows the pointer', () => {
    // Regression: the pressed state's 75ms "transition: all" eased right/bottom
    // behind the pointer on every move, so the button did not follow the drag.
    render(<AssistantRoot />, { initialEntries: ['/'] })
    fireEvent.pointerDown(launcher(), { pointerId: 1, button: 0, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(launcher(), { pointerId: 1, clientX: 400, clientY: 400 })
    expect(launcher()).toHaveClass('transition-none')
    expect(launcher().className).not.toMatch(/active:duration|transition-\[/)
    fireEvent.pointerUp(launcher(), { pointerId: 1, clientX: 400, clientY: 400 })
    expect(launcher()).not.toHaveClass('transition-none')
  })

  it('clamps a drag past any edge to the viewport', () => {
    render(<AssistantRoot />, { initialEntries: ['/'] })
    drag(-5000, -5000)
    expect(offsets()).toStrictEqual({ right: 1440 - LAUNCHER_SIZE - EDGE_MARGIN, bottom: 900 - LAUNCHER_SIZE - EDGE_MARGIN })
    drag(9000, 9000)
    expect(offsets()).toStrictEqual({ right: EDGE_MARGIN, bottom: EDGE_MARGIN })
  })

  it('re-clamps on resize and restores the stored spot when the window grows back', () => {
    render(<AssistantRoot />, { initialEntries: ['/'] })
    drag(-1000, -600)
    expect(offsets()).toStrictEqual({ right: 1016, bottom: 616 })
    setViewport(390, 844)
    expect(offsets()).toStrictEqual({ right: 390 - LAUNCHER_SIZE - EDGE_MARGIN, bottom: 616 })
    setViewport(1440, 900)
    expect(offsets()).toStrictEqual({ right: 1016, bottom: 616 })
  })

  it('moves with the arrow keys (Shift = larger steps) and Home puts it back', async () => {
    const user = userEvent.setup()
    render(<AssistantRoot />, { initialEntries: ['/'] })
    launcher().focus()
    await user.keyboard('{ArrowLeft}{ArrowUp}')
    expect(offsets()).toStrictEqual({ right: 16 + KEY_STEP, bottom: 16 + KEY_STEP })
    await user.keyboard('{Shift>}{ArrowLeft}{/Shift}')
    expect(offsets().right).toBe(16 + KEY_STEP + KEY_STEP_LARGE)
    await user.keyboard('{Home}')
    expect(offsets()).toStrictEqual({ right: 16, bottom: 16 })
    expect(useAssistantUiStore.getState().open).toBe(false)
  })

  it('persists the position per user and survives a remount (reload)', async () => {
    const user = userEvent.setup()
    const first = render(<AssistantRoot />, { initialEntries: ['/'] })
    launcher().focus()
    await user.keyboard('{ArrowUp}{ArrowUp}')
    const stored = lastStored('voc-assistant-bubble')
    expect(stored).toMatchObject({ state: { positions: { 'sub-a': { right: 16, bottom: 16 + 2 * KEY_STEP } } } })
    first.unmount()

    // A reload: memory is empty, localStorage holds what was written.
    useBubbleStore.setState({ positions: {} })
    vi.mocked(localStorage.getItem).mockImplementation((key) => (key === 'voc-assistant-bubble' ? JSON.stringify(stored) : null))
    await useBubbleStore.persist.rehydrate()

    render(<AssistantRoot />, { initialEntries: ['/'] })
    expect(offsets()).toStrictEqual({ right: 16, bottom: 16 + 2 * KEY_STEP })
    // Another user on the same browser keeps the default corner.
    act(() => signIn('sub-b'))
    expect(offsets()).toStrictEqual({ right: 16, bottom: 16 })
  })

  it('offers "reset position" in the open panel only once the launcher was moved', async () => {
    const user = userEvent.setup()
    render(<AssistantRoot />, { initialEntries: ['/'] })
    await user.click(launcher())
    expect(screen.queryByRole('button', { name: 'Reset assistant button position' })).not.toBeInTheDocument()
    launcher().focus()
    await user.keyboard('{ArrowUp}')
    await user.click(screen.getByRole('button', { name: 'Reset assistant button position' }))
    expect(offsets()).toStrictEqual({ right: 16, bottom: 16 })
  })

  it('lifts above a sticky action bar so it never covers the Save button', async () => {
    const barTop = 900 - 56
    renderBesideActionBar({ x: 240, y: barTop, width: 1176, height: 56 })
    await waitFor(() => expect(offsets().bottom).toBe(900 - barTop + ACTION_BAR_GAP))
    const launcherTop = 900 - offsets().bottom - LAUNCHER_SIZE
    const launcherBottom = launcherTop + LAUNCHER_SIZE
    expect(launcherBottom).toBeLessThan(barTop)
    // Nothing was stored: the lift follows the bar, it is not the user's choice.
    expect(useBubbleStore.getState().positions).toStrictEqual({})
  })

  it('drops back to its spot once the action bar unmounts', async () => {
    const view = renderBesideActionBar({ x: 0, y: 840, width: 1440, height: 60 })
    await waitFor(() => expect(offsets().bottom).toBe(60 + ACTION_BAR_GAP))
    view.rerender(<AssistantRoot />)
    await waitFor(() => expect(offsets().bottom).toBe(16))
  })
})
