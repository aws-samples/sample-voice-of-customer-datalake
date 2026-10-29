/**
 * The Settings API's grants for Administration → AI models → Image generation (5.45.00,
 * api-marketplace.ts grantImageModelProbe, lambda/shared/image_model_status.py):
 * - `bedrock:InvokeModel` on the image model's foundation-model ARN ONLY (POST /settings/model/test
 *   sends one minimal image request), never a wildcard or another image model;
 * - `bedrock:GetFoundationModelAvailability` alone in its statement (account-level, no resource ARN);
 * - Marketplace ViewSubscriptions + Subscribe, Subscribe scoped to the image model's product id;
 * - the role's inline policy stays under IAM's 10,240-character inline quota.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiTemplate, policyStatementsOf } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { IMAGE_MODEL_MARKETPLACE_PRODUCT_ID, IMAGE_MODEL_REGION, imageModelArn } from '../utils/model-allowlist';

const ROLE = 'SettingsLambdaRole';
/** IAM's limit on the aggregate size of a role's inline policies. */
const INLINE_POLICY_QUOTA_CHARS = 10_240;

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const statements = () => policyStatementsOf(apiTemplate(), `${ROLE}DefaultPolicy`);

describe('Settings role: image model probe', () => {
  it('may invoke the image model by its exact ARN, in the image region, and no other image model', () => {
    const onImage = statements().filter((s) => s.actions.includes('bedrock:InvokeModel') && s.resource.includes('stability.'));
    expect(onImage.map((s) => [s.actions, JSON.parse(s.resource)])).toStrictEqual([[['bedrock:InvokeModel'], imageModelArn()]]);
    expect(imageModelArn()).toContain(`:bedrock:${IMAGE_MODEL_REGION}::foundation-model/`);
  });

  it('never invokes a model through a wildcard', () => {
    const wildcards = statements()
      .filter((s) => s.actions.some((a) => a.startsWith('bedrock:Invoke')))
      .filter((s) => /foundation-model\/\*|"\*"/.test(s.resource));
    expect(wildcards).toStrictEqual([]);
  });

  it('reads model availability with one statement holding that action alone', () => {
    const availability = statements().filter((s) => s.actions.includes('bedrock:GetFoundationModelAvailability'));
    expect(availability.map((s) => [s.actions, JSON.parse(s.resource)]))
      .toStrictEqual([[['bedrock:GetFoundationModelAvailability'], '*']]);
  });

  it('holds ViewSubscriptions and a Subscribe scoped to the image model product', () => {
    const marketplace = statements().filter((s) => s.actions.some((a) => a.startsWith('aws-marketplace:')));
    expect(marketplace.map((s) => s.actions.join(',')).sort(byCodeUnit))
      .toStrictEqual(['aws-marketplace:Subscribe', 'aws-marketplace:ViewSubscriptions']);
    const subscribe = marketplace.find((s) => s.actions.includes('aws-marketplace:Subscribe'));
    expect(subscribe?.condition).toStrictEqual({
      'ForAnyValue:StringEquals': { 'aws-marketplace:ProductId': [IMAGE_MODEL_MARKETPLACE_PRODUCT_ID] },
    });
  });

  it('keeps the inline policy under the 10,240-character quota', () => {
    const PolicySchema = z.object({ Properties: z.object({ PolicyDocument: z.unknown() }) });
    const policy = Object.entries(apiTemplate().findResources('AWS::IAM::Policy'))
      .find(([id]) => id.startsWith(`${ROLE}DefaultPolicy`));
    expect(policy).toBeDefined();
    const size = JSON.stringify(PolicySchema.parse(policy?.[1]).Properties.PolicyDocument).length;
    expect(size).toBeLessThan(INLINE_POLICY_QUOTA_CHARS);
  });
});
