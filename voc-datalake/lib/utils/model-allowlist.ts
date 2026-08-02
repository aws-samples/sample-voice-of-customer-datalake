/**
 * Single source of truth for the Bedrock models this platform can reach.
 *
 * MUST stay in lockstep with:
 *   - lambda/shared/model_config.py                (REST/job inference)
 *   - lambda/stream/src/bedrock/model-override.ts  (streaming chat)
 * Python lockstep tests read both mirrors and fail the build on drift.
 *
 * A model that is selectable but not invocable AccessDenies the whole surface,
 * so every bedrock:InvokeModel* grant across the stacks (api, processing,
 * ingestion) is built from allowlistedModelArns(), the BedrockAccessStack
 * agreements from ALLOWED_FOUNDATION_MODEL_IDS, and the cdk-nag suppressions
 * from bedrockFoundationModelSuppressionTargets() — all derived from the one
 * list below.
 *
 * Note on Opus 4.8: it is a selectable model in its own right AND the model
 * Opus 5 automatically falls back to when its safety classifiers decline a
 * higher-risk request. Both roles need the same grant, so no separate tier is
 * required here. (repo-review takes the opposite stance — see its
 * `fallbackModelIds`, where 4.8 is granted for fallback but may never be
 * configured as the primary model.)
 */

/** Strip the `global.` cross-region prefix to get the foundation-model id. */
function toFoundationModelId(inferenceProfileId: string): string {
  return inferenceProfileId.replace(/^global\./, '');
}

/**
 * Global cross-region inference profile IDs — exactly what the application
 * passes to Bedrock as `modelId`, and what the picker stores/validates.
 */
export const ALLOWED_MODEL_IDS: readonly string[] = [
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/**
 * Underlying foundation-model IDs. Used for Bedrock model-access agreements —
 * a model without its agreement cannot be invoked at all, which includes being
 * reached via an Opus 5 safety fallback.
 */
export const ALLOWED_FOUNDATION_MODEL_IDS: readonly string[] =
  ALLOWED_MODEL_IDS.map(toFoundationModelId);

/**
 * IAM resource ARNs granting bedrock:InvokeModel* on every allowlisted model:
 * the region/account-scoped global inference-profile ARN plus the cross-region
 * foundation-model ARN each profile can route to.
 *
 * The foundation-model ARN keeps a region wildcard (models are cross-region
 * resources) — see bedrockModelSuppressions in lib/utils/nag-suppressions.ts,
 * which derives its targets from this same list.
 */
export function allowlistedModelArns(region: string, account: string): string[] {
  const arns: string[] = [];
  for (const id of ALLOWED_MODEL_IDS) {
    arns.push(`arn:aws:bedrock:${region}:${account}:inference-profile/${id}`);
    arns.push(`arn:aws:bedrock:*::foundation-model/${toFoundationModelId(id)}`);
  }
  return arns;
}

/**
 * cdk-nag `appliesTo` entries for the wildcard-region foundation-model ARNs
 * produced by allowlistedModelArns(). Derived rather than hand-listed so a
 * model added above can't leave a stale or missing suppression behind.
 */
export function bedrockFoundationModelSuppressionTargets(): string[] {
  return ALLOWED_FOUNDATION_MODEL_IDS.map(
    (id) => `Resource::arn:aws:bedrock:*::foundation-model/${id}`,
  );
}

/**
 * ── Persona avatar image model ────────────────────────────────────────────────
 *
 * Deliberately NOT part of ALLOWED_MODEL_IDS: that list is the per-surface text
 * picker, and anything added there becomes selectable for chat/documents/etc.
 * This is a fixed image model with its own request shape, region and IAM grant.
 * It lives here anyway so one file still answers "which Bedrock models can this
 * platform reach", and so the ARN is derived rather than pasted into each role.
 *
 * ⚠️ LIFECYCLE — ACTION REQUIRED BEFORE 2026-09-30
 * Per the AWS Bedrock model-lifecycle table, amazon.nova-canvas-v1:0 entered
 * LEGACY on 2026-03-30 with EOL on 2026-09-30, after which requests fail in
 * every region. During the legacy window an account that does not invoke the
 * model for 15+ days can ALSO lose access early, surfacing as
 * ResourceNotFoundException ("marked as Legacy… upgrade to an active model") —
 * which is exactly the outage previously seen on this codebase, where avatars
 * silently stopped generating while persona creation carried on.
 *
 * Migrating is a one-line change here plus the same value in
 * lambda/api/prompts/avatar-generation.json (a Python lockstep test pins the
 * two together). Confirm the replacement against the account before switching:
 *   aws bedrock list-foundation-models --by-output-modality IMAGE \
 *     --query 'modelSummaries[].[modelId,modelLifecycle.status]' --output table
 * Note the successor may need a different request body than Nova Canvas's
 * TEXT_IMAGE/textToImageParams shape in lambda/shared/avatar.py.
 */
export const IMAGE_MODEL_ID = 'amazon.nova-canvas-v1:0';

/** Nova Canvas is not offered in every region; the avatar client pins this one. */
export const IMAGE_MODEL_REGION = 'us-east-1';

/**
 * IAM resource ARN for the avatar image model. Region-pinned (unlike the
 * cross-region text models) because the model is only invoked in
 * IMAGE_MODEL_REGION, which keeps the grant narrow enough to need no cdk-nag
 * suppression.
 */
export function imageModelArn(): string {
  return `arn:aws:bedrock:${IMAGE_MODEL_REGION}::foundation-model/${IMAGE_MODEL_ID}`;
}
