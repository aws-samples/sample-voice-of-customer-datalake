/**
 * One plan step, end to end, over injected deps (handler.ts wires the real
 * ones). Never throws: every failure is a `failed` result with client-safe
 * text, so the conductor records it and skips the step's dependents. Every
 * answer carries `model_calls` — the Converse calls made through `deps`
 * (free-field fills, think-step rounds) — for the plan's model-call cap.
 */
import { DEFAULT_PLAN_DAYS } from '../assistant/plan/write-requests.js';
import type { WriteEnv } from '../assistant/plan/write-routes.js';
import { isAdminCaller } from '../assistant/runtime/event.js';
import { ProjectAccessLedger } from '../assistant/tools/project-access.js';
import { describeToolError } from '../assistant/tools/errors.js';
import type { PageContext } from '../assistant/contract.js';
import type { AssistantRunContext, CallerClaims } from '../assistant/types.js';
import type { RunLimits } from '../assistant/runtime/run.js';
import { failed, planStepEventSchema, type PlanStepAnswer, type PlanStepEvent, type PlanStepResult } from './event.js';
import type { PlanStepDeps } from './deps.js';
import { runThinkStep } from './think.js';
import { runWriteStep } from './write-step.js';

/** The claims the domain APIs see: exactly the event's, nothing added. */
function claimsOf(event: PlanStepEvent): CallerClaims {
  const { sub, ...rest } = event.claims;
  const optional = (key: keyof typeof rest) => (rest[key] === undefined || rest[key] === '' ? {} : { [key]: rest[key] });
  return {
    sub,
    ...optional('cognito:username'),
    ...optional('cognito:groups'),
    ...optional('voc:acting_subject'),
    ...optional('voc:principal'),
  };
}

function envOf(event: PlanStepEvent, claims: CallerClaims): WriteEnv {
  return {
    days: event.env?.days ?? DEFAULT_PLAN_DAYS,
    ...(event.env?.response_language === undefined ? {} : { responseLanguage: event.env.response_language }),
    ...(event.env?.date_basis === 'review' ? { dateBasis: 'review' } : {}),
    ...(claims['cognito:username'] === undefined ? {} : { author: claims['cognito:username'] }),
    // Stable per step, so a retried document edit is the same edit (shared/document_history.py).
    editId: `${event.plan_id}-${event.step.id}`,
  };
}

/** The run context the catalogue's read tools expect, for a plan acting as its approver. */
function readContext(claims: CallerClaims, isAdmin: boolean, modelId: string, env: WriteEnv, limits: RunLimits): AssistantRunContext {
  const page: PageContext = { kind: 'other', path: '/agents' };
  return {
    claims, isAdmin, page, modelId,
    props: { page, days: env.days, ...(env.dateBasis === undefined ? {} : { dateBasis: env.dateBasis }) },
    // A plan step has no client stream: tool progress events (STEP_*, navigation chips) go nowhere.
    emit: () => {},
    projectAccess: new ProjectAccessLedger(),
    // A tool waiting on a background job (analyze_scraper_url) stops before this Lambda is cut off.
    ...(limits.deadlineMs === undefined ? {} : { deadlineMs: limits.deadlineMs }),
  };
}

function memo(load: () => Promise<string>): () => Promise<string> {
  const cell: { value?: Promise<string> } = {};
  return () => {
    cell.value ??= load();
    return cell.value;
  };
}

async function dispatch(deps: PlanStepDeps, event: PlanStepEvent, limits: RunLimits): Promise<PlanStepResult> {
  const claims = claimsOf(event);
  const isAdmin = isAdminCaller(claims);
  const env = envOf(event, claims);
  const modelId = memo(() => deps.resolveModel());
  const { step } = event;
  if (step.kind === 'wait') return failed('A wait step is run by the plan runtime, not by voc-plan-step.');
  if (step.kind === 'think') {
    const context = Object.values(event.think_outputs).join('\n\n');
    const id = await modelId();
    return runThinkStep(deps, { step, ctx: readContext(claims, isAdmin, id, env, limits), context, modelId: id });
  }
  return runWriteStep(deps, { event: { ...event, step }, claims, isAdmin, env, modelId });
}

/** `deps` with its Converse calls counted. */
function counted(deps: PlanStepDeps): { deps: PlanStepDeps; calls: () => number } {
  const tally = { calls: 0 };
  return {
    deps: {
      invoke: (call, claims) => deps.invoke(call, claims),
      catalogue: deps.catalogue,
      resolveModel: () => deps.resolveModel(),
      converse: (command) => {
        tally.calls += 1;
        return deps.converse(command);
      },
    },
    calls: () => tally.calls,
  };
}

async function outcome(raw: unknown, deps: PlanStepDeps, limits: RunLimits): Promise<PlanStepResult> {
  const parsed = planStepEventSchema.safeParse(raw);
  if (!parsed.success) return failed('The plan step event is invalid.');
  try {
    return await dispatch(deps, parsed.data, limits);
  } catch (error) {
    return failed(describeToolError(error));
  }
}

export async function runPlanStep(raw: unknown, deps: PlanStepDeps, limits: RunLimits = {}): Promise<PlanStepAnswer> {
  const counter = counted(deps);
  const result = await outcome(raw, counter.deps, limits);
  return { ...result, model_calls: counter.calls() };
}
