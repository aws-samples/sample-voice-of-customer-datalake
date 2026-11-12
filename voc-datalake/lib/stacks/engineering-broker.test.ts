/**
 * The engineering agents' connector broker (engineering-broker.ts, docs/autonomous-engineering.md): absent by
 * default; with -c engineeringAgents=true, one Python function behind an IAM-authenticated function URL, no
 * resource-based permission, and a role that can write its own logs and nothing else.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()),
    PolicyDocument: z.object({ Statement: z.array(z.object({ Action: z.union([z.string(), z.array(z.string())]) })) }),
  }),
});

const holder: { off?: Template; on?: Template; onString?: Template } = {};

beforeAll(() => {
  holder.off = synthProcessingTemplate();
  holder.on = synthProcessingTemplate({ context: { engineeringAgents: true } });
  holder.onString = synthProcessingTemplate({ context: { engineeringAgents: 'true' } });
}, SYNTH_TIMEOUT_MS);

function template(key: keyof typeof holder): Template {
  const synthesized = holder[key];
  if (!synthesized) throw new Error(`${key} was not synthesized`);
  return synthesized;
}

/** The logical ids of the broker's function (its physical name starts `voc-engineering-broker`). */
function brokerIds(synthesized: Template): string[] {
  return Object.entries(synthesized.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => JSON.stringify(resource.Properties?.FunctionName ?? '').includes('voc-engineering-broker'))
    .map(([id]) => id);
}

/** The broker's one logical id in a synth that has it. */
function brokerId(synthesized: Template): string {
  const ids = brokerIds(synthesized);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

describe('the engineering broker', () => {
  it.each([['off'], ['onString']] as const)('is absent by default and present for the string "true" (%s)', (key) => {
    expect(brokerIds(template(key))).toHaveLength(key === 'off' ? 0 : 1);
  });

  it('adds no function URL to the default synth', () => {
    expect(Object.keys(template('off').findResources('AWS::Lambda::Url'))).toStrictEqual([]);
  });

  it('is one arm64 Python function behind a function URL with IAM authentication', () => {
    const on = template('on');
    const id = brokerId(on);
    expect(on.findResources('AWS::Lambda::Function')[id]?.Properties).toMatchObject({
      Handler: 'engineering/connectors/handler.lambda_handler',
      Runtime: 'python3.14',
      Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES['voc-engineering-broker'],
      Environment: {
        Variables: {
          AGENT_ROLE_NAME_PATTERN: {
            'Fn::Join': ['', ['voc-eng-{role}-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]],
          },
        },
      },
    });
    const urls = Object.values(on.findResources('AWS::Lambda::Url'));
    expect(urls.map((url) => [url.Properties?.AuthType, url.Properties?.TargetFunctionArn])).toStrictEqual([
      ['AWS_IAM', { 'Fn::GetAtt': [id, 'Arn'] }],
    ]);
  });

  it('grants nobody a way in: no resource-based permission on the broker', () => {
    const on = template('on');
    const id = brokerId(on);
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties).includes(id));
    expect(permissions).toStrictEqual([]);
  });

  it('holds no grant beyond writing its own log group', () => {
    const on = template('on');
    const id = brokerId(on);
    const role = JSON.stringify(on.findResources('AWS::Lambda::Function')[id]?.Properties?.Role);
    const roleId = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(role)?.[1];
    expect(roleId).toBeDefined();
    const actions = Object.values(on.findResources('AWS::IAM::Policy'))
      .map((policy) => PolicySchema.parse(policy).Properties)
      .filter((policy) => JSON.stringify(policy.Roles).includes(`"${roleId ?? ''}"`))
      .flatMap((policy) => policy.PolicyDocument.Statement)
      .flatMap((statement) => [statement.Action].flat())
      .sort(byCodeUnit);
    expect(actions).toStrictEqual(['logs:CreateLogStream', 'logs:PutLogEvents']);
    expect(on.findResources('AWS::IAM::Role')[roleId ?? '']?.Properties?.ManagedPolicyArns).toBeUndefined();
  });
});
