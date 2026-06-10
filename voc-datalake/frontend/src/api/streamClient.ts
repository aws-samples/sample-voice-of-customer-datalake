/**
 * SSE stream consumer for the new API Gateway streaming endpoints.
 *
 * Replaces the old SigV4-signed Function URL approach with simple
 * Cognito token auth through API Gateway.
 */
import {
  getBaseUrl, getAuthHeaders,
} from './baseUrl'

class StreamAuthError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'StreamAuthError'
  }
}

class StreamResponseError extends Error {
  readonly status?: number
  constructor(message: string, status?: number) {
    super(message)
    this.name = 'StreamResponseError'
    this.status = status
  }
}

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'done' | 'error' | 'metadata' | 'document_changed' | 'persona_turn'
  content?: string
  toolName?: string
  toolInput?: Record<string, unknown>
  metadata?: Record<string, unknown>
  documentChange?: {
    document_id: string
    title: string
    action: 'updated' | 'created'
    summary: string
  }
  persona?: {
    persona_id: string
    name: string
    avatar_url?: string
  }
}

function getStreamHeaders(): Record<string, string> {
  return getAuthHeaders({ Accept: 'text/event-stream' })
}

const VALID_EVENT_TYPES = new Set(['text', 'thinking', 'tool_use', 'tool_result', 'done', 'error', 'metadata', 'document_changed', 'persona_turn'])

function isStreamEvent(value: unknown): value is StreamEvent {
  if (typeof value !== 'object' || value === null || !('type' in value)) return false
  const { type } = value
  return typeof type === 'string' && VALID_EVENT_TYPES.has(type)
}

/** Try to parse a single SSE data line into a StreamEvent. */
function parseSSELine(line: string): StreamEvent | null {
  if (!line.startsWith('data: ')) return null
  try {
    const parsed: unknown = JSON.parse(line.slice(6))
    return isStreamEvent(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Parse complete lines from a buffer, returning events and the remaining partial line. */
function parseBufferedLines(buffer: string): {
  events: StreamEvent[];
  remainder: string
} {
  const lines = buffer.split('\n')
  const remainder = lines.pop() ?? ''
  const events: StreamEvent[] = []
  for (const line of lines) {
    const event = parseSSELine(line)
    if (event) events.push(event)
  }
  return {
    events,
    remainder,
  }
}

/** Read an SSE stream from a ReadableStreamDefaultReader, yielding parsed events. */
async function* readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  const buf = { value: '' }

  try {
    for (;;) {
      const {
        done, value,
      } = await reader.read()
      if (done) break

      buf.value += decoder.decode(value, { stream: true })
      const {
        events, remainder,
      } = parseBufferedLines(buf.value)
      buf.value = remainder
      yield* events
    }
  } finally {
    reader.releaseLock()
  }
}

/**
 * Async generator that streams SSE events from the chat endpoint.
 * Yields parsed StreamEvent objects as they arrive.
 */
export async function* streamChat(
  endpoint: string,
  body: Record<string, unknown>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const headers = getStreamHeaders()

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    if (response.status === 401) throw new StreamAuthError('Session expired - please sign in again')
    if (response.status === 403) throw new StreamAuthError('Access denied - please sign in again')
    throw new StreamResponseError(`Stream error: ${response.status}`, response.status)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new StreamResponseError('No response body')

  yield* readSSEStream(reader)
}

interface VocChatOptions {
  message: string
  context?: string
  days?: number
  responseLanguage?: string
  history?: Array<{
    role: string;
    content: string
  }>
  signal?: AbortSignal
}

/** Stream VoC chat. */
export function streamVocChat(options: VocChatOptions): AsyncGenerator<StreamEvent> {
  const base = getBaseUrl()
  return streamChat(`${base}/chat/stream`, {
    message: options.message,
    context: options.context,
    days: options.days ?? 7,
    response_language: options.responseLanguage,
    history: options.history,
  }, options.signal)
}

interface ProjectChatOptions {
  projectId: string
  message: string
  selectedPersonas?: string[]
  selectedDocuments?: string[]
  responseLanguage?: string
  attachments?: Array<{
    name: string;
    media_type: string;
    data: string
  }>
  history?: Array<{
    role: string;
    content: string
  }>
  signal?: AbortSignal
  roundtable?: boolean
}

/** Stream project chat. Uses /chat/stream with project_id in body. */
export function streamProjectChat(options: ProjectChatOptions): AsyncGenerator<StreamEvent> {
  const base = getBaseUrl()
  return streamChat(`${base}/chat/stream`, {
    message: options.message,
    project_id: options.projectId,
    selected_personas: options.selectedPersonas,
    selected_documents: options.selectedDocuments,
    response_language: options.responseLanguage,
    attachments: options.attachments,
    history: options.history,
    ...(options.roundtable === true ? { roundtable: true } : {}),
  }, options.signal)
}
