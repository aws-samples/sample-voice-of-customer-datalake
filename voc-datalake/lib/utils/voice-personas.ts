/**
 * `-c voicePersonas=true` (7.69.00, docs/voice-personas.md): talk to a project's personas out loud, through Amazon
 * Nova Sonic, relayed by an AgentCore Runtime (lib/stacks/voice-relay.ts). Off by default: the default synth builds
 * nothing of it, and every companion setting below is refused without the flag (it would otherwise do nothing,
 * silently).
 *
 * - `-c voiceModelId`: `amazon.nova-2-5-sonic` (Nova 2.5 Sonic, the default) or `amazon.nova-2-sonic-v1:0` (Nova 2
 *   Sonic, to pin it; its "end of life no sooner than" date is 2026-12-02). Both are in-Region only: no `eu.`, `us.`
 *   or `global.` profile exists, so a profile id is refused.
 * - The Regions: the models run in us-east-1, us-west-2, eu-north-1 and ap-northeast-1 only (the S-15 spike, read
 *   2026-11-21), and every call stays in the deployment's own Region, so the flag is refused anywhere else. An EU
 *   deployment (eu-central-1 or eu-west-1, docs/eu-deployment.md) gets no voice in v1: the owner's "EU in-Region
 *   only" decision.
 * - `-c voiceMonthlyMinutes` (300), `-c voiceSessionMinutes` (15, at most 15: the runtime ends a session at 20
 *   minutes), `-c voiceMaxConcurrent` (8, at most 20: Nova Sonic's streams per account and Region): the budget the
 *   projects API checks at the start and the relay every minute (lambda/shared/voice_sessions.py).
 *
 * With the flag the SPA's response headers allow the microphone on its own origin and name the AgentCore WebSocket
 * host in `connect-src` (lib/stacks/core-cdn.ts); without it they stay `microphone=()` and unchanged.
 */
import * as cdk from 'aws-cdk-lib';
import type { Construct } from 'constructs';

import { booleanContextFlag, nonNegativeIntegerContext } from './context-flag';

const VOICE_PERSONAS_CONTEXT = 'voicePersonas';
const MODEL_CONTEXT = 'voiceModelId';
const MONTHLY_CONTEXT = 'voiceMonthlyMinutes';
const SESSION_CONTEXT = 'voiceSessionMinutes';
const CONCURRENT_CONTEXT = 'voiceMaxConcurrent';
const COMPANION_SETTINGS = [MODEL_CONTEXT, MONTHLY_CONTEXT, SESSION_CONTEXT, CONCURRENT_CONTEXT] as const;

/** The model ids the flag takes, the default first (lambda/shared/voice_sessions.py VOICE_MODEL_IDS, pinned). */
const VOICE_MODEL_IDS = ['amazon.nova-2-5-sonic', 'amazon.nova-2-sonic-v1:0'] as const;
/** Where both models run in-Region (no cross-Region profile exists). */
export const VOICE_REGIONS = ['us-east-1', 'us-west-2', 'eu-north-1', 'ap-northeast-1'] as const;

const DEFAULT_MONTHLY_MINUTES = 300;
const DEFAULT_SESSION_MINUTES = 15;
const MAX_SESSION_MINUTES = 15;
const DEFAULT_MAX_CONCURRENT = 8;
const MAX_CONCURRENT = 20;
const MAX_MONTHLY_MINUTES = 1_000_000;

/** The one env var the projects API reads its voice settings from (lambda/shared/voice_sessions.py), JSON; set only
 *  with the flag. One variable, so the env contract (scripts/audit/py_env_contract.py) has one gated read to excuse:
 *  the audit's gated synth is an EU deployment, where the flag is refused. */
const VOICE_PERSONAS_ENV = 'VOICE_PERSONAS';
/** Where a session's transient files live in the raw bucket (scratch/ expires after 2 days, core-buckets.ts): its
 *  evidence (the projects API writes it, the relay reads it) and its transcript parts (the relay writes them, the
 *  projects API reads and deletes them when it saves the transcript). */
export const VOICE_SCRATCH_PREFIX = 'scratch/voice/';

export interface VoiceSettings {
  readonly modelId: (typeof VOICE_MODEL_IDS)[number];
  readonly monthlyMinutes: number;
  readonly sessionMinutes: number;
  readonly maxConcurrent: number;
}

/** Whether this synth builds the voice personas (`-c voicePersonas=true|false`, off by default). */
export function voicePersonasEnabled(scope: Construct): boolean {
  return booleanContextFlag(scope.node.tryGetContext(VOICE_PERSONAS_CONTEXT), VOICE_PERSONAS_CONTEXT, false,
    'Use -c voicePersonas=true|false.');
}

function modelId(scope: Construct): VoiceSettings['modelId'] {
  const raw: unknown = scope.node.tryGetContext(MODEL_CONTEXT);
  if (raw === undefined || raw === null || raw === '') return VOICE_MODEL_IDS[0];
  const found = VOICE_MODEL_IDS.find((id) => id === String(raw).trim());
  if (found === undefined) {
    throw new Error(`${MODEL_CONTEXT} is ${VOICE_MODEL_IDS.join(' or ')} (in-Region model ids; Nova Sonic has no `
      + `eu., us. or global. profile): got ${JSON.stringify(raw)}.`);
  }
  return found;
}

function boundedMinutes(scope: Construct, key: string, fallback: number, max: number): number {
  const usage = `Use -c ${key}=<1-${max}> (${fallback} by default).`;
  const value = nonNegativeIntegerContext(scope.node.tryGetContext(key), key, fallback, usage);
  if (value < 1 || value > max) throw new Error(`${key} must be from 1 to ${max}. ${usage}`);
  return value;
}

/**
 * The voice personas' settings, checked, with the flag on; `undefined` with it off (and then no companion setting
 * may be passed). Throws at synth on anything the runtime could not honour: a Region without the model, a model id
 * outside the two, a minute count out of range.
 */
export function voiceSettings(scope: Construct): VoiceSettings | undefined {
  if (!voicePersonasEnabled(scope)) {
    const passed = COMPANION_SETTINGS.filter((key) => scope.node.tryGetContext(key) !== undefined);
    if (passed.length > 0) throw new Error(`${passed.join(', ')} need -c ${VOICE_PERSONAS_CONTEXT}=true.`);
    return undefined;
  }
  const region = cdk.Stack.of(scope).region;
  if (cdk.Token.isUnresolved(region) || !VOICE_REGIONS.some((allowed) => allowed === region)) {
    throw new Error(`-c ${VOICE_PERSONAS_CONTEXT}=true needs a deployment in ${VOICE_REGIONS.join(', ')}: Nova Sonic `
      + `runs in those Regions only and every voice call stays in the deployment's own Region (no EU deployment `
      + `region has it but eu-north-1, docs/voice-personas.md). This deployment is in ${region}.`);
  }
  return {
    modelId: modelId(scope),
    monthlyMinutes: boundedMinutes(scope, MONTHLY_CONTEXT, DEFAULT_MONTHLY_MINUTES, MAX_MONTHLY_MINUTES),
    sessionMinutes: boundedMinutes(scope, SESSION_CONTEXT, DEFAULT_SESSION_MINUTES, MAX_SESSION_MINUTES),
    maxConcurrent: boundedMinutes(scope, CONCURRENT_CONTEXT, DEFAULT_MAX_CONCURRENT, MAX_CONCURRENT),
  };
}

/** The AgentCore Runtime WebSocket host the SPA connects to (CSP `connect-src`, with the flag only). */
export function voiceConnectSrc(region: string): string {
  return `wss://bedrock-agentcore.${region}.amazonaws.com`;
}

/** The one foundation-model ARN the relay may invoke (in-Region, no profile). */
export function voiceModelArn(stack: cdk.Stack, model: VoiceSettings['modelId']): string {
  return stack.formatArn({ service: 'bedrock', account: '', resource: 'foundation-model', resourceName: model });
}

/** The projects API's voice settings (lambda/shared/voice_sessions.py `VoiceConfig.from_env`). */
export function voiceApiEnvironment(stack: cdk.Stack, settings: VoiceSettings, runtimeArn: string): Record<string, string> {
  return {
    [VOICE_PERSONAS_ENV]: stack.toJsonString({
      runtime_arn: runtimeArn,
      model_id: settings.modelId,
      monthly_minutes: settings.monthlyMinutes,
      session_minutes: settings.sessionMinutes,
      max_concurrent: settings.maxConcurrent,
    }),
  };
}
