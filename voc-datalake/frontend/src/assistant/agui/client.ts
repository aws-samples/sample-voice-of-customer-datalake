/**
 * @fileoverview AG-UI client for the unified assistant: `POST /chat/stream`.
 *
 * Same route, auth and SSE framing as the old `api/streamClient.ts`; the body is
 * now an AG-UI `RunAgentInput` and the events are AG-UI events. Auth behaviour is
 * ported unchanged: a 401 gets exactly one silent `refreshSession()` and retry
 * (headers rebuilt, so the trusted-origin check fires again), and a refresh that
 * fails or a retry that is still 401 ends the session visibly via
 * `endExpiredSession()`. A 403 is authorization (WAF / IAM), not an expired
 * token, so it never signs the user out.
 *
 * @module assistant/agui/client
 */
import { getAuthHeaders, getBaseUrl } from '../../api/baseUrl'
import { authService } from '../../services/auth'
import { endExpiredSession } from '../../services/sessionExpiry'
import { AGUI_PROTOCOL_VERSION } from '../contract'
import { readSseEvents } from './sse'
import type { Message, ResumeEntry, RunAgentInput } from '@ag-ui/core'
import type { ForwardedProps } from '../contract'
import type { AguiEvent } from './sse'

class AssistantAuthError extends Error {
  readonly code: 'expired' | 'forbidden'
  constructor(message: string, code: 'expired' | 'forbidden') {
    super(message)
    this.name = 'AssistantAuthError'
    this.code = code
  }
}

class AssistantStreamError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'AssistantStreamError'
    this.status = status
  }
}

function streamEndpoint(): string {
  return `${getBaseUrl()}/chat/stream`
}

function postRun(endpoint: string, body: string, signal?: AbortSignal): Promise<Response> {
  return fetch(endpoint, {
    method: 'POST',
    headers: getAuthHeaders(endpoint, { Accept: 'text/event-stream' }),
    body,
    signal,
  })
}

async function retryAfterRefresh(endpoint: string, body: string, signal?: AbortSignal): Promise<Response> {
  const expired = () => {
    endExpiredSession()
    return new AssistantAuthError('Session expired - please sign in again', 'expired')
  }
  try {
    await authService.refreshSession()
  } catch {
    throw expired()
  }
  const retry = await postRun(endpoint, body, signal)
  if (retry.status === 401) throw expired()
  return retry
}

export interface BuildRunInputOptions {
  threadId: string
  runId?: string
  messages: Message[]
  forwardedProps: ForwardedProps
  resume?: ResumeEntry[]
}

export function newId(): string {
  return crypto.randomUUID()
}

/** Assemble a RunAgentInput the server accepts (AG-UI 1.0, no client-declared tools). */
export function buildRunInput(options: BuildRunInputOptions): RunAgentInput {
  return {
    protocolVersion: AGUI_PROTOCOL_VERSION,
    threadId: options.threadId,
    runId: options.runId ?? newId(),
    messages: options.messages,
    tools: [],
    context: [],
    forwardedProps: options.forwardedProps,
    ...(options.resume && options.resume.length > 0 ? { resume: options.resume } : {}),
  }
}

/**
 * Run the agent once. Resolves when the stream ends; every validated event is
 * handed to `onEvent` in order. Throws on transport/auth failures and on abort
 * (the caller distinguishes abort via `signal.aborted`).
 */
export async function runAgent(
  input: RunAgentInput,
  onEvent: (event: AguiEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const endpoint = streamEndpoint()
  const body = JSON.stringify(input)
  const first = await postRun(endpoint, body, signal)
  const response = first.status === 401 ? await retryAfterRefresh(endpoint, body, signal) : first

  if (!response.ok) {
    if (response.status === 403) throw new AssistantAuthError('Access denied', 'forbidden')
    throw new AssistantStreamError(`Stream error: ${response.status}`, response.status)
  }
  const reader = response.body?.getReader()
  if (!reader) throw new AssistantStreamError('No response body')

  for await (const event of readSseEvents(reader)) {
    onEvent(event)
  }
}
