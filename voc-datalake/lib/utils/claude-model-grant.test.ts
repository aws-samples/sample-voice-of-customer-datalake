/**
 * The Claude grant's IAM shape (lib/utils/claude-model-grant.ts), pinned on one role of a minimal stack in both
 * inference scopes: the three parts AWS documents for global cross-Region inference, the `eu.` shape with each
 * destination Region, the conditions, the sharing across roles and the managed-policy size.
 * The whole-app check that EVERY Claude-invoking role holds every part: lib/app-template-gates.test.ts and
 * lib/app-inference-scope.test.ts.
 */
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import * as iam from 'aws-cdk-lib/aws-iam';
import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { CLAUDE_INVOKE_ACTIONS, type ClaudeInvokeVariant, grantClaudeModels, MODELS_PER_POLICY } from './claude-model-grant';
import { ALLOWED_MODEL_IDS, toFoundationModelId } from './model-allowlist';

const ACCOUNT = '111111111111';
const MANAGED_POLICY_LIMIT = 6_144;
const WARN_FRACTION = 0.7;

type RoleSpec = readonly [id: string, variant: ClaudeInvokeVariant];

/** A stack whose roles each hold one inline statement (so a default policy exists) and then the Claude grant. */
function stackWithRoles(region: string, context: Record<string, unknown> = {}, roles: readonly RoleSpec[] = [['RoleA', 'invoke']]): Template {
  const app = new cdk.App({ context });
  const stack = new cdk.Stack(app, 'Grant', { env: { account: ACCOUNT, region } });
  for (const [id, variant] of roles) {
    const role = new iam.Role(stack, id, { assumedBy: new iam.ServicePrincipal('lambda.amazonaws.com') });
    role.addToPolicy(new iam.PolicyStatement({ actions: ['sqs:SendMessage'], resources: ['arn:aws:sqs:us-east-1:111111111111:q'] }));
    grantClaudeModels(role, variant);
  }
  return Template.fromStack(stack);
}

const ManagedPolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.object({ Ref: z.string() })),
    PolicyDocument: z.object({ Statement: z.array(z.unknown()) }),
  }),
});

function managedPolicies(template: Template): [string, z.infer<typeof ManagedPolicySchema>][] {
  return Object.entries(template.findResources('AWS::IAM::ManagedPolicy'))
    .map(([id, resource]) => [id, ManagedPolicySchema.parse(resource)]);
}

/** The statements of the stack's first `invoke` Claude policy. */
const firstPolicyStatements = (template: Template) =>
  managedPolicies(template).find(([id]) => id.startsWith('ClaudeInvokePolicy0'))?.[1].Properties.PolicyDocument.Statement;

/**
 * Parts 1 and 2 as synthesized: the profiles, then `regional` through those profiles only; with `requesting`
 * (global scope) both also carry `aws:RequestedRegion` = that region, as the global doc's example does.
 */
const profileAndRegionalParts = (profiles: string[], regional: string[], requesting?: string) => {
  const inRegion = requesting === undefined ? {} : { 'aws:RequestedRegion': requesting };
  return [
    {
      Sid: 'ClaudeProfiles', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: profiles,
      ...(requesting === undefined ? {} : { Condition: { StringEquals: inRegion } }),
    },
    {
      Sid: 'ClaudeRegionalModels', Effect: 'Allow', Action: 'bedrock:InvokeModel', Resource: regional,
      Condition: { StringEquals: { ...inRegion, 'bedrock:InferenceProfileArn': profiles } },
    },
  ];
};

const models = ALLOWED_MODEL_IDS.slice(0, MODELS_PER_POLICY);
const profileArn = (region: string, prefix: string, id: string) =>
  `arn:aws:bedrock:${region}:${ACCOUNT}:inference-profile/${prefix}${toFoundationModelId(id)}`;

describe('grantClaudeModels, global scope (default)', () => {
  const template = stackWithRoles('us-east-1');
  const profiles = models.map((id) => profileArn('us-east-1', 'global.', id));

  it('grants the first policy\'s models in exactly the three documented parts', () => {
    expect(firstPolicyStatements(template)).toStrictEqual([
      ...profileAndRegionalParts(profiles, models.map((id) => `arn:aws:bedrock:us-east-1::foundation-model/${toFoundationModelId(id)}`), 'us-east-1'),
      {
        Sid: 'ClaudeGlobalModels', Effect: 'Allow', Action: 'bedrock:InvokeModel',
        Resource: models.map((id) => `arn:aws:bedrock:::foundation-model/${toFoundationModelId(id)}`),
        Condition: { StringEquals: { 'aws:RequestedRegion': 'unspecified', 'bedrock:InferenceProfileArn': profiles } },
      },
    ]);
  });

  it('covers every allowlisted model across the policies, attached to the role', () => {
    const policies = managedPolicies(template);
    expect(policies).toHaveLength(Math.ceil(ALLOWED_MODEL_IDS.length / MODELS_PER_POLICY));
    const text = JSON.stringify(policies);
    for (const id of ALLOWED_MODEL_IDS) expect(text).toContain(`"${profileArn('us-east-1', 'global.', id)}"`);
    expect(text).not.toContain('*');
    for (const [, policy] of policies) expect(policy.Properties.Roles.map((r) => r.Ref.replace(/[0-9A-F]{8}$/, ''))).toStrictEqual(['RoleA']);
  });

  it('makes the role\'s inline policy wait for the managed ones (no AccessDenied gap on the upgrade deploy)', () => {
    const [inline] = Object.values(template.findResources('AWS::IAM::Policy'));
    const dependsOn = z.object({ DependsOn: z.array(z.string()) }).parse(inline).DependsOn;
    expect(dependsOn.filter((id) => id.startsWith('ClaudeInvokePolicy'))).toHaveLength(managedPolicies(template).length);
  });
});

describe('grantClaudeModels sharing', () => {
  const template = stackWithRoles('us-east-1', {}, [['RoleA', 'invoke'], ['RoleC', 'invoke'], ['RoleB', 'stream']]);

  it('shares one policy set per action variant across the stack\'s roles', () => {
    const byVariant = (prefix: string) => managedPolicies(template).filter(([id]) => id.startsWith(prefix));
    const perVariant = Math.ceil(ALLOWED_MODEL_IDS.length / MODELS_PER_POLICY);
    const invoke = byVariant('ClaudeInvokePolicy');
    const stream = byVariant('ClaudeInvokeStreamPolicy');
    expect([invoke.length, stream.length]).toStrictEqual([perVariant, perVariant]);
    for (const [, policy] of invoke) expect(policy.Properties.Roles).toHaveLength(2);
    for (const [, policy] of stream) {
      expect(policy.Properties.Roles).toHaveLength(1);
      expect(JSON.stringify(policy.Properties.PolicyDocument)).toContain(JSON.stringify(CLAUDE_INVOKE_ACTIONS.stream));
    }
  });
});

describe('grantClaudeModels, -c inferenceScope=eu', () => {
  const template = stackWithRoles('eu-central-1', { inferenceScope: 'eu' });
  const profiles = models.map((id) => profileArn('eu-central-1', 'eu.', id));
  const destinations = ['eu-central-1', 'eu-north-1', 'eu-south-1', 'eu-south-2', 'eu-west-1', 'eu-west-3'];

  it('grants the eu. profiles and each model in every destination Region, through those profiles only', () => {
    expect(firstPolicyStatements(template)).toStrictEqual(profileAndRegionalParts(
      profiles,
      models.flatMap((id) => destinations.map((r) => `arn:aws:bedrock:${r}::foundation-model/${toFoundationModelId(id)}`)),
    ));
  });

  it('grants no global. profile and no Region-agnostic model', () => {
    const text = JSON.stringify(managedPolicies(template));
    expect(text).not.toContain('global.');
    expect(text).not.toContain('bedrock:::');
  });
});

describe('managed-policy size', () => {
  // The largest shapes: global, and eu from a source Region that adds itself to the destinations.
  it.each([['us-east-1', {}], ['eu-west-2', { inferenceScope: 'eu' }], ['eu-central-2', { inferenceScope: 'eu' }]])(
    'keeps every Claude policy under 70%% of the 6,144-char managed quota (%s)',
    (region, context) => {
      const sizes = managedPolicies(stackWithRoles(region, context, [['RoleA', 'invoke'], ['RoleB', 'stream']]))
        .map(([id, policy]) => ({ id, chars: JSON.stringify(policy.Properties.PolicyDocument).length }));
      expect(sizes.length).toBeGreaterThan(0);
      expect(sizes.filter((s) => s.chars >= MANAGED_POLICY_LIMIT * WARN_FRACTION)).toStrictEqual([]);
    },
  );
});
