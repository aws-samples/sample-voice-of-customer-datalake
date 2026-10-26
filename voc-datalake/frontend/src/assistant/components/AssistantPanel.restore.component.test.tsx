/**
 * Live 5.14 finding: after a full page load on another route, opening the
 * bubble and sending put the message in a NEW conversation; when the saved one
 * finished loading it replaced the view (the answer "vanished") and the next
 * message went back to the old conversation.
 *
 * The industry default these specs pin: the conversation in view persists
 * across reloads and route changes, a send continues the conversation on
 * screen, a new one starts only on "New chat", and the panel keeps showing the
 * conversation that just answered.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { act } from 'react'
import { screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useLocation, useNavigate } from 'react-router-dom'
import { stubElementScrollIntoView } from '@test/stubScrollTo'
import type { SessionRecord } from '../sessions/schema'

// The scripted transport and sessions API (hoisted above the imports below).
const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createScriptedRunAgent())
vi.mock('../sessions/sessionsApi', agent.sessionsModule)
vi.mock('../agui/client', agent.clientModule)
const { scripts, runs } = agent

import { getSession } from '../sessions/sessionsApi'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { textRunEvents } from '@test/assistantDoubles'
import { render } from '@test/test-utils'
import AssistantRoot from './AssistantRoot'

const SAVED_ID = 'saved-1'

function savedRecord(): SessionRecord {
  return {
    id: SAVED_ID,
    messages: [
      { id: 'u1', role: 'user', content: 'How is Radar looking?' },
      { id: 'a1', role: 'assistant', content: 'Radar answer from before.' },
    ],
    pendingInterrupts: [], createdAt: '2026-10-18T10:00:00.000Z',
    updatedAt: '2026-10-18T10:01:00.000Z', runStatus: 'finished', revision: 3,
  }
}

/** A getSession that answers only when the test says so (a slow cold read). */
function deferGetSession(result: SessionRecord | null) {
  const gate: { open?: () => void } = {}
  const promise = new Promise<SessionRecord | null>((resolve) => {
    gate.open = () => resolve(result)
  })
  vi.mocked(getSession).mockImplementationOnce(() => promise)
  return async () => {
    await act(async () => {
      gate.open?.()
      await promise
    })
  }
}

/** A route change from the page itself (any link in the app). */
function GoTo({ to }: Readonly<{ to: string }>) {
  const navigate = useNavigate()
  const { pathname } = useLocation()
  return <button type="button" data-path={pathname} onClick={() => void navigate(to)}>go</button>
}

/** A full page load on `/radar`: the app shell (AssistantRoot) mounts with nothing in memory. */
function reloadOn(path: string) {
  const user = userEvent.setup()
  render(<><GoTo to="/dashboard" /><AssistantRoot /></>, { initialEntries: [path] })
  return user
}

function composer(): HTMLElement {
  return screen.getByLabelText('Message the assistant')
}

describe('the conversation in view survives a reload and a route change', () => {
  beforeEach(() => {
    stubElementScrollIntoView()
    scripts.length = 0
    runs.length = 0
    vi.mocked(getSession).mockReset()
    vi.mocked(getSession).mockResolvedValue(null)
    useThreadStore.getState().reset()
    useAssistantUiStore.getState().reset()
    // What the previous page load left behind (localStorage).
    useAssistantUiStore.setState({ activeThreadId: SAVED_ID })
  })

  it('starts loading the last conversation when the app loads, before the panel is opened', () => {
    deferGetSession(savedRecord())
    reloadOn('/radar')
    expect(getSession).toHaveBeenCalledExactlyOnceWith(SAVED_ID)
    expect(useThreadStore.getState().restore.status).toBe('pending')
  })

  it('holds the send while it loads, so a message cannot start a throwaway conversation', async () => {
    deferGetSession(savedRecord())
    const user = reloadOn('/radar')
    await user.click(screen.getByRole('button', { name: 'Open assistant' }))
    await user.type(composer(), 'Typed early')
    await user.keyboard('{Enter}')
    expect(runs).toHaveLength(0)
    expect(screen.getAllByText('Opening your last conversation…').length).toBeGreaterThan(0)
    expect(screen.queryByText('How can I help?')).not.toBeInTheDocument()
  })

  it('continues the restored conversation on send and keeps showing its answer after a route change', async () => {
    const land = deferGetSession(savedRecord())
    const user = reloadOn('/radar')
    await user.click(screen.getByRole('button', { name: 'Open assistant' }))
    await land()
    expect(screen.getByText('Radar answer from before.')).toBeInTheDocument()

    scripts.push(textRunEvents('r2', 'a2', 'The new Radar answer.', SAVED_ID))
    await user.type(composer(), 'And this week?')
    await user.keyboard('{Enter}')
    await screen.findByText('The new Radar answer.')
    expect(runs.map((r) => r.threadId)).toStrictEqual([SAVED_ID])

    await user.click(screen.getByRole('button', { name: 'go' }))
    expect(screen.getByRole('button', { name: 'go' })).toHaveAttribute('data-path', '/dashboard')
    expect(screen.getByText('The new Radar answer.')).toBeInTheDocument()
  })

  it('leaves a conversation the user started with New chat in view when the old one lands late', async () => {
    const land = deferGetSession(savedRecord())
    const user = reloadOn('/radar')
    await user.click(screen.getByRole('button', { name: 'Open assistant' }))
    await user.click(screen.getByRole('button', { name: 'New chat' }))
    expect(screen.queryByText('Opening your last conversation…')).not.toBeInTheDocument()
    await land()
    expect(screen.queryByText('Radar answer from before.')).not.toBeInTheDocument()
    expect(screen.getByText('How can I help?')).toBeInTheDocument()
  })

  it('forgets a conversation that no longer exists and opens an empty one', async () => {
    const land = deferGetSession(null)
    reloadOn('/radar')
    await land()
    expect(useAssistantUiStore.getState().activeThreadId).toBeNull()
    expect(useThreadStore.getState().restore.status).toBe('done')
  })
})
