/**
 * `voc-plan-step` Lambda handler (Node.js 22, ARM64; bundled by esbuild from
 * THIS file — `lambda/stream/src/plan-step/handler.ts`, export `handler`).
 * Invoked directly by the plan conductor (VocProcessingStack) once per `write`
 * or `think` step; never behind API Gateway. See event.ts for the contract and
 * write-step.ts / think.ts for what a step does.
 *
 * Environment:
 *   METRICS_FUNCTION, PROJECTS_FUNCTION, FEEDBACK_FORMS_FUNCTION, SETTINGS_FUNCTION,
 *   SCRAPERS_FUNCTION, MEMORY_FUNCTION, AGENTS_FUNCTION, USERS_FUNCTION,
 *   INTEGRATIONS_FUNCTION, FEEDBACK_EDIT_FUNCTION — domain functions it invokes
 *     as the approver (writes and the think steps' reads);
 *   AGGREGATES_TABLE — the model picker's settings (surface `agent_worker`) and
 *     get_source_run;
 *   BEDROCK_INFERENCE_SCOPE — `eu` maps `global.` model ids to `eu.` profiles;
 *   FEEDBACK_TABLE (optional) — search_feedback in think steps.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { LambdaClient } from '@aws-sdk/client-lambda';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';
import { getBedrockClient } from '../bedrock/converse-stream.js';
import { CHAT_SURFACE_DEFAULT } from '../bedrock/model-fallback.js';
import { resolveModelOverride } from '../bedrock/model-override.js';
import { getDefaultCatalogue } from '../assistant/tools/catalogue.js';
import { functionNamesFromEnv, invokeDomainRoute } from '../assistant/tools/internal-api.js';
import { PLAN_STEP_SURFACE, type PlanStepDeps } from './deps.js';
import type { PlanStepAnswer } from './event.js';
import { runPlanStep } from './run-step.js';
import { invocationDeadlineMs } from '../lib/lambda-deadline.js';

/** shared/model_config.py SURFACE_DEFAULTS['agent_worker'] (Sonnet 5.5, the chat default too). */
const AGENT_WORKER_DEFAULT = CHAT_SURFACE_DEFAULT;

/** voc-plan-step's Lambda timeout is 300 s: a Bedrock request never outlives it. */
const PLAN_STEP_BEDROCK_TIMEOUT_MS = 300_000;

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const lambdaClient = new LambdaClient({ maxAttempts: 2 });
const functionNames = functionNamesFromEnv();
const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE ?? '';
const logIdsSchema = z.object({ plan_id: z.string().max(32), step: z.object({ id: z.string().max(8) }) });

const deps: PlanStepDeps = {
  invoke: (call, claims) => invokeDomainRoute(lambdaClient, functionNames, call, claims),
  get catalogue() {
    return getDefaultCatalogue();
  },
  converse: (command) => getBedrockClient(PLAN_STEP_BEDROCK_TIMEOUT_MS).send(command),
  resolveModel: async () => (await resolveModelOverride(docClient, AGGREGATES_TABLE, PLAN_STEP_SURFACE)) ?? AGENT_WORKER_DEFAULT,
};

export async function handler(event: unknown, context?: unknown): Promise<PlanStepAnswer> {
  const deadlineMs = invocationDeadlineMs(context, Date.now());
  const result = await runPlanStep(event, deps, deadlineMs === undefined ? {} : { deadlineMs });
  // Ids and kinds only — never arguments, outputs or claims.
  const ids = logIdsSchema.safeParse(event);
  console.log(JSON.stringify({ event: 'plan_step', ...(ids.success ? { plan: ids.data.plan_id, step: ids.data.step.id } : {}), status: result.status }));
  return result;
}
