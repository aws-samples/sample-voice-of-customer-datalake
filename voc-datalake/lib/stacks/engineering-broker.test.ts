/**
 * The engineering agents' connector broker (engineering-broker.ts, docs/autonomous-engineering.md): absent by
 * default; with -c engineeringAgents=true, one Python function behind an IAM-authenticated function URL, no
 * resource-based permission, and a role that can write its own logs, read the connections' SSM parameters and
 * decrypt them through SSM, and nothing else.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { engineeringParameterPrefix } from './engineering-broker';
import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

const StatementSchema = z.looseObject({
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()),
    PolicyDocument: z.object({ Statement: z.array(StatementSchema) }),
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

  it('holds its log writes, the connections\' parameters and their key through SSM, and nothing else', () => {
    const on = template('on');
    const statements = brokerStatements(on);
    const actions = statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit);
    expect(actions).toStrictEqual(['kms:Decrypt', 'logs:CreateLogStream', 'logs:PutLogEvents', 'ssm:GetParameter']);
    const parameters = {
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-east-1:111111111111:parameter/voc/engineering/*']],
    };
    expect(statements.find((statement) => statement.Action === 'ssm:GetParameter'))
      .toMatchObject({ Effect: 'Allow', Resource: parameters });
    const decrypt = statements.find((statement) => statement.Action === 'kms:Decrypt');
    // Through SSM only, and only for the connections' parameters (SSM's encryption context names the parameter).
    expect(decrypt).toMatchObject({
      Effect: 'Allow',
      Condition: {
        StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': parameters },
      },
    });
    // The stack's one customer-managed key (an import from the test's dependency stack), never "*".
    expect(JSON.stringify(decrypt?.Resource)).toContain('Fn::ImportValue');
  });

  it('has no managed policy on its role', () => {
    const on = template('on');
    expect(on.findResources('AWS::IAM::Role')[brokerRoleId(on)]?.Properties?.ManagedPolicyArns).toBeUndefined();
  });

  it('names the parameters\' prefix and carries the signing layer for the App JWT', () => {
    const on = template('on');
    const properties = on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties;
    expect(properties?.Environment?.Variables?.ENGINEERING_PARAMETER_PREFIX).toBe('/voc/engineering/');
    const layers = JSON.stringify(properties?.Layers);
    expect(layers).toContain('EngineeringBrokerSigningDepsLayer');
  });

  it('puts a deployment prefix on the voc segment of the parameters\' path', () => {
    expect(engineeringParameterPrefix(undefined)).toBe('/voc/engineering/');
    expect(engineeringParameterPrefix('qa')).toBe('/qa-voc/engineering/');
  });
});

/** The logical id of the broker's role. */
function brokerRoleId(synthesized: Template): string {
  const role = JSON.stringify(synthesized.findResources('AWS::Lambda::Function')[brokerId(synthesized)]?.Properties?.Role);
  const roleId = /"Fn::GetAtt":\["([^"]+)","Arn"\]/.exec(role)?.[1];
  expect(roleId).toBeDefined();
  return roleId ?? '';
}

/** Every statement of the policies attached to the broker's role. */
function brokerStatements(synthesized: Template): z.infer<typeof StatementSchema>[] {
  const roleId = brokerRoleId(synthesized);
  return Object.values(synthesized.findResources('AWS::IAM::Policy'))
    .map((policy) => PolicySchema.parse(policy).Properties)
    .filter((policy) => JSON.stringify(policy.Roles).includes(`"${roleId}"`))
    .flatMap((policy) => policy.PolicyDocument.Statement);
}
