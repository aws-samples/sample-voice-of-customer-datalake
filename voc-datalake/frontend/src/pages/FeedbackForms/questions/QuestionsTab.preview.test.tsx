/**
 * Room for the editor (F28) on the Questions tab from xl: Hide preview gives the editor the width and is remembered in
 * this browser; while the preview window is open (its BroadcastChannel says `alive`) the in-pane preview collapses on
 * its own, says where it went, and comes back when the window says `closed`; Show preview brings it back meanwhile.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { renderWithDraft, sampleForm } from '../test/draftHarness'
import { FakeBroadcastChannel, listen } from '../test/fakeBroadcastChannel'
import PreviewWindowProvider from '../preview/PreviewWindowProvider'
import QuestionsTab from './QuestionsTab'

vi.mock('../preview/PreviewFrame', () => import('../test/previewFrameStub'))

const FORM = sampleForm()
const SESSION = 'session_for_the_test'

function renderTab() {
  return renderWithDraft(
    <PreviewWindowProvider form={FORM} formKey="f_test"><QuestionsTab /></PreviewWindowProvider>,
    FORM, { rest: ['q_feedback'] },
  )
}

const preview = () => screen.queryByRole('complementary', { name: 'Preview' })

/** The tab with its form's preview window open on the session the builder keeps; what that window says on it. */
function renderWithWindow(): (action: 'alive' | 'closed') => void {
  window.sessionStorage.setItem('voc-form-preview-session:f_test', SESSION)
  renderTab()
  const previewWindow = listen(`voc-form-preview:${SESSION}`)
  return (action) => { act(() => { previewWindow.channel.postMessage({ type: 'voc-form-preview', action }) }) }
}

beforeEach(() => {
  // (from xl: every width query matches)
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: query.startsWith('(min-width'), media: query, onchange: null,
    addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(),
  }))
  vi.stubGlobal('BroadcastChannel', FakeBroadcastChannel)
})

afterEach(() => {
  FakeBroadcastChannel.reset()
  vi.mocked(window.localStorage.getItem).mockReset().mockReturnValue(null)
  window.sessionStorage.clear()
  vi.unstubAllGlobals()
})

describe('the in-pane preview from xl', () => {
  it('hides on Hide preview and keeps the choice in this browser', async () => {
    const user = userEvent.setup()
    renderTab()
    expect(preview()).toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Hide preview' }))
    expect(preview()).not.toBeInTheDocument()
    expect(window.localStorage.setItem).toHaveBeenCalledWith('voc-form-builder-preview', 'hidden')
  })

  it('stays hidden when the browser kept that choice, until Show preview', async () => {
    const user = userEvent.setup()
    // (the setup's localStorage is a stand-in: it answers what was kept)
    vi.mocked(window.localStorage.getItem).mockImplementation((key) => (key === 'voc-form-builder-preview' ? 'hidden' : null))
    renderTab()
    expect(preview()).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(preview()).toBeInTheDocument()
  })

  it('collapses while the preview window is open, and comes back when it closes', () => {
    const windowSays = renderWithWindow()
    expect(preview()).toBeInTheDocument()
    windowSays('alive')
    expect(preview()).not.toBeInTheDocument()
    expect(screen.getByText('The preview is open in its window.')).toBeInTheDocument()
    windowSays('closed')
    expect(preview()).toBeInTheDocument()
  })

  it('takes a window that went silent (its tab killed) as closed', () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const windowSays = renderWithWindow()
    windowSays('alive')
    expect(preview()).not.toBeInTheDocument()
    act(() => { vi.advanceTimersByTime(7500) })
    expect(preview()).toBeInTheDocument()
    vi.useRealTimers()
  })

  it('shows beside an open window when asked, until the next window', async () => {
    const user = userEvent.setup()
    const windowSays = renderWithWindow()
    windowSays('alive')
    await user.click(screen.getByRole('button', { name: 'Show preview' }))
    expect(preview()).toBeInTheDocument()
    windowSays('closed')
    expect(preview()).toBeInTheDocument()
  })
})
