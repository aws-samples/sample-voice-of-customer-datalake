/**
 * Guards the IAM/agreement derivation in model-allowlist.ts.
 *
 * The failure mode this protects against is silent and deploy-time: a model
 * that is selectable but not invocable AccessDenies the whole surface, and a
 * wildcard ARN without a matching cdk-nag suppression fails synth.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_FOUNDATION_MODEL_IDS,
  ALLOWED_MODEL_IDS,
  allowlistedModelArns,
  bedrockFoundationModelSuppressionTargets,
  EU_PROFILE_MODEL_IDS,
  IMAGE_MODEL_ID,
  IMAGE_MODEL_MARKETPLACE_PRODUCT_ID,
  IMAGE_MODEL_REGION,
  imageModelArn,
  scopedModelId,
} from './model-allowlist';
import { byCodeUnit } from './compare';

const OPUS55 = 'global.anthropic.claude-opus-5-5';
const OPUS5 = 'global.anthropic.claude-opus-5';
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
const OPUS48 = 'global.anthropic.claude-opus-4-8';
const REGION = 'us-east-1';
const ACCOUNT = '123456789012';

describe('ALLOWED_MODEL_IDS', () => {
  it('offers every Opus on the safety-fallback path', () => {
    // Opus 5.5 falls back to Opus 5 and Opus 5 to Opus 4.8 when the safety
    // classifiers decline a request; each is also selectable in its own right,
    // so every hop must be present here or the fallback AccessDenies.
    expect(ALLOWED_MODEL_IDS).toContain(OPUS55);
    expect(ALLOWED_MODEL_IDS).toContain(OPUS5);
    expect(ALLOWED_MODEL_IDS).toContain(OPUS48);
  });

  it('offers Haiku 5.5 with its foundation id and an eu. profile', () => {
    expect(ALLOWED_MODEL_IDS).toContain(HAIKU55);
    expect(ALLOWED_FOUNDATION_MODEL_IDS).toContain('anthropic.claude-haiku-5-5');
    expect(scopedModelId(HAIKU55, 'eu')).toBe('eu.anthropic.claude-haiku-5-5');
    expect(scopedModelId(OPUS55, 'eu')).toBe('eu.anthropic.claude-opus-5-5');
  });

  it('offers Sonnet 5.5, the AI assistant default', () => {
    expect(ALLOWED_MODEL_IDS).toContain('global.anthropic.claude-sonnet-5-5');
    expect(ALLOWED_FOUNDATION_MODEL_IDS).toContain('anthropic.claude-sonnet-5-5');
  });

  it('contains no duplicates', () => {
    expect(new Set(ALLOWED_MODEL_IDS).size).toBe(ALLOWED_MODEL_IDS.length);
  });

  it('uses global cross-region inference profile ids throughout', () => {
    for (const id of ALLOWED_MODEL_IDS) {
      expect(id.startsWith('global.anthropic.')).toBe(true);
    }
  });
});

describe('ALLOWED_FOUNDATION_MODEL_IDS', () => {
  it('strips the global. prefix from every entry', () => {
    expect(ALLOWED_FOUNDATION_MODEL_IDS).toHaveLength(ALLOWED_MODEL_IDS.length);
    for (const id of ALLOWED_FOUNDATION_MODEL_IDS) {
      expect(id.startsWith('anthropic.')).toBe(true);
    }
  });

  it('requires an agreement for the fallback model too', () => {
    // No agreement means the model cannot be invoked at all, including when it
    // is reached via an Opus 5 safety fallback rather than being requested.
    expect(ALLOWED_FOUNDATION_MODEL_IDS).toContain('anthropic.claude-opus-4-8');
  });
});

describe('allowlistedModelArns', () => {
  it('emits a profile ARN and a foundation-model ARN per model', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT, 'global');
    expect(arns).toHaveLength(ALLOWED_MODEL_IDS.length * 2);
  });

  it('grants invoke on the fallback model so a safety fallback cannot AccessDeny', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT, 'global');
    expect(arns).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${OPUS48}`,
    );
    expect(arns).toContain(
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-8',
    );
  });

  it('confines the region wildcard to foundation-model ARNs', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT, 'global');
    for (const arn of arns.filter((a) => a.includes('inference-profile/'))) {
      expect(arn).toContain(`:${REGION}:${ACCOUNT}:`);
      expect(arn).not.toContain(':*:');
    }
  });

  it('never leaves a global. prefix on a foundation-model ARN', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT, 'global');
    for (const arn of arns.filter((a) => a.includes('foundation-model/'))) {
      expect(arn).not.toContain('foundation-model/global.');
    }
  });
});

describe('allowlistedModelArns under inferenceScope=eu', () => {
  const euArns = () => allowlistedModelArns(REGION, ACCOUNT, 'eu');

  it('grants the eu. profile of every allowlisted model and no global. profile', () => {
    const profiles = euArns().filter((a) => a.includes('inference-profile/'));
    expect(profiles).toStrictEqual(ALLOWED_MODEL_IDS.map((id) =>
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${id.replace(/^global\./, 'eu.')}`));
    expect(profiles.filter((a) => a.includes('/global.'))).toStrictEqual([]);
  });

  it('keeps the same foundation-model ARNs (the cdk-nag targets stay valid)', () => {
    const foundation = (arns: string[]) => arns.filter((a) => a.includes('foundation-model/'));
    expect(foundation(euArns())).toStrictEqual(foundation(allowlistedModelArns(REGION, ACCOUNT, 'global')));
  });

  it('maps a canonical id to its eu. twin and leaves global alone', () => {
    expect(scopedModelId(OPUS48, 'eu')).toBe('eu.anthropic.claude-opus-4-8');
    expect(scopedModelId(OPUS48, 'global')).toBe(OPUS48);
  });

  it('knows an eu. profile exists for every allowlisted model (verified list, docs/eu-deployment.md)', () => {
    // A model added to the allowlist without being verified in the EU must be a
    // deliberate decision (exclude it from the EU picker), not an AccessDenied.
    expect([...EU_PROFILE_MODEL_IDS].sort(byCodeUnit)).toStrictEqual([...ALLOWED_MODEL_IDS].sort(byCodeUnit));
  });
});

describe('avatar image model', () => {
  it('stays out of the text picker allowlist', () => {
    // ALLOWED_MODEL_IDS drives the per-surface picker. An image model in there
    // would become selectable for chat/documents and fail on the first call.
    expect(ALLOWED_MODEL_IDS).not.toContain(IMAGE_MODEL_ID);
    expect(ALLOWED_FOUNDATION_MODEL_IDS).not.toContain(IMAGE_MODEL_ID);
  });

  it('keeps the Marketplace product id in lockstep with the model id', () => {
    // The Subscribe grant is conditioned on this product id. Switching the model
    // without its id would leave every avatar role unable to auto-subscribe in a
    // fresh account (AccessDenied on the first InvokeModel). Change both together,
    // from https://docs.aws.amazon.com/bedrock/latest/userguide/model-access-product-ids.html
    expect({ IMAGE_MODEL_ID, IMAGE_MODEL_MARKETPLACE_PRODUCT_ID }).toStrictEqual({
      IMAGE_MODEL_ID: 'stability.stable-image-core-v1:1',
      IMAGE_MODEL_MARKETPLACE_PRODUCT_ID: 'prod-eacdrmv7zfc5e',
    });
  });

  it('pins the ARN to a single region rather than wildcarding it', () => {
    // A region-pinned ARN needs no cdk-nag suppression, unlike the cross-region
    // text-model ARNs.
    expect(imageModelArn()).toBe(
      `arn:aws:bedrock:${IMAGE_MODEL_REGION}::foundation-model/${IMAGE_MODEL_ID}`,
    );
    expect(imageModelArn()).not.toContain(':*:');
  });

  it('is excluded from the cdk-nag wildcard suppressions', () => {
    // Those targets exist only for wildcard-region ARNs; adding the pinned
    // image model would be a suppression with nothing to suppress.
    for (const target of bedrockFoundationModelSuppressionTargets()) {
      expect(target).not.toContain(IMAGE_MODEL_ID);
    }
  });
});

describe('bedrockFoundationModelSuppressionTargets', () => {
  it('covers every wildcard ARN the policy actually emits', () => {
    // An uncovered wildcard ARN fails synth with an unsuppressed IAM5 finding —
    // the exact drift that hand-listing these used to cause.
    const targets = bedrockFoundationModelSuppressionTargets();
    const wildcardArns = allowlistedModelArns(REGION, ACCOUNT, 'global').filter((a) =>
      a.includes('foundation-model/'),
    );
    expect(targets).toHaveLength(ALLOWED_MODEL_IDS.length);
    for (const arn of wildcardArns) {
      expect(targets).toContain(`Resource::${arn}`);
    }
  });
});
