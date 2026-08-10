/**
 * @fileoverview Regression tests for the history payload ChatTab sends.
 *
 * Project chat posts to the same `/chat/stream` endpoint as VOC chat, so the
 * same server cap and the same Bedrock Converse shape rules apply.  Roundtable
 * mode makes this path harder than the VOC one: `buildRoundtableMessages`
 * stores one assistant message *per persona*, so the stored list contains runs
 * of consecutive assistant turns that Bedrock would reject.
 */
import {
  describe, it, expect, vi, beforeEach,
} from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import ChatTab from './ChatTab'
import { useProjectChatStore } from '../../store/projectChatStore'
import { MAX_HISTORY_ENTRIES } from '../../constants/chat'
import type { ProjectPersona, ProjectDocument } from '../../api/types'

// jsdom doesn't implement scrollIntoView — stub it so the effect in ChatTab works.
Object.defineProperty(Element.prototype, 'scrollIntoView', {
  value: vi.fn(),
  writable: true,
  configurable: true,
})

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

interface SentHistoryEntry {
  role: string
  content: string
}

function isHistoryEntry(value: unknown): value is SentHistoryEntry {
  if (typeof value !== 'object' || value === null) return false
  const record: Record<string, unknown> = { ...value }
  return typeof record.role === 'string' && typeof record.content === 'string'
}

/** Read the history array ChatTab passed to sendMessage, guarded not cast. */
function sentHistory(): SentHistoryEntry[] {
  const call: unknown[] | undefined = mockSendMessage.mock.calls[0]
  if (call === undefined) throw new Error('sendMessage was not called')
  const options: unknown = call[1]
  if (typeof options !== 'object' || options === null || !('history' in options)) {
    throw new Error('sendMessage options did not include a history field')
  }
  const { history } = options
  if (!Array.isArray(history) || !history.every(isHistoryEntry)) {
    throw new Error('history was not an array of {role, content} entries')
  }
  return history
}

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
          },
          {
            role: 'assistant',
            content: 'persona B says',
          },
          {
            role: 'assistant',
            content: 'persona C says',
          },
          {
            role: 'user',
            content: 'and about pricing?',
          },
          {
            role: 'assistant',
            content: 'pricing answer',
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
    expect(history.some((m, i) => i > 0 && m.role === history[i - 1].role)).toBe(false)
  })
})
