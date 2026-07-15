/**
 * Runtime per-surface model resolution for streaming chat (issue #96).
 *
 * Admins pick a Bedrock model per AI surface in Settings; the choices live in
 * the aggregates table under SETTINGS#model. Streaming chat is the "chat"
 * surface: this module resolves the chat override (per-surface first, then the
 * legacy global override), returning `undefined` when nothing valid is
 * configured so the caller falls back to its env default. The lookup must
 * never break a chat turn.
 *
 * The allowlist and the temperature/adaptive-thinking capability sets MIRROR
 * lambda/shared/model_config.py and are enforced here too, so a tampered DB
 * value can't steer inference to an arbitrary model. The Python lockstep tests
 * read this file and assert the allowlist matches.
 */
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const MODEL_SETTINGS_PK = 'SETTINGS#model';
const MODEL_SETTINGS_SK = 'config';

// Curated allowlist — MUST stay in lockstep with model_config.py::ALLOWED_MODELS
// and lib/stacks/api-stack.ts::allowlistedModelArns.
export const ALLOWED_MODEL_IDS = new Set<string>([
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
]);

// Models that reject the `temperature` inference param (Sonnet 5 runs adaptive
// thinking; Opus 4.8 deprecates temperature). Mirrors model_config.py.
export const OMIT_TEMPERATURE_IDS = new Set<string>([
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-opus-4-8',
]);

// Models with always-on adaptive thinking that reject an explicit thinking
// budget — skip the `thinking` request field for these. Mirrors model_config.py.
export const ADAPTIVE_THINKING_IDS = new Set<string>([
  'global.anthropic.claude-sonnet-5',
]);

/** True when the model rejects the `temperature` inference parameter. */
export function omitsTemperature(modelId: string): boolean {
  return OMIT_TEMPERATURE_IDS.has(modelId);
}

/** True when the model runs adaptive thinking always-on (no explicit budget). */
export function usesAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_IDS.has(modelId);
}

const CACHE_TTL_MS = 60_000;
// Lookup failures cache for a shorter window so a throttling blip doesn't
// silently pin streaming chat to the default for a full minute.
const ERROR_CACHE_TTL_MS = 10_000;

const cache: { item: Record<string, unknown> | null; expires: number } = { item: null, expires: 0 };

/** Reset the container cache (tests). */
export function clearModelOverrideCache(): void {
  cache.item = null;
  cache.expires = 0;
}

async function loadSettings(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  if (cache.item !== null && now < cache.expires) {
    return cache.item;
  }
  let item: Record<string, unknown> = {};
  let ttl = CACHE_TTL_MS;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: MODEL_SETTINGS_PK, sk: MODEL_SETTINGS_SK },
    }));
    if (result.Item && typeof result.Item === 'object') {
      item = result.Item as Record<string, unknown>;
    }
  } catch (error) {
    console.warn('Model override lookup failed; using default:', error);
    ttl = ERROR_CACHE_TTL_MS;
  }
  cache.item = item;
  cache.expires = now + ttl;
  return item;
}

function allowlisted(value: unknown): string | undefined {
  if (typeof value === 'string' && ALLOWED_MODEL_IDS.has(value)) {
    return value;
  }
  if (value) {
    console.warn(`Configured model '${String(value).slice(0, 80)}' not in allowlist; ignoring`);
  }
  return undefined;
}

/**
 * Resolve the admin-configured model override for a surface, if any.
 *
 * Precedence: per-surface override > legacy global override > undefined
 * (caller falls back to its own env default). Returns an allowlisted model id
 * or undefined; never throws.
 */
export async function resolveModelOverride(
  docClient: DynamoDBDocumentClient,
  tableName: string,
  surface = 'chat',
): Promise<string | undefined> {
  if (!tableName) return undefined;
  const item = await loadSettings(docClient, tableName);
  const surfaces = item.surfaces;
  if (surfaces && typeof surfaces === 'object') {
    const perSurface = allowlisted((surfaces as Record<string, unknown>)[surface]);
    if (perSurface) return perSurface;
  }
  const legacyGlobal = allowlisted(item.model_id);
  if (legacyGlobal) return legacyGlobal;
  return undefined;
}
