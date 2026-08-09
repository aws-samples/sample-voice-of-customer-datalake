/**
 * @fileoverview Regression tests for Chat page streaming behaviour.
 *
 * Covers issue #265:
 *   - Defect 1: reply must land in the conversation it was sent from, even
 *     when the user switches away mid-stream.
 *   - Defect 3 (pairing): long conversations must be sliced before sending
 *     so the payload never exceeds the server's 50-entry history cap.
 */
import React from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, act } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { TestRouter } from '../../test/test-utils'
import { useChatStore } from '../../store/chatStore'

// ---------------------------------------------------------------------------
// Silence DOM warnings that do not affect correctness
// ---------------------------------------------------------------------------
// eslint-disable-next-line vitest/prefer-spy-on -- scrollIntoView is not a real jsdom method
Element.prototype.scrollIntoView = vi.fn()

// ---------------------------------------------------------------------------
// Config store — static, not interesting for these tests
// ---------------------------------------------------------------------------
vi.mock('../../store/configStore', () => ({
  useConfigStore: () => ({
    config: { apiEndpoint: 'https://api.example.com' },
    timeRange: '7d',
    customDays: undefined,
  }),
}))

vi.mock('../../api/baseUrl', () => ({
  getDaysFromRange: vi.fn(() => 7),
}))

// ---------------------------------------------------------------------------
// useStreamChat — reactive fake backed by React state so that changes to
// streaming values cause the component to re-render (and therefore trigger
// useEffect dependencies like `isStreaming`).
// ---------------------------------------------------------------------------

interface FakeStreamState {
  isStreaming: boolean
  streamingText: string
  thinkingText: string
  activeTools: string[]
  sources: unknown[]
  webSources: unknown[]
  error: string | null
}

const defaultFakeState: FakeStreamState = {
  isStreaming: false,
  streamingText: '',
  thinkingText: '',
  activeTools: [],
  sources: [],
  webSources: [],
  error: null,
}

// Module-level setter that tests use to drive state changes.
// Assigned during the first render of useStreamChat in a test.  Reset to
// undefined in beforeEach so that a test that fails before rendering cannot
// accidentally drive the previous test's state.
let setFakeStreamState: React.Dispatch<React.SetStateAction<FakeStreamState>> | undefined

const mockSendMessageImpl = vi.fn()
const mockCancel = vi.fn()

vi.mock('../../hooks/useStreamChat', () => ({
  useStreamChat: () => {
    // Using React state makes changes observable to the component.
    // eslint-disable-next-line react-hooks/rules-of-hooks -- this IS a hook body
    const [state, setState] = React.useState<FakeStreamState>(defaultFakeState)
    setFakeStreamState = setState  // capture for test use
    return {
      ...state,
      sendMessage: mockSendMessageImpl,
      cancel: mockCancel,
    }
  },
}))

// ---------------------------------------------------------------------------
// Child component stubs — minimal DOM surface for queries
// ---------------------------------------------------------------------------
vi.mock('../../components/ChatSidebar', () => ({
  default: ({ onClose }: { onClose?: () => void }) => (
    <div data-testid="chat-sidebar">
      {onClose != null && <button onClick={onClose}>Close Sidebar</button>}
    </div>
  ),
}))

vi.mock('../../components/ChatMessage', () => ({
  default: ({ message }: { message: { id: string; content: string; role: string } }) => (
    <div data-testid={`message-${message.id}`} data-role={message.role}>
      {message.content}
    </div>
  ),
}))

vi.mock('../../components/ChatFilters', () => ({
  default: () => <div data-testid="chat-filters" />,
}))

vi.mock('../../components/ChatExportMenu', () => ({
  default: () => <div data-testid="chat-export-menu" />,
}))

// ---------------------------------------------------------------------------
// Import after mocks
// ---------------------------------------------------------------------------
import Chat from './Chat'

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function createWrapper() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  })
  return ({ children }: { children: React.ReactNode }) => (
    <QueryClientProvider client={queryClient}>
      <TestRouter initialEntries={['/chat']}>
        {children}
      </TestRouter>
    </QueryClientProvider>
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  // Reset the module-level setter so a test that never renders cannot
  // accidentally use a stale setter from a previous test.
  setFakeStreamState = undefined
  // Reset the real chat store before each test.
  useChatStore.setState({
    conversations: [],
    activeConversationId: null,
    draftFilters: {},
  })
})

// ---------------------------------------------------------------------------
// Defect 1 — mid-stream conversation switch
// ---------------------------------------------------------------------------
describe('mid-stream conversation switch (issue #265 defect 1)', () => {
  it('reply lands in conversation A, not in conversation B, when the user switches mid-stream', async () => {
    const user = userEvent.setup()

    // Pre-create two conversations in the store.  A is where we'll send from;
    // B is where the user will switch while A's stream is still running.
    const idA = useChatStore.getState().createConversation()
    const idB = useChatStore.getState().createConversation()

    // Make A active so the submit targets it.
    act(() => {
      useChatStore.setState({ activeConversationId: idA })
    })

    const wrapper = createWrapper()
    render(<Chat />, { wrapper })

    // After render, setFakeStreamState is populated by the mock factory.
    expect(setFakeStreamState).toBeDefined()

    // sendMessage: immediately signals isStreaming=true so we can switch
    // before "completing" the stream later.
    mockSendMessageImpl.mockImplementation(() => {
      act(() => {
        setFakeStreamState!((prev) => ({ ...prev, isStreaming: true }))
      })
      return Promise.resolve()
    })

    // Type and submit — this will call sendMessage which marks isStreaming.
    const input = screen.getByPlaceholderText(/Ask about your feedback/i)
    await user.type(input, 'question for A')
    await user.click(screen.getByRole('button', { name: /send/i }))

    // Confirm streaming started.
    await waitFor(() => expect(mockSendMessageImpl).toHaveBeenCalled())

    // Switch active conversation to B while A's stream is "in flight".
    act(() => {
      useChatStore.setState({ activeConversationId: idB })
    })

    // Now simulate stream completion with a reply for A.
    act(() => {
      setFakeStreamState!({
        isStreaming: false,
        streamingText: 'The answer from conversation A',
        thinkingText: '',
        activeTools: [],
        sources: [],
        webSources: [],
        error: null,
      })
    })

    // The finish-effect must write the reply to conversation A.
    await waitFor(() => {
      const convA = useChatStore.getState().conversations.find((c) => c.id === idA)
      const assistantInA = convA?.messages.some(
        (m) => m.role === 'assistant' && m.content.includes('The answer from conversation A'),
      )
      expect(assistantInA).toBe(true)
    })

    // It must NOT also land in conversation B.  This assertion is what the
    // bug broke — replies were saved to whichever conversation was active at
    // completion time, not at send time.
    const convB = useChatStore.getState().conversations.find((c) => c.id === idB)
    const assistantInB = convB?.messages.some((m) => m.role === 'assistant')
    expect(assistantInB).toBeFalsy()
  })
})

// ---------------------------------------------------------------------------
// Cancel — partial reply must NOT be saved when the user clicks Stop
// ---------------------------------------------------------------------------
describe('cancel / Stop button (issue #265 defect 1 related)', () => {
  it('does not add an assistant message when the user cancels a stream mid-way', async () => {
    const user = userEvent.setup()

    const id = useChatStore.getState().createConversation()
    act(() => {
      useChatStore.setState({ activeConversationId: id })
    })

    // sendMessage starts the stream.
    mockSendMessageImpl.mockImplementation(() => {
      act(() => {
        setFakeStreamState!((prev) => ({ ...prev, isStreaming: true }))
      })
      return Promise.resolve()
    })
    // cancel simulates the finally-block: always resets isStreaming to false.
    mockCancel.mockImplementation(() => {
      act(() => {
        setFakeStreamState!((prev) => ({ ...prev, isStreaming: false }))
      })
    })

    render(<Chat />, { wrapper: createWrapper() })
    expect(setFakeStreamState).toBeDefined()

    // Send a message — streaming starts.
    const input = screen.getByPlaceholderText(/Ask about your feedback/i)
    await user.type(input, 'a question')
    await user.click(screen.getByRole('button', { name: /send/i }))
    await waitFor(() => expect(mockSendMessageImpl).toHaveBeenCalled())

    // Accumulate some partial text while streaming.
    act(() => {
      setFakeStreamState!((prev) => ({
        ...prev,
        streamingText: 'partial answer that must not be saved',
      }))
    })

    // User clicks Stop — handleCancel clears originConversationIdRef and then
    // calls cancel() which sets isStreaming=false, firing the finish-effect.
    await user.click(screen.getByRole('button', { name: /stop/i }))

    // The finish-effect fires but origin ref is null — no assistant message saved.
    await waitFor(() => expect(mockCancel).toHaveBeenCalled())

    const conv = useChatStore.getState().conversations.find((c) => c.id === id)
    expect(conv).toBeDefined()
    const assistantMessages = conv!.messages.filter((m) => m.role === 'assistant')
    expect(assistantMessages).toHaveLength(0)
  })
})

// ---------------------------------------------------------------------------
// Defect 3 (pairing) — history slice
// ---------------------------------------------------------------------------
describe('history cap (issue #265 defect 3 pairing)', () => {
  it('sends at most 50 history messages even when the conversation is longer', async () => {
    const user = userEvent.setup()

    // Build a conversation with 60 messages (alternating user/assistant).
    const id = useChatStore.getState().createConversation()
    for (let i = 0; i < 60; i++) {
      useChatStore.getState().addMessage(id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      })
    }
    act(() => {
      useChatStore.setState({ activeConversationId: id })
    })

    mockSendMessageImpl.mockResolvedValue(undefined)

    render(<Chat />, { wrapper: createWrapper() })

    const input = screen.getByPlaceholderText(/Ask about your feedback/i)
    await user.type(input, 'new question')
    await user.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(mockSendMessageImpl).toHaveBeenCalled())

    // The second argument to sendMessage is the options object; history is on it.
    const options = mockSendMessageImpl.mock.calls[0][1] as {
      history?: Array<{ role: string; content: string }>
    }
    expect(options.history).toBeDefined()
    // Must not exceed the server-side cap (schema.ts: .max(50)).
    expect(options.history!.length).toBeLessThanOrEqual(50)
    // Exactly 50: the 60-message conversation sliced to the cap.
    expect(options.history!.length).toBe(50)
    // The slice keeps the NEWEST entries — the last entry before the new
    // question is message 59 (index 59 in the original).
    const last = options.history![options.history!.length - 1]
    expect(last.content).toBe('message 59')
  })

  it('sends all history when the conversation is within the cap', async () => {
    const user = userEvent.setup()

    const id = useChatStore.getState().createConversation()
    for (let i = 0; i < 10; i++) {
      useChatStore.getState().addMessage(id, {
        role: i % 2 === 0 ? 'user' : 'assistant',
        content: `message ${i}`,
      })
    }
    act(() => {
      useChatStore.setState({ activeConversationId: id })
    })

    mockSendMessageImpl.mockResolvedValue(undefined)

    render(<Chat />, { wrapper: createWrapper() })

    const input = screen.getByPlaceholderText(/Ask about your feedback/i)
    await user.type(input, 'short conversation question')
    await user.click(screen.getByRole('button', { name: /send/i }))

    await waitFor(() => expect(mockSendMessageImpl).toHaveBeenCalled())

    const options = mockSendMessageImpl.mock.calls[0][1] as {
      history?: Array<{ role: string; content: string }>
    }
    expect(options.history!.length).toBe(10)
  })
})
