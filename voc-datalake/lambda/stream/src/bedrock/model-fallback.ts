/**
 * Model capacity fallback for the streaming assistant.
 *
 * Bedrock can grant an account a model and still give it zero capacity for it
 * (and a young account cannot ask for quota yet), so an allowlisted, granted,
 * agreed model can fail on every call. When the chat model cannot serve right
 * now the agent loop re-runs the turn on the next model of `fallbackChain` —
 * only while nothing of that turn has reached the client — and skips the failed
 * model in this container for COOLDOWN_MS.
 *
 * MIRRORS lambda/shared/model_fallback.py and model_config.py::MODEL_FALLBACK_ORDER.
 * lambda/shared/test/test_model_fallback_lockstep.py reads this file and fails on
 * drift of the order, the cooldown, the error codes or the message patterns.
 */
import { ALLOWED_MODEL_IDS } from './model-override.js';

/**
 * Fallback order after the configured model (Opus only ever as the configured one).
 * MUST match model_config.py::MODEL_FALLBACK_ORDER (test_model_fallback_lockstep.py).
 */
export const MODEL_FALLBACK_ORDER: readonly string[] = [
  'global.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-haiku-5-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/** Built-in default of the 'chat' surface (model_config.py SURFACE_DEFAULTS['chat']). */
export const CHAT_SURFACE_DEFAULT = 'global.anthropic.claude-sonnet-5-5';

/** How long a model that failed for capacity is skipped in this container. */
export const COOLDOWN_SECONDS = 300;

const MODEL_FALLBACK_METRIC = 'ModelFallback';
const METRIC_NAMESPACE = 'VoC';

/** Error names that always mean the model cannot serve now. */
const CAPACITY_ERROR_CODES: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'ServiceUnavailableException',
  'ModelNotReadyException',
  'ServiceQuotaExceededException',
  'ResourceNotFoundException',
]);

/** Error names that mean it only when the message names model availability. */
const MESSAGE_GATED_CODES: ReadonlySet<string> = new Set(['AccessDeniedException', 'ValidationException']);

/**
 * Lower-cased message fragments that name model availability, not the input —
 * model_fallback.py::MODEL_UNAVAILABLE_PATTERNS, same order (lockstep test).
 */
const MODEL_UNAVAILABLE_PATTERNS: readonly RegExp[] = [
  /access to (?:the )?model/,
  /model (?:is )?not (?:available|enabled|accessible|ready)/,
  /not (?:available|enabled|accessible) for (?:this|your) account/,
  /on-demand throughput (?:is not|isn.t) supported/,
  /model identifier is invalid/,
  /end of (?:its )?life/,
  /not authorized to perform: bedrock:invoke/,
];

/** The configured model first, then the chat default, then the order — de-duplicated. */
export function fallbackChain(primary: string): string[] {
  const candidates = [primary, CHAT_SURFACE_DEFAULT, ...MODEL_FALLBACK_ORDER];
  return candidates.filter(
    (model, index) => (index === 0 || ALLOWED_MODEL_IDS.has(model)) && candidates.indexOf(model) === index,
  );
}

/** True when `err` means this model cannot serve now (try another model). */
export function isModelUnavailable(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  if (CAPACITY_ERROR_CODES.has(err.name)) return true;
  if (!MESSAGE_GATED_CODES.has(err.name)) return false;
  const message = err.message.toLowerCase();
  return MODEL_UNAVAILABLE_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Per-container cooldowns: model id -> epoch ms until which it is tried last.
 * Module-level on purpose (survives warm invocations); specs clear it.
 */
export const cooldownUntil = new Map<string, number>();

export function markUnavailable(modelId: string, nowMs: number = Date.now()): void {
  cooldownUntil.set(modelId, nowMs + COOLDOWN_SECONDS * 1000);
}

export function isCoolingDown(modelId: string, nowMs: number = Date.now()): boolean {
  // A model never marked has no entry: -Infinity makes it "not cooling" for any clock.
  return nowMs < (cooldownUntil.get(modelId) ?? Number.NEGATIVE_INFINITY);
}

/** `chain` with cooling models moved last (tried, never dropped). */
export function orderForAttempt(chain: readonly string[], nowMs: number = Date.now()): string[] {
  const ready = chain.filter((model) => !isCoolingDown(model, nowMs));
  const cooling = chain.filter((model) => isCoolingDown(model, nowMs));
  return [...ready, ...cooling];
}

/** The error name a fallback is logged and counted under. */
export function fallbackReason(err: unknown): string {
  return err instanceof Error && err.name ? err.name : 'UnknownError';
}

/** Log one fallback and emit the ModelFallback metric (CloudWatch EMF on stdout). */
export function recordFallback(fromModel: string, toModel: string, reason: string): void {
  console.warn(`Model ${fromModel} cannot serve now (${reason}); falling back to ${toModel}`);
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [['Surface', 'From', 'To']],
        Metrics: [{ Name: MODEL_FALLBACK_METRIC, Unit: 'Count' }],
      }],
    },
    Surface: 'chat',
    From: fromModel,
    To: toModel,
    Reason: reason,
    [MODEL_FALLBACK_METRIC]: 1,
  }));
}
