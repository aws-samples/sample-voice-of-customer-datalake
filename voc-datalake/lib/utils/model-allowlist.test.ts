/**
 * Guards the IAM/agreement derivation in model-allowlist.ts.
 *
 * The failure mode this protects against is silent and deploy-time: a model
 * that is selectable but not invocable AccessDenies the whole surface, and a
 * Region-wildcard ARN would bring back the cdk-nag findings this shape removed.
 */
import { describe, expect, it } from 'vitest';

import {
  ALLOWED_FOUNDATION_MODEL_IDS,
  ALLOWED_MODEL_IDS,
  allowlistedModelArns,
  EU_PROFILE_DESTINATION_REGIONS,
  EU_PROFILE_MODEL_IDS,
  euProfileDestinations,
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

describe('allowlistedModelArns (global scope)', () => {
  const arns = () => allowlistedModelArns(REGION, ACCOUNT, 'global');
  const flat = () => arns().flatMap((m) => [m.profile, ...m.regionalModels, ...(m.globalModel === undefined ? [] : [m.globalModel])]);

  it('emits the three documented parts per model: profile, in-Region model, Region-agnostic model', () => {
    expect(arns()).toHaveLength(ALLOWED_MODEL_IDS.length);
    expect(arns().find((m) => m.profile.endsWith(OPUS48))).toStrictEqual({
      profile: `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${OPUS48}`,
      regionalModels: [`arn:aws:bedrock:${REGION}::foundation-model/anthropic.claude-opus-4-8`],
      globalModel: 'arn:aws:bedrock:::foundation-model/anthropic.claude-opus-4-8',
      requestingRegion: REGION,
    });
  });

  it('names no Region wildcard anywhere (no cdk-nag acknowledgement needed)', () => {
    expect(flat().filter((arn) => arn.includes('*'))).toStrictEqual([]);
  });

  it('never leaves a global. prefix on a foundation-model ARN', () => {
    expect(flat().filter((arn) => arn.includes('foundation-model/global.'))).toStrictEqual([]);
  });
});

describe('allowlistedModelArns under inferenceScope=eu', () => {
  const EU_REGION = 'eu-central-1';
  const euArns = (region = EU_REGION) => allowlistedModelArns(region, ACCOUNT, 'eu');

  it('grants the eu. profile of every allowlisted model and no global. profile', () => {
    const profiles = euArns().map((m) => m.profile);
    expect(profiles).toStrictEqual(ALLOWED_MODEL_IDS.map((id) =>
      `arn:aws:bedrock:${EU_REGION}:${ACCOUNT}:inference-profile/${id.replace(/^global\./, 'eu.')}`));
  });

  it('grants each foundation model in every destination Region of the eu. profile, and no global model', () => {
    const haiku = euArns().find((m) => m.profile.endsWith('eu.anthropic.claude-haiku-5-5'));
    expect(haiku?.regionalModels).toStrictEqual(
      ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3']
        .map((r) => `arn:aws:bedrock:${r}::foundation-model/anthropic.claude-haiku-5-5`));
    expect(euArns().filter((m) => m.globalModel !== undefined)).toStrictEqual([]);
  });

  it('adds the source Region where the AWS table routes to it (eu-west-2, eu-central-2)', () => {
    for (const source of ['eu-west-2', 'eu-central-2']) {
      expect(euProfileDestinations(source)).toContain(source);
      expect(euArns(source)[0]?.regionalModels).toContain(`arn:aws:bedrock:${source}::foundation-model/${ALLOWED_FOUNDATION_MODEL_IDS[0] ?? ''}`);
    }
  });

  it('routes every source Region to itself and stays inside the EU', () => {
    for (const [source, destinations] of Object.entries(EU_PROFILE_DESTINATION_REGIONS)) {
      expect(destinations).toContain(source);
      expect(destinations.filter((r) => !r.startsWith('eu-'))).toStrictEqual([]);
    }
  });

  it('refuses a region without eu. profiles at synth', () => {
    expect(() => allowlistedModelArns('us-east-1', ACCOUNT, 'eu')).toThrow(/EU source Region/);
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
    // A region-pinned ARN needs no cdk-nag suppression.
    expect(imageModelArn()).toBe(
      `arn:aws:bedrock:${IMAGE_MODEL_REGION}::foundation-model/${IMAGE_MODEL_ID}`,
    );
    expect(imageModelArn()).not.toContain(':*:');
  });
});
