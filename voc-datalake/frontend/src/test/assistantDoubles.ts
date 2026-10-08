/**
 * Shared doubles for the assistant suites: the sessions API, AG-UI event
 * scripts, and a `runAgent` whose runs stay open until the test settles them.
 *
 * `vi.mock` factories are hoisted above static imports, so a suite reaches
 * these through `vi.hoisted` / a dynamic import inside the factory:
 *
 *   const agent = await vi.hoisted(async () =>
 *     (await import('@test/assistantDoubles')).createPendingRunAgent({ rejectOnAbort: true }))
 *   vi.mock('../agui/client', agent.clientModule)
 *   vi.mock('../sessions/sessionsApi', agent.sessionsModule)
 */
import { vi } from 'vitest'
import { EventType } from '@ag-ui/core'
import type { RunAgentInput } from '@ag-ui/core'
import type { AguiEvent } from '../assistant/agui/sse'

/** `assistant/sessions/sessionsApi`: saves succeed, nothing is stored. */
export function sessionsApiModule() {
  return {
    saveSession: vi.fn(() => Promise.resolve()),
    listSessions: vi.fn(() => Promise.resolve([])),
    getSession: vi.fn(() => Promise.resolve(null)),
    deleteSession: vi.fn(() => Promise.resolve()),
  }
}

/** A complete successful run that streams one assistant text message. */
export function textRunEvents(runId: string, messageId: string, text: string, threadId = 't'): AguiEvent[] {
  return [
    { type: EventType.RUN_STARTED, threadId, runId },
    { type: EventType.TEXT_MESSAGE_START, messageId, role: 'assistant' },
    { type: EventType.TEXT_MESSAGE_CONTENT, messageId, delta: text },
    { type: EventType.TEXT_MESSAGE_END, messageId },
    { type: EventType.RUN_FINISHED, threadId, runId, outcome: { type: 'success' } },
  ]
}

/** One streamed tool call with its JSON arguments. */
export function toolCallEvents(id: string, name: string, args: string): AguiEvent[] {
  return [
    { type: EventType.TOOL_CALL_START, toolCallId: id, toolCallName: name, parentMessageId: 'a1' },
    { type: EventType.TOOL_CALL_ARGS, toolCallId: id, delta: args },
    { type: EventType.TOOL_CALL_END, toolCallId: id },
  ]
}

export interface PendingRun {
  input: RunAgentInput
  signal: AbortSignal | undefined
  emit: (e: AguiEvent) => void
  finish: () => void
  fail: (error: unknown) => void
}

/** Stream `text` as the run's answer and close it with RUN_FINISHED (the promise stays open). */
export function answerRun(run: PendingRun, messageId: string, text: string): void {
  for (const event of textRunEvents(run.input.runId, messageId, text, run.input.threadId)) run.emit(event)
}

/** `vi.mock('../agui/client', double.clientModule)`: the real client with `runAgent` swapped. */
function clientModuleWith(runAgent: unknown) {
  return async (importOriginal: () => Promise<object>) => ({ ...(await importOriginal()), runAgent })
}

/**
 * A `runAgent` that records every run and leaves it open: the test emits events
 * and settles it. With `rejectOnAbort` an abort rejects the run like the real
 * transport; without it the test decides when an aborted run settles.
 */
export function createPendingRunAgent({ rejectOnAbort }: { rejectOnAbort: boolean }) {
  const runs: PendingRun[] = []
  const runAgent = (input: RunAgentInput, onEvent: (e: AguiEvent) => void, signal?: AbortSignal) => new Promise<void>((resolve, reject) => {
    runs.push({ input, signal, emit: onEvent, finish: resolve, fail: reject })
    if (rejectOnAbort) signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')))
  })
  return { runs, runAgent, clientModule: clientModuleWith(runAgent), sessionsModule: sessionsApiModule }
}

/** A script entry that leaves the run streaming until it is aborted. */
export const HANG = 'hang'

/**
 * A `runAgent` that plays queued scripts synchronously, one per run, recording
 * each run's input. A `HANG` entry starts the run and keeps it streaming until
 * aborted (then rejects like the real transport).
 */
export function createScriptedRunAgent() {
  const runs: RunAgentInput[] = []
  const scripts: (AguiEvent[] | typeof HANG)[] = []
  const runAgent = vi.fn(async (input: RunAgentInput, onEvent: (e: AguiEvent) => void, signal?: AbortSignal) => {
    runs.push(input)
    const script = scripts.shift() ?? []
    if (script === HANG) {
      onEvent({ type: EventType.RUN_STARTED, threadId: input.threadId, runId: input.runId })
      await new Promise<void>((_resolve, reject) => signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))))
      return
    }
    for (const event of script) onEvent(event)
  })
  return { runs, scripts, runAgent, clientModule: clientModuleWith(runAgent), sessionsModule: sessionsApiModule }
}
