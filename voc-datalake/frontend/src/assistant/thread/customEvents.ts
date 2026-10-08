/**
 * @fileoverview Lenient Zod normalisers for the assistant's CUSTOM event values
 * and for RUN_FINISHED interrupts.
 *
 * Follows the repo's boundary-schema precedent (`formSchema.ts`,
 * `scrapersSchema.ts`): the wire is never trusted to match the declared type,
 * so every value is parsed with `catch` defaults and junk entries are dropped
 * rather than failing the whole event.
 *
 * @module assistant/thread/customEvents
 */
import { z } from 'zod'
import { INTERRUPT_REASON_TOOL_APPROVAL } from '../contract'
import { lenientList } from '../lenient'
import type { ApprovalInterrupt } from '../types'
import type {
  FeedbackSourceRef, MessageSources, NavigationSuggestion, RunContextInfo, WebSourceRef,
} from './types'

const optionalString = z.string().optional().catch(undefined)

const feedbackSourceSchema = z.object({
  feedback_id: z.string().min(1),
  original_text: optionalString,
  text: optionalString,
  source_platform: optionalString,
  sentiment_label: optionalString,
  rating: z.number().optional().catch(undefined),
})

const webSourceSchema = z.object({
  title: z.string().catch(''),
  url: z.url(),
})

function lenientArray<T>(schema: z.ZodType<T>, value: unknown): T[] {
  return lenientList(schema, value)
}

const objectSchema = z.record(z.string(), z.unknown())

function asRecord(value: unknown): Record<string, unknown> {
  const parsed = objectSchema.safeParse(value)
  return parsed.success ? parsed.data : {}
}

function toFeedbackRef(raw: z.infer<typeof feedbackSourceSchema>): FeedbackSourceRef {
  return {
    feedback_id: raw.feedback_id,
    text: raw.original_text ?? raw.text,
    source_platform: raw.source_platform,
    sentiment_label: raw.sentiment_label,
    rating: raw.rating,
  }
}

/** Only http(s) links are rendered — never `javascript:` or `data:`. */
function isSafeWebSource(source: WebSourceRef): boolean {
  return /^https?:\/\//i.test(source.url)
}

export function parseSources(value: unknown): MessageSources {
  const record = asRecord(value)
  return {
    feedback: lenientArray(feedbackSourceSchema, record.feedback).map(toFeedbackRef),
    web: lenientArray(webSourceSchema, record.web).filter(isSafeWebSource),
  }
}

const navigationSchema = z.object({
  path: z.string().startsWith('/').max(300),
  label: z.string().min(1).max(200),
})

/** In-app paths only: `//host` would be a protocol-relative external link. */
export function parseNavigation(value: unknown): NavigationSuggestion | null {
  const parsed = navigationSchema.safeParse(value)
  if (!parsed.success || parsed.data.path.startsWith('//')) return null
  return parsed.data
}

const contextSchema = z.object({
  model: optionalString,
  packs: z.array(z.string()).catch([]),
  webSearch: z.boolean().catch(false),
})

export function parseRunContext(value: unknown): RunContextInfo | null {
  const parsed = contextSchema.safeParse(value)
  return parsed.success ? parsed.data : null
}

const interruptMetadataSchema = z.object({
  toolName: optionalString,
  risk: z.enum(['write', 'destructive']).optional().catch(undefined),
  projectId: optionalString,
})

const interruptSchema = z.object({
  id: z.string().min(1),
  reason: z.string(),
  toolCallId: z.string().min(1),
  message: optionalString,
  expiresAt: optionalString,
  metadata: z.unknown().optional(),
})

/** The tool-approval interrupts in a RUN_FINISHED outcome; others are ignored. */
export function parseApprovalInterrupts(value: unknown): ApprovalInterrupt[] {
  return lenientArray(interruptSchema, value)
    .filter((entry) => entry.reason === INTERRUPT_REASON_TOOL_APPROVAL)
    .map((entry) => {
      const metadata = interruptMetadataSchema.safeParse(entry.metadata ?? {})
      return {
        id: entry.id,
        toolCallId: entry.toolCallId,
        ...(entry.message !== undefined ? { message: entry.message } : {}),
        ...(entry.expiresAt !== undefined ? { expiresAt: entry.expiresAt } : {}),
        ...(metadata.success ? { metadata: metadata.data } : {}),
      }
    })
}
