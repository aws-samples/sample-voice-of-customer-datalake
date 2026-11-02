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
 * ingestion) is built from allowlistedModelArns() (by lib/utils/claude-model-grant.ts,
 * with no Region wildcard, so no cdk-nag acknowledgement) and the BedrockAccessStack
 * agreements from ALLOWED_FOUNDATION_MODEL_IDS — both derived from the one
 * list below.
 *
 * Note on Opus 5 and Opus 4.8: each is a selectable model in its own right AND
 * a safety-fallback target — Opus 5.5 re-runs a request its classifiers decline
 * on Opus 5, and Opus 5 on Opus 4.8. Both roles need the same grant, so no
 * separate tier is required here. (repo-review takes the opposite stance — see its
 * `fallbackModelIds`, where 4.8 is granted for fallback but may never be
 * configured as the primary model.)
 */

import * as cdk from 'aws-cdk-lib';
import { RegionInfo } from 'aws-cdk-lib/region-info';
import type { IConstruct } from 'constructs';

import { inferenceScopeOf, type InferenceScope } from './inference-scope';

/**
 * The ARN partition (`aws`, `aws-cn`, `aws-us-gov`, ...) of `region`, so no ARN hardcodes `arn:aws:`.
 * A concrete region gives its literal partition from RegionInfo, so the commercial-partition template is
 * byte-identical to a hardcoded `arn:aws:`; an unresolved (token) region, or one RegionInfo does not
 * know, falls back to the `AWS::Partition` pseudo parameter. Unlike `Stack.partition`, it does not depend
 * on the `@aws-cdk/core:enablePartitionLiterals` flag (absent from the specs' synth context). Added 5.49
 * wave (the CDK partition lint rule); also used by api-routes.ts.
 */
export function partitionOf(region: string): string {
  if (cdk.Token.isUnresolved(region)) return cdk.Aws.PARTITION;
  return RegionInfo.get(region).partition ?? cdk.Aws.PARTITION;
}

/** Strip the `global.` cross-region prefix to get the foundation-model id. */
export function toFoundationModelId(inferenceProfileId: string): string {
  return inferenceProfileId.replace(/^global\./, '');
}

/**
 * The inference-profile id actually invoked under `scope`: the canonical
 * `global.` id, or its `eu.` twin (docs/eu-deployment.md). Mirrored at call time
 * by shared/model_config.py::invocation_model_id and the stream Lambda's
 * invocationModelId.
 */
export function scopedModelId(canonicalId: string, scope: InferenceScope): string {
  return scope === 'eu' ? `eu.${toFoundationModelId(canonicalId)}` : canonicalId;
}

/**
 * Global cross-region inference profile IDs — exactly what the application
 * passes to Bedrock as `modelId`, and what the picker stores/validates.
 */
export const ALLOWED_MODEL_IDS: readonly string[] = [
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-5-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/**
 * Underlying foundation-model IDs. Used for Bedrock model-access agreements —
 * a model without its agreement cannot be invoked at all, which includes being
 * reached via an Opus 5.5 / Opus 5 safety fallback.
 */
export const ALLOWED_FOUNDATION_MODEL_IDS: readonly string[] =
  ALLOWED_MODEL_IDS.map(toFoundationModelId);

/**
 * Allowlisted models verified to have an `eu.` inference profile (checked with
 * `aws bedrock list-inference-profiles --region eu-central-1` and eu-west-1 on
 * 2026-11, docs/eu-deployment.md; Opus 5.5 and Haiku 5.5 in eu-central-1 on
 * 2026-10-08). Every allowlisted model is here today.
 *
 * DECISION for a future model WITHOUT an `eu.` profile: it is excluded from the
 * EU picker (not silently routed to an in-region foundation id, whose quotas and
 * feature set differ). model-allowlist.test.ts fails when a model is added to
 * ALLOWED_MODEL_IDS without being listed here, forcing that decision.
 */
export const EU_PROFILE_MODEL_IDS: readonly string[] = [
  'global.anthropic.claude-opus-5-5',
  'global.anthropic.claude-sonnet-5-5',
  'global.anthropic.claude-sonnet-5',
  'global.anthropic.claude-sonnet-4-6',
  'global.anthropic.claude-opus-5',
  'global.anthropic.claude-opus-4-8',
  'global.anthropic.claude-haiku-5-5',
  'global.anthropic.claude-haiku-4-5-20251001-v1:0',
];

/**
 * Destination Regions of the `eu.` inference profiles, by SOURCE Region (the region the app deploys to).
 *
 * Source: the "Geo: EU" table on each allowlisted model's card in the Bedrock user guide
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-anthropic-claude-<model>.html, read
 * 2026-11 for all eight models; the table was identical for every one, so ONE table serves the allowlist).
 * Geographic cross-Region inference authorizes the foundation model in EVERY destination Region
 * (https://docs.aws.amazon.com/bedrock/latest/userguide/geographic-cross-region-inference.html), so a
 * destination AWS adds later is an AccessDenied on the calls routed there until it is listed here.
 * Re-check with `aws bedrock get-inference-profile --region <source> --inference-profile-identifier
 * eu.<model>` (`models[].modelArn`). A model whose table differs needs its own entry before it is added
 * to EU_PROFILE_MODEL_IDS.
 */
const EU_CORE_DESTINATIONS = ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'] as const;
export const EU_PROFILE_DESTINATION_REGIONS: Readonly<Record<string, readonly string[]>> = {
  'eu-central-1': EU_CORE_DESTINATIONS,
  'eu-central-2': [...EU_CORE_DESTINATIONS, 'eu-central-2'],
  'eu-north-1': EU_CORE_DESTINATIONS,
  'eu-south-1': EU_CORE_DESTINATIONS,
  'eu-south-2': EU_CORE_DESTINATIONS,
  'eu-west-1': EU_CORE_DESTINATIONS,
  'eu-west-2': [...EU_CORE_DESTINATIONS, 'eu-west-2'],
  'eu-west-3': EU_CORE_DESTINATIONS,
};

/** The `eu.` profiles' destination Regions from `region`; throws for a region with no `eu.` profiles (or a token). */
export function euProfileDestinations(region: string): readonly string[] {
  const destinations = cdk.Token.isUnresolved(region) ? undefined : EU_PROFILE_DESTINATION_REGIONS[region];
  if (destinations === undefined) {
    throw new Error(
      `-c inferenceScope=eu needs the app deployed to an EU source Region of the eu. inference profiles `
      + `(${Object.keys(EU_PROFILE_DESTINATION_REGIONS).join(', ')}); got ${cdk.Token.isUnresolved(region) ? 'an unresolved region' : region}. `
      + 'See docs/eu-deployment.md.',
    );
  }
  return destinations;
}

/**
 * The IAM resources one allowlisted Claude model needs under `scope`, in the three parts AWS documents for
 * cross-Region inference (global: .../global-cross-region-inference.html; eu: .../geographic-cross-region-inference.html):
 *  - `profile`: the inference profile in the app region, the `modelId` the code sends (no condition);
 *  - `regionalModels`: the foundation model in the app region (global) or in every destination Region of
 *    the `eu.` profile (eu), granted only with `bedrock:InferenceProfileArn` = `profile`;
 *  - `globalModel`: the Region-agnostic `arn:…:bedrock:::foundation-model/<model>` (global only), granted with
 *    `aws:RequestedRegion` = `unspecified` and the same profile condition.
 * No Region wildcard anywhere.
 */
export interface ClaudeModelArns {
  readonly profile: string;
  readonly regionalModels: readonly string[];
  readonly globalModel?: string;
}

/** {@link ClaudeModelArns} for every allowlisted model (eu: only those with a verified `eu.` profile). */
export function allowlistedModelArns(region: string, account: string, scope: InferenceScope): ClaudeModelArns[] {
  const models = scope === 'eu' ? ALLOWED_MODEL_IDS.filter((id) => EU_PROFILE_MODEL_IDS.includes(id)) : ALLOWED_MODEL_IDS;
  const partition = partitionOf(region);
  const modelRegions = scope === 'eu' ? euProfileDestinations(region) : [region];
  return models.map((id) => {
    const model = toFoundationModelId(id);
    const profile = `arn:${partition}:bedrock:${region}:${account}:inference-profile/${scopedModelId(id, scope)}`;
    const regionalModels = modelRegions.map((r) => `arn:${partition}:bedrock:${r}::foundation-model/${model}`);
    return scope === 'eu'
      ? { profile, regionalModels }
      : { profile, regionalModels, globalModel: `arn:${partition}:bedrock:::foundation-model/${model}` };
  });
}

/**
 * {@link allowlistedModelArns} for the stack `scope` lives in, under the app's inference scope
 * (`-c inferenceScope`). The grant itself is built by lib/utils/claude-model-grant.ts.
 */
export function stackModelArns(scope: IConstruct): ClaudeModelArns[] {
  const stack = cdk.Stack.of(scope);
  return allowlistedModelArns(stack.region, stack.account, inferenceScopeOf(stack));
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
 * WHY NOT amazon.nova-canvas-v1:0 (the previous model): it went LEGACY on
 * 2026-03-30 with EOL 2026-09-30, and a legacy model also drops access for
 * accounts idle 15+ days — which had already caused a silent avatar outage here
 * (generation degrades to avatar_url=null, so nothing visibly breaks).
 *
 * WHY us-west-2 rather than the platform's us-east-1: as of 2026-08-02 there is
 * NO active text-to-image model in us-east-1 — Nova Canvas is the only generator
 * offered there and it is legacy. Every other image model in us-east-1 is a
 * Stability EDITING primitive (inpaint/upscale/remove-background) that requires
 * an input image. us-west-2 carries the three active generators, verified
 * invocable from this account. avatar.py builds its own regional client, so the
 * cross-region call needs no extra plumbing.
 *
 * Alternatives if quality matters more than cost/latency:
 * stability.stable-image-ultra-v1:1 (best quality) or stability.sd3-5-large-v1:0.
 * All three share one request/response shape, so switching is just this constant.
 *
 * To re-check the landscape:
 *   aws bedrock list-foundation-models --region us-west-2 \
 *     --by-output-modality IMAGE \
 *     --query 'modelSummaries[].[modelId,modelLifecycle.status]' --output table
 * A model from a different VENDOR will need a new payload builder in
 * lambda/shared/avatar.py — the body shapes are not interchangeable.
 */
export const IMAGE_MODEL_ID = 'stability.stable-image-core-v1:1';

/**
 * AWS Marketplace product id of IMAGE_MODEL_ID — the `aws-marketplace:ProductId`
 * value that scopes the `aws-marketplace:Subscribe` grant to this one listing.
 * MUST change together with IMAGE_MODEL_ID (model-allowlist.test.ts pins the pair).
 *
 * Source: the "Stable Image Core 1.0" row of
 * https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-product-ids.html
 * (`aws bedrock get-foundation-model --model-identifier <IMAGE_MODEL_ID>
 * --region us-west-2` reports modelName "Stable Image Core 1.0").
 */
export const IMAGE_MODEL_MARKETPLACE_PRODUCT_ID = 'prod-eacdrmv7zfc5e';

/** Image generators are region-limited; the avatar client pins this one. */
export const IMAGE_MODEL_REGION = 'us-west-2';

/**
 * IAM resource ARN for the avatar image model. Region-pinned (unlike the
 * cross-region text models) because the model is only invoked in
 * IMAGE_MODEL_REGION, which keeps the grant narrow enough to need no cdk-nag
 * suppression.
 */
export function imageModelArn(): string {
  return `arn:${partitionOf(IMAGE_MODEL_REGION)}:bedrock:${IMAGE_MODEL_REGION}::foundation-model/${IMAGE_MODEL_ID}`;
}

/**
 * ── Memory embedding model ────────────────────────────────────────────────────
 *
 * Titan Text Embeddings V2 (1024 dims) — memory dedup (cosine ≥ 0.86) and
 * retrieval. Like the image model it is NOT a picker choice: embeddings stored
 * in voc-memory are only comparable when they come from one model, so letting
 * an admin repoint it would silently break every stored vector. Region-scoped
 * (invoked in the stack's own region), so the grant needs no cdk-nag
 * suppression. Mirrored by the memory Lambdas' model constant.
 */
export const EMBEDDING_MODEL_ID = 'amazon.titan-embed-text-v2:0';

/** IAM resource ARN for {@link EMBEDDING_MODEL_ID} in `region`. */
export function embeddingModelArn(region: string): string {
  return `arn:${partitionOf(region)}:bedrock:${region}::foundation-model/${EMBEDDING_MODEL_ID}`;
}

/**
 * ── Image limits for visual grounding ─────────────────────────────────────────
 *
 * Caps for any image this platform sends to Bedrock as part of a prompt.
 * `MAX_IMAGE_BYTES` is mirrored in `lambda/shared/image_limits.py`, and a lockstep
 * test (`lambda/shared/test/test_image_limits_lockstep.py`) reads this file as
 * source text and fails on drift. `MAX_IMAGE_DIMENSION_PX` reaches the extractor
 * through its Lambda environment instead.
 *
 * WHY HARDCODED NUMBERS ARE SAFE HERE, given the admin model picker:
 *
 * These are limits of the Bedrock **Converse API request shape**, not of any one
 * model — `Message.content` accepts at most 20 images, each no larger than
 * 3.75 MB and no more than 8000 px on either side. See
 * https://docs.aws.amazon.com/bedrock/latest/APIReference/API_runtime_Message.html
 *
 * Because the constraint lives on the API surface *above* the model, repointing a
 * surface through the picker cannot move it. And the picker can only ever choose
 * an Anthropic Claude: every entry in ALLOWED_MODEL_IDS is one, and Anthropic's
 * own documented vision limits (5 MB per image, 8000x8000 px) are looser than or
 * equal to the API's. So the API figure is the binding one for the entire
 * allowlist — and for any further Claude added to it. That is what makes a
 * constant here durable rather than something that quietly goes stale the next
 * time the picker gains a model.
 *
 * WHY 3_750_000 AND NOT 3_932_160: "3.75 MB" is ambiguous between the decimal
 * reading (3.75 * 1000^2 = 3,750,000) and the binary one (3.75 * 1024^2 =
 * 3,932,160). The decimal reading is 4.6% lower, so enforcing it keeps us inside
 * the limit under *either* interpretation. Do not "fix" this upward: the higher
 * number is only correct if the docs mean MiB, and a rejected Converse call is a
 * worse outcome than a slightly conservative cap.
 */
export const MAX_IMAGE_BYTES = 3_750_000;

/** Max pixels on either side of an image in a Converse message. */
export const MAX_IMAGE_DIMENSION_PX = 8000;
