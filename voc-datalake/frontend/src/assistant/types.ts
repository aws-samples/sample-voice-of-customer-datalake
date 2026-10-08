/**
 * Unified assistant — interfaces between the assistant runtime/UI and the
 * write-tool (human-in-the-loop) module.
 *
 * The runtime renders `<ApprovalCard>` (from `./approvals/ApprovalCard`) for each
 * pending AG-UI interrupt, and resumes the thread once every card resolved.
 * The approvals module owns the per-tool argument schemas, previews and REST
 * executors (`./approvals/registry`).
 */
import type { ComponentType } from 'react'
import type { QueryClient } from '@tanstack/react-query'
import type { z } from 'zod'
import type { ClientToolName, PageContext, ToolOutcome } from './contract'
import type { ShownRecord } from './approvals/shown'

/** A tool call the model made, with its arguments already JSON-parsed. */
export interface AssistantToolCall {
  id: string
  name: string
  args: unknown
}

/** The subset of an AG-UI `Interrupt` the approval UI needs. */
export interface ApprovalInterrupt {
  id: string
  toolCallId: string
  message?: string
  expiresAt?: string
  metadata?: { toolName?: string; risk?: 'write' | 'destructive'; projectId?: string }
}

export interface ApprovalResolution {
  interruptId: string
  toolCallId: string
  outcome: ToolOutcome
}

export interface ApprovalCardProps {
  interrupt: ApprovalInterrupt
  toolCall: AssistantToolCall
  page: PageContext
  /** Called exactly once, after the write executed/failed or was declined. */
  onResolve: (resolution: ApprovalResolution) => void
  /** True while the thread is streaming or the card belongs to a stale run. */
  disabled?: boolean
}

export interface WriteToolExecutionContext {
  queryClient: QueryClient
  page: PageContext
  /** What the approval card displayed (job window/language, brand base); executors write exactly that. */
  shown?: ShownRecord
}

export interface WriteToolDefinition<A = unknown> {
  name: ClientToolName
  argsSchema: z.ZodType<A>
  risk: 'write' | 'destructive'
  adminOnly?: boolean
  /** Translated one-line title for the approval card. */
  title: (args: A, t: (key: string, options?: Record<string, unknown>) => string) => string
  /** Optional rich preview (e.g. a document diff). */
  Preview?: ComponentType<{ args: A; page: PageContext }>
  /** Execute through the existing REST client; resolves to the executed summary. */
  execute: (args: A, ctx: WriteToolExecutionContext) => Promise<{ summary: string; data?: unknown }>
}
