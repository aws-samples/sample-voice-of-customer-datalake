import * as cdk from 'aws-cdk-lib';
import { Match, Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { beforeAll, describe, expect, it } from 'vitest';

import { fixtureBucket } from '../test-support/fixture-resources';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { addEngineeringRuntime } from './engineering-runtime';

/** A stack with only the runtime's dependencies, under `context`. */
function runtimeStack(context: Record<string, unknown>): { template: Template; added: boolean } {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], ...context } });
  const stack = new cdk.Stack(app, 'EngineeringTest', { env: { account: '111111111111', region: 'us-east-1' } });
  const added = addEngineeringRuntime(stack, {
    uniqueName: (baseName) => baseName,
    layer: lambda.LayerVersion.fromLayerVersionArn(stack, 'Layer', 'arn:aws:lambda:us-east-1:111111111111:layer:deps:1'),
    kmsKey: new kms.Key(stack, 'Key'),
    agentsTable: new dynamodb.Table(stack, 'Agents', {
      partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'sk', type: dynamodb.AttributeType.STRING },
    }),
    rawDataBucket: fixtureBucket(stack, 'Raw'),
  });
  return { template: Template.fromStack(stack), added };
}

/** How many resources of `type` match `properties`. */
function count(template: Template, type: string, properties?: Record<string, unknown>): number {
  return Object.keys(template.findResources(type, properties ? { Properties: properties } : undefined)).length;
}

/** The inline policies attached to the role whose logical id contains `roleId`, as searchable text. */
function policyText(template: Template, roleId: string): string {
  return JSON.stringify(template.findResources('AWS::IAM::Policy', {
    Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(roleId) }]) },
  }));
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

  it('ticks the supervisor every minute from an EventBridge rule created disabled, failures to a queue', () => {
    expect(count(template, 'AWS::Events::Rule', {
      Name: 'voc-engineering-supervisor',
      ScheduleExpression: 'rate(1 minute)',
      State: 'DISABLED',
      Targets: [Match.objectLike({
        Input: '{"action":"tick"}',
        RetryPolicy: { MaximumRetryAttempts: 0 },
        DeadLetterConfig: Match.objectLike({ Arn: Match.anyValue() }),
      })],
    })).toBe(1);
    expect(count(template, 'AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-runtime', Handler: 'engineering/runtime/handler.lambda_handler',
    })).toBe(1);
  });

  it('adds no alarm unless asked (an alarm is a fixed cost)', () => {
    expect(count(template, 'AWS::CloudWatch::Alarm')).toBe(0);
    const withAlarm = runtimeStack({ engineeringAgents: 'true', engineeringSupervisorAlarm: 'true' }).template;
    expect(count(withAlarm, 'AWS::CloudWatch::Alarm')).toBe(2);
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

  it('scopes an agent role to its session: its cache and run, its own keys and queues, its own bus source', () => {
    const agent = policyText(template, 'EngineeringAgentFixerRole');
    expect(agent).toContain('engineering/runs/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}/*');
    expect(agent).toContain('engineering/cache/${aws:PrincipalTag/connection}/*');
    expect(agent).toContain('voc-eng_${aws:PrincipalTag/run}_role_fixer');
    expect(agent).not.toMatch(/s3:DeleteObject|s3:\*|dynamodb:|iam:|lambda:/);
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
    expect(count(template, 'AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('EngineeringAgentFixerRole') }],
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([
          Match.objectLike({ Sid: 'NoRoleChaining', Effect: 'Deny', Action: ['sts:AssumeRole', 'sts:TagSession'] }),
          Match.objectLike({
            Sid: 'OwnEventSourceOnly', Effect: 'Deny', Action: 'events:PutEvents',
            Condition: { StringNotEquals: { 'events:source': 'voc.engineering/agent/fixer/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}' } },
          }),
        ]),
      }),
    })).toBe(1);
  });

  it('lets the supervisor touch only session rows, its own rule and the agent roles, and delete nothing', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({
          Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query'],
          Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['ENGRUN#*', 'ENG_SESSIONS_ACTIVE'] } },
        })]),
      }),
    });
    const supervisor = policyText(template, 'EngineeringSupervisorRole');
    expect(supervisor).toContain(':rule/voc-engineering-supervisor');
    expect(supervisor).toContain('lambda:RunMicrovm');
    expect(supervisor).not.toMatch(/dynamodb:DeleteItem|s3:DeleteObject|s3:PutObject|dynamodb:\*|s3:\*|iam:/);
  });
});
