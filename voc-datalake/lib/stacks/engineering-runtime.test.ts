import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as events from 'aws-cdk-lib/aws-events';
import type * as iam from 'aws-cdk-lib/aws-iam';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { fixtureBucket } from '../test-support/fixture-resources';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { type EngineeringPeers, addEngineeringRuntime } from './engineering-runtime';

const ACCOUNT = 'arn:aws:lambda:us-east-1:111111111111';

/** The bus's and the broker's parts the runtime takes, as references, and the sources pinned on the bus. */
function fakePeers(stack: cdk.Stack, kmsKey: kms.IKey, pins: Map<string, string>): EngineeringPeers {
  return {
    // A queue on the stack's key, as voc-engineering-dlq is.
    deadLetterQueue: new sqs.Queue(stack, 'EngineeringDLQ', { encryption: sqs.QueueEncryption.KMS, encryptionMasterKey: kmsKey }),
    bus: events.EventBus.fromEventBusArn(stack, 'Bus', 'arn:aws:events:us-east-1:111111111111:event-bus/voc-engineering'),
    addAgentPublisher: (statementId: string, _role: iam.IRole, source: string) => {
      pins.set(statementId, source);
    },
    board: lambda.Function.fromFunctionArn(stack, 'Board', `${ACCOUNT}:function:voc-engineering-board`),
    broker: lambda.Function.fromFunctionArn(stack, 'Broker', `${ACCOUNT}:function:voc-engineering-broker`),
  };
}

interface RuntimeStack { template: Template; added: boolean; pins: Map<string, string> }

/** A stack with only the runtime's dependencies, under `context`; `withPeers: false` leaves out the bus and broker. */
function runtimeStack(context: Record<string, unknown>, withPeers = true): RuntimeStack {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new cdk.Stack(app, 'EngineeringTest', { env: { account: '111111111111', region: 'us-east-1' } });
  const kmsKey = new kms.Key(stack, 'Key');
  const pins = new Map<string, string>();
  const added = addEngineeringRuntime(stack, {
    uniqueName: (baseName) => baseName,
    layer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', 'arn:aws:lambda:us-east-1:111111111111:layer:deps:1'),
    kmsKey,
    engineeringTable: new dynamodb.Table(stack, 'Engineering', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    rawDataBucket: fixtureBucket(stack, 'Raw'),
    workspaceBucket: fixtureBucket(stack, 'Workspace'),
    peers: withPeers ? fakePeers(stack, kmsKey, pins) : undefined,
  });
  return { template: Template.fromStack(stack), added, pins };
}

/** How many resources of `type` match `properties`. */
function count(template: Template, type: string, properties?: Record<string, unknown>): number {
  return Object.keys(template.findResources(type, properties ? { Properties: properties } : undefined)).length;
}

const StatementsSchema = z.array(z.looseObject({
  Sid: z.string().optional(),
  Resource: z.unknown(),
  Condition: z.looseObject({ StringLike: z.looseObject({ 's3:prefix': z.array(z.string()).optional() }).optional() })
    .optional(),
}));
const EnvSchema = z.object({ Variables: z.record(z.string(), z.unknown()) });

/** The supervisor function's environment variables. */
function supervisorEnv(template: Template): Record<string, unknown> {
  const [fn] = Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'voc-engineering-runtime' },
  }));
  return EnvSchema.parse(fn?.Properties?.Environment).Variables;
}

/** The inline policies attached to the role whose logical id contains `roleId`, as searchable text. */
function policyText(template: Template, roleId: string): string {
  return JSON.stringify(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) },
  }));
}

/** How many of the fixer agent role's policies hold every one of `statements`. */
function fixerPoliciesWith(template: Template, statements: unknown[]): number {
  return count(template, 'AWS::IAM::Policy', {
    Roles: [{ Ref: Match.stringLikeRegexp('EngineeringAgentFixerRole') }],
    PolicyDocument: Match.objectLike({ Statement: Match.arrayWith(statements) }),
  });
}

describe('the engineering runtime is off by default', () => {
  it('adds nothing to the default processing stack', () => {
    const resources = JSON.stringify(synthProcessingTemplate().toJSON());
    expect(resources).not.toContain('voc-engineering-runtime');
    expect(resources).not.toContain('voc-engineering-supervisor');
  }, SYNTH_TIMEOUT_MS);

  it('refuses a mistyped flag rather than deploying the opposite', () => {
    expect(() => runtimeStack({ engineeringAgents: 'ture' })).toThrow(/engineeringAgents/);
  });

  it.each([[{}], [{ engineeringAgents: 'false' }], [{ engineeringAgents: false }]])(
    'adds nothing without engineeringAgents=true (%j)', (context) => {
      const { template, added } = runtimeStack(context);
      expect(added).toBe(false);
      template.resourceCountIs('AWS::Lambda::Function', 0);
    });
});

describe('with -c engineeringAgents=true', () => {
  let template: Template;
  beforeAll(() => {
    template = runtimeStack({ engineeringAgents: 'true' }).template;
  }, SYNTH_TIMEOUT_MS);

  it('ticks the supervisor every minute from an EventBridge rule created disabled, failures to the bus\'s DLQ', () => {
    const [dlq] = Object.keys(template.findResources('AWS::SQS::Queue'));
    expect(count(template, 'AWS::Events::Rule', {
      Name: 'voc-engineering-supervisor',
      ScheduleExpression: 'rate(1 minute)',
      State: 'DISABLED',
      Targets: [Match.objectLike({
        Input: '{"action":"tick"}',
        RetryPolicy: { MaximumRetryAttempts: 0 },
        DeadLetterConfig: { Arn: { 'Fn::GetAtt': [dlq, 'Arn'] } },
      })],
    })).toBe(1);
    expect(count(template, 'AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-runtime', Handler: 'engineering/runtime/handler.lambda_handler',
    })).toBe(1);
  });

  it('makes no queue of its own: every queue is on the stack\'s key (the bus\'s DLQ, given to it)', () => {
    // Only the test's stand-in for voc-engineering-dlq, on the customer-managed key.
    expect(count(template, 'AWS::SQS::Queue')).toBe(1);
    expect(count(template, 'AWS::SQS::Queue', { KmsMasterKeyId: Match.objectLike({ 'Fn::GetAtt': Match.anyValue() }) }))
      .toBe(1);
    expect(() => runtimeStack({ engineeringAgents: 'true' }, false)).toThrow(/engineering bus/);
  });

  it('runs voc-engineering-delivery as the supervisor (its code and role), retried twice, failures to the DLQ', () => {
    const [dlq] = Object.keys(template.findResources('AWS::SQS::Queue'));
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: Match.stringLikeRegexp('^voc-engineering-(runtime|delivery)$') },
    });
    const roles = new Set(Object.values(functions).map((fn) => JSON.stringify(fn.Properties?.Role)));
    expect([Object.keys(functions).length, roles.size]).toStrictEqual([2, 1]);
    expect(count(template, 'AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-delivery', Handler: 'engineering/runtime/handler.delivery_handler',
    })).toBe(1);
    expect(count(template, 'AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [dlq, 'Arn'] } } },
    })).toBe(1);
  });

  it('configures no MicroVM image by default, so every launch is refused until one is set', () => {
    expect(supervisorEnv(template).ENGINEERING_IMAGE_ARNS).toBe('{}');
  });

  it('takes the image ARNs from -c engineeringImageArns (a JSON object, or its text from the CLI)', () => {
    const arns = { python: 'arn:aws:lambda:us-east-1:111111111111:microvm-image/python:3', rust: 'arn:aws:lambda:us-east-1:111111111111:microvm-image/rust:1' };
    for (const value of [arns, JSON.stringify(arns)]) {
      const env = supervisorEnv(runtimeStack({ engineeringAgents: 'true', engineeringImageArns: value }).template);
      expect(JSON.parse(String(env.ENGINEERING_IMAGE_ARNS))).toStrictEqual(arns);
    }
  });

  it.each([
    ['not JSON', '{python:'],
    ['not an object', '["arn:aws:lambda:us-east-1:111111111111:microvm-image/python:3"]'],
    ['an unknown language', { go: 'arn:aws:lambda:us-east-1:111111111111:microvm-image/go:1' }],
    ['not an ARN', { python: 'python:3.14' }],
  ])('refuses image ARNs that are %s', (_case, value) => {
    expect(() => runtimeStack({ engineeringAgents: 'true', engineeringImageArns: value })).toThrow(/engineeringImageArns/);
  });

  it('adds no alarm unless asked (an alarm is a fixed cost)', () => {
    expect(count(template, 'AWS::CloudWatch::Alarm')).toBe(0);
    const withAlarm = runtimeStack({ engineeringAgents: 'true', engineeringSupervisorAlarm: 'true' }).template;
    // The supervisor's errors; its undelivered ticks are the engineering DLQ's, which alerting already watches.
    expect(count(withAlarm, 'AWS::CloudWatch::Alarm')).toBe(1);
  });

  it('has one fixed role per agent role, trusted only by the launcher', () => {
    const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: Match.stringLikeRegexp('^voc-eng-') } });
    // The broker's and the board's 13 roles (connectors/identity.py AGENT_ROLES), named as their pattern reads them.
    expect(Object.keys(roles)).toHaveLength(13);
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'voc-eng-gate-runner' });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'voc-eng-fixer',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [Match.objectLike({
          Action: ['sts:AssumeRole', 'sts:TagSession'],
          Principal: { AWS: { 'Fn::GetAtt': [Match.stringLikeRegexp('EngineeringSupervisorRole'), 'Arn'] } },
        })],
      }),
    });
  });

  it('lets the launcher assume an agent role only with all four session tags', () => {
    const trust = {
      Statement: [Match.objectLike({
        Action: ['sts:AssumeRole', 'sts:TagSession'],
        Condition: { Null: {
          'aws:RequestTag/ws': 'false', 'aws:RequestTag/run': 'false', 'aws:RequestTag/agent': 'false',
          'aws:RequestTag/connection': 'false',
        } },
      })],
    };
    // Every one of the 13 agent roles.
    expect(count(template, 'AWS::IAM::Role', { AssumeRolePolicyDocument: Match.objectLike(trust) })).toBe(13);
  });

  it('reads and lists the same keys: its cache in the raw bucket, its run in the workspace bucket', () => {
    const agent = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('EngineeringAgentFixerRole') }] },
    });
    const statements = Object.values(agent).flatMap((policy) => StatementsSchema.parse(policy.Properties?.PolicyDocument?.Statement));
    const prefixes = (sid: string) => statements.find((statement) => statement.Sid === sid)?.Condition?.StringLike?.['s3:prefix'];
    const read = JSON.stringify(statements.find((statement) => statement.Sid === 'ReadCacheAndRun')?.Resource);
    const listed = [...prefixes('ListCache') ?? [], ...prefixes('ListRun') ?? []];
    expect(listed).toStrictEqual(['engineering/cache/${aws:PrincipalTag/connection}/*',
      'ws/${aws:PrincipalTag/ws}/runs/${aws:PrincipalTag/run}/*']);
    for (const keys of listed) expect(read).toContain(`/${keys}`);
    // Each in its own bucket: the cache in the raw one, the run (read, list, its own writes) in the workspace one.
    const on = (sid: string) => JSON.stringify(statements.find((statement) => statement.Sid === sid)?.Resource);
    expect([on('ListCache'), on('ListRun'), on('WriteOwnKeys')].map((text) => /Workspace/.test(text)))
      .toStrictEqual([false, true, true]);
    expect(read).toMatch(/Raw.*engineering\/cache|engineering\/cache.*Raw/);
    expect(read).toMatch(/Workspace.*ws\/|ws\/.*Workspace/);
  });

  it('scopes an agent role to its session: its cache and run, its own keys, and no queue', () => {
    const agent = policyText(template, 'EngineeringAgentFixerRole');
    expect(agent).toContain('ws/${aws:PrincipalTag/ws}/runs/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}/*');
    expect(agent).not.toContain('engineering/runs/');
    expect(agent).toContain('engineering/cache/${aws:PrincipalTag/connection}/*');
    // The role queues serve every run: no agent reads one (its run's messages are pushed to it).
    expect(agent).not.toMatch(/s3:DeleteObject|s3:\*|dynamodb:|iam:|lambda:\*|sqs:/);
  });

  it('lets an agent role call the board\'s and the broker\'s function URLs, and invoke them only through one', () => {
    const urls = [`${ACCOUNT}:function:voc-engineering-board`, `${ACCOUNT}:function:voc-engineering-broker`];
    expect(fixerPoliciesWith(template, [
          Match.objectLike({
            Sid: 'BoardAndBrokerUrls', Action: 'lambda:InvokeFunctionUrl', Resource: urls,
            Condition: { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
          }),
          Match.objectLike({
            Sid: 'BoardAndBrokerThroughUrls', Action: 'lambda:InvokeFunction', Resource: urls,
            Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
          }),
    ])).toBe(1);
  });

  it('pins every agent role with a voice to its own source on the bus as well', () => {
    const { pins } = runtimeStack({ engineeringAgents: 'true' });
    expect(pins.size).toBe(12);
    expect(pins.get('Fixer')).toBe('voc.engineering/agent/fixer/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}');
    expect(pins.get('Coordinator')).toBe('voc.engineering/conductor/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}');
    expect(policyText(template, 'EngineeringAgentFixerRole')).toContain(':event-bus/voc-engineering');
  });

  it('gives the coach no voice on the bus until it has a run-scoped source (its service source names no run)', () => {
    const { pins } = runtimeStack({ engineeringAgents: 'true' });
    expect(pins.has('Coach')).toBe(false);
    expect(policyText(template, 'EngineeringAgentCoachRole')).not.toContain('PutOnTheBus');
  });

  it('lets each engineering role use the key only through the services that store its data', () => {
    const via = Match.objectLike({
      Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
      Condition: { StringEquals: { 'kms:ViaService': Match.anyValue() } },
    });
    for (const role of ['EngineeringAgentFixerRole', 'EngineeringSupervisorRole']) {
      expect(count(template, 'AWS::IAM::Policy', {
        Roles: [{ Ref: Match.stringLikeRegexp(role) }],
        PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([via]) }),
      })).toBe(1);
      expect(policyText(template, role)).not.toMatch(/kms:Encrypt"|kms:ReEncrypt/);
    }
  });

  it('lets the run coordinator speak on the bus only as its run\'s conductor', () => {
    expect(policyText(template, 'EngineeringAgentCoordinatorRole'))
      .toContain('voc.engineering/conductor/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}');
  });

  it('denies an agent role any role chaining and any bus source but its own', () => {
    expect(fixerPoliciesWith(template, [
          Match.objectLike({ Sid: 'NoRoleChaining', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:TagSession'] }),
          Match.objectLike({
            Sid: 'OwnEventSourceOnly', Effect: 'Deny', Action: 'events:PutEvents',
            Condition: { StringNotEquals: { 'events:source': 'voc.engineering/agent/fixer/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}' } },
          }),
    ])).toBe(1);
  });

  it('lets the supervisor touch only the runs\' rows and their registry, its own rule and the agent roles', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({
            Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem', 'dynamodb:ConditionCheckItem',
              'dynamodb:Query'],
            Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#RUN#*', 'WS#*#RUNS'] } },
          }),
          // Its one delete: an ended run's registry row, never a run's own rows.
          Match.objectLike({
            Action: 'dynamodb:DeleteItem',
            Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#RUNS'] } },
          }),
        ]),
      }),
    });
    const supervisor = policyText(template, 'EngineeringSupervisorRole');
    expect(supervisor).toContain(':rule/voc-engineering-supervisor');
    // The checkpoints it reads are the agents' in the workspace bucket's layout; the raw bucket only for the cache.
    expect(supervisor).toMatch(/"Workspace\w*","Arn"\]\},"\/ws\/\*\/runs\/\*\/\*\/commits\/\*\/_checkpoints/);
    expect(supervisor).toContain('lambda:RunMicrovm');
    expect(supervisor).not.toMatch(/s3:DeleteObject|s3:PutObject|dynamodb:\*|s3:\*|iam:|gsi1|engineering\/runs\//);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-runtime',
      Environment: { Variables: Match.objectLike({ ENGINEERING_TABLE: Match.anyValue() }) },
    });
  });
});
