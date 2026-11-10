/**
 * @fileoverview A run that stopped for a person: why (`needs_human`), the
 * decision taken on it (`decision`) and what may still be decided (`actions`),
 * as lenient read schemas for the run view of `agents_handler.py`. Unknown
 * reasons read as null (the card falls back to a generic sentence); objections
 * are capped at five per verdict, like the server.
 *
 * @module api/agentRunDecision
 */
import { z } from 'zod'
import { lenientList } from './lenientFields'
import { schemaGuard as guard } from './workflowsApi'

const RUN_DECISIONS = ['accept', 'another_round', 'stop'] as const
export type RunDecisionKind = (typeof RUN_DECISIONS)[number]

const NEEDS_HUMAN_REASONS = ['loop_exhausted', 'no_fail_path', 'end_node', 'budget', 'verification'] as const

/** `POST …/decision` accepts a note of at most this many characters. */
export const MAX_DECISION_NOTE_CHARS = 6000
const MAX_OBJECTIONS = 5

const optionalInt = z.number().int().optional().catch(undefined)

const VerdictSchema = z.object({
  name: z.string().catch(''),
  score: z.number().min(1).max(5),
  blocking: z.boolean().catch(false),
  objections: lenientList((o): o is string => typeof o === 'string' && o.trim() !== '')
    .transform((list) => list.slice(0, MAX_OBJECTIONS)),
})
export type RunVerdict = z.output<typeof VerdictSchema>

export const NeedsHumanSchema = z.object({
  reason: z.enum(NEEDS_HUMAN_REASONS).nullable().catch(null),
  node_id: z.string().catch(''),
  node_title: z.string().catch(''),
  loop_index: optionalInt,
  max_rounds: optionalInt,
  // The guard only filters (it keeps the raw element), so parse each kept one for its transforms.
  verdicts: lenientList(guard(VerdictSchema)).transform((items) => items.map((item) => VerdictSchema.parse(item))),
}).nullable().catch(null)
export type NeedsHuman = NonNullable<z.output<typeof NeedsHumanSchema>>

export const RunDecisionSchema = z.object({
  decision: z.enum(RUN_DECISIONS),
  note: z.string().optional().catch(undefined),
  by_username: z.string().catch(''),
  at: z.string().catch(''),
}).nullable().catch(null)
export type RunDecision = NonNullable<z.output<typeof RunDecisionSchema>>

export const RunActionsSchema = lenientList((a): a is RunDecisionKind => RUN_DECISIONS.some((d) => d === a))
