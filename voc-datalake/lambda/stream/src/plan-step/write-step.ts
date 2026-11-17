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
 * conductor forwards it only after its Cognito re-check). (7.52.00) An
 * update_workflow the agents API refuses because other automations run the flow
 * (409 `shared_flow`) becomes needs_approval: an ordinary card for the same
 * args with `confirm_shared: true`, naming them; approved, it saves the flow for
 * all of them. Already confirmed, the refusal is the step's failure.
 */
import { ADMIN_ONLY_CLIENT_TOOLS } from '../assistant/contract.js';
import { canonicalWriteFingerprint } from '../assistant/plan/fingerprint.js';
import { NEVER_PREAPPROVABLE_TOOLS, type PlanStep } from '../assistant/plan/schema.js';
import { WriteRequestError } from '../assistant/plan/write-args.js';
import { preconditionFor, settlePrecondition, type PreconditionOutcome } from '../assistant/plan/write-preconditions.js';
import { PLAN_STEP_WRITE_TOOLS, buildWriteRequest, extractOutputs, forbiddenFallback } from '../assistant/plan/write-requests.js';
import type { WriteEnv, WriteRequest } from '../assistant/plan/write-routes.js';
import { describeIssues } from '../assistant/tools/spec.js';
import { missingStoreAppRefusal } from '../assistant/tools/client/store-app-check.js';
import { describeToolError, isAssistantToolError } from '../assistant/tools/errors.js';
import type { CallerClaims, ClientToolDefinition } from '../assistant/types.js';
import { isRecord } from '../lib/is-record.js';
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

/** The store fields of a create_app_connector's args (already parsed by the tool's own schema). */
function storeArgs(args: Record<string, unknown>): { source: string; app_id?: string; package_name?: string } {
  const field = (name: string) => (typeof args[name] === 'string' ? { [name]: args[name] } : {});
  return { source: typeof args.source === 'string' ? args.source : '', ...field('app_id'), ...field('package_name') };
}

/** The agents API's refusal of a save of a flow other automations run, unconfirmed (7.52.00). */
const SHARED_FLOW = 'shared_flow';

/**
 * The card a refused shared-flow save becomes: the same args with `confirm_shared: true`, the automations named;
 * undefined for any other failure, and for a save already confirmed (that refusal is the step's failure).
 */
function sharedFlowCard(toolName: string, args: Record<string, unknown>, error: unknown): PlanStepResult | undefined {
  if (toolName !== 'update_workflow' || args.confirm_shared === true) return undefined;
  if (!isAssistantToolError(error) || error.serverCode !== SHARED_FLOW) return undefined;
  const who = error.automations.length === 0 ? 'Other automations run this flow'
    : `Other automations run this flow (${error.automations.join(', ')})`;
  return pending(toolName, { ...args, confirm_shared: true },
    `${who}: approving saves it for all of them, each from its next run.`);
}

/** The write's answer (a 403 sent again as its fallback), or the card a refused shared-flow save becomes. */
async function send(
  deps: PlanStepDeps, c: WriteContext, toolName: string, args: Record<string, unknown>, request: WriteRequest,
): Promise<{ response: unknown } | { card: PlanStepResult }> {
  try {
    return { response: await deps.invoke(request, c.claims) };
  } catch (error) {
    const card = sharedFlowCard(toolName, args, error);
    if (card !== undefined) return { card };
    const fallback = forbiddenFallback(toolName, args);
    if (fallback === undefined || !isAssistantToolError(error) || error.code !== 'not_permitted') throw error;
    return { response: await deps.invoke(fallback, c.claims) };
  }
}

/** Run the write: a create_app_connector's store check, precondition, request (403 fallback), outputs. */
async function execute(deps: PlanStepDeps, c: WriteContext, toolName: string, args: Record<string, unknown>): Promise<PlanStepResult> {
  const missingApp = toolName === 'create_app_connector' ? await missingStoreAppRefusal(storeArgs(args), deps.lookupStoreApp) : undefined;
  if (missingApp !== undefined) return failed(missingApp);
  const read = preconditionFor(toolName, args);
  const outcome: PreconditionOutcome = read === undefined ? NO_PRECONDITION : settlePrecondition(toolName, args, await deps.invoke(read, c.claims));
  if (!outcome.ok) return failed(outcome.refusal);
  const request = buildWriteRequest(toolName, args, { ...c.env, ...(outcome.current === undefined ? {} : { current: outcome.current }) });
  const sent = await send(deps, c, toolName, args, request);
  if ('card' in sent) return sent.card;
  const { response } = sent;
  const methodology = isRecord(response) && isRecord(response.methodology) ? response.methodology : undefined;
  return {
    status: 'done',
    outputs: declaredOutputs(extractOutputs(toolName, response, args), c.event.step.produces),
    fingerprint: canonicalWriteFingerprint(toolName, args),
    // A methodology step's start answer (research, PR/FAQ, PRD, prototype): the conductor bounds and journals it.
    ...(methodology === undefined ? {} : { methodology }),
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
