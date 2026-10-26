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
 * The allowlist and the adaptive-thinking capability set MIRROR
 * lambda/shared/model_config.py and are enforced here too, so a tampered DB
 * value can't steer inference to an arbitrary model. The Python lockstep tests
 * read this file and assert the allowlist matches.
 */
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import { z } from 'zod';

const settingsRecordSchema = z.record(z.string(), z.unknown());

const MODEL_SETTINGS_PK = 'SETTINGS#model';
const MODEL_SETTINGS_SK = 'config';

// Curated allowlist — MUST stay in lockstep with model_config.py::ALLOWED_MODELS
// and lib/stacks/api-stack.ts::allowlistedModelArns.
export const ALLOWED_MODEL_IDS = new Set<string>([
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-5-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
]);

// Models with always-on adaptive thinking that reject an explicit thinking
// budget with a 400 (Sonnet 5 / 5.5, Haiku 5.5, and Opus 4.7 and later) — skip the `thinking`
// request field for these. Mirrors model_config.py (`adaptive_thinking`).
const ADAPTIVE_THINKING_IDS = new Set<string>([
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-5-5',
]);

/**
 * The id to put on the wire for a canonical (`global.`) model id under the
 * deployment's inference scope (docs/eu-deployment.md). An EU deployment sets
 * BEDROCK_INFERENCE_SCOPE=eu and is granted only the `eu.` profiles, so every
 * Converse command must go through this. Allowlist checks, capabilities, the
 * fallback chain and usage reporting keep using the canonical id. Mirrors
 * shared/model_config.py::invocation_model_id and lib/utils/model-allowlist.ts::scopedModelId.
 */
export function invocationModelId(modelId: string, scope = process.env.BEDROCK_INFERENCE_SCOPE): string {
  if (scope?.trim().toLowerCase() !== 'eu' || !modelId.startsWith('global.')) return modelId;
  return `eu.${modelId.slice('global.'.length)}`;
}

/** True when the model runs adaptive thinking always-on (no explicit budget). */
export function usesAdaptiveThinking(modelId: string): boolean {
  return ADAPTIVE_THINKING_IDS.has(modelId);
}

const CACHE_TTL_MS = 60_000;
// Lookup failures cache for a shorter window so a throttling blip doesn't
// silently pin streaming chat to the default for a full minute.
const ERROR_CACHE_TTL_MS = 10_000;

// Empty until the first read; `entry` is the item and when it goes stale.
const settingsCache: { entry?: { item: Record<string, unknown>; expires: number } } = {};

async function fetchSettings(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<{ item: Record<string, unknown>; ttl: number }> {
  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: MODEL_SETTINGS_PK, sk: MODEL_SETTINGS_SK },
    }));
    const parsed = settingsRecordSchema.safeParse(result.Item);
    return { item: parsed.success ? parsed.data : {}, ttl: CACHE_TTL_MS };
  } catch (error) {
    console.warn('Model override lookup failed; using default:', error);
    return { item: {}, ttl: ERROR_CACHE_TTL_MS };
  }
}

async function loadSettings(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<Record<string, unknown>> {
  const now = Date.now();
  const cached = settingsCache.entry;
  if (cached && now < cached.expires) {
    return cached.item;
  }
  const { item, ttl } = await fetchSettings(docClient, tableName);
  settingsCache.entry = { item, expires: now + ttl };
  return item;
}

function allowlisted(value: unknown): string | undefined {
  // A lookup by equality (not Set.has) so a non-string value needs no separate type check.
  const allowed = [...ALLOWED_MODEL_IDS].find((id) => id === value);
  if (allowed) {
    return allowed;
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
  const surfaces = settingsRecordSchema.safeParse(item.surfaces);
  if (surfaces.success) {
    const perSurface = allowlisted(surfaces.data[surface]);
    if (perSurface) return perSurface;
  }
  return allowlisted(item.model_id);
}
