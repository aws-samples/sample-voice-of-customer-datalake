/**
 * One `bedrock_usage` line per Converse call and per ConverseStream turn, and the workspace it is counted to.
 *
 * The stream Lambda's mirror of lambda/shared/usage_meter.py (docs/multi-workspace.md, "Cost per workspace"): the same
 * message and fields in the same order (`USAGE_FIELDS`, held equal by usage-meter.test.ts), so the daily cost rollup's
 * one Logs Insights query (lambda/jobs/cost_rollup/handler.py, `message = "bedrock_usage"`) counts the assistant's and
 * the plan steps' calls beside the Python Lambdas'. Numbers and ids only, never a prompt, an answer or anything a
 * person typed. Written raw to stdout as one JSON line (not `console.log`, which the Node runtime prefixes with the
 * time, the request id and the level): the log event is the JSON alone, as a Python Lambda's Powertools line is, so
 * Logs Insights reads its fields the same way. A turn stopped or cut before its last event logs nothing (its usage
 * comes in that event): an undercount, never a guess.
 *
 * ATTRIBUTION. The workspace the run acts in: `attributeFrom` its claims (`voc:workspace`: none is the deployment,
 * `DEPLOYMENT`; a workspace id is that workspace, an entered platform admin's included, as the Python resolver
 * attributes it; anything else `UNATTRIBUTED`), set where a run or a plan step reads its claims, after which every
 * model call of the invocation is counted to it. One invocation at a time per container, so the value is the
 * module's; `resetAttribution` at each invocation's start (lib/invocation-cost.ts, the plan step's handler) keeps a
 * warm container from counting a call to the last invocation's workspace. The tier is always `default`: no call
 * sends one.
 *
 * @module lib/usage-meter
 */
import type { TokenUsage } from '@aws-sdk/client-bedrock-runtime';

import { WORKSPACE_ID } from './workspace-id.js';

/** LOCKSTEP with lambda/shared/usage_meter.py `USAGE_LINE`. */
export const USAGE_LINE = 'bedrock_usage';
/** LOCKSTEP with lambda/shared/usage_meter.py `DEPLOYMENT`: a call made on the deployment's own behalf. */
export const DEPLOYMENT = 'DEPLOYMENT';
/** LOCKSTEP with lambda/shared/usage_meter.py `UNATTRIBUTED`: a call no run attributed. */
export const UNATTRIBUTED = 'UNATTRIBUTED';
/** LOCKSTEP with lambda/shared/usage_meter.py `USAGE_FIELDS`: the line's fields, in order. */
export const USAGE_FIELDS = [
  'workspace_id', 'model_id', 'operation', 'service_tier',
  'input_tokens', 'output_tokens', 'cache_read_tokens', 'cache_write_tokens',
] as const;
const DEFAULT_TIER = 'default';

/** The operations this Lambda meters (the Python side's are Converse and InvokeModel). */
export type MeteredOperation = 'Converse' | 'ConverseStream';

export type UsageLine = { message: typeof USAGE_LINE } & Record<(typeof USAGE_FIELDS)[number], string | number>;

/** This invocation's attribution (one invocation at a time per container: the module docstring). */
const meter: { attribution: string } = { attribution: UNATTRIBUTED };

/** The workspace id, DEPLOYMENT or UNATTRIBUTED this invocation's calls are counted to now. */
export function currentAttribution(): string {
  return meter.attribution;
}

/** A new invocation: nothing is attributed yet. */
export function resetAttribution(): void {
  meter.attribution = UNATTRIBUTED;
}

/** The attribution a run's claims name (see the module docstring). */
function attributionOf(named: string): string {
  if (named === '') return DEPLOYMENT;
  return WORKSPACE_ID.test(named) ? named : UNATTRIBUTED;
}

/** Count this invocation's calls to the scope its claims name (see the module docstring). */
export function attributeFrom(claims: { readonly 'voc:workspace'?: string }): void {
  meter.attribution = attributionOf(claims['voc:workspace']?.trim() ?? '');
}

const tokenCount = (value: number | undefined): number => (typeof value === 'number' && Number.isFinite(value) ? value : 0);

/** The line of one call: the fields in order, the model id as sent, every token count (0 when absent). */
export function usageLine(modelId: string, operation: MeteredOperation, usage: Partial<TokenUsage>,
  attribution: string = meter.attribution): UsageLine {
  return {
    message: USAGE_LINE,
    workspace_id: attribution,
    model_id: modelId,
    operation,
    service_tier: DEFAULT_TIER,
    input_tokens: tokenCount(usage.inputTokens),
    output_tokens: tokenCount(usage.outputTokens),
    cache_read_tokens: tokenCount(usage.cacheReadInputTokens),
    cache_write_tokens: tokenCount(usage.cacheWriteInputTokens),
  };
}

/** One JSON log event, raw to stdout (see the module docstring). */
const writeLine = (line: string): void => { process.stdout.write(`${line}\n`); };

/** Log the line of one call that answered usage, counted to `attribution` (the one current when the call started);
 *  nothing without usage. Never throws into the call. */
export function logBedrockUsage(modelId: string, operation: MeteredOperation, usage: Partial<TokenUsage> | undefined,
  attribution: string = meter.attribution, log: (line: string) => void = writeLine): void {
  if (usage === undefined) return;
  try {
    log(JSON.stringify(usageLine(modelId, operation, usage, attribution)));
  } catch {
    // Counting a call must never fail the call.
  }
}
