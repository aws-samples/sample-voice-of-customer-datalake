/**
 * Template-level tests for the merged us-east-1 AI-enablement stack.
 *
 * VocWebSearchStack hosts two independently switchable halves — the web-search
 * AgentCore Gateway and Bedrock model access — because they are one deployment
 * unit and splitting them put the app one CloudFormation template over Workshop
 * Studio's ceiling of five.
 *
 * These tests fail if:
 *  - either half stops being independently switchable (e.g. someone makes the
 *    gateway unconditional again, which would break `-c enableWebSearch=false`,
 *    or makes the agreements unconditional, breaking accounts that already have
 *    Bedrock access);
 *  - the gateway's export names drift. VocProcessingStack and VocApiStack import
 *    them by literal name, so a rename silently breaks both consumer stacks at
 *    deploy time with "No export named ..." and zero resources created — the
 *    exact failure this stack caused in a workshop event;
 *  - the both-halves-off guard is removed, which would synthesize a stack with
 *    no resources. The workshop converter strips CDKMetadata, so that becomes an
 *    invalid `Resources: {}` template.
 */
import { describe, it, expect } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template, Match } from 'aws-cdk-lib/assertions';
import { z } from 'zod';
import { VocWebSearchStack, VocWebSearchStackProps } from './web-search-stack';
import { shouldDeployAiEnablement } from '../utils/ai-enablement-default';
import { ALLOWED_FOUNDATION_MODEL_IDS } from '../utils/model-allowlist';
import { byCodeUnit } from '../utils/compare';
import { defined } from '../test-support/guards';

/** `Template.toJSON()` is untyped, so validate rather than assert. */
const ExportedOutputSchema = z.object({ Export: z.object({ Name: z.string() }) });

/** Names of every output carrying an `Export` block, sorted. */
function exportNames(template: Template): string[] {
  return Object.values(template.toJSON().Outputs ?? {})
    .map((output) => ExportedOutputSchema.safeParse(output))
    .flatMap((parsed) => (parsed.success ? [parsed.data.Export.Name] : []))
    .sort(byCodeUnit);
}

/**
 * How many resources of each `type` the template holds, as one object, so a
 * case asserts every count at once and a failure diffs all of them together.
 */
function resourceCounts(template: Template, ...types: string[]): Record<string, number> {
  return Object.fromEntries(types.map((type) => [type, Object.keys(template.findResources(type)).length]));
}

const ANTHROPIC_USE_CASE = {
  companyName: 'Test Co',
  companyWebsite: 'https://example.com',
  intendedUsers: '0' as const,
  industryOption: 'Technology' as const,
  useCases: 'Testing the merged AI-enablement stack synthesizes correctly.',
  otherIndustryOption: '',
};

/** The us-east-1 env and cross-region references every case constructs the stack with. */
const STACK_ENV = {
  env: { account: '111111111111', region: 'us-east-1' },
  crossRegionReferences: true,
} as const;

/**
 * Construct the stack in a fresh app with the common env. `modelRegion` is only
 * defaulted by `synth` below, so the cases about its absence can leave it out.
 */
function construct(props: Omit<VocWebSearchStackProps, 'env' | 'crossRegionReferences'>): VocWebSearchStack {
  // Skip asset bundling — template assertions only need structure.
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  return new VocWebSearchStack(app, 'VocWebSearchStack', { ...STACK_ENV, ...props });
}

function synth(props: Omit<VocWebSearchStackProps, 'env'>): Template {
  return Template.fromStack(construct({ modelRegion: 'us-east-1', ...props }));
}

const GATEWAY = 'AWS::BedrockAgentCore::Gateway';
const GATEWAY_TARGET = 'AWS::BedrockAgentCore::GatewayTarget';
/** One per allowlisted model; `cdk.CustomResource` renders as this type. */
const AGREEMENT = 'AWS::CloudFormation::CustomResource';
/** The AwsCustomResource wrapping PutUseCaseForModelAccess. */
const USE_CASE_SUBMISSION = 'Custom::AWS';

describe('VocWebSearchStack — both halves on (the default)', () => {
  const template = synth({ deployWebSearch: true, anthropicUseCase: ANTHROPIC_USE_CASE });

  it('creates the gateway and one agreement per allowlisted model', () => {
    expect(resourceCounts(template, GATEWAY, GATEWAY_TARGET, AGREEMENT, USE_CASE_SUBMISSION)).toStrictEqual({
      [GATEWAY]: 1,
      [GATEWAY_TARGET]: 1,
      [AGREEMENT]: ALLOWED_FOUNDATION_MODEL_IDS.length,
      [USE_CASE_SUBMISSION]: 1,
    });
  });

  it('scopes the gateway role to the concrete gateway ARN, not a wildcard', () => {
    // Why the gateway half needs no cdk-nag IAM5 suppression.
    expect(() => template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Sid: 'InvokeGateway',
            Resource: { 'Fn::GetAtt': [Match.anyValue(), 'GatewayArn'] },
          }),
        ]),
      }),
    })).not.toThrow();
  });
});

describe('VocWebSearchStack — the cross-stack contract with Processing and Api', () => {
  /**
   * The `ExportsOutput*` outputs only exist once another stack consumes the
   * values, so this synthesizes a consumer too. That is deliberate: it is the
   * real path, and these literal names are what VocProcessingStack and
   * VocApiStack resolve at deploy time. A drift here fails those stacks with
   * "No export named ..." and zero resources created.
   */
  it('exports the gateway ARN and URL under their established names', () => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    const env = { account: '111111111111', region: 'us-east-1' };
    const producer = new VocWebSearchStack(app, 'VocWebSearchStack', {
      env,
      crossRegionReferences: true,
      modelRegion: 'us-east-1',
      deployWebSearch: true,
      anthropicUseCase: ANTHROPIC_USE_CASE,
    });
    const consumer = new cdk.Stack(app, 'Consumer', { env });
    new cdk.CfnOutput(consumer, 'Arn', { value: defined(producer.gatewayArn, 'gatewayArn') });
    new cdk.CfnOutput(consumer, 'Url', { value: defined(producer.gatewayUrl, 'gatewayUrl') });

    expect(exportNames(Template.fromStack(producer))).toStrictEqual([
      'VocWebSearchStack:ExportsOutputFnGetAttWebSearchGatewayGatewayArnBA97E0DC',
      'VocWebSearchStack:ExportsOutputFnGetAttWebSearchGatewayGatewayUrlE01706EF',
    ]);
  });

  it('exposes the gateway properties as undefined when the half is off', () => {
    // This is what lets processing-stack-consolidated.ts and api-stack.ts skip
    // their web-search wiring with no change of their own.
    const stack = construct({ modelRegion: 'us-east-1', deployWebSearch: false, anthropicUseCase: ANTHROPIC_USE_CASE });
    expect(stack.gatewayArn).toBeUndefined();
    expect(stack.gatewayUrl).toBeUndefined();
    expect(stack.toolName).toBeUndefined();
  });
});

describe('VocWebSearchStack — model access only (-c enableWebSearch=false)', () => {
  const template = synth({ deployWebSearch: false, anthropicUseCase: ANTHROPIC_USE_CASE });

  it('creates no gateway resources at all', () => {
    expect(resourceCounts(template, GATEWAY, GATEWAY_TARGET)).toStrictEqual({ [GATEWAY]: 0, [GATEWAY_TARGET]: 0 });
  });

  it('publishes no exports, so the consumer stacks import nothing', () => {
    expect(exportNames(template)).toStrictEqual([]);
  });

  it('still creates the agreements', () => {
    expect(resourceCounts(template, AGREEMENT)).toStrictEqual({ [AGREEMENT]: ALLOWED_FOUNDATION_MODEL_IDS.length });
  });
});

describe('VocWebSearchStack — gateway only (account already has Bedrock access)', () => {
  const template = synth({ deployWebSearch: true });

  it('creates the gateway', () => {
    expect(resourceCounts(template, GATEWAY, GATEWAY_TARGET)).toStrictEqual({ [GATEWAY]: 1, [GATEWAY_TARGET]: 1 });
  });

  it('creates no agreements and no use-case submission', () => {
    expect(resourceCounts(template, AGREEMENT, USE_CASE_SUBMISSION))
      .toStrictEqual({ [AGREEMENT]: 0, [USE_CASE_SUBMISSION]: 0 });
  });
});

describe('VocWebSearchStack — model agreements target the app region, not the stack region', () => {
  it('passes modelRegion through as a custom-resource property', () => {
    // The stack is pinned to us-east-1; the agreements must still be created in
    // whichever region the app runs in. This is what made merging the two
    // stacks free rather than a regional behaviour change.
    const template = synth({
      deployWebSearch: false,
      anthropicUseCase: ANTHROPIC_USE_CASE,
      modelRegion: 'eu-central-1',
    });
    expect(() => template.hasResourceProperties(AGREEMENT, {
      region: 'eu-central-1',
      modelId: ALLOWED_FOUNDATION_MODEL_IDS[0],
    })).not.toThrow();
  });
});

describe('VocWebSearchStack — modelRegion is required only when the model-access half is on', () => {
  it('is not needed for a gateway-only deployment', () => {
    // A gateway-only caller has no agreements, so it must not be forced to
    // invent a region it never reads.
    expect(() => construct({ deployWebSearch: true })).not.toThrow();
  });

  it('throws when the model-access half is on without it', () => {
    // Silently defaulting would create the agreements in a region the app never
    // calls Bedrock in.
    expect(() => construct({ deployWebSearch: false, anthropicUseCase: ANTHROPIC_USE_CASE })).toThrow(/modelRegion is required/);
  });
});

describe('VocWebSearchStack — the both-halves-off invariant is enforced, not just documented', () => {
  it('throws rather than synthesizing a resource-less stack', () => {
    // An empty stack becomes an invalid `Resources: {}` once
    // convert-template.mjs strips CDKMetadata, so this must be impossible to
    // reach even if a caller skips shouldDeployAiEnablement().
    expect(() => construct({ modelRegion: 'us-east-1', deployWebSearch: false })).toThrow(/both halves are disabled/);
  });
});

describe('shouldDeployAiEnablement', () => {
  it('constructs the stack when either half is wanted', () => {
    expect(shouldDeployAiEnablement(true, undefined)).toBe(true);
    expect(shouldDeployAiEnablement(false, ANTHROPIC_USE_CASE)).toBe(true);
    expect(shouldDeployAiEnablement(true, ANTHROPIC_USE_CASE)).toBe(true);
  });

  it('does NOT construct the stack when both halves are off', () => {
    // Reachable in the normal deploy path: an account that already has Bedrock
    // access, deployed with -c enableWebSearch=false. Constructing here would
    // emit a resource-less stack, which the workshop converter turns into an
    // invalid `Resources: {}`.
    expect(shouldDeployAiEnablement(false, undefined)).toBe(false);
  });
});
