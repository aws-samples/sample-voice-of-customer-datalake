/**
 * The engineering agents' connector broker (engineering-broker.ts, docs/autonomous-engineering.md): absent by
 * default; with -c engineeringAgents=true, one Python function behind an IAM-authenticated function URL, no
 * resource-based permission, and a role that can write its own logs, read the connections' SSM parameters and
 * decrypt them through SSM, and nothing else.
 */
import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';

import { engineeringParameterPrefix } from './engineering-broker';
import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import {
  AGENT_ROLE_NAME_PATTERN_JOIN, functionRoleId, functionStatements, functionUrlAuthTypes, processingSynths,
} from '../test-support/engineering-template';
import { byCodeUnit } from '../utils/compare';

const template = processingSynths({ off: {}, on: { engineeringAgents: true }, onString: { engineeringAgents: 'true' } });

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
          AGENT_ROLE_NAME_PATTERN: AGENT_ROLE_NAME_PATTERN_JOIN,
        },
      },
    });
    // Its one URL (the board API has its own: engineering-bus.test.ts).
    expect(functionUrlAuthTypes(on, id)).toStrictEqual(['AWS_IAM']);
  });

  it('grants nobody a way in: no resource-based permission on the broker', () => {
    const on = template('on');
    const id = brokerId(on);
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties).includes(id));
    expect(permissions).toStrictEqual([]);
  });

  it('holds its log writes, the connections\' parameters, the run records\' reads and their key, and nothing else', () => {
    const on = template('on');
    const statements = brokerStatements(on);
    const actions = statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit);
    // Reads only: no PutItem, UpdateItem, DeleteItem, PutObject or GenerateDataKey anywhere on its role.
    expect(actions).toStrictEqual([
      'dynamodb:GetItem', 'dynamodb:GetItem', 'dynamodb:Query', 'kms:Decrypt', 'kms:Decrypt', 'logs:CreateLogStream',
      'logs:PutLogEvents', 's3:GetObject', 'ssm:GetParameter',
    ]);
    const parameters = {
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-east-1:111111111111:parameter/voc/engineering/*']],
    };
    expect(statements.find((statement) => statement.Action === 'ssm:GetParameter'))
      .toMatchObject({ Effect: 'Allow', Resource: parameters });
    const decrypt = statements.find((statement) => statement.Sid === 'EngineeringConnectionCredentialsKey');
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

  it('reads the runs\' rows of voc-engineering only in the runs\' partitions', () => {
    const records = brokerStatements(template('on')).find((statement) => statement.Sid === 'EngineeringRunRecords');
    expect(records).toMatchObject({
      Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:Query'],
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#RUN#*'] } },
    });
    // One table: voc-engineering's ARN (an import from VocCoreStack), never an index or "*".
    expect(JSON.stringify(records?.Resource)).toMatch(/^\{"Fn::ImportValue":"[^"]*GetAttEngineering[^"]*Arn[^"]*"\}$/);
    expect(JSON.stringify(records?.Resource)).not.toContain('index');
  });

  it('reads a person\'s way of working from the aggregates table\'s flag partitions only', () => {
    const modes = brokerStatements(template('on')).find((statement) => statement.Sid === 'WaysOfWorking');
    // Of that row, only its mode (and its key), by a projection: never the whole item or another attribute.
    expect(modes).toMatchObject({
      Effect: 'Allow', Action: 'dynamodb:GetItem',
      Condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['USERFLAGS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'mode'] },
        StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      },
    });
    expect(JSON.stringify(modes?.Resource)).toContain('Aggregates');
  });

  it('reads only the agents\' patches and the gate records of the workspace', () => {
    const objects = brokerStatements(template('on'))
      .find((statement) => statement.Sid === 'SubmittedPatchesAndGateRecords');
    expect(objects?.Action).toBe('s3:GetObject');
    const keys = [objects?.Resource].flat().map((resource) => JSON.stringify(resource).replace(/^.*"(\/ws[^"]*)".*$/, '$1'));
    expect(keys).toStrictEqual([
      '/ws/default/runs/*/commits/*/_patches/*', '/ws/default/runs/*/final-go-*/commits/*/_gate/*',
      '/ws/default/runs/*/gate-runner-*/commits/*/_gate/*']);
  });

  it('decrypts what it reads through DynamoDB and S3 only', () => {
    const statements = brokerStatements(template('on'));
    expect(statements.find((statement) => statement.Sid === 'EngineeringRunRecordsKey')).toMatchObject({
      Action: 'kms:Decrypt',
      Condition: { StringEquals: { 'kms:ViaService': ['dynamodb.us-east-1.amazonaws.com', 's3.us-east-1.amazonaws.com'] } },
    });
  });

  it('names the stores it reads', () => {
    const on = template('on');
    const variables = on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties?.Environment?.Variables;
    expect(['ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET', 'AGGREGATES_TABLE']
      .filter((name) => !(name in (variables ?? {})))).toStrictEqual([]);
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
  return functionRoleId(synthesized, brokerId(synthesized));
}

/** Every statement of the policies attached to the broker's role. */
function brokerStatements(synthesized: Template): ReturnType<typeof functionStatements> {
  return functionStatements(synthesized, brokerId(synthesized));
}
