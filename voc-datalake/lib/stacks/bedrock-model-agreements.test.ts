/**
 * BedrockModelAgreements (bedrock-access-stack.ts): the Bedrock model agreements on EVERY
 * deployment, best effort, with no flag and no opt-out. Ported from PR #429 by @aws-bryan (the
 * Claude agreements moved here from the us-east-1 VocWebSearchStack); the image agreement has been
 * here since 5.45.00.
 *
 * Pinned:
 * - one Claude agreement per allowlisted model, in the HOSTING stack's region (the app's), and the
 *   image model's in IMAGE_MODEL_REGION (us-west-2, whatever the app region);
 * - every agreement is marked best effort, so a refused or failed agreement never fails the deploy
 *   (the handler's behaviour is tested in lambda/shared/test/test_model_agreement_handler.py);
 * - one shared provider: a single agreement Lambda for all of them;
 * - the image agreement and the provider keep the logical ids deployed since 5.45.00, so the image
 *   agreement keeps its ServiceToken (CloudFormation refuses to change one).
 *
 * Where the app hosts it (VocCoreStack, with or without VocWebSearchStack) is pinned by
 * lib/app-region.test.ts.
 */
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { BedrockModelAgreements } from './bedrock-access-stack';
import { byCodeUnit } from '../utils/compare';
import { ALLOWED_FOUNDATION_MODEL_IDS, IMAGE_MODEL_ID, IMAGE_MODEL_REGION } from '../utils/model-allowlist';

/** `cdk.CustomResource` renders as this type. */
const AGREEMENT = 'AWS::CloudFormation::CustomResource';
const HOST_REGION = 'eu-west-1';

const AgreementSchema = z.object({
  Properties: z.object({ ServiceToken: z.unknown(), modelId: z.string(), region: z.string(), bestEffort: z.string().optional() }),
});
const InlineFunctionSchema = z.object({ Properties: z.object({ Code: z.object({ ZipFile: z.string() }) }) });

function agreementsOf(template: Template): z.infer<typeof AgreementSchema>['Properties'][] {
  return Object.values(template.findResources(AGREEMENT)).map((resource) => AgreementSchema.parse(resource).Properties);
}

/** The agreements alone in a stack of another region than the image model's, under the app's id. */
function agreementsTemplate(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'Host', { env: { account: '111111111111', region: HOST_REGION } });
  BedrockModelAgreements.addTo(stack, 'ImageModelAccess');
  return Template.fromStack(stack);
}

describe('BedrockModelAgreements construct', () => {
  const template = agreementsTemplate();
  const agreements = agreementsOf(template);

  it('requests every allowlisted Claude model in the host region and the image model in its own', () => {
    const claude = agreements.filter((a) => a.modelId !== IMAGE_MODEL_ID);
    expect(claude.map((a) => a.modelId).sort(byCodeUnit)).toStrictEqual([...ALLOWED_FOUNDATION_MODEL_IDS].sort(byCodeUnit));
    expect(new Set(claude.map((a) => a.region))).toStrictEqual(new Set([HOST_REGION]));
    expect(agreements.filter((a) => a.modelId === IMAGE_MODEL_ID).map((a) => a.region)).toStrictEqual([IMAGE_MODEL_REGION]);
    expect(IMAGE_MODEL_REGION).toBe('us-west-2');
  });

  it('marks every agreement best effort', () => {
    expect(agreements).toHaveLength(ALLOWED_FOUNDATION_MODEL_IDS.length + 1);
    expect(agreements.filter((a) => a.bestEffort !== 'true')).toStrictEqual([]);
  });

  it('shares ONE agreement Lambda, whose handler turns any failure into UNAVAILABLE when best effort', () => {
    const inline = Object.values(template.findResources('AWS::Lambda::Function'))
      .map((fn) => InlineFunctionSchema.safeParse(fn))
      .flatMap((parsed) => (parsed.success ? [parsed.data.Properties.Code.ZipFile] : []));
    expect(inline).toHaveLength(1);
    const code = inline[0] ?? '';
    expect(code).toContain("properties.get('bestEffort', '')");
    expect(code).toContain('return _unavailable(model_id, code)');
  });

  it('keeps the image agreement and the provider under the logical ids deployed since 5.45.00', () => {
    const strip = (ids: string[]): string[] => ids.map((id) => id.replace(/[0-9A-F]{8}$/, ''));
    expect(strip(Object.keys(template.findResources('AWS::Lambda::Function'))))
      .toStrictEqual(['ImageModelAccessModelAgreementLambda', 'ImageModelAccessModelAgreementProviderframeworkonEvent']);
    expect(strip(Object.keys(template.findResources(AGREEMENT)))).toContain('ImageModelAccessImageModelAgreement');
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
