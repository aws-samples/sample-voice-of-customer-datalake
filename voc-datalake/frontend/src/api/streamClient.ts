/**
 * SSE stream consumer for the new API Gateway streaming endpoints.
 *
 * Replaces the old SigV4-signed Function URL approach with simple
 * Cognito token auth through API Gateway.
 */
import { authService } from '../services/auth'
import { useConfigStore } from '../store/configStore'

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

function getBaseUrl(): string {
  const { config } = useConfigStore.getState()
  const url = config.apiEndpoint || '/api'
  return url.endsWith('/') ? url.slice(0, -1) : url
}

function getAuthHeaders(): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Accept: 'text/event-stream',
  }
  if (authService.isConfigured()) {
    const idToken = authService.getIdToken()
    if (idToken) headers['Authorization'] = idToken
  }
  return headers
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
function parseBufferedLines(buffer: string): { events: StreamEvent[]; remainder: string } {
  const lines = buffer.split('\n')
  const remainder = lines.pop() ?? ''
  const events: StreamEvent[] = []
  for (const line of lines) {
    const event = parseSSELine(line)
    if (event) events.push(event)
  }
  return { events, remainder }
}

/** Read an SSE stream from a ReadableStreamDefaultReader, yielding parsed events. */
async function* readSSEStream(reader: ReadableStreamDefaultReader<Uint8Array>): AsyncGenerator<StreamEvent> {
  const decoder = new TextDecoder()
  const buf = { value: '' }

  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break

      buf.value += decoder.decode(value, { stream: true })
      const { events, remainder } = parseBufferedLines(buf.value)
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
  const headers = getAuthHeaders()

  const response = await fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal,
  })

  if (!response.ok) {
    if (response.status === 401) throw new Error('Session expired - please sign in again')
    if (response.status === 403) throw new Error('Access denied - please sign in again')
    throw new Error(`Stream error: ${response.status}`)
  }

  const reader = response.body?.getReader()
  if (!reader) throw new Error('No response body')

  yield* readSSEStream(reader)
}

/** Stream VoC chat. */
export function streamVocChat(
  message: string,
  context?: string,
  days?: number,
  responseLanguage?: string,
  history?: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
): AsyncGenerator<StreamEvent> {
  const base = getBaseUrl()
  return streamChat(`${base}/chat/stream`, {
    message,
    context,
    days: days ?? 7,
    response_language: responseLanguage,
    history,
  }, signal)
}

/** Stream project chat. Uses /chat/stream with project_id in body. */
export function streamProjectChat(
  projectId: string,
  message: string,
  selectedPersonas?: string[],
  selectedDocuments?: string[],
  responseLanguage?: string,
  attachments?: Array<{ name: string; media_type: string; data: string }>,
  history?: Array<{ role: string; content: string }>,
  signal?: AbortSignal,
  roundtable?: boolean,
): AsyncGenerator<StreamEvent> {
  const base = getBaseUrl()
  return streamChat(`${base}/chat/stream`, {
    message,
    project_id: projectId,
    selected_personas: selectedPersonas,
    selected_documents: selectedDocuments,
    response_language: responseLanguage,
    attachments,
    history,
    ...(roundtable ? { roundtable: true } : {}),
  }, signal)
}
