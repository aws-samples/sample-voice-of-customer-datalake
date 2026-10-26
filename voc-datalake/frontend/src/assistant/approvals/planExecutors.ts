/**
 * @fileoverview REST executors of the plan-mode client tools: `run_source`, `set_source_enabled`,
 * `build_prototype`, `cancel_plan` and `propose_plan`
 * (docs/assistant-plan-mode.md → "New tools", deviations 2 and 4).
 *
 * `propose_plan` approves the WHOLE plan: the card has shown every step, and the
 * executor re-checks the plan (shape, limits, graph, packs, admin tools,
 * placeholders) before `POST /agents/plans`, which validates it again. Its
 * result `{plan_id}` is what the bubble's progress view follows.
 *
 * Summaries go to the model, in English, and name ids so it can refer back.
 *
 * @module assistant/approvals/planExecutors
 */
import { api } from '../../api/client'
import { plansApi } from '../../api/plansApi'
import { projectsApi } from '../../api/projectsApi'
import { startSourceRun } from '../../api/sourceRunsApi'
import { packsAllowedFor } from '../plan/packsAllowed'
import { validatePlan } from '../plan/validate'
import { invalidateKeys, keysFor } from './invalidation'
import { StaleApprovalError, currentJobEnvironment, shownOf } from './shown'
import type { QueryKey } from '@tanstack/react-query'
import type { WriteToolExecutionContext } from '../types'
import type { BuildPrototypeArgs, CancelPlanArgs, ProposePlanArgs, RunSourceArgs, SetSourceEnabledArgs } from './planSchemas'

interface ExecutionResult {
  summary: string
  data?: unknown
}

/** How many plan problems a refusal names (the rest are counted). */
const MAX_REPORTED_PROBLEMS = 5

function refresh(ctx: WriteToolExecutionContext, keys: readonly QueryKey[]): void {
  void invalidateKeys(ctx.queryClient, keys)
}

export async function runSource(args: RunSourceArgs, ctx: WriteToolExecutionContext): Promise<ExecutionResult> {
  const res = await startSourceRun(args.source)
  refresh(ctx, keysFor.sourceRuns())
  const executionId = res.execution_id
  return {
    summary: `Started the ${args.source} import (execution ${executionId}); it runs in the background.`,
    data: { source: args.source, execution_id: executionId },
  }
}

/** `PUT /sources/{source}/enable|disable`; enabling also closes a tripped circuit breaker (server side). */
export async function setSourceEnabled(args: SetSourceEnabledArgs, ctx: WriteToolExecutionContext): Promise<ExecutionResult> {
  await (args.enabled ? api.enableSource(args.source) : api.disableSource(args.source))
  refresh(ctx, keysFor.sources())
  return {
    summary: `${args.enabled ? 'Enabled' : 'Disabled'} the ${args.source} schedule; ${args.enabled ? 'scheduled imports run again' : 'no scheduled imports run until it is enabled'}. Nothing already imported changed.`,
    data: { source: args.source, enabled: args.enabled },
  }
}

/** The route's body: every given argument but the path's project id (the names are the route's own). */
function withoutProjectId(args: BuildPrototypeArgs): Partial<BuildPrototypeArgs> {
  return Object.fromEntries(Object.entries(args).filter(([key]) => key !== 'project_id'))
}

export async function buildPrototype(args: BuildPrototypeArgs, ctx: WriteToolExecutionContext): Promise<ExecutionResult> {
  const env = shownOf(ctx)?.job ?? currentJobEnvironment()
  const res = await projectsApi.buildPrototype(args.project_id, {
    response_language: env.responseLanguage,
    ...withoutProjectId(args),
  })
  refresh(ctx, keysFor.projectJobs(args.project_id))
  return {
    summary: `Started prototype build job ${res.job_id}; it runs in the background and appears in the project's Jobs.`,
    data: { job_id: res.job_id },
  }
}

export async function cancelPlan(args: CancelPlanArgs, ctx: WriteToolExecutionContext): Promise<ExecutionResult> {
  const plan = await plansApi.cancel(args.plan_id)
  refresh(ctx, keysFor.plans())
  return { summary: `Cancelled plan ${plan.plan_id}; it is now ${plan.status}. A running step finishes first.`, data: { plan_id: plan.plan_id, status: plan.status } }
}

type PlanProblem = { step?: string; field?: string; message: string }

/** `s2 write.args.source: must be …`, or just the message when it names no place. */
function describeProblem(problem: PlanProblem): string {
  const where = [problem.step, problem.field].filter((part) => part !== undefined && part !== '').join(' ')
  return where === '' ? problem.message : `${where}: ${problem.message}`
}

/** One sentence naming the plan's problems (our own validator's text, safe to relay). */
function problemsSentence(errors: readonly PlanProblem[]): string {
  const named = errors.slice(0, MAX_REPORTED_PROBLEMS).map(describeProblem)
  const more = errors.length > MAX_REPORTED_PROBLEMS ? ` (+${errors.length - MAX_REPORTED_PROBLEMS} more)` : ''
  return `The plan was not started because it is invalid: ${named.join('; ')}${more}. Fix the plan and propose it again.`
}

export async function proposePlan(args: ProposePlanArgs, ctx: WriteToolExecutionContext): Promise<ExecutionResult> {
  const isAdmin = ctx.isAdmin === true
  const checked = validatePlan(args, { isAdmin, packsAllowed: packsAllowedFor(isAdmin) })
  if (!checked.ok) throw new StaleApprovalError(problemsSentence(checked.errors))
  const created = await plansApi.create(checked.plan, ctx.conversationId)
  refresh(ctx, keysFor.plans())
  return {
    summary: `The user approved plan ${created.plan_id}; it now runs in the background, step by step, and the plan card shows each step's result as it finishes. Do not repeat its steps.`,
    data: { plan_id: created.plan_id },
  }
}
