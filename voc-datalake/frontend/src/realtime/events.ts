/**
 * @fileoverview The notices the Event API pushes (docs/realtime.md), validated at the boundary.
 *
 * A notice carries ids and statuses only. It is a hint to re-read now: every view still reads the
 * row through the API (which applies the caller's access), so a notice never becomes UI state itself.
 * Publishers: `lambda/shared/realtime.py` (jobs, runs) and `lambda/stream/src/lib/realtime-publish.ts`
 * (chat).
 *
 * @module realtime/events
 */
import { z } from 'zod'

const id = z.string().min(1).max(200)

const JobNoticeSchema = z.object({
  type: z.literal('job'),
  job_id: id,
  status: z.string(),
  job_type: z.string().optional(),
  project_id: id.optional(),
})

const SessionNoticeSchema = z.object({
  type: z.literal('session'),
  conversation_id: id,
  run_status: z.string(),
  revision: z.number().int().nonnegative(),
})

const RunNoticeSchema = z.object({
  type: z.literal('run'),
  agent_id: id,
  run_id: id,
  status: z.string(),
})

const PlanNoticeSchema = z.object({
  type: z.literal('plan'),
  plan_id: id,
  change: z.string(),
  step_id: id.optional(),
})

const RealtimeNoticeSchema = z.discriminatedUnion('type', [
  JobNoticeSchema, SessionNoticeSchema, RunNoticeSchema, PlanNoticeSchema,
])

export type RealtimeNotice = z.infer<typeof RealtimeNoticeSchema>

/** AppSync Events delivers `{id, event}`; the event itself is the published JSON (a string or already parsed). */
const DeliverySchema = z.object({ event: z.unknown() })

function decoded(value: unknown): unknown {
  if (typeof value !== 'string') return value
  try {
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

/** The notice in one delivery, or null for anything that is not one of ours (it is dropped). */
export function parseNotice(delivery: unknown): RealtimeNotice | null {
  const wrapped = DeliverySchema.safeParse(delivery)
  const payload = decoded(wrapped.success ? wrapped.data.event : delivery)
  const parsed = RealtimeNoticeSchema.safeParse(payload)
  return parsed.success ? parsed.data : null
}
