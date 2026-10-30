/**
 * Runtime: stop keeps partial text, errors surface, duplicate resolutions and
 * sends while approvals are open are ignored; Stop cancels the server run and marks the
 * answer, Regenerate re-runs the last question.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { EventType } from '@ag-ui/core'
import type { RunAgentInput } from '@ag-ui/core'
import type { AguiEvent } from '../agui/sse'

const runAgentMock = vi.fn<(input: RunAgentInput, onEvent: (e: AguiEvent) => void, signal?: AbortSignal) => Promise<void>>()

vi.mock('../agui/client', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../agui/client')>()
  return { ...actual, runAgent: (...args: Parameters<typeof runAgentMock>) => runAgentMock(...args) }
})
vi.mock('../sessions/sessionsApi', () => ({ saveSession: vi.fn(() => Promise.resolve()), getSession: vi.fn(), cancelServerRun: vi.fn(() => Promise.resolve()) }))

import { regenerate, resolveApproval, sendMessage, stopRun } from './runtime'
import { cancelServerRun, getSession, saveSession } from '../sessions/sessionsApi'
import { threadFromSession, toSaveBody } from '../sessions/serialize'
import { useThreadStore } from '../store/assistantStore'
import type { RunEnvironment } from './runtime'
import type { ApprovalResolution } from '../types'

const env: RunEnvironment = { page: { kind: 'home', path: '/' }, useWebSearch: false }

describe('assistant runtime', () => {
  beforeEach(() => {
    runAgentMock.mockReset()
    useThreadStore.getState().reset()
  })

  it('stop aborts the run, keeps partial text and returns to idle', async () => {
    runAgentMock.mockImplementation((_input, onEvent, signal) => new Promise((_resolve, reject) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
      onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' })
      signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
    }))
    const pending = sendMessage('hi', env)
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1))
    stopRun()
    await pending
    const { thread } = useThreadStore.getState()
    expect(thread.status).toBe('idle')
    expect(thread.error).toBeNull()
    expect(thread.messages.at(-1)).toMatchObject({ role: 'assistant', content: 'Partial' })
  })

  it('surfaces transport errors on the thread', async () => {
    runAgentMock.mockRejectedValue(new Error('Stream error: 502'))
    await sendMessage('hi', env)
    expect(useThreadStore.getState().thread).toMatchObject({ status: 'error', error: { message: 'Stream error: 502' } })
  })

  /** Start a run that ends awaiting approval of one `create_project` call. */
  async function awaitApproval() {
    runAgentMock.mockImplementationOnce((_i, onEvent) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
      onEvent({ type: EventType.TOOL_CALL_START, toolCallId: 'w', toolCallName: 'create_project', parentMessageId: 'a' })
      onEvent({ type: EventType.TOOL_CALL_END, toolCallId: 'w' })
      onEvent({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'interrupt', interrupts: [{ id: 'approval:w', reason: 'tool_approval', toolCallId: 'w' }] } })
      return Promise.resolve()
    })
    await sendMessage('make a project', env)
  }

  const declineW: ApprovalResolution = { interruptId: 'approval:w', toolCallId: 'w', outcome: { status: 'declined', reason: 'no' } }

  it('ignores sends while approvals are open', async () => {
    await awaitApproval()
    expect(useThreadStore.getState().thread.status).toBe('awaiting_approval')
    await sendMessage('another', env)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
  })

  it('ignores a resolution for an unknown interrupt', async () => {
    await awaitApproval()
    resolveApproval({ interruptId: 'approval:nope', toolCallId: 'x', outcome: { status: 'declined' } }, env)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
  })

  it('resumes once on a duplicated resolution, with the declined entry', async () => {
    await awaitApproval()
    runAgentMock.mockResolvedValue(undefined)
    resolveApproval(declineW, env)
    resolveApproval(declineW, env)
    expect(runAgentMock).toHaveBeenCalledTimes(2)
    expect(runAgentMock.mock.calls.at(1)?.[0].resume).toStrictEqual([{ interruptId: 'approval:w', status: 'resolved', payload: { approved: false } }])
  })

  /**
   * A conversation used to be saved only when its run ended, so reloading (or
   * closing the tab) mid-stream lost it entirely, question included: QA s1 on
   * production 2.13.00 got 404 for the thread both at once and a minute later.
   */
  describe('saving', () => {
    const saveMock = vi.mocked(saveSession)
    const savedRoles = (call: number): string[] => (saveMock.mock.calls.at(call)?.[0].messages ?? []).map((m) => m.role)
    /** Hold the next (early) save in flight; call the returned function to let it land. */
    const holdEarlySave = (): (() => void) => {
      const early: { release: () => void } = { release: () => {} }
      saveMock.mockImplementationOnce(() => new Promise<void>((resolve) => { early.release = resolve }))
      return () => early.release()
    }

    beforeEach(() => {
      saveMock.mockReset()
      saveMock.mockResolvedValue(undefined)
    })

    it('saves the question as soon as it is sent, while the run is still streaming', async () => {
      runAgentMock.mockImplementation((_input, onEvent) => new Promise(() => {
        onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
      }))
      void sendMessage('hi', env)
      await vi.waitFor(() => expect(useThreadStore.getState().thread.status).toBe('streaming'))
      expect(saveMock).toHaveBeenCalledTimes(1)
      expect(savedRoles(0)).toStrictEqual(['user'])
    })

    it('writes the finished thread after the early save, never before it', async () => {
      saveMock.mockImplementationOnce(() => Promise.resolve())
      runAgentMock.mockImplementation((_input, onEvent) => {
        onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
        onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Answer' })
        onEvent({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' })
        return Promise.resolve()
      })
      await sendMessage('hi', env)
      expect(saveMock).toHaveBeenCalledTimes(2)
      expect(savedRoles(0)).toStrictEqual(['user'])
      expect(savedRoles(1)).toStrictEqual(['user', 'assistant'])
    })

    /**
     * QA 2.14.00 on production: the early save was not awaited, so it raced the
     * stream Lambda's first write of the same item and was refused 409 ("A reply
     * is still being generated") on ~half of first messages — a console error.
     */
    it('starts the stream only once the early save has landed', async () => {
      const releaseEarlySave = holdEarlySave()
      runAgentMock.mockResolvedValue(undefined)
      const pending = sendMessage('hi', env)
      await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
      expect(runAgentMock).not.toHaveBeenCalled()
      releaseEarlySave()
      await pending
      expect(runAgentMock.mock.calls.map(([input]) => input.messages.map((m) => m.role))).toStrictEqual([['user']])
    })

    it('is already streaming while the early save is in flight, so a second Send is ignored', async () => {
      const releaseEarlySave = holdEarlySave()
      runAgentMock.mockResolvedValue(undefined)
      const pending = sendMessage('hi', env)
      await vi.waitFor(() => expect(useThreadStore.getState().thread.status).toBe('streaming'))
      await sendMessage('again', env)
      releaseEarlySave()
      await pending
      expect(runAgentMock).toHaveBeenCalledTimes(1)
    })

    it('never starts the stream when stopped while the early save is in flight', async () => {
      const releaseEarlySave = holdEarlySave()
      const pending = sendMessage('hi', env)
      await vi.waitFor(() => expect(saveMock).toHaveBeenCalledTimes(1))
      stopRun()
      releaseEarlySave()
      await pending
      expect(runAgentMock).not.toHaveBeenCalled()
      expect(useThreadStore.getState().thread.status).toBe('idle')
    })

    it('a refused early save is silent and never replaces the thread with the server copy', async () => {
      saveMock.mockRejectedValueOnce(new Error('API Error: 409'))
      runAgentMock.mockResolvedValue(undefined)
      await sendMessage('hi', env)
      expect(vi.mocked(getSession)).not.toHaveBeenCalled()
      expect(runAgentMock).toHaveBeenCalledTimes(1)
      expect(useThreadStore.getState().thread.messages.at(0)).toMatchObject({ role: 'user', content: 'hi' })
    })
  })
})

/** A run that streams `events` and then hangs until it is aborted, like the real transport. */
function hangAfter(events: AguiEvent[]) {
  runAgentMock.mockImplementationOnce((input, onEvent, signal) => new Promise((_resolve, reject) => {
    onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
    for (const event of events) onEvent(event)
    signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  }))
}

async function sendAndStop(events: AguiEvent[]) {
  hangAfter(events)
  const pending = sendMessage('Write a long report', env)
  await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1))
  stopRun()
  await pending
  return useThreadStore.getState().thread
}

function lastRun(): RunAgentInput {
  const input = runAgentMock.mock.calls.at(-1)?.[0]
  if (input === undefined) throw new Error('no run')
  return input
}

// 5.35 (E2E 5.34): Stop cleared the answer while the server run went on, a reload showed the full
// answer, and nothing said the answer was stopped.
beforeEach(() => {
  runAgentMock.mockReset()
  vi.mocked(cancelServerRun).mockClear()
  useThreadStore.getState().reset()
})

describe('Stop', () => {
  it('asks the server to cancel exactly the run it stopped', async () => {
    const thread = await sendAndStop([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' }])
    expect(cancelServerRun).toHaveBeenCalledWith(thread.threadId, lastRun().runId)
  })

  it('keeps the partial answer and marks it Stopped', async () => {
    const thread = await sendAndStop([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' }])
    expect(thread.messages.at(-1)).toMatchObject({ id: 'a', role: 'assistant', content: 'Partial' })
    expect(thread.stopped).toStrictEqual({ a: true })
  })

  it('keeps the thinking of a turn stopped before any answer, on a marked empty answer', async () => {
    const thread = await sendAndStop([{ type: EventType.REASONING_MESSAGE_CONTENT, messageId: 'r', delta: 'Counting themes' }])
    const answer = thread.messages.at(-1)
    expect(answer).toMatchObject({ role: 'assistant', content: '' })
    const id = answer?.id ?? ''
    expect(thread.stopped[id]).toBe(true)
    expect(thread.reasoningByMessage[id]).toBe('Counting themes')
  })

  it('saves the marker, so a reload shows it again', async () => {
    const thread = await sendAndStop([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' }])
    const body = toSaveBody(thread, null, '2026-10-25T00:00:00Z')
    expect(body.messages.at(-1)).toMatchObject({ metadata: { voc: { stopped: true } } })
    const restored = threadFromSession({
      id: thread.threadId, messages: body.messages, pendingInterrupts: [], createdAt: '', updatedAt: '', runStatus: 'stopped', revision: 1,
    })
    expect(restored.stopped).toStrictEqual({ a: true })
  })

  it('marks an answer the server reports stopped (another tab pressed Stop)', async () => {
    runAgentMock.mockImplementationOnce((input, onEvent) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
      onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' })
      onEvent({ type: EventType.CUSTOM, name: 'assistant.stopped', value: {} })
      onEvent({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: 'success' } })
      return Promise.resolve()
    })
    await sendMessage('Write a long report', env)
    expect(useThreadStore.getState().thread.stopped).toStrictEqual({ a: true })
  })
})

describe('Regenerate', () => {
  it('re-runs the last question without its old answer', async () => {
    await sendAndStop([{ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Partial' }])
    runAgentMock.mockImplementationOnce((input, onEvent) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
      onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'b', delta: 'Full answer' })
      onEvent({ type: EventType.RUN_FINISHED, threadId: input.threadId, runId: input.runId, outcome: { type: 'success' } })
      return Promise.resolve()
    })
    await regenerate(env)
    expect(lastRun().messages.map((m) => m.role)).toStrictEqual(['user'])
    const { thread } = useThreadStore.getState()
    expect(thread.messages.some((m) => m.id === 'a')).toBe(false)
    expect(thread.messages.at(-1)).toMatchObject({ id: 'b', content: 'Full answer' })
  })

  it('does nothing while the thread is streaming', async () => {
    hangAfter([])
    void sendMessage('Write a long report', env)
    await vi.waitFor(() => expect(runAgentMock).toHaveBeenCalledTimes(1))
    await regenerate(env)
    expect(runAgentMock).toHaveBeenCalledTimes(1)
    stopRun()
  })
})
