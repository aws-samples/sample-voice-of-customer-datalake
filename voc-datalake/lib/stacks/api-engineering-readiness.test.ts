/**
 * The Agents API's readiness grants (api-engineering-readiness.ts; lambda/engineering/readiness_aws.py): nothing by
 * default; with -c engineeringAgents=true exactly the checks' reads (the models' access, AgentCore's one sessions
 * quota, the Issues source's repository watermarks) and the probe's one create-only put, and nothing that writes a
 * run's object, deletes, merges or changes a branch rule.
 */
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import type { Template } from 'aws-cdk-lib/assertions';
import { Template as TemplateOf } from 'aws-cdk-lib/assertions';

import { apiTemplate, buildApiStack, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { AGENTCORE_SESSIONS_QUOTA, ISSUES_WATERMARK_KEYS } from './api-engineering-readiness';
import { ENGINEERING_WORKSPACE_READINESS_KEYS } from './core-buckets';

let cached: Template | undefined;
const on = (): Template => {
  cached ??= TemplateOf.fromStack(buildApiStack({ engineeringAgents: true }));
  return cached;
};
const statements = (template: Template) => policyStatementsOf(template, 'AgentsLambdaRole');

describe('the readiness checks\' grants on the agents API', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('are off by default: no model availability, quota, watermark or probe grant', () => {
    const text = JSON.stringify(statements(apiTemplate()));
    expect(text).not.toMatch(/GetFoundationModelAvailability|servicequotas|voc-watermarks|_readiness/);
  });

  it('read each model\'s access, account-level, and nothing else of Bedrock\'s control plane', () => {
    const bedrock = statements(on()).filter((statement) => statement.actions.some((action) => action.startsWith('bedrock:')
      && !action.startsWith('bedrock:Invoke')));
    expect(bedrock.map((statement) => [statement.actions, statement.resource]))
      .toStrictEqual([[['bedrock:GetFoundationModelAvailability'], '"*"']]);
  });

  it('read AgentCore\'s one active sessions quota, by its ARN', () => {
    const quotas = statements(on()).filter((statement) => statement.actions.some((action) => action.startsWith('servicequotas:')));
    expect(quotas.map((statement) => statement.actions)).toStrictEqual([['servicequotas:GetServiceQuota']]);
    expect(quotas[0]?.resource).toContain(`:${AGENTCORE_SESSIONS_QUOTA}`);
    expect(quotas[0]?.resource).not.toMatch(/\*/);
  });

  it('read the Issues source\'s repository watermarks only, keyed by dynamodb:LeadingKeys', () => {
    const watermarks = statements(on()).filter((statement) => /voc-watermarks/.test(statement.resource));
    expect(watermarks.map((statement) => statement.actions)).toStrictEqual([['dynamodb:GetItem']]);
    expect(watermarks[0]?.condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [ISSUES_WATERMARK_KEYS] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    });
    expect(JSON.stringify(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_WATERMARKS_TABLE)).toMatch(/voc-watermarks/);
  });

  it('put the probe\'s one object and nothing else of the workspace bucket, never a read or a delete', () => {
    const all = statements(on());
    const puts = all.filter((statement) => statement.actions.includes('s3:PutObject'));
    expect(puts.map((statement) => statement.resource)).toStrictEqual(
      [expect.stringContaining(`/${ENGINEERING_WORKSPACE_READINESS_KEYS}"`)]);
    expect(ENGINEERING_WORKSPACE_READINESS_KEYS).toBe('ws/default/_readiness/*');
    // The runs' objects stay unwritable to this role, and nothing is deleted; it reads only the run workspace's
    // (7.51.00, api-engineering-reads.test.ts pins them), and only the probe's key is written.
    const s3 = all.filter((statement) => statement.actions.some((action) => action.startsWith('s3:')));
    expect(JSON.stringify(s3)).not.toMatch(/DeleteObject|PutObjectAcl|PutBucket/);
    expect(JSON.stringify(s3.filter((statement) => !statement.actions.every((action) => ['s3:GetObject',
      's3:ListBucket'].includes(action))))).not.toMatch(/\/runs\//);
  });

  it('give no role here a merge, a ruleset or branch protection write, nor any write of a repository host', () => {
    const text = JSON.stringify(statements(on()));
    expect(text).not.toMatch(/merge|ruleset|protection|codecommit|PutRule|ServiceQuotaIncrease|RequestServiceQuota/i);
  });

  it('name the deployment\'s images, network, build size and sessions to the checks', () => {
    const env = serviceEnvironment(on(), 'voc-agents-api');
    expect([env.ENGINEERING_IMAGE_LANGUAGES, env.ENGINEERING_AGENT_NETWORK, env.ENGINEERING_BUILD_MEMORY_MIB,
      env.ENGINEERING_MAX_SESSIONS]).toStrictEqual(['', 'none', '0', '5000']);
    const named = buildApiStack({
      engineeringAgents: true,
      engineeringImages: `{"python":"sha256:${'a'.repeat(64)}"}`,
      engineeringAgentNetwork: '{"vpcId":"vpc-0123456789abcdef0","subnetIds":["subnet-0123456789abcdef0"]}',
      engineeringBuildMemoryMiB: 8192,
      engineeringMaxSessions: 200,
    });
    const namedEnv = serviceEnvironment(TemplateOf.fromStack(named), 'voc-agents-api');
    expect([namedEnv.ENGINEERING_IMAGE_LANGUAGES, namedEnv.ENGINEERING_AGENT_NETWORK, namedEnv.ENGINEERING_BUILD_MEMORY_MIB,
      namedEnv.ENGINEERING_MAX_SESSIONS]).toStrictEqual(['python', 'vpc', '8192', '200']);
    expect(cdk.Stack.of(named).region).toBe('us-east-1');
  });

  it('name the models\' prices, which a model choice is checked against, with no Bedrock grant for them (7.58.00)', () => {
    expect(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_MODEL_PRICES).toBe('{}');
    const prices = '{"global.anthropic.claude-opus-5":{"input":"1","output":"2"}}';
    const priced = TemplateOf.fromStack(buildApiStack({ engineeringAgents: true, engineeringModelPrices: prices }));
    expect(JSON.parse(String(serviceEnvironment(priced, 'voc-agents-api').ENGINEERING_MODEL_PRICES))).toStrictEqual(
      JSON.parse(prices));
    // (pricing a model grants nothing: the role's statements are the same with or without the price)
    expect(statements(priced)).toStrictEqual(statements(on()));
  });
});
