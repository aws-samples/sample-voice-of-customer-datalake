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
  AGENT_ROLE_NAME_PATTERN_JOIN, functionRoleId, functionStatements, functionUrlAuthTypes, permissionsNaming,
  processingSynths,
} from '../test-support/engineering-template';
import { byCodeUnit } from '../utils/compare';
import { isAuditRowGuardStatement } from '../test-support/iam-statements';

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

  it('admits the runtime by its execution role\'s name and its function\'s, for the reactions read (7.10.00)', () => {
    const on = template('on');
    const variables = JSON.stringify(on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties?.Environment);
    // The role is the runtime's own (a reference to it, never a pattern), and the session Lambda names after its
    // function (connectors/identity.py runtime_caller_from_event checks both).
    expect(variables).toMatch(/"ENGINEERING_RUNTIME_ROLE_NAME":\{"Ref":"EngineeringRuntimeEngineeringSupervisorRole\w+"\}/);
    expect(variables).toMatch(/"ENGINEERING_RUNTIME_FUNCTION_NAME":\{"Fn::Join":\["",\["voc-engineering-runtime-",/);
  });

  it('grants nobody a way in: no resource-based permission on the broker', () => {
    const on = template('on');
    expect(permissionsNaming(on, brokerId(on))).toStrictEqual([]);
  });

  it('holds its log writes, the connections\' parameters, the run records\' reads and their key, and nothing else', () => {
    const on = template('on');
    const statements = brokerStatements(on);
    const actions = statements.flatMap((statement) => [statement.Action].flat()).sort(byCodeUnit);
    // Reads, and the one write of its claim rows (PutItem, UpdateItem, their GenerateDataKey): no DeleteItem,
    // PutObject or other write anywhere on its role.
    // (7.10.00: one more Query, of the runs' writes' partitions, for the reactions read: RunPullRequestReads)
    // (7.52.00: one more GetItem and GetObject, the approved docs' rows and the knowledge packs' objects, read only)
    // (7.57.00's GitHub App user authorizations, a read and a put of the people's tokens, are gone with the app's own
    // open of the upstream pull request: 7.58.00)
    // (7.60.00: one more GetParameter and Decrypt, the fine-grained connections' write tokens: EngineeringWriteTokens)
    expect(actions).toStrictEqual([
      'dynamodb:GetItem', 'dynamodb:GetItem', 'dynamodb:GetItem', 'dynamodb:GetItem', 'dynamodb:PutItem',
      'dynamodb:Query', 'dynamodb:Query', 'dynamodb:Query', 'dynamodb:UpdateItem',
      'kms:Decrypt', 'kms:Decrypt', 'kms:Decrypt', 'kms:GenerateDataKey', 'logs:CreateLogStream', 'logs:PutLogEvents',
      's3:GetObject', 's3:GetObject', 'ssm:GetParameter', 'ssm:GetParameter',
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

  it('reads the fine-grained connections\' write tokens on their own path, decrypted through SSM for them alone (7.60.00)', () => {
    const statements = brokerStatements(template('on'));
    const tokens = {
      'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-east-1:111111111111:parameter/voc/engineering-token/*']],
    };
    expect(statements.find((statement) => statement.Sid === 'EngineeringWriteTokens'))
      .toMatchObject({ Effect: 'Allow', Action: 'ssm:GetParameter', Resource: tokens });
    expect(statements.find((statement) => statement.Sid === 'EngineeringWriteTokensKey')).toMatchObject({
      Effect: 'Allow', Action: 'kms:Decrypt',
      Condition: {
        StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
        StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': tokens },
      },
    });
    const on = template('on');
    expect(on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties?.Environment?.Variables
      ?.ENGINEERING_TOKEN_PARAMETER_PREFIX).toBe('/voc/engineering-token/');
  });

  it('holds no grant of 7.57.00\'s user authorizations, gone with the app\'s own upstream pull request (7.58.00)', () => {
    expect(JSON.stringify(brokerStatements(template('on')))).not.toMatch(/engineering-user-auth|cognito-idp:/);
  });

  it('reads the run\'s recorded pull request by one Query of the runs\' writes\' partitions alone (7.10.00)', () => {
    const reads = brokerStatements(template('on')).find((statement) => statement.Sid === 'RunPullRequestReads');
    expect(reads).toMatchObject({
      Effect: 'Allow', Action: 'dynamodb:Query',
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#WRITES#*'] } },
    });
    expect(JSON.stringify(reads?.Resource)).toMatch(/^\{"Fn::ImportValue":"[^"]*GetAttEngineering[^"]*Arn[^"]*"\}$/);
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

  it('writes only a write\'s claim row, in its own partition, of its own attributes, encrypted through DynamoDB', () => {
    const statements = brokerStatements(template('on'));
    const claims = statements.find((statement) => statement.Sid === 'WriteClaims');
    // In the runs' writes' partitions alone: never a run's own (its META, tasks, a person's go, its log).
    expect(claims).toMatchObject({
      Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
      Condition: {
        // (7.52.00: and the connections' docs writes' claims, once per kind and version, with the same attributes)
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#WRITES#*', 'WS#*#DOCS#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'state', 'op', 'at', 'result', 'closed_at'] },
        StringEqualsIfExists: { 'dynamodb:ReturnValues': 'NONE' },
      },
    });
    // voc-engineering alone (an import from VocCoreStack), never an index, another table or "*".
    expect(JSON.stringify(claims?.Resource)).toMatch(/^\{"Fn::ImportValue":"[^"]*GetAttEngineering[^"]*Arn[^"]*"\}$/);
    const key = statements.find((statement) => statement.Sid === 'WriteClaimsKey');
    expect(key).toMatchObject({
      Action: 'kms:GenerateDataKey',
      Condition: { StringEquals: { 'kms:ViaService': 'dynamodb.us-east-1.amazonaws.com' } },
    });
    // For voc-engineering's rows alone: the table's name in DynamoDB's encryption context.
    expect(JSON.stringify(key?.Condition)).toMatch(
      /"kms:EncryptionContext:aws:dynamodb:tableName":\{"Fn::ImportValue":"[^"]*RefEngineering[^"]*"\}/);
  });

  it('keeps the run\'s pull request under the claims\' grant: no other write on any table (7.09.00)', () => {
    // The pull request's row (records.py WriteClaims.record_pull_request) is in the writes' partition with a claim
    // row's attributes only, so the broker gains no write: WriteClaims stays its one DynamoDB write statement.
    const writes = /^dynamodb:(?:Put|Update|Delete|BatchWrite|TransactWrite|PartiQL)/;
    const writers = brokerStatements(template('on'))
      .filter((statement) => [statement.Action].flat().some((action) => writes.test(action)));
    expect(writers.map((statement) => statement.Sid)).toStrictEqual(['WriteClaims']);
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

  it('reads of voc-agents only the connections\' CI attestations, by a projected Query', () => {
    const attestations = brokerStatements(template('on')).find((statement) => statement.Sid === 'ConnectionAttestations');
    // In the attestations' partitions alone (never a connection's own row or its audit rows), of a row only what the
    // broker reads (attestations.py BROKER_ATTRIBUTES), and never a GetItem or a write.
    expect(attestations).toMatchObject({
      Effect: 'Allow', Action: 'dynamodb:Query',
      Condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['CONNECTIONS#*#CI#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'state', 'repository', 'version'] },
        StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      },
    });
    // One table: voc-agents' ARN (an import from VocCoreStack), never an index or "*".
    expect(JSON.stringify(attestations?.Resource)).toMatch(/^\{"Fn::ImportValue":"[^"]*Agents[^"]*Arn[^"]*"\}$/);
    expect(JSON.stringify(attestations?.Resource)).not.toContain('index');
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

  it('reads the approved docs (7.52.00): the repositories\' rows by GetItem and the knowledge packs\' objects, no write', () => {
    const statements = brokerStatements(template('on'));
    const rows = statements.find((statement) => statement.Sid === 'ApprovedDocsRecords');
    expect(rows).toMatchObject({
      Effect: 'Allow', Action: 'dynamodb:GetItem',
      Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#default#REPO#*'] } },
    });
    expect(JSON.stringify(rows?.Resource)).toMatch(/^\{"Fn::ImportValue":"[^"]*GetAttEngineering[^"]*Arn[^"]*"\}$/);
    const objects = statements.find((statement) => statement.Sid === 'ApprovedDocsObjects');
    expect(objects?.Action).toBe('s3:GetObject');
    expect(JSON.stringify(objects?.Resource)).toMatch(/"\/ws\/default\/knowledge\/\*"/);
  });

  it('writes no repository row and nothing to the bucket: the docs go to the host, through the claims (7.52.00)', () => {
    // Negative pins: no write on a repository's rows (an approval, an acceptance: the Agents API's alone) and none on the
    // bucket; the docs it writes go to the host, through the claims' one grant.
    const statements = brokerStatements(template('on'));
    const repositoryWriters = statements.filter((statement) => JSON.stringify(statement.Condition ?? {}).includes('REPO')
      && [statement.Action].flat().some((action) => !/^dynamodb:GetItem$/.test(String(action))));
    expect(repositoryWriters).toStrictEqual([]);
    expect(JSON.stringify(statements)).not.toMatch(/s3:PutObject|s3:DeleteObject/);
  });

  it('admits voc-engineering-start, never an agent role, as the docs write\'s caller (7.52.00)', () => {
    const on = template('on');
    const variables = on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties?.Environment?.Variables ?? {};
    // The start's own role, by its reference: never the agents' role name pattern (an agent's session is refused
    // push_approved_docs in the code, connectors/broker.py, pinned in test_broker_docs.py).
    expect(JSON.stringify(variables.ENGINEERING_START_ROLE_NAME)).toMatch(/EngineeringStartRole/);
    expect(JSON.stringify(variables.ENGINEERING_START_ROLE_NAME)).not.toMatch(/voc-eng-/);
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
    expect(['ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET', 'AGGREGATES_TABLE', 'ENGINEERING_CONNECTIONS_TABLE']
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

  it('carries the YAML reader of GitLab CI files in a layer of its own', () => {
    const on = template('on');
    const layers = JSON.stringify(on.findResources('AWS::Lambda::Function')[brokerId(on)]?.Properties?.Layers);
    expect(layers).toContain('EngineeringBrokerCiDepsLayer');
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
/** The broker's statements but the audit-row guard's Denies (7.84.00: voc-engineering is guarded, so every writer of it
 *  carries one; lib/utils/audit-row-guard.test.ts pins them). */
function brokerStatements(synthesized: Template): ReturnType<typeof functionStatements> {
  return functionStatements(synthesized, brokerId(synthesized))
    .filter((statement) => !isAuditRowGuardStatement({ Sid: typeof statement.Sid === 'string' ? statement.Sid : undefined }));
}
