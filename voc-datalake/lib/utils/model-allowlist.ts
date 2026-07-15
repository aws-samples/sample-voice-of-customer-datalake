/**
 * Single source of truth for the Bedrock models the per-surface AI-model
 * picker can route inference to (issue #96).
 *
 * MUST stay in lockstep with:
 *   - lambda/shared/model_config.py            (ALLOWED_MODELS — REST/job inference)
 *   - lambda/stream/src/bedrock/model-override.ts (streaming-chat lookup)
 *
 * A model that is selectable but not invocable AccessDenies the surface, so
 * every bedrock:InvokeModel* grant across the stacks (api, processing,
 * ingestion) is built from allowlistedModelArns(), the BedrockAccessStack
 * agreements are built from ALLOWED_FOUNDATION_MODEL_IDS, and a Python
 * lockstep test asserts this list equals the one in model_config.py.
 */

/**
 * Global cross-region inference profile IDs — exactly what the application
 * passes to Bedrock as `modelId`, and what the picker stores/validates.
 */
export const ALLOWED_MODEL_IDS: readonly string[] = [
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/**
 * Foundation-model IDs (the inference-profile IDs without the `global.`
 * prefix). Used for Bedrock model-access agreements in BedrockAccessStack.
 */
export const ALLOWED_FOUNDATION_MODEL_IDS: readonly string[] = ALLOWED_MODEL_IDS.map(
  (id) => id.replace(/^global\./, ''),
);

/**
 * IAM resource ARNs granting bedrock:InvokeModel* on every allowlisted model:
 * the region/account-scoped global inference-profile ARN plus the
 * cross-region foundation-model ARN each profile can route to.
 *
 * The foundation-model ARN keeps a region wildcard (models are cross-region
 * resources) — see bedrockModelSuppressions in lib/utils/nag-suppressions.ts.
 */
export function allowlistedModelArns(region: string, account: string): string[] {
  const arns: string[] = [];
  for (const id of ALLOWED_MODEL_IDS) {
    const foundationModel = id.replace(/^global\./, '');
    arns.push(`arn:aws:bedrock:${region}:${account}:inference-profile/${id}`);
    arns.push(`arn:aws:bedrock:*::foundation-model/${foundationModel}`);
  }
  return arns;
}
