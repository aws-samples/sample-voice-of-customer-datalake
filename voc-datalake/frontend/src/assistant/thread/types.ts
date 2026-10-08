/**
 * @fileoverview Thread state for the unified assistant (pure data, no React).
 *
 * `messages` hold AG-UI message shapes so the array can be sent back verbatim
 * (after wire sanitising) as the next run's `messages`. Everything else is UI
 * bookkeeping keyed by message / tool-call id.
 *
 * @module assistant/thread/types
 */
import type { Message, TokenUsage } from '@ag-ui/core'
import type { ApprovalInterrupt, ApprovalResolution } from '../types'

/**
 * `generating`: this tab is not streaming, but the server is still generating
 * the answer (a reload or a dropped stream mid-run) — the runtime polls the
 * stored session until it finishes (runtime/followServerRun.ts).
 */
type ThreadStatus = 'idle' | 'streaming' | 'awaiting_approval' | 'error' | 'generating'

export type ToolCallStatus =
  | 'streaming'
  | 'running'
  | 'complete'
  | 'awaiting_approval'
  | 'executed'
  | 'failed'
  | 'declined'
  | 'cancelled'

export interface FeedbackSourceRef {
  feedback_id: string
  text?: string
  source_platform?: string
  sentiment_label?: string
  rating?: number
}

export interface WebSourceRef {
  title: string
  url: string
}

export interface MessageSources {
  feedback: FeedbackSourceRef[]
  web: WebSourceRef[]
}

export interface NavigationSuggestion {
  path: string
  label: string
}

export interface RunContextInfo {
  model?: string
  packs: string[]
  webSearch: boolean
}

export interface ThreadError {
  message: string
  code?: string
}

export interface ThreadState {
  threadId: string
  runId: string | null
  messages: Message[]
  /** Thinking text, keyed by the assistant message it preceded. */
  reasoningByMessage: Record<string, string>
  /** Reasoning streamed before its assistant message exists. */
  reasoningBuffer: string
  toolCallStatus: Record<string, ToolCallStatus>
  /** Parsed `function.arguments`, set at TOOL_CALL_END (undefined when unparsable). */
  toolCallArgs: Record<string, unknown>
  /** TOOL_CALL_RESULT content (or the SPA's own tool outcome), keyed by tool call id. */
  toolResults: Record<string, string>
  pendingInterrupts: ApprovalInterrupt[]
  /** Resolutions recorded for pending interrupts, keyed by interrupt id. */
  resolutions: Record<string, ApprovalResolution>
  sources: Record<string, MessageSources>
  navigation: Record<string, NavigationSuggestion[]>
  usage: TokenUsage[]
  context: RunContextInfo | null
  status: ThreadStatus
  error: ThreadError | null
  /** Last assistant message touched in the current run (anchor for sources/navigation). */
  lastAssistantId: string | null
}
