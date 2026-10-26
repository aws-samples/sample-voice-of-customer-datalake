/**
 * `voc-plan-step` wire contract (integrator brief → "Plan-step Lambda"). The
 * conductor (`lambda/agents/`, track P) invokes this function directly
 * (IAM-authorised RequestResponse) once per `write` / `think` step.
 *
 * Event:
 *   { plan_id, step: PlanStep, resolved: {"<step>.<output>": value},
 *     think_outputs: {"<step>.<output>": text}, claims: {sub, cognito:username,
 *     cognito:groups, voc:acting_subject, voc:principal},
 *     approved_pending?: {tool, args, fingerprint},
 *     env?: {days?, response_language?, date_basis?} }      ← optional extension
 *
 * Response (every one also carries `model_calls`: the Converse calls this step made, 0 for a
 * pure write — the conductor adds it to the plan's model-call cap):
 *   {status:'done', outputs, fingerprint?}   (fingerprint: canonical tool + args of the executed write)
 *   | {status:'needs_approval', pending:{tool, args, fingerprint, reason}}
 *   | {status:'failed', error}   (error client-safe, ≤ 500 chars)
 */
import { z } from 'zod';
import { PLAN_ID_RE, planSchema } from '../assistant/plan/schema.js';

const MAX_CLAIM_CHARS = 256;
const MAX_RESOLVED_ENTRIES = 200;
const MAX_RESOLVED_CHARS = 2000;
const MAX_THINK_CHARS = 20_000;
const claim = z.string().max(MAX_CLAIM_CHARS);
const SHA256_HEX = /^[0-9a-f]{64}$/;

/** `{"<step>.<output>": value}`, bounded in entries and value length. */
const outputMap = (maxChars: number) => z.record(z.string().max(64), z.string().max(maxChars))
  .refine((map) => Object.keys(map).length <= MAX_RESOLVED_ENTRIES, `at most ${MAX_RESOLVED_ENTRIES} entries`)
  .default({});

export const planStepEventSchema = z.object({
  plan_id: z.string().regex(PLAN_ID_RE),
  step: planSchema.shape.steps.element,
  resolved: outputMap(MAX_RESOLVED_CHARS),
  think_outputs: outputMap(MAX_THINK_CHARS),
  claims: z.object({
    sub: claim.min(1),
    'cognito:username': claim.optional(),
    'cognito:groups': claim.optional(),
    'voc:acting_subject': claim.optional(),
    'voc:principal': claim.optional(),
  }),
  approved_pending: z.object({
    tool: z.string().min(1).max(64),
    args: z.record(z.string(), z.unknown()),
    fingerprint: z.string().regex(SHA256_HEX),
  }).optional(),
  env: z.object({
    days: z.number().int().min(0).max(9999).optional(),
    response_language: z.string().max(16).optional(),
    date_basis: z.enum(['imported', 'review']).optional(),
  }).optional(),
});

export type PlanStepEvent = z.infer<typeof planStepEventSchema>;

export interface PendingWrite {
  tool: string;
  args: Record<string, unknown>;
  fingerprint: string;
  reason: string;
}

export type PlanStepResult =
  | { status: 'done'; outputs: Record<string, string>; fingerprint?: string }
  | { status: 'needs_approval'; pending: PendingWrite }
  | { status: 'failed'; error: string };

/** What the Lambda answers: a result plus the step's model-call count. */
export type PlanStepAnswer = PlanStepResult & { model_calls: number };

const MAX_STEP_ERROR_CHARS = 500;

export function failed(error: string): PlanStepResult {
  return { status: 'failed', error: error.replaceAll(/\p{Cc}/gu, ' ').slice(0, MAX_STEP_ERROR_CHARS) };
}
