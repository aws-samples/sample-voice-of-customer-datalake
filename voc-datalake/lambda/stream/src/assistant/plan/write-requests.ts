/**
 * Plan writes as REST requests (docs/assistant-plan-mode.md → "Runtime": the
 * tool → REST mapping lives ONCE, here). `buildWriteRequest(tool, args, env)`
 * is the request the SPA executor sends for the same approved arguments, so a
 * write is built identically by an approval card and by a plan step;
 * `frontend/src/assistant/plan/writeRequests.lockstep.test.ts` pins that.
 *
 * Every write tool a plan may name has a builder (`planWriteTools`: every pack's
 * CLIENT_TOOLS except PLAN_CONTROL_TOOLS and CARD_ONLY_WRITE_TOOLS); the
 * NEVER_PREAPPROVABLE_TOOLS among them run only after their own card.
 * `extractOutputs` reads the ids a later step may reference from the answer.
 */
import { TOOL_PACKS } from '../contract.js';
import { isRecord } from '../../lib/is-record.js';
import { planWriteTools } from './schema.js';
import { WriteRequestError, type Args } from './write-args.js';
import { PROJECT_WRITE_REQUESTS } from './write-requests-project.js';
import { WORKSPACE_WRITE_REQUESTS, companyMemoryProposal } from './write-requests-workspace.js';
import type { RequestBuilder, WriteEnv, WriteRequest } from './write-routes.js';

const BUILDERS: ReadonlyMap<string, RequestBuilder> = new Map(Object.entries({ ...PROJECT_WRITE_REQUESTS, ...WORKSPACE_WRITE_REQUESTS }));

/** Every write a plan step may name (planWriteTools of every pack); each has a builder, pinned by write-requests.test.ts. */
export const PLAN_STEP_WRITE_TOOLS: readonly string[] = TOOL_PACKS.flatMap((pack) => planWriteTools(pack));


/** The env a plan step writes with when its event names none (the stream's default analysis window). */
export const DEFAULT_PLAN_DAYS = 30;

const PLAN_STEP: ReadonlySet<string> = new Set(PLAN_STEP_WRITE_TOOLS);

/**
 * The REST request of one approved write — a plan write, including the
 * never-pre-approvable ones once their card was approved. Throws
 * WriteRequestError for a tool no plan may name, or bad args.
 */
export function buildWriteRequest(tool: string, args: Args, env: WriteEnv): WriteRequest {
  const builder = PLAN_STEP.has(tool) ? BUILDERS.get(tool) : undefined;
  if (builder === undefined) throw new WriteRequestError(`${tool} cannot run as a plan write`);
  return builder(args, env);
}

/**
 * The request to send instead when `request` was refused with 403, or
 * undefined: `update_company_memory` by someone who is not a curator is filed as
 * a company proposal, as the SPA executor does.
 */
export function forbiddenFallback(tool: string, args: Args): WriteRequest | undefined {
  return tool === 'update_company_memory' ? companyMemoryProposal(args) : undefined;
}

// ── Outputs ────────────────────────────────────────────────────────────────

/** Output name → where the answer carries it: the key, optionally inside a wrapper object. */
const OUTPUT_SOURCES: Readonly<Record<string, readonly (readonly [string, string?])[]>> = {
  project_id: [['project_id', 'project']],
  job_id: [['job_id']],
  execution_id: [['execution_id']],
  app_config_id: [['id', 'app']],
  document_id: [['document_id', 'document']],
  agent_id: [['agent_id', 'agent']],
  run_id: [['run_id', 'run']],
  workflow_id: [['workflow_id', 'workflow'], ['workflow_id', 'view']],
  scraper_id: [['id', 'scraper']],
  memory_id: [['memory_id', 'memory']],
  note_id: [['note_id', 'note']],
};

const MAX_OUTPUT_CHARS = 500;

function valueAt(body: Record<string, unknown>, key: string, wrapper?: string): unknown {
  const wrapped = wrapper === undefined ? undefined : body[wrapper];
  if (isRecord(wrapped) && wrapped[key] !== undefined) return wrapped[key];
  return body[key];
}

function asOutput(value: unknown): string | undefined {
  if (typeof value === 'string' && value !== '') return value.slice(0, MAX_OUTPUT_CHARS);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return undefined;
}

/** `persona_ids` as one comma-separated output (a list answer of a persona write). */
function personaIds(body: Record<string, unknown>): Record<string, string> {
  const ids = body.persona_ids;
  if (!Array.isArray(ids)) return {};
  const joined = ids.filter((id): id is string => typeof id === 'string').join(',');
  return joined === '' ? {} : { persona_ids: joined.slice(0, MAX_OUTPUT_CHARS) };
}

/**
 * The ids a write's answer carries, by output name (`project_id`, `job_id`,
 * `execution_id`, `app_config_id`, `document_id`, `persona_ids`, …). The
 * scraper id of a create is its argument (the route echoes the saved record).
 */
export function extractOutputs(tool: string, response: unknown, args: Args = {}): Record<string, string> {
  const body = isRecord(response) ? response : {};
  const found = Object.entries(OUTPUT_SOURCES).flatMap(([name, sources]) => {
    const value = sources.map(([key, wrapper]) => asOutput(valueAt(body, key, wrapper))).find((v) => v !== undefined);
    return value === undefined ? [] : [[name, value] as const];
  });
  const fromArgs: Record<string, string> = tool === 'create_scraper' && typeof args.id === 'string' ? { scraper_id: args.id } : {};
  return { ...Object.fromEntries(found), ...personaIds(body), ...fromArgs };
}
