/**
 * Runtime model override for streaming chat (issue #96).
 *
 * Admins can pin every AI feature to one allowlisted model from Settings;
 * the choice lives in the aggregates table under SETTINGS#model. When no
 * override is set (or the lookup fails), streaming chat keeps its own env
 * default — the lookup must never break a chat turn.
 *
 * The allowlist mirrors lambda/shared/model_config.py and is enforced here
 * too, so a tampered DB value can't steer inference to an arbitrary model.
 */
import { GetCommand, type DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

const MODEL_SETTINGS_PK = 'SETTINGS#model';
const MODEL_SETTINGS_SK = 'config';

const ALLOWED_MODEL_IDS = new Set([
  'global.anthropic.claude-sonnet-4-5-20250929-v1:0',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
]);

const CACHE_TTL_MS = 60_000;

const cache: { value: string | null; expires: number } = { value: null, expires: 0 };

/** Reset the container cache (tests). */
export function clearModelOverrideCache(): void {
  cache.value = null;
  cache.expires = 0;
}

/**
 * Resolve the admin-configured model override, if any.
 *
 * Returns the allowlisted model id, or undefined when no valid override is
 * configured or the lookup fails (caller falls back to its own default).
 */
export async function getModelOverride(
  docClient: DynamoDBDocumentClient,
  tableName: string,
): Promise<string | undefined> {
  if (!tableName) return undefined;

  const now = Date.now();
  if (now < cache.expires) {
    return cache.value ?? undefined;
  }

  let value: string | null = null;
  try {
    const result = await docClient.send(new GetCommand({
      TableName: tableName,
      Key: { pk: MODEL_SETTINGS_PK, sk: MODEL_SETTINGS_SK },
    }));
    const configured = result.Item?.model_id;
    if (typeof configured === 'string' && ALLOWED_MODEL_IDS.has(configured)) {
      value = configured;
    } else if (configured) {
      console.warn(`Configured model '${String(configured)}' not in allowlist; using default`);
    }
  } catch (error) {
    console.warn('Model override lookup failed; using default:', error);
  }

  cache.value = value;
  cache.expires = now + CACHE_TTL_MS;
  return value ?? undefined;
}
