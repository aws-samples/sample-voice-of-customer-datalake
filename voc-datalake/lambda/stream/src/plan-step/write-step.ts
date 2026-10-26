/**
 * A `write` step (docs/assistant-plan-mode.md → "Matching"):
 *
 *   approved_pending whose fingerprint is that of its own tool + args (and the
 *   step's tool) → execute exactly those args (a human approved them);
 *   otherwise: resolve references (missing → failed) → write the `{{free}}`
 *   fields (one model call) → parse with the tool's own schema → fingerprint →
 *   never-pre-approvable tool, schema refusal or any mismatch → needs_approval
 *   (an ordinary card for exactly these args) → else execute.
 *
 * Execute: the write's precondition read (stored state, duplicates) → the REST
 * request `buildWriteRequest` builds → invoked as the approver's claims → the
 * ids `extractOutputs` finds. Admin-only tools need `admins` in the claims (the
 * conductor forwards it only after its Cognito re-check).
 */
import { ADMIN_ONLY_CLIENT_TOOLS } from '../assistant/contract.js';
import { canonicalWriteFingerprint } from '../assistant/plan/fingerprint.js';
import { NEVER_PREAPPROVABLE_TOOLS, type PlanStep } from '../assistant/plan/schema.js';
import { WriteRequestError } from '../assistant/plan/write-args.js';
import { preconditionFor, settlePrecondition, type PreconditionOutcome } from '../assistant/plan/write-preconditions.js';
import { PLAN_STEP_WRITE_TOOLS, buildWriteRequest, extractOutputs, forbiddenFallback } from '../assistant/plan/write-requests.js';
import type { WriteEnv } from '../assistant/plan/write-routes.js';
import { describeIssues } from '../assistant/tools/spec.js';
import { describeToolError, isAssistantToolError } from '../assistant/tools/errors.js';
import type { CallerClaims, ClientToolDefinition } from '../assistant/types.js';
import { failed, type PendingWrite, type PlanStepEvent, type PlanStepResult } from './event.js';
import type { PlanStepDeps } from './deps.js';
import { writeFreeFields } from './free-fields.js';
import { freePaths, matchesDefinition, resolveReferences, withFreeValues } from './matching.js';

type WriteStep = Extract<PlanStep, { kind: 'write' }>;

const NEVER_PREAPPROVABLE: ReadonlySet<string> = new Set(NEVER_PREAPPROVABLE_TOOLS);
const RUNNABLE: ReadonlySet<string> = new Set(PLAN_STEP_WRITE_TOOLS);
const ADMIN_ONLY: ReadonlySet<string> = new Set(ADMIN_ONLY_CLIENT_TOOLS);
const NO_PRECONDITION: PreconditionOutcome = { ok: true };

/** The outputs the step declared (`produces`), or every output when it declared none. */
function declaredOutputs(outputs: Record<string, string>, produces: readonly string[] | undefined): Record<string, string> {
  if (produces === undefined || produces.length === 0) return outputs;
  return Object.fromEntries(Object.entries(outputs).filter(([name]) => produces.includes(name)));
}

export interface WriteContext {
  event: PlanStepEvent & { step: WriteStep };
  claims: CallerClaims;
  isAdmin: boolean;
  env: WriteEnv;
  modelId: () => Promise<string>;
}

function pending(tool: string, args: Record<string, unknown>, reason: string): PlanStepResult {
  const write: PendingWrite = { tool, args, fingerprint: canonicalWriteFingerprint(tool, args), reason };
  return { status: 'needs_approval', pending: write };
}

/**
 * The approved pending write when it is intact: same tool, fingerprint of its own args, schema-valid, and
 * the parsed args are byte for byte the approved ones (so the executed write's fingerprint is the approved
 * one — the conductor fails a resolved step that reports any other).
 */
function approvedArgs(tool: ClientToolDefinition, c: WriteContext): Record<string, unknown> | undefined {
  const approved = c.event.approved_pending;
  if (approved?.tool !== tool.name) return undefined;
  if (canonicalWriteFingerprint(approved.tool, approved.args) !== approved.fingerprint) return undefined;
  const parsed = tool.argsSchema?.safeParse(approved.args);
  if (parsed?.success !== true) return undefined;
  return canonicalWriteFingerprint(tool.name, parsed.data) === approved.fingerprint ? parsed.data : undefined;
}

async function filledArgs(deps: PlanStepDeps, c: WriteContext, resolvedArgs: Record<string, unknown>): Promise<Record<string, unknown>> {
  const paths = freePaths(c.event.step.write.args);
  if (paths.length === 0) return resolvedArgs;
  const values = await writeFreeFields(deps, {
    step: c.event.step, args: resolvedArgs, paths, context: Object.values(c.event.think_outputs).join('\n\n'), modelId: await c.modelId(),
  });
  return withFreeValues(resolvedArgs, values);
}

/** Run the write: precondition, request (403 fallback), outputs. */
async function execute(deps: PlanStepDeps, c: WriteContext, toolName: string, args: Record<string, unknown>): Promise<PlanStepResult> {
  const read = preconditionFor(toolName, args);
  const outcome: PreconditionOutcome = read === undefined ? NO_PRECONDITION : settlePrecondition(toolName, args, await deps.invoke(read, c.claims));
  if (!outcome.ok) return failed(outcome.refusal);
  const request = buildWriteRequest(toolName, args, { ...c.env, ...(outcome.current === undefined ? {} : { current: outcome.current }) });
  const response = await deps.invoke(request, c.claims).catch(async (error: unknown) => {
    const fallback = forbiddenFallback(toolName, args);
    if (fallback === undefined || !isAssistantToolError(error) || error.code !== 'not_permitted') throw error;
    return deps.invoke(fallback, c.claims);
  });
  return {
    status: 'done',
    outputs: declaredOutputs(extractOutputs(toolName, response, args), c.event.step.produces),
    fingerprint: canonicalWriteFingerprint(toolName, args),
  };
}

async function decide(deps: PlanStepDeps, c: WriteContext, tool: ClientToolDefinition): Promise<PlanStepResult> {
  const approved = approvedArgs(tool, c);
  if (approved !== undefined) return execute(deps, c, tool.name, approved);
  const resolution = resolveReferences(c.event.step.write.args, c.event.resolved, c.event.think_outputs);
  if (!resolution.ok) return failed(`An earlier step did not record ${resolution.missing}.`);
  const final = await filledArgs(deps, c, resolution.args);
  const parsed = tool.argsSchema?.safeParse(final);
  if (parsed === undefined) return failed(`${tool.name} has no argument schema.`);
  if (!parsed.success) return pending(tool.name, final, `The arguments do not pass ${tool.name}'s validation: ${describeIssues(parsed.error)}`);
  if (c.event.approved_pending !== undefined) return pending(tool.name, parsed.data, 'The approved write no longer matches; approve it again.');
  if (NEVER_PREAPPROVABLE.has(tool.name)) return pending(tool.name, parsed.data, `${tool.name} always asks for approval when it runs.`);
  if (!matchesDefinition(resolution.args, parsed.data)) return pending(tool.name, parsed.data, 'The write differs from the approved plan step.');
  return execute(deps, c, tool.name, parsed.data);
}

/** The step's result; every failure is client-safe text. */
export async function runWriteStep(deps: PlanStepDeps, c: WriteContext): Promise<PlanStepResult> {
  const name = c.event.step.write.tool;
  const tool = deps.catalogue.find((candidate): candidate is ClientToolDefinition => candidate.kind === 'client' && candidate.name === name);
  if (tool === undefined || !RUNNABLE.has(name)) return failed(`${name} cannot run as a plan step.`);
  if (ADMIN_ONLY.has(name) && !c.isAdmin) return failed(`${name} needs an administrator, and the approver is not one now.`);
  try {
    return await decide(deps, c, tool);
  } catch (error) {
    if (error instanceof WriteRequestError) return failed(`The write could not be built: ${error.message}`);
    return failed(describeToolError(error));
  }
}
