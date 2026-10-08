/**
 * Runtime edges: which runs may write to a thread, what a finished run
 * announces and remembers, sign-out, and session loading.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, renderHook } from '@testing-library/react'
import { EventType } from '@ag-ui/core'
import { createElement } from 'react'
import { answerRun } from '@test/assistantDoubles'
import type { ReactNode } from 'react'
import type { PendingRun } from '@test/assistantDoubles'

// Abort does NOT settle the promise here: each test decides when a run ends.
const agent = await vi.hoisted(async () => (await import('@test/assistantDoubles')).createPendingRunAgent({ rejectOnAbort: false }))
const pendingRuns = agent.runs

vi.mock('../agui/client', agent.clientModule)
vi.mock('../sessions/sessionsApi', agent.sessionsModule)
vi.mock('../notifications/runNotifications', () => ({ announceRunEnd: vi.fn(() => false) }))
const webSearchAvailable = vi.hoisted(() => vi.fn(() => false))
vi.mock('../../runtimeConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../runtimeConfig')>()
  return { ...actual, isWebSearchAvailable: () => webSearchAvailable() }
})

import { closeThread, newThread, openSession, resolveApproval, sendMessage, stopRun } from './runtime'
import { useAssistant } from './useAssistant'
import { useAssistantUiStore, useThreadStore } from '../store/assistantStore'
import { useAuthStore } from '../../store/authStore'
import { createThreadState } from '../thread/reducer'
import { isValidSessionId } from '../sessions/schema'
import { getSession, saveSession } from '../sessions/sessionsApi'
import { announceRunEnd } from '../notifications/runNotifications'
import { AllProviders } from '../../test/TestRouter'
import type { RunEnvironment } from './runtime'
import type { SessionRecord } from '../sessions/schema'
import type { ApprovalResolution } from '../types'

const env: RunEnvironment = { page: { kind: 'home', path: '/' }, useWebSearch: false }

function store() {
  return useThreadStore.getState()
}

function ui() {
  return useAssistantUiStore.getState()
}

function statusOf(threadId: string): string | undefined {
  return store().slots[threadId]?.thread.status
}

function lastRun(): PendingRun {
  const run = pendingRuns.at(-1)
  if (run === undefined) throw new Error('no run started')
  return run
}

/**
 * Start a run in `threadId` (default: the one in view).
 *
 * `sendMessage` saves the thread as the run starts (so a reload mid-run keeps
 * the question). That save is awaited and then cleared here, so the tests
 * below pin what happens when a run ENDS; `the save as a run starts` pins the
 * start save itself.
 */
async function startRun(text: string, threadId: string = store().activeId): Promise<{ id: string; run: PendingRun; done: Promise<void> }> {
  const count = pendingRuns.length
  const done = sendMessage(text, env, threadId)
  await vi.waitFor(() => expect(pendingRuns).toHaveLength(count + 1))
  if (isValidSessionId(threadId)) {
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ id: threadId })))
  }
  vi.mocked(saveSession).mockClear()
  return { id: threadId, run: lastRun(), done }
}

function answer(run: PendingRun, text: string): void {
  answerRun(run, `m-${run.input.runId}`, text)
}

/** Park a run on one pending `create_project` approval (the run itself is not settled). */
function interrupt(run: PendingRun): void {
  const { threadId, runId } = run.input
  run.emit({ type: EventType.RUN_STARTED, threadId, runId })
  run.emit({ type: EventType.TOOL_CALL_START, toolCallId: 'w', toolCallName: 'create_project', parentMessageId: 'a' })
  run.emit({ type: EventType.TOOL_CALL_END, toolCallId: 'w' })
  run.emit({ type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'interrupt', interrupts: [{ id: 'approval:w', reason: 'tool_approval', toolCallId: 'w' }] } })
}

/** A finished run in view; returns its thread id. */
async function finishedThread(text = 'question'): Promise<string> {
  const started = await startRun(text)
  answer(started.run, 'answer')
  started.run.finish()
  await started.done
  return started.id
}

function lastAnnounceOptions() {
  const call = vi.mocked(announceRunEnd).mock.calls.at(-1)
  if (call === undefined) throw new Error('announceRunEnd was not called')
  return call[2]
}

const declineW: ApprovalResolution = { interruptId: 'approval:w', toolCallId: 'w', outcome: { status: 'declined', reason: 'no' } }

beforeEach(() => {
  pendingRuns.length = 0
  vi.mocked(saveSession).mockClear()
  vi.mocked(getSession).mockReset()
  vi.mocked(getSession).mockResolvedValue(null)
  vi.mocked(announceRunEnd).mockClear()
  webSearchAvailable.mockReturnValue(false)
  store().reset()
  ui().reset()
})

afterEach(() => {
  window.history.pushState({}, '', '/')
})

describe('which runs write to a thread', () => {
  it('a send to a conversation that is not open starts no run', async () => {
    await expect(sendMessage('hi', env, 'not-open')).resolves.toBeUndefined()
    expect(pendingRuns).toStrictEqual([])
  })

  it('a second send while the thread streams is ignored', async () => {
    const { id } = await startRun('first')
    await sendMessage('second', env, id)
    expect(pendingRuns).toHaveLength(1)
    expect(store().thread.messages.filter((m) => m.role === 'user')).toHaveLength(1)
  })

  it('events a stopped run still emits are dropped', async () => {
    const { id, run } = await startRun('hi')
    stopRun(null, id)
    const before = store().thread.messages
    answer(run, 'late')
    expect(store().thread.messages).toStrictEqual(before)
  })

  it('a stream that ends without RUN_FINISHED marks the thread closed', async () => {
    const { run, done } = await startRun('hi')
    run.finish()
    await done
    expect(store().thread).toMatchObject({ status: 'error', error: { message: 'stream_closed', code: 'STREAM_CLOSED' } })
  })

  /** Stop a run, start a new one on the same thread, then let the stopped run settle late. */
  async function restartThenSettleStopped(): Promise<string> {
    const first = await startRun('hi')
    stopRun(null, first.id)
    await startRun('again', first.id)
    first.run.finish()
    await first.done
    return first.id
  }

  it('a stopped run that settles after a new run started leaves the new run streaming', async () => {
    const id = await restartThenSettleStopped()
    expect(statusOf(id)).toBe('streaming')
  })

  it('a stopped run that settles late does not unregister the new run, which can still be stopped', async () => {
    const id = await restartThenSettleStopped()
    stopRun(null, id)
    expect(statusOf(id)).toBe('idle')
  })

  it('a run that failed is no longer stoppable (stop leaves the error in place)', async () => {
    const { id, run, done } = await startRun('hi')
    run.fail(new Error('boom'))
    await done
    stopRun(null, id)
    expect(store().thread).toMatchObject({ status: 'error', error: { message: 'boom' } })
  })

  it('stopping twice saves the thread once', async () => {
    const { id } = await startRun('hi')
    stopRun(null, id)
    stopRun(null, id)
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledWith(expect.objectContaining({ id })))
    expect(saveSession).toHaveBeenCalledTimes(1)
  })

  it('a stopped run that settles afterwards announces nothing and saves only once', async () => {
    const { id, run, done } = await startRun('hi')
    stopRun(null, id)
    run.finish()
    await done
    expect(announceRunEnd).not.toHaveBeenCalled()
    expect(saveSession).toHaveBeenCalledTimes(1)
  })

  it('a resume whose thread closes while the previous run aborts sends no history', async () => {
    const { id, run } = await startRun('make a project')
    interrupt(run)
    run.signal?.addEventListener('abort', () => store().close(id))
    resolveApproval(declineW, env, id)
    await vi.waitFor(() => expect(pendingRuns).toHaveLength(2))
    expect(lastRun().input.messages).toStrictEqual([])
  })
})

describe('a run whose conversation was dropped from memory', () => {
  it('finishes quietly without announcing or saving', async () => {
    const { id, run, done } = await startRun('hi')
    store().close(id)
    answer(run, 'answer')
    run.finish()
    await expect(done).resolves.toBeUndefined()
    expect(announceRunEnd).not.toHaveBeenCalled()
    expect(saveSession).not.toHaveBeenCalled()
  })
})

describe('approvals', () => {
  it('a resolution for a conversation that is not open is ignored', () => {
    expect(() => resolveApproval(declineW, env, 'not-open')).not.toThrow()
    expect(pendingRuns).toStrictEqual([])
  })

  it('a resolution for an interrupt the thread never raised is not recorded', async () => {
    const { id, run } = await startRun('make a project')
    interrupt(run)
    resolveApproval({ interruptId: 'approval:nope', toolCallId: 'x', outcome: { status: 'declined' } }, env, id)
    expect(store().thread.resolutions).toStrictEqual({})
  })

  it('the first answer to an approval wins over a later one', async () => {
    const { id, run } = await startRun('make two projects')
    const { threadId, runId } = run.input
    run.emit({ type: EventType.RUN_STARTED, threadId, runId })
    run.emit({
      type: EventType.RUN_FINISHED, threadId, runId,
      outcome: { type: 'interrupt', interrupts: [{ id: 'approval:w', reason: 'tool_approval', toolCallId: 'w' }, { id: 'approval:v', reason: 'tool_approval', toolCallId: 'v' }] },
    })
    resolveApproval(declineW, env, id)
    resolveApproval({ interruptId: 'approval:w', toolCallId: 'w', outcome: { status: 'executed', summary: 'done' } }, env, id)
    expect(store().thread.resolutions['approval:w']).toStrictEqual(declineW)
  })

  it('a resolution on a thread whose approval run failed is not recorded', async () => {
    const { id, run, done } = await startRun('make a project')
    interrupt(run)
    run.fail(new Error('broken pipe'))
    await done
    resolveApproval(declineW, env, id)
    expect(store().thread.resolutions).toStrictEqual({})
  })
})

describe('what a finished run remembers', () => {
  it('a thread whose id is not a valid session id is never saved', async () => {
    store().replace(createThreadState('not.a.session'))
    const started = await startRun('hi')
    answer(started.run, 'answer')
    started.run.finish()
    await started.done
    expect(saveSession).not.toHaveBeenCalled()
  })

  it('a save of the thread in view remembers it for reload', async () => {
    const id = await finishedThread()
    expect(ui().activeThreadId).toBe(id)
  })

  it('every successful save bumps the save tick', async () => {
    const started = await startRun('question')
    const afterStart = store().saveTick
    answer(started.run, 'answer')
    started.run.finish()
    await started.done
    expect(afterStart).toBe(1)
    expect(store().saveTick).toBe(2)
  })

  it('a background save does not change the remembered conversation', async () => {
    const first = await startRun('first')
    newThread()
    const second = await startRun('second')
    answer(first.run, 'first answer')
    first.run.finish()
    await first.done
    // The conversation in view (saved as its run started) stays remembered.
    expect(ui().activeThreadId).toBe(second.id)
  })

  it('"New chat" forgets the remembered conversation (an empty one has no session)', async () => {
    await finishedThread()
    newThread()
    expect(ui().activeThreadId).toBeNull()
  })

  it('switching back to an open conversation remembers it', async () => {
    const id = await finishedThread()
    newThread()
    await expect(openSession(id, env)).resolves.toBe(true)
    expect(ui().activeThreadId).toBe(id)
  })

  it('closing the empty conversation in view remembers the one that comes into view', async () => {
    const id = await finishedThread()
    newThread()
    closeThread(store().activeId)
    expect(ui().activeThreadId).toBe(id)
  })
})

describe('run-end notifications', () => {
  it('passes the notify preference through as enabled', async () => {
    ui().setNotify(true)
    await finishedThread()
    expect(lastAnnounceOptions().enabled).toBe(true)
  })

  it('a background conversation is off screen even with the panel open', async () => {
    ui().setOpen(true)
    const first = await startRun('first')
    newThread()
    answer(first.run, 'answer')
    first.run.finish()
    await first.done
    expect(lastAnnounceOptions().threadOnScreen).toBe(false)
  })

  it('the conversation in view is off screen when the panel is closed and the route is not /chat', async () => {
    await finishedThread()
    expect(lastAnnounceOptions().threadOnScreen).toBe(false)
  })

  it('the conversation in view is on screen when the panel is open', async () => {
    ui().setOpen(true)
    await finishedThread()
    expect(lastAnnounceOptions().threadOnScreen).toBe(true)
  })

  it('the conversation in view is on screen on /chat with the panel closed', async () => {
    window.history.pushState({}, '', '/chat')
    await finishedThread()
    expect(lastAnnounceOptions().threadOnScreen).toBe(true)
  })

  it('opening the notification brings its conversation into view', async () => {
    const first = await startRun('first')
    newThread()
    answer(first.run, 'answer')
    first.run.finish()
    await first.done
    lastAnnounceOptions().onOpen()
    expect(store().activeId).toBe(first.id)
  })

  it('opening the notification off /chat opens the panel', async () => {
    await finishedThread()
    lastAnnounceOptions().onOpen()
    expect(ui().open).toBe(true)
  })

  it('opening the notification on /chat leaves the panel closed', async () => {
    window.history.pushState({}, '', '/chat')
    await finishedThread()
    lastAnnounceOptions().onOpen()
    expect(ui().open).toBe(false)
  })
})

describe('sign-out', () => {
  function signOut(): void {
    useAuthStore.setState({ isAuthenticated: true })
    useAuthStore.setState({ isAuthenticated: false })
  }

  it('aborts every running conversation', async () => {
    const { run } = await startRun('hi')
    signOut()
    expect(run.signal?.aborted).toBe(true)
  })

  it('forgets the aborted runs, so a reopened conversation has nothing to stop', async () => {
    const { id } = await startRun('hi')
    signOut()
    store().replace({ ...createThreadState(id), messages: [{ id: 'u', role: 'user', content: 'hi' }] })
    stopRun(null, id)
    await Promise.resolve()
    expect(saveSession).not.toHaveBeenCalled()
  })
})

describe('openSession', () => {
  function record(overrides: Partial<SessionRecord> = {}): SessionRecord {
    return {
      id: 'saved-1',
      title: 'saved',
      kind: 'assistant',
      messages: [{ id: 'u1', role: 'user', content: 'make a project' }],
      page: null,
      pendingInterrupts: [],
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-01-01T00:00:00.000Z',
      runStatus: null,
      revision: 0,
      ...overrides,
    }
  }

  it('reports false for a session that does not exist', async () => {
    await expect(openSession('missing', env)).resolves.toBe(false)
    expect(getSession).toHaveBeenCalledWith('missing')
  })

  it('a loaded session whose only approval expired resumes with a cancelled entry', async () => {
    vi.mocked(getSession).mockResolvedValue(record({
      pendingInterrupts: [{ id: 'approval:w', toolCallId: 'w', expiresAt: '2000-01-01T00:00:00Z' }],
    }))
    await expect(openSession('saved-1', env)).resolves.toBe(true)
    expect(lastRun().input).toMatchObject({ threadId: 'saved-1', resume: [{ interruptId: 'approval:w', status: 'cancelled', payload: { approved: false } }] })
  })

  it('a loaded session is remembered for reload and keeps its creation time', async () => {
    vi.mocked(getSession).mockResolvedValue(record())
    await openSession('saved-1', env)
    expect(ui().activeThreadId).toBe('saved-1')
    expect(store().createdAt).toBe('2026-01-01T00:00:00.000Z')
  })

  it('a loaded session without a creation time gets a fresh one', async () => {
    vi.mocked(getSession).mockResolvedValue(record({ createdAt: '' }))
    await openSession('saved-1', env)
    expect(Number.isNaN(Date.parse(store().createdAt))).toBe(false)
  })

  it('a loaded session without approvals starts no run', async () => {
    vi.mocked(getSession).mockResolvedValue(record())
    await expect(openSession('saved-1', env)).resolves.toBe(true)
    expect(pendingRuns).toStrictEqual([])
  })
})

describe('useAssistant binds actions to the thread in view', () => {
  function wrapper({ children }: Readonly<{ children: ReactNode }>) {
    return createElement(AllProviders, null, children)
  }

  /** Make the thread in view non-empty, render the hook, then open a fresh one. */
  function renderThenSwitch() {
    store().dispatch({ type: 'local/user_message', message: { id: 'u0', role: 'user', content: 'old' } })
    const hook = renderHook(() => useAssistant(), { wrapper })
    act(() => newThread())
    return hook
  }

  it.each([
    ['on when the deployment offers it and the toggle is on', true, true, true],
    ['off when the deployment offers it but the toggle is off', true, false, false],
    ['off when the toggle is on but the deployment does not offer it', false, true, false],
  ] as const)('web search is %s', (_label, available, toggle, expected) => {
    webSearchAvailable.mockReturnValue(available)
    ui().setUseWebSearch(toggle)
    const { result } = renderHook(() => useAssistant(), { wrapper })
    expect(result.current.env.useWebSearch).toBe(expected)
  })

  it('flipping the web-search toggle updates the run environment', () => {
    webSearchAvailable.mockReturnValue(true)
    const { result } = renderHook(() => useAssistant(), { wrapper })
    act(() => ui().setUseWebSearch(true))
    expect(result.current.env.useWebSearch).toBe(true)
  })

  it('send targets the conversation in view after a switch', async () => {
    const { result } = renderThenSwitch()
    const inView = store().activeId
    await act(async () => {
      void result.current.send('hi')
      await vi.waitFor(() => expect(pendingRuns).toHaveLength(1))
    })
    expect(lastRun().input.threadId).toBe(inView)
  })

  it('stop stops the run of the conversation in view after a switch', async () => {
    const { result } = renderThenSwitch()
    const { id } = await act(() => startRun('hi'))
    act(() => result.current.stop())
    expect(statusOf(id)).toBe('idle')
  })

  it('resolve answers the approval of the conversation in view after a switch', async () => {
    const { result } = renderThenSwitch()
    const { id, run } = await act(() => startRun('make a project'))
    act(() => interrupt(run))
    act(() => result.current.resolve(declineW))
    expect(lastRun().input).toMatchObject({ threadId: id, resume: [{ interruptId: 'approval:w', status: 'resolved' }] })
  })
})

describe('the save as a run starts (QA perf: a reload mid-run keeps the conversation)', () => {
  it('stores the question before the run has answered anything', async () => {
    const id = store().activeId
    const done = sendMessage('what changed this week?', env, id)
    await vi.waitFor(() => expect(saveSession).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      id, messages: [expect.objectContaining({ role: 'user', content: 'what changed this week?' })],
    })))
    expect(pendingRuns).toHaveLength(1)
    // A brand-new conversation is remembered at once, so a reload reopens it.
    expect(ui().activeThreadId).toBe(id)
    answer(lastRun(), 'answer')
    lastRun().finish()
    await done
  })

  it('reaches the server before the stream is requested, and before the end-of-run save', async () => {
    const order: string[] = []
    const release: { first?: () => void } = {}
    vi.mocked(saveSession)
      .mockImplementationOnce(async (body) => {
        await new Promise<void>((resolve) => {
          release.first = resolve
        })
        order.push(`start:${String(body.messages.length)}`)
      })
      .mockImplementation(async (body) => {
        order.push(`end:${String(body.messages.length)}`)
      })
    const id = store().activeId
    const done = sendMessage('hi', env, id)
    await vi.waitFor(() => expect(release.first).toBeDefined())
    // A slow start save holds the stream back (it would race the stream Lambda's first write).
    expect(pendingRuns).toHaveLength(0)
    release.first?.()
    await vi.waitFor(() => expect(pendingRuns).toHaveLength(1))
    answer(lastRun(), 'answer')
    lastRun().finish()
    await done
    // The start save carries the question only; the end save the answer too.
    await vi.waitFor(() => expect(order).toStrictEqual(['start:1', 'end:2']))
  })
})
