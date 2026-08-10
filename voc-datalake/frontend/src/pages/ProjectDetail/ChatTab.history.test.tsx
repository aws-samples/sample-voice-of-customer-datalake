/**
 * @fileoverview Regression tests for the history payload ChatTab sends.
 *
 * Project chat posts to the same `/chat/stream` endpoint as VOC chat, so the
 * same server window and the same Bedrock Converse shape rules apply.
 * Roundtable mode makes this path harder than the VOC one:
 * `buildRoundtableMessages` stores one assistant message *per persona*, so the
 * stored list contains runs of consecutive assistant turns that Bedrock would
 * reject — and those runs carry an `activePersona` that has to survive the merge
 * that repairs them, or several personas end up speaking with one voice.
 */
import {
  describe, it, expect, vi, beforeAll, afterAll, beforeEach,
} from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatTab from './ChatTab'
import { useProjectChatStore } from '../../store/projectChatStore'
import { MAX_HISTORY_ENTRIES } from '../../constants/chat'
import { stubElementScrollIntoView } from '../../test/stubScrollTo'
import { readSentHistory, hasAdjacentSameRole } from '../../test/historyPayload'
import type { ProjectPersona, ProjectDocument } from '../../api/types'

const mockSendMessage = vi.fn()

vi.mock('../../hooks/useStreamChat', () => ({
  useStreamChat: () => ({
    isStreaming: false,
    streamingText: '',
    thinkingText: '',
    activeTools: [],
    toolSteps: [],
    documentChanges: [],
    error: null,
    completedTurns: [],
    currentPersona: null,
    sendMessage: mockSendMessage,
    cancel: vi.fn(),
  }),
}))

const defaultProps = {
  projectId: 'proj_history',
  personas: [] as ProjectPersona[],
  documents: [] as ProjectDocument[],
  onSaveAsDocument: vi.fn(),
  onDocumentChanged: vi.fn(),
}

/** Read the history array ChatTab passed to sendMessage, guarded not cast. */
const sentHistory = () => readSentHistory(mockSendMessage)

async function sendAQuestion(): Promise<void> {
  const user = userEvent.setup()
  render(<ChatTab {...defaultProps} />)
  await user.type(screen.getByPlaceholderText(/Ask/i), 'next question')
  // Queried by accessible name, not by its absence: `{ name: '' }` matched the
  // send button only because it was the one icon-only button without a label.
  await user.click(screen.getByRole('button', { name: /send/i }))
  await waitFor(() => expect(mockSendMessage).toHaveBeenCalled())
}

describe('ChatTab history payload', () => {
  // ChatTab scrolls the message list into view in an effect, which jsdom does
  // not implement.  Installed and torn down here rather than patched at module
  // scope so the stub cannot leak into the rest of the suite.
  let restoreScrollIntoView: () => void
  beforeAll(() => {
    restoreScrollIntoView = stubElementScrollIntoView()
  })
  afterAll(() => {
    restoreScrollIntoView()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    useProjectChatStore.setState({ messagesByProject: {} })
  })

  it('merges the per-persona assistant turns of a roundtable into one entry', async () => {
    useProjectChatStore.setState({
      messagesByProject: {
        proj_history: [
          {
            role: 'user',
            content: 'what do you all think?',
          },
          {
            role: 'assistant',
            content: 'persona A says',
            activePersona: { name: 'Priya, CFO' },
          },
          {
            role: 'assistant',
            content: 'persona B says',
            activePersona: { name: 'Sam, PM' },
          },
          {
            role: 'assistant',
            content: 'persona C says',
            activePersona: { name: 'Dana, Eng' },
          },
          {
            role: 'user',
            content: 'and about pricing?',
          },
          {
            role: 'assistant',
            content: 'pricing answer',
            activePersona: { name: 'Priya, CFO' },
          },
        ],
      },
    })

    await sendAQuestion()

    const history = sentHistory()
    // Bedrock Converse requires strictly alternating roles.
    expect(history.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant'])
    // No persona's contribution may be dropped by the merge.
    expect(history[1].content).toContain('persona A says')
    expect(history[1].content).toContain('persona B says')
    expect(history[1].content).toContain('persona C says')
    // Nor may attribution be dropped: a roundtable exists to surface
    // disagreement, and a merged turn with the names stripped reads as one
    // speaker contradicting itself.  The store holds the name, so it must reach
    // the model.
    expect(history[1].content).toContain('Priya, CFO')
    expect(history[1].content).toContain('Sam, PM')
    expect(history[1].content).toContain('Dana, Eng')
    // Each name must sit on its own contribution rather than being collected at
    // the top, so the model can tell who said what.
    expect(history[1].content).toContain('Sam, PM: persona B says')
  })

  it('leaves a message with no persona unprefixed', async () => {
    // Single-persona project chat and any pre-existing stored message carry no
    // `activePersona`, so attribution must be additive: no stray separator, and
    // no 'undefined:' leaking into the payload.
    useProjectChatStore.setState({
      messagesByProject: {
        proj_history: [
          {
            role: 'user',
            content: 'a question',
          },
          {
            role: 'assistant',
            content: 'an unattributed answer',
          },
        ],
      },
    })

    await sendAQuestion()

    const history = sentHistory()
    expect(history[1].content).toBe('an unattributed answer')
  })

  it('does not prefix a user turn even when one carries a persona', async () => {
    // `activePersona` is only meaningful on an assistant turn.  Prefixing a user
    // turn would put words in the user's mouth, so the guard is on role too.
    useProjectChatStore.setState({
      messagesByProject: {
        proj_history: [
          {
            role: 'user',
            content: 'a question',
            activePersona: { name: 'Priya, CFO' },
          },
          {
            role: 'assistant',
            content: 'an answer',
          },
        ],
      },
    })

    await sendAQuestion()

    expect(sentHistory()[0].content).toBe('a question')
  })

  it('caps a long project conversation and keeps it starting with a user turn', async () => {
    useProjectChatStore.setState({
      messagesByProject: {
        // 61 entries: slice(-50) alone would start on an assistant turn.
        proj_history: Array.from({ length: 61 }, (_, i) => ({
          role: i % 2 === 0 ? 'user' as const : 'assistant' as const,
          content: `message ${i}`,
        })),
      },
    })

    await sendAQuestion()

    const history = sentHistory()
    expect(history.length).toBeLessThanOrEqual(MAX_HISTORY_ENTRIES)
    expect(history.length).toBeGreaterThan(0)
    expect(history[0].role).toBe('user')
    expect(hasAdjacentSameRole(history)).toBe(false)
  })
})
