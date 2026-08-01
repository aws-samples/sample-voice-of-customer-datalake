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
} from './model-allowlist';

const OPUS5 = 'global.anthropic.claude-opus-5';
const OPUS48 = 'global.anthropic.claude-opus-4-8';
const REGION = 'us-east-1';
const ACCOUNT = '123456789012';

describe('ALLOWED_MODEL_IDS', () => {
  it('offers both current Opus generations', () => {
    // Opus 4.8 is selectable in its own right AND the model Opus 5 falls back
    // to, so it must be present here or the fallback AccessDenies.
    expect(ALLOWED_MODEL_IDS).toContain(OPUS5);
    expect(ALLOWED_MODEL_IDS).toContain(OPUS48);
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
    const arns = allowlistedModelArns(REGION, ACCOUNT);
    expect(arns).toHaveLength(ALLOWED_MODEL_IDS.length * 2);
  });

  it('grants invoke on the fallback model so a safety fallback cannot AccessDeny', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT);
    expect(arns).toContain(
      `arn:aws:bedrock:${REGION}:${ACCOUNT}:inference-profile/${OPUS48}`,
    );
    expect(arns).toContain(
      'arn:aws:bedrock:*::foundation-model/anthropic.claude-opus-4-8',
    );
  });

  it('confines the region wildcard to foundation-model ARNs', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT);
    for (const arn of arns.filter((a) => a.includes('inference-profile/'))) {
      expect(arn).toContain(`:${REGION}:${ACCOUNT}:`);
      expect(arn).not.toContain(':*:');
    }
  });

  it('never leaves a global. prefix on a foundation-model ARN', () => {
    const arns = allowlistedModelArns(REGION, ACCOUNT);
    for (const arn of arns.filter((a) => a.includes('foundation-model/'))) {
      expect(arn).not.toContain('foundation-model/global.');
    }
  });
});

describe('bedrockFoundationModelSuppressionTargets', () => {
  it('covers every wildcard ARN the policy actually emits', () => {
    // An uncovered wildcard ARN fails synth with an unsuppressed IAM5 finding —
    // the exact drift that hand-listing these used to cause.
    const targets = bedrockFoundationModelSuppressionTargets();
    const wildcardArns = allowlistedModelArns(REGION, ACCOUNT).filter((a) =>
      a.includes('foundation-model/'),
    );
    expect(targets).toHaveLength(ALLOWED_MODEL_IDS.length);
    for (const arn of wildcardArns) {
      expect(targets).toContain(`Resource::${arn}`);
    }
  });
});
