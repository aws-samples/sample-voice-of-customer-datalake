/**
 * Runtime: stop keeps partial text, errors surface, duplicate resolutions and
 * sends while approvals are open are ignored.
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
vi.mock('../sessions/sessionsApi', () => ({ saveSession: vi.fn(() => Promise.resolve()), getSession: vi.fn() }))

import { resolveApproval, sendMessage, stopRun } from './runtime'
import { getSession, saveSession } from '../sessions/sessionsApi'
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
    runAgentMock.mockImplementationOnce(async (_i, onEvent) => {
      onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
      onEvent({ type: EventType.TOOL_CALL_START, toolCallId: 'w', toolCallName: 'create_project', parentMessageId: 'a' })
      onEvent({ type: EventType.TOOL_CALL_END, toolCallId: 'w' })
      onEvent({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r', outcome: { type: 'interrupt', interrupts: [{ id: 'approval:w', reason: 'tool_approval', toolCallId: 'w' }] } })
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
      const early: { release: () => void } = { release: () => undefined }
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
      runAgentMock.mockImplementation(async (_input, onEvent) => {
        onEvent({ type: EventType.RUN_STARTED, threadId: 't', runId: 'r' })
        onEvent({ type: EventType.TEXT_MESSAGE_CONTENT, messageId: 'a', delta: 'Answer' })
        onEvent({ type: EventType.RUN_FINISHED, threadId: 't', runId: 'r' })
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
