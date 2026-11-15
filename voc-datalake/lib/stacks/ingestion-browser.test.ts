/**
 * The Web Reviews ingestor's browser (lib/stacks/ingestion-browser.ts): the deployment's own Web Bot Auth browser
 * and its browser profile, made only with a browser plugin; `-c webReviewsBotAuth=false` keeps the AWS-managed
 * aws.browser.v1 and `-c webReviewsBrowserProfile=false` the profile-less sessions; under a deployment prefix both
 * names carry it. The role grants on them are in ingestion-browser-iam.test.ts.
 */
import type { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { IamPolicySchema } from '../test-support/iam-statements';
import { SYNTH_ACCOUNT, SYNTH_REGION } from '../test-support/synth-app';
import { valueAt } from '../test-support/guards';
import { BROWSER_IDENTIFIER_ENV, BROWSER_PROFILE_IDENTIFIER_ENV } from './ingestion-browser';

const BROWSER = 'AWS::BedrockAgentCore::BrowserCustom';
const PROFILE = 'AWS::BedrockAgentCore::BrowserProfile';
const RoleSchema = z.object({
  Properties: z.object({
    AssumeRolePolicyDocument: z.object({ Statement: z.array(z.unknown()) }),
    Policies: z.unknown().optional(),
    ManagedPolicyArns: z.unknown().optional(),
  }),
});
const FunctionSchema = z.object({
  Properties: z.object({ FunctionName: z.unknown(), Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }) }),
});
const BrowserSchema = z.object({ Properties: z.record(z.string(), z.unknown()) });

const ofType = (template: Template, type: string): Record<string, unknown> => template.findResources(type);
const only = (resources: Record<string, unknown>): [string, unknown] => {
  const entries = Object.entries(resources);
  expect(entries).toHaveLength(1);
  return entries[0] ?? ['', undefined];
};

/** The web_reviews ingestor's environment. */
function webReviewsEnv(template: Template): Record<string, unknown> {
  const fns = Object.entries(ofType(template, 'AWS::Lambda::Function'))
    .filter(([id]) => id.startsWith('IngestorWebReviews'));
  const [, fn] = only(Object.fromEntries(fns));
  return FunctionSchema.parse(fn).Properties.Environment.Variables;
}

describe('the Web Reviews browser, by default (Web Bot Auth and a profile)', () => {
  let template: Template;
  beforeAll(() => { template = synthIngestionTemplate(['web_reviews']); });

  it('is one custom browser that signs its requests, on the public network', () => {
    const [, browser] = only(ofType(template, BROWSER));
    expect(BrowserSchema.parse(browser).Properties).toStrictEqual({
      Name: 'voc_web_reviews',
      Description: 'Web Reviews: signs every request (Web Bot Auth)',
      NetworkConfiguration: { NetworkMode: 'PUBLIC' },
      BrowserSigning: { Enabled: true },
      ExecutionRoleArn: { 'Fn::GetAtt': [expect.stringMatching(/^WebReviewsBrowserRole/), 'Arn'] },
    });
  });

  it('runs as a role AgentCore alone may assume, for this account\'s resources in the region, with no permission', () => {
    const roles = Object.entries(ofType(template, 'AWS::IAM::Role')).filter(([id]) => id.startsWith('WebReviewsBrowserRole'));
    const [roleId, role] = only(Object.fromEntries(roles));
    const { Properties: properties } = RoleSchema.parse(role);
    expect(properties.AssumeRolePolicyDocument.Statement).toStrictEqual([{
      Effect: 'Allow',
      Principal: { Service: 'bedrock-agentcore.amazonaws.com' },
      Action: 'sts:AssumeRole',
      Condition: {
        StringEquals: { 'aws:SourceAccount': SYNTH_ACCOUNT },
        ArnLike: { 'aws:SourceArn': `arn:aws:bedrock-agentcore:${SYNTH_REGION}:${SYNTH_ACCOUNT}:*` },
      },
    }]);
    expect([properties.Policies, properties.ManagedPolicyArns]).toStrictEqual([undefined, undefined]);
    const attached = Object.values(ofType(template, 'AWS::IAM::Policy'))
      .filter((policy) => JSON.stringify(IamPolicySchema.parse(policy).Properties.Roles ?? []).includes(roleId));
    expect(attached).toStrictEqual([]);
  });

  it('keeps one browser profile of the same name', () => {
    const [, profile] = only(ofType(template, PROFILE));
    expect(BrowserSchema.parse(profile).Properties).toStrictEqual({
      Name: 'voc_web_reviews',
      Description: 'Web Reviews: the review sites\' cookies and local storage, kept between runs',
    });
  });

  it('tells the ingestor the browser and the profile it was made with', () => {
    const env = webReviewsEnv(template);
    expect(valueAt(env, BROWSER_IDENTIFIER_ENV)).toStrictEqual({
      'Fn::GetAtt': ['WebReviewsBrowser', 'BrowserId'],
    });
    expect(valueAt(env, BROWSER_PROFILE_IDENTIFIER_ENV)).toStrictEqual({
      'Fn::GetAtt': ['WebReviewsBrowserProfile', 'ProfileId'],
    });
  });
});

describe('the Web Reviews browser, opted out and absent', () => {
  it('is the AWS-managed aws.browser.v1 with -c webReviewsBotAuth=false: no custom browser, no role, no identifier', () => {
    const template = synthIngestionTemplate(['web_reviews'], { webReviewsBotAuth: 'false' });
    expect(Object.keys(ofType(template, BROWSER))).toStrictEqual([]);
    expect(Object.keys(ofType(template, 'AWS::IAM::Role')).filter((id) => id.startsWith('WebReviewsBrowserRole')))
      .toStrictEqual([]);
    const env = webReviewsEnv(template);
    expect(env).not.toHaveProperty(BROWSER_IDENTIFIER_ENV);
    expect(env).toHaveProperty(BROWSER_PROFILE_IDENTIFIER_ENV);
  });

  it('keeps no profile with -c webReviewsBrowserProfile=false', () => {
    const template = synthIngestionTemplate(['web_reviews'], { webReviewsBrowserProfile: false });
    expect(Object.keys(ofType(template, PROFILE))).toStrictEqual([]);
    expect(webReviewsEnv(template)).not.toHaveProperty(BROWSER_PROFILE_IDENTIFIER_ENV);
    expect(Object.keys(ofType(template, BROWSER))).toHaveLength(1);
  });

  it('is not made without a browser plugin', () => {
    const template = synthIngestionTemplate(['webscraper', 'app_reviews_ios']);
    expect([Object.keys(ofType(template, BROWSER)), Object.keys(ofType(template, PROFILE))]).toStrictEqual([[], []]);
  });

  it.each(['flase', 'yes', 1])('fails the synth on -c webReviewsBotAuth=%s, whatever the plugins', (value) => {
    expect(() => synthIngestionTemplate([], { webReviewsBotAuth: value }))
      .toThrow(/Unrecognized webReviewsBotAuth context value.*-c webReviewsBotAuth=true\|false/);
  });

  it('fails the synth on an unparsable -c webReviewsBrowserProfile', () => {
    expect(() => synthIngestionTemplate([], { webReviewsBrowserProfile: 'off' }))
      .toThrow(/Unrecognized webReviewsBrowserProfile context value/);
  });
});

describe('the Web Reviews browser of a prefixed deployment', () => {
  it('carries the prefix, hyphens as underscores (an AgentCore name has no "-")', () => {
    const template = synthIngestionTemplate(['web_reviews'], {}, 'team-a');
    const names = [BROWSER, PROFILE].map((type) => BrowserSchema.parse(only(ofType(template, type))[1]).Properties.Name);
    expect(names).toStrictEqual(['team_a_voc_web_reviews', 'team_a_voc_web_reviews']);
  });
});
