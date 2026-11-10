/**
 * Navigation chips (live 5.14: "the link to the dashboard is below" while the
 * chip sat ABOVE the text, and clicking it did not visibly navigate).
 *
 * The model may offer the link in a tool round before it writes, so the chip
 * was anchored to an earlier message than the answer. Chips now render after
 * the answer's last message, navigate, drop full screen to the expanded panel,
 * and on a phone close the sheet that covers the page.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation } from 'react-router-dom'
import { render } from '@test/test-utils'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import { createThreadState } from '../thread/reducer'
import { shownMode, useAssistantUiStore } from '../store/assistantStore'
import MessageList from './MessageList'
import { navigationAtTurnEnd } from './messageHelpers'
import type { Message } from '@ag-ui/core'
import type { NavigationSuggestion } from '../thread/types'

const DASHBOARD: NavigationSuggestion = { path: '/dashboard', label: 'Open the dashboard' }

/** One answer: a tool round that offered the link (message a1), then the text (a2). */
const ANSWER: Message[] = [
  { id: 'u1', role: 'user', content: 'Where do I see trends?' },
  { id: 'a1', role: 'assistant', content: '', toolCalls: [{ id: 'c1', type: 'function', function: { name: 'suggest_navigation', arguments: '{}' } }] },
  { id: 't1', role: 'tool', toolCallId: 'c1', content: 'shown' },
  { id: 'a2', role: 'assistant', content: 'The trends are on the dashboard. The link to the dashboard is below.' },
]

function Where() {
  return <span data-testid="where">{useLocation().pathname}</span>
}

function renderAnswer() {
  const thread = { ...createThreadState('t'), messages: ANSWER, navigation: { a1: [DASHBOARD] } }
  render(<><MessageList thread={thread} page={{ kind: 'radar', path: '/radar' }} /><Where /></>, { initialEntries: ['/radar'] })
  return userEvent.setup()
}

/** Only what the code reads (`matches`, the `change` listeners); MediaQueryList's deprecated members are left out. */
function mockViewport(narrow: boolean) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: narrow, media: query, onchange: null,
    addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn(() => true),
  }))
}

describe('navigationAtTurnEnd', () => {
  it('moves a chip offered before the text to the answer\u2019s last message', () => {
    expect(navigationAtTurnEnd(ANSWER, { a1: [DASHBOARD] })).toStrictEqual({ a2: [DASHBOARD] })
  })

  it('keeps each answer\u2019s chips with that answer and shows a repeated chip once', () => {
    const messages: Message[] = [
      ...ANSWER,
      { id: 'u2', role: 'user', content: 'And projects?' },
      { id: 'a3', role: 'assistant', content: 'Here.' },
    ]
    const projects = { path: '/projects', label: 'Projects' }
    expect(navigationAtTurnEnd(messages, { a1: [DASHBOARD], a2: [DASHBOARD], a3: [projects] }))
      .toStrictEqual({ a2: [DASHBOARD], a3: [projects] })
  })
})

describe('navigation chips in the conversation', () => {
  beforeEach(() => {
    stubElementScrollIntoView()
    useAssistantUiStore.getState().reset()
    mockViewport(false)
  })
  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('renders the chip after the answer text', () => {
    renderAnswer()
    const text = screen.getByText(/The link to the dashboard is below/u)
    const chip = screen.getByRole('button', { name: 'Open the dashboard' })
    expect(text.compareDocumentPosition(chip) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0)
  })

  it('navigates and shows the expanded panel, keeping the user\u2019s full-screen choice (wave 4)', async () => {
    useAssistantUiStore.setState({ open: true, mode: 'fullscreen' })
    const user = renderAnswer()
    await user.click(screen.getByRole('button', { name: 'Open the dashboard' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard')
    const state = useAssistantUiStore.getState()
    expect([state.mode, state.open, shownMode(state)]).toStrictEqual(['fullscreen', true, 'expanded'])
  })

  it('brings full screen back on the next open of the panel', async () => {
    useAssistantUiStore.setState({ open: true, mode: 'fullscreen' })
    const user = renderAnswer()
    await user.click(screen.getByRole('button', { name: 'Open the dashboard' }))
    act(() => {
      useAssistantUiStore.getState().setOpen(false)
      useAssistantUiStore.getState().setOpen(true)
    })
    expect(shownMode(useAssistantUiStore.getState())).toBe('fullscreen')
  })

  it('on a phone closes the sheet that covers the page, so the page shows', async () => {
    mockViewport(true)
    useAssistantUiStore.setState({ open: true, mode: 'bubble' })
    const user = renderAnswer()
    await user.click(screen.getByRole('button', { name: 'Open the dashboard' }))
    expect(screen.getByTestId('where')).toHaveTextContent('/dashboard')
    expect(useAssistantUiStore.getState().open).toBe(false)
  })
})
