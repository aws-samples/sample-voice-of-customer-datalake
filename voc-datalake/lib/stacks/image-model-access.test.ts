/**
 * ImageModelAccess (bedrock-access-stack.ts, 5.45.00): the persona-avatar image model's agreement
 * on EVERY deployment, with no flag and no opt-out.
 *
 * Pinned:
 * - the custom resource asks for exactly IMAGE_MODEL_ID in IMAGE_MODEL_REGION (us-west-2, whatever
 *   the app region) and is marked best effort, so a refused agreement never fails the deploy;
 * - the inline handler carries the best-effort branch (its behaviour is tested in
 *   lambda/shared/test/test_model_agreement_handler.py);
 * - the app hosts it in VocCoreStack even with web search off and no `anthropicUseCase`, i.e. when
 *   VocWebSearchStack (the Claude agreements' host) does not exist;
 * - the Claude agreements did NOT move: same construct paths and logical ids as before, so their
 *   custom resources keep their ServiceToken (CloudFormation refuses to change one), and no
 *   `bestEffort` property (their template is unchanged).
 */
import { afterAll, describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { ImageModelAccess } from './bedrock-access-stack';
import { VocWebSearchStack } from './web-search-stack';
import { IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from '../utils/model-allowlist';
import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

afterAll(cleanupAssemblyDirs);

/** `cdk.CustomResource` renders as this type. */
const AGREEMENT = 'AWS::CloudFormation::CustomResource';

const AgreementSchema = z.object({
  Properties: z.object({ ServiceToken: z.unknown(), modelId: z.string(), region: z.string(), bestEffort: z.string().optional() }),
});
const InlineFunctionSchema = z.object({ Properties: z.object({ Code: z.object({ ZipFile: z.string() }) }) });

function agreementsOf(resources: Record<string, unknown>): z.infer<typeof AgreementSchema>['Properties'][] {
  return Object.values(resources).map((resource) => AgreementSchema.parse(resource).Properties);
}

/** ImageModelAccess alone in a stack of another region than the image model's. */
function imageAccessTemplate(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Host', { env: { account: '111111111111', region: 'eu-west-1' } });
  ImageModelAccess.addTo(stack, 'ImageModelAccess');
  return Template.fromStack(stack);
}

describe('ImageModelAccess construct', () => {
  const template = imageAccessTemplate();

  it('requests exactly the image model in its own region, best effort', () => {
    expect(agreementsOf(template.findResources(AGREEMENT)).map(({ modelId, region, bestEffort }) => ({ modelId, region, bestEffort })))
      .toStrictEqual([{ modelId: IMAGE_MODEL_ID, region: IMAGE_MODEL_REGION, bestEffort: 'true' }]);
    expect(IMAGE_MODEL_REGION).toBe('us-west-2');
  });

  it('ships a handler that turns any failure into an UNAVAILABLE result when best effort', () => {
    const inline = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => InlineFunctionSchema.safeParse(fn))
      .flatMap((parsed) => (parsed.success ? [parsed.data.Properties.Code.ZipFile] : []));
    expect(inline).toHaveLength(1);
    const code = inline[0] ?? '';
    expect(code).toContain("properties.get('bestEffort', '')");
    expect(code).toContain('return _unavailable(model_id, code)');
  });

  it('may accept agreements and subscribe, and nothing else of Bedrock', () => {
    const json = JSON.stringify(template.findResources('AWS::IAM::Policy'));
    for (const action of [
      'bedrock:ListFoundationModelAgreementOffers', 'bedrock:CreateFoundationModelAgreement',
      'bedrock:GetFoundationModelAvailability', 'aws-marketplace:Subscribe', 'aws-marketplace:ViewSubscriptions',
    ]) expect(json).toContain(action);
    expect(json).not.toMatch(/bedrock:Invoke/);
  });
});

describe('the Claude agreements keep their construct paths (VocWebSearchStack)', () => {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new VocWebSearchStack(app, 'VocWebSearchStack', {
    env: { account: '111111111111', region: 'us-east-1' },
    crossRegionReferences: true,
    modelRegion: 'us-east-1',
    deployWebSearch: false,
    anthropicUseCase: {
      companyName: 'Test Co', companyWebsite: 'https://example.com', intendedUsers: '0',
      industryOption: 'Technology', useCases: 'Pinning the agreement construct paths.', otherIndustryOption: '',
    },
  });
  const template = Template.fromStack(stack);

  it('has the agreement Lambda and provider under the logical ids deployed before 5.45.00', () => {
    const fnIds = Object.keys(template.findResources('AWS::Lambda::Function'));
    expect(fnIds).toContain('BedrockModelAccessModelAgreementLambda6BECE77F');
    expect(fnIds).toContain('BedrockModelAccessModelAgreementProviderframeworkonEventBFFB8E4D');
  });

  it('carries no bestEffort property on any Claude agreement', () => {
    const agreements = agreementsOf(template.findResources(AGREEMENT));
    expect(agreements.length).toBeGreaterThan(0);
    expect(agreements.filter((a) => a.bestEffort !== undefined)).toStrictEqual([]);
  });
});

describe('the app hosts ImageModelAccess in VocCoreStack', () => {
  it('with web search off and no anthropicUseCase (no VocWebSearchStack at all)', () => {
    // null survives the JSON context and reads as unset (bin/voc-datalake.ts), overriding cdk.context.json.
    const synthed = synthApp({ enableWebSearch: false, anthropicUseCase: null });
    expect(synthed.stackNames).not.toContain('VocWebSearchStack');
    const resources = z.record(z.string(), z.object({ Type: z.string() }).loose())
      .parse(synthed.template('VocCoreStack').Resources);
    const agreements = Object.entries(resources).filter(([, r]) => r.Type === AGREEMENT);
    expect(agreements.map(([id]) => id.replace(/[0-9A-F]{8}$/, ''))).toStrictEqual(['ImageModelAccessImageModelAgreement']);
    expect(agreementsOf(Object.fromEntries(agreements)).map((a) => [a.modelId, a.region]))
      .toStrictEqual([[IMAGE_MODEL_ID, IMAGE_MODEL_REGION]]);
  }, SYNTH_TIMEOUT_MS);
});
