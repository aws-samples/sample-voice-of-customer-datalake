/**
 * React hook for streaming chat with thinking + tool use indicators.
 */
import {
  useState, useRef, useCallback,
} from 'react'
import {
  streamVocChat, streamProjectChat,
} from '../api/streamClient'
import { isRecord } from '../lib/typeGuards'
import type { StreamEvent } from '../api/streamClient'
import type { FeedbackItem } from '../api/types'

interface ChatOptions {
  projectId?: string
  context?: string
  days?: number
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
  roundtable?: boolean
}

interface PersonaTurnInfo {
  persona_id: string
  name: string
  avatar_url?: string
}

export interface ToolStep {
  name: string
  status: 'active' | 'completed'
}

interface StreamChatState {
  isStreaming: boolean
  streamingText: string
  thinkingText: string
  activeTools: string[]
  toolSteps: ToolStep[]
  sources: FeedbackItem[]
  metadata: Record<string, unknown>
  documentChanges: Array<{
    document_id: string;
    title: string;
    action: 'updated' | 'created';
    summary: string
  }>
  error: string | null
  currentPersona: PersonaTurnInfo | null
  completedTurns: Array<{
    persona: PersonaTurnInfo;
    content: string;
    thinking?: string
  }>
}

const initialState: StreamChatState = {
  isStreaming: false,
  streamingText: '',
  thinkingText: '',
  activeTools: [],
  toolSteps: [],
  sources: [],
  metadata: {},
  documentChanges: [],
  error: null,
  currentPersona: null,
  completedTurns: [],
}

function isFeedbackArray(value: unknown): value is FeedbackItem[] {
  return Array.isArray(value)
}

function extractSources(meta: Record<string, unknown> | undefined): FeedbackItem[] {
  const raw = meta?.sources
  return isFeedbackArray(raw) ? raw : []
}

function applyMetadataEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  const sources = extractSources(event.metadata)
  return {
    ...prev,
    metadata: {
      ...prev.metadata,
      ...event.metadata,
    },
    sources: sources.length > 0 ? sources : prev.sources,
  }
}

function applyDoneEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  const sources = extractSources(event.metadata)
  return {
    ...prev,
    sources: sources.length > 0 ? sources : prev.sources,
    metadata: event.metadata ? {
      ...prev.metadata,
      ...event.metadata,
    } : prev.metadata,
  }
}

function isDocumentChange(value: unknown): value is {
  document_id: string;
  title: string;
  action: 'updated' | 'created';
  summary: string
} {
  if (!isRecord(value)) return false
  return typeof value.document_id === 'string' && typeof value.title === 'string' && typeof value.action === 'string' && typeof value.summary === 'string'
}

function applyDocumentChangedEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  if (isDocumentChange(event.documentChange)) {
    return {
      ...prev,
      documentChanges: [...prev.documentChanges, event.documentChange],
    }
  }
  return prev
}

function applyTextEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  return {
    ...prev,
    streamingText: prev.streamingText + (event.content ?? ''),
  }
}

function applyToolEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  const toolName = event.toolName ?? ''
  if (event.type === 'tool_use') {
    return {
      ...prev,
      activeTools: [...prev.activeTools, toolName],
      toolSteps: [...prev.toolSteps, {
        name: toolName,
        status: 'active',
      }],
    }
  }
  // tool_result — mark as completed, remove from activeTools
  return {
    ...prev,
    activeTools: prev.activeTools.filter((t) => t !== toolName),
    toolSteps: prev.toolSteps.map((s) => s.name === toolName && s.status === 'active' ? {
      ...s,
      status: 'completed',
    } : s),
  }
}

function isPersonaTurn(value: unknown): value is PersonaTurnInfo {
  if (!isRecord(value)) return false
  return typeof value.persona_id === 'string' && typeof value.name === 'string'
}

function applyPersonaTurnEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  const newPersona = isPersonaTurn(event.persona) ? event.persona : null
  // Flush current streaming text as a completed turn
  if (prev.currentPersona && prev.streamingText !== '') {
    return {
      ...prev,
      completedTurns: [
        ...prev.completedTurns,
        {
          persona: prev.currentPersona,
          content: prev.streamingText,
          thinking: prev.thinkingText === '' ? undefined : prev.thinkingText,
        },
      ],
      currentPersona: newPersona,
      streamingText: '',
      thinkingText: '',
    }
  }
  return {
    ...prev,
    currentPersona: newPersona,
    streamingText: '',
    thinkingText: '',
  }
}

function applyThinkingEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  return {
    ...prev,
    thinkingText: prev.thinkingText + (event.content ?? ''),
  }
}

function applyErrorEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  return {
    ...prev,
    error: event.content ?? 'Unknown error',
  }
}

/** Apply a single SSE event to the current state. */
function applyEvent(prev: StreamChatState, event: StreamEvent): StreamChatState {
  switch (event.type) {
    case 'text': return applyTextEvent(prev, event)
    case 'thinking': return applyThinkingEvent(prev, event)
    case 'tool_use':
    case 'tool_result': return applyToolEvent(prev, event)
    case 'document_changed': return applyDocumentChangedEvent(prev, event)
    case 'error': return applyErrorEvent(prev, event)
    case 'metadata': return applyMetadataEvent(prev, event)
    case 'persona_turn': return applyPersonaTurnEvent(prev, event)
    case 'done': return applyDoneEvent(prev, event)
    default: return prev
  }
}

function createStream(message: string, options: ChatOptions | undefined, signal: AbortSignal) {
  if (options?.projectId != null && options.projectId !== '') {
    return streamProjectChat({
      projectId: options.projectId,
      message,
      selectedPersonas: options.selectedPersonas,
      selectedDocuments: options.selectedDocuments,
      responseLanguage: options.responseLanguage,
      attachments: options.attachments,
      history: options.history,
      signal,
      roundtable: options.roundtable,
    })
  }
  return streamVocChat({
    message,
    context: options?.context,
    days: options?.days,
    responseLanguage: options?.responseLanguage,
    history: options?.history,
    signal,
  })
}

export function useStreamChat() {
  const [state, setState] = useState<StreamChatState>(initialState)
  const abortRef = useRef<AbortController | null>(null)

  const sendMessage = useCallback(async (message: string, options?: ChatOptions) => {
    setState({
      ...initialState,
      isStreaming: true,
    })

    abortRef.current = new AbortController()
    const { signal } = abortRef.current

    try {
      const events = createStream(message, options, signal)

      for await (const event of events) {
        if (signal.aborted) break
        setState((prev) => applyEvent(prev, event))
      }
    } catch (err) {
      if (signal.aborted) return
      const errorMessage = err instanceof Error ? err.message : 'Stream failed'
      setState((prev) => ({
        ...prev,
        error: errorMessage,
      }))
    } finally {
      // Mark any still-active tools as completed (stream may have been cut off)
      setState((prev) => ({
        ...prev,
        isStreaming: false,
        activeTools: [],
        toolSteps: prev.toolSteps.map((s) => s.status === 'active' ? {
          ...s,
          status: 'completed' as const,
        } : s),
      }))
    }
  }, [])

  const cancel = useCallback(() => {
    abortRef.current?.abort()
  }, [])

  return {
    ...state,
    sendMessage,
    cancel,
  }
}
