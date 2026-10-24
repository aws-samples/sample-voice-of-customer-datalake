/**
 * @fileoverview Which plans a message started, and which project a plan made.
 *
 * A plan is approved through the `propose_plan` card; its executed outcome (the
 * thread's `toolResults` entry, `ToolOutcome` JSON) carries `data.plan_id`. Only
 * an EXECUTED outcome with a well-formed id counts: a declined or failed
 * proposal started nothing.
 *
 * @module assistant/planProgress/planIds
 */
import { z } from 'zod'
import { toolOutcomeSchema } from '../contract'
import { ownEntry } from '../ownEntry'
import { PLAN_ID_RE } from '../plan/schema'
import { PLAN_PROPOSAL_TOOL } from '../approvals/planSchemas'
import type { PlanView } from '../../api/plansApi'
import type { ThreadState } from '../thread/types'

const planDataSchema = z.object({ plan_id: z.string().regex(PLAN_ID_RE) })

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

function planIdOf(result: string): string | undefined {
  const outcome = toolOutcomeSchema.safeParse(parseJson(result))
  if (!outcome.success || outcome.data.status !== 'executed') return undefined
  const data = planDataSchema.safeParse(outcome.data.data)
  return data.success ? data.data.plan_id : undefined
}

/** The plan ids approved through this message's `propose_plan` calls, in call order. */
export function approvedPlanIds(toolCalls: readonly { id: string; function: { name: string } }[], thread: Pick<ThreadState, 'toolResults'>): string[] {
  return toolCalls
    .filter((call) => call.function.name === PLAN_PROPOSAL_TOOL)
    .flatMap((call) => {
      const result = ownEntry(thread.toolResults, call.id)
      const planId = result === undefined ? undefined : planIdOf(result)
      return planId === undefined ? [] : [planId]
    })
}

/** A project id that is safe in a path (`idSchema`'s charset). */
const PROJECT_ID_RE = /^[\w.:-]{1,128}$/

/** The project a plan step created, if any (the first `project_id` output). */
export function createdProjectId(plan: PlanView): string | undefined {
  return plan.steps.map((step) => step.outputs.project_id).find((id) => id !== undefined && PROJECT_ID_RE.test(id))
}
