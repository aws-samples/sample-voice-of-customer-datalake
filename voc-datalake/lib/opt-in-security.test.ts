/**
 * The paid security opt-ins (TENETS.md tenet 7: off by default, chosen per deployment):
 *
 * - AWS WAF (lib/utils/waf.ts, `-c enableWaf=true`): a CLOUDFRONT-scope web ACL in VocWebSearchStack (us-east-1)
 *   on the SPA distribution (cdk-nag CFR2), and a REGIONAL one on the API stage (APIG3);
 * - the Cognito Plus plan (lib/utils/cognito-plus.ts, `-c cognitoPlus=true`): threat protection in audit mode on
 *   both user pools (COG8);
 * - `-c performanceTier=true` turns on both.
 *
 * Every synth here runs cdk-nag (an unacknowledged finding fails it), so a synth that succeeds with the rule's
 * acknowledgement withdrawn proves the rule passes. The fixed-cost side (exactly which billed resources each flag
 * adds) is lib/fixed-cost-guard.test.ts.
 */
import { Match, Template } from 'aws-cdk-lib/assertions';
import { afterAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { cleanupAssemblyDirs, synthApp, SYNTH_TIMEOUT_MS, type SynthResult } from './test-support/synth-app';
import { API_COUNTED_CRS_RULES, WAF_RATE_LIMIT_PER_5_MIN } from './utils/waf';

const SHAPES = {
  default: synthApp(),
  performanceTier: synthApp({ performanceTier: 'true' }),
  cognitoPlus: synthApp({ cognitoPlus: 'true' }),
  tierWithoutPlus: synthApp({ performanceTier: 'true', cognitoPlus: 'false' }),
  tierWithoutWaf: synthApp({ performanceTier: 'true', enableWaf: 'false' }),
  wafOutsideUsEast1: synthApp({ enableWaf: 'true' }, 'eu-west-1'),
} as const;
afterAll(cleanupAssemblyDirs);

const templateOf = (result: SynthResult, stack: string) => Template.fromJSON(result.template(stack));
const core = (result: SynthResult) => templateOf(result, 'VocCoreStack');

const MANAGED_GROUPS = ['AWSManagedRulesAmazonIpReputationList', 'AWSManagedRulesKnownBadInputsRuleSet', 'AWSManagedRulesCommonRuleSet'];

const WebAclRulesSchema = z.array(z.object({
  Name: z.string(),
  Priority: z.number(),
  Statement: z.object({
    RateBasedStatement: z.object({ Limit: z.number(), AggregateKeyType: z.string(), EvaluationWindowSec: z.number() }).optional(),
    ManagedRuleGroupStatement: z.object({
      RuleActionOverrides: z.array(z.object({ Name: z.string(), ActionToUse: z.unknown() })).optional(),
    }).optional(),
  }),
}));

/** The rules of the one web ACL in `stack`. */
function webAclRules(result: SynthResult, stack: string): z.infer<typeof WebAclRulesSchema> {
  const acls = Object.values(templateOf(result, stack).findResources('AWS::WAFv2::WebACL'));
  expect(acls).toHaveLength(1);
  return WebAclRulesSchema.parse(acls[0]?.Properties?.Rules);
}

/** The stacks of a synth that hold any web ACL. */
const stacksWithWebAcl = (result: SynthResult): string[] => result.stackNames
  .filter((stack) => Object.keys(templateOf(result, stack).findResources('AWS::WAFv2::WebACL')).length > 0);

/** Each pool's [UserPoolTier, threat-protection mode] by pool name prefix. */
function poolPlans(result: SynthResult): Record<string, [unknown, unknown]> {
  const pools = core(result).findResources('AWS::Cognito::UserPool');
  return Object.fromEntries(Object.entries(pools).map(([id, pool]) => [
    id.replace(/[0-9A-F]{8}$/, ''),
    [pool.Properties?.UserPoolTier, pool.Properties?.UserPoolAddOns?.AdvancedSecurityMode],
  ]));
}

describe('the default synth', () => {
  it('has no web ACL anywhere and no WebACLId on the SPA distribution', () => {
    expect(stacksWithWebAcl(SHAPES.default)).toStrictEqual([]);
    const [distribution] = Object.values(core(SHAPES.default).findResources('AWS::CloudFront::Distribution'));
    expect(distribution?.Properties?.DistributionConfig?.WebACLId).toBeUndefined();
  });

  it('keeps both user pools on Essentials, threat protection off', () => {
    expect(poolPlans(SHAPES.default)).toStrictEqual({
      VocUserPool: ['ESSENTIALS', undefined], VocBoardUserPool: ['ESSENTIALS', undefined],
    });
  });
});

describe('-c performanceTier=true', () => {
  const tier = SHAPES.performanceTier;

  it('puts both user pools on Plus with threat protection in audit mode (it never blocks a sign-in)', () => {
    expect(poolPlans(tier)).toStrictEqual({ VocUserPool: ['PLUS', 'AUDIT'], VocBoardUserPool: ['PLUS', 'AUDIT'] });
  });

  it('creates the CLOUDFRONT-scope web ACL in VocWebSearchStack, and the SPA distribution uses it', () => {
    expect(stacksWithWebAcl(tier)).toStrictEqual(['VocApiStack', 'VocWebSearchStack']);
    const cloudFrontAcls = templateOf(tier, 'VocWebSearchStack').findResources('AWS::WAFv2::WebACL', {
      Properties: { Scope: 'CLOUDFRONT', DefaultAction: { Allow: {} } },
    });
    expect(Object.keys(cloudFrontAcls)).toStrictEqual(['FrontendWebAcl']);
    // Same region: a plain CloudFormation export, read by Core with Fn::ImportValue.
    const distributions = core(tier).findResources('AWS::CloudFront::Distribution', {
      Properties: { DistributionConfig: Match.objectLike({ WebACLId: { 'Fn::ImportValue': Match.stringLikeRegexp('FrontendWebAcl') } }) },
    });
    expect(Object.keys(distributions)).toHaveLength(1);
  });

  it('associates a REGIONAL web ACL with the API v1 stage', () => {
    const api = templateOf(tier, 'VocApiStack');
    expect(Object.keys(api.findResources('AWS::WAFv2::WebACL', { Properties: { Scope: 'REGIONAL' } }))).toStrictEqual(['ApiWebAcl']);
    const associations = api.findResources('AWS::WAFv2::WebACLAssociation', {
      Properties: {
        ResourceArn: { 'Fn::Join': ['', Match.arrayWith([Match.stringLikeRegexp('/stages/$'), { Ref: Match.stringLikeRegexp('^VocAnalyticsApiDeploymentStagev1') }])] },
        WebACLArn: { 'Fn::GetAtt': ['ApiWebAcl', 'Arn'] },
      },
    });
    expect(Object.keys(associations)).toStrictEqual(['ApiWebAclAssociation']);
  });

  it.each([
    ['VocWebSearchStack', WAF_RATE_LIMIT_PER_5_MIN.cloudFront, []],
    ['VocApiStack', WAF_RATE_LIMIT_PER_5_MIN.api, [...API_COUNTED_CRS_RULES]],
  ] as const)('%s web ACL: IP reputation, a per-IP rate limit, Known bad inputs and the CRS', (stack, limit, counted) => {
    const rules = webAclRules(tier, stack);
    expect(rules.map((rule) => [rule.Priority, rule.Name])).toStrictEqual([
      [0, MANAGED_GROUPS[0]], [1, 'RateLimitPerIp'], [2, MANAGED_GROUPS[1]], [3, MANAGED_GROUPS[2]],
    ]);
    expect(rules[1]?.Statement.RateBasedStatement).toMatchObject({ Limit: limit, AggregateKeyType: 'IP', EvaluationWindowSec: 300 });
    const crs = rules[3]?.Statement.ManagedRuleGroupStatement;
    expect((crs?.RuleActionOverrides ?? []).map((override) => [override.Name, override.ActionToUse]))
      .toStrictEqual(counted.map((name) => [name, { Count: {} }]));
  });
});

describe('-c performanceTier=true -c cognitoPlus=false', () => {
  it('leaves the pools on Essentials while the tier still adds the web ACLs (an own flag set to false wins)', () => {
    expect(poolPlans(SHAPES.tierWithoutPlus)).toStrictEqual({
      VocUserPool: ['ESSENTIALS', undefined], VocBoardUserPool: ['ESSENTIALS', undefined],
    });
    expect(stacksWithWebAcl(SHAPES.tierWithoutPlus)).toStrictEqual(['VocApiStack', 'VocWebSearchStack']);
  });
});

describe('-c performanceTier=true -c enableWaf=false', () => {
  it('adds no web ACL while the tier still moves the pools to Plus', () => {
    expect(stacksWithWebAcl(SHAPES.tierWithoutWaf)).toStrictEqual([]);
    expect(poolPlans(SHAPES.tierWithoutWaf)).toStrictEqual({ VocUserPool: ['PLUS', 'AUDIT'], VocBoardUserPool: ['PLUS', 'AUDIT'] });
  });
});

describe('-c cognitoPlus=true alone', () => {
  it('moves both pools to Plus and adds no web ACL', () => {
    expect(poolPlans(SHAPES.cognitoPlus)).toStrictEqual({ VocUserPool: ['PLUS', 'AUDIT'], VocBoardUserPool: ['PLUS', 'AUDIT'] });
    expect(stacksWithWebAcl(SHAPES.cognitoPlus)).toStrictEqual([]);
  });
});

describe('-c enableWaf=true with the app outside us-east-1', () => {
  const eu = SHAPES.wafOutsideUsEast1;

  it('keeps the CLOUDFRONT web ACL in us-east-1 and reads its ARN into Core through the cross-region reader', () => {
    expect(eu.stackNames).toContain('VocWebSearchStack');
    expect(stacksWithWebAcl(eu)).toStrictEqual(['VocApiStack', 'VocWebSearchStack']);
    expect(Object.keys(core(eu).findResources('Custom::CrossRegionExportReader'))).toHaveLength(1);
    const [distribution] = Object.values(core(eu).findResources('AWS::CloudFront::Distribution'));
    expect(JSON.stringify(distribution?.Properties?.DistributionConfig?.WebACLId)).toMatch(/ExportsReader/);
  });

  it('leaves the Cognito pools on Essentials (enableWaf is not cognitoPlus)', () => {
    expect(poolPlans(eu)).toStrictEqual({ VocUserPool: ['ESSENTIALS', undefined], VocBoardUserPool: ['ESSENTIALS', undefined] });
  });
});

describe('flag parsing', () => {
  it.each(['enableWaf', 'cognitoPlus'])('refuses a typo in -c %s, even with the performance tier on', (key) => {
    expect(() => synthApp({ [key]: 'ture', performanceTier: 'true' })).toThrow(new RegExp(`Unrecognized ${key} context value`));
  }, SYNTH_TIMEOUT_MS);
});
