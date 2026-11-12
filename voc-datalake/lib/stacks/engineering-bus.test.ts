/**
 * The engineering bus (engineering-bus.ts, docs/autonomous-engineering.md): absent by default; with
 * -c engineeringAgents=true, one custom bus with no archive, ONE rule sending every event to the inbox router, a task
 * queue per role of lambda/engineering/bus/schema.py, and the board API behind an IAM-authenticated function URL with
 * no resource-based permission, each role holding exactly the calls its code makes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { ENGINEERING_DLQ_BASE_NAME } from './dlq-alarms';
import { ENGINEERING_QUEUE_ROLES } from './engineering-bus';
import { OPTIONAL_FUNCTION_SIZES } from '../sizing/policy';
import {
  AGENT_ROLE_NAME_PATTERN_JOIN, functionRoleId, functionStatements as statementsOf, functionUrlAuthTypes, processingSynths,
} from '../test-support/engineering-template';
import { byCodeUnit } from '../utils/compare';

const template = processingSynths({ off: {}, on: { engineeringAgents: true } });

/** The logical id of the ONE function whose physical name starts with `baseName`. */
function functionId(synthesized: Template, baseName: string): string {
  const ids = Object.entries(synthesized.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => JSON.stringify(resource.Properties?.FunctionName ?? '').includes(`"${baseName}-"`))
    .map(([id]) => id);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function actionsOf(synthesized: Template, fnId: string): string[] {
  return [...new Set(statementsOf(synthesized, fnId).flatMap((statement) => [statement.Action].flat()))].sort(byCodeUnit);
}

/** The logical ids of the queues whose physical name starts with `baseName`. */
function queueIds(synthesized: Template, baseName: string): string[] {
  return Object.entries(synthesized.findResources('AWS::SQS::Queue'))
    .filter(([, queue]) => JSON.stringify(queue.Properties?.QueueName ?? '').includes(`"${baseName}`))
    .map(([id]) => id);
}

/** The logical ids of the role queues. */
function roleQueueIds(synthesized: Template): string[] {
  return queueIds(synthesized, 'voc-eng-tasks-');
}

/** The bus's one dead-letter queue. */
function dlqId(synthesized: Template): string {
  const ids = queueIds(synthesized, `${ENGINEERING_DLQ_BASE_NAME}-`);
  expect(ids).toHaveLength(1);
  return ids[0] ?? '';
}

function busId(synthesized: Template): string {
  return Object.keys(synthesized.findResources('AWS::Events::EventBus'))[0] ?? '';
}

/** The stack key's actions: only what a table read or write and a queue send need. */
const KEY_ACTIONS = ['kms:Decrypt', 'kms:GenerateDataKey'];

/** The services the function's key statement lets the key be used through (kms:ViaService); asserts one statement. */
function keyServices(on: Template, fnId: string): unknown {
  const keyStatements = statementsOf(on, fnId).filter((statement) => JSON.stringify(statement.Action).includes('kms:'));
  expect(keyStatements).toHaveLength(1);
  return z.looseObject({ Condition: z.object({ StringEquals: z.object({ 'kms:ViaService': z.unknown() }) }) })
    .parse(keyStatements[0]).Condition.StringEquals['kms:ViaService'];
}
const TABLE_ACTIONS = ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'];
/** The fixture's voc-engineering table, imported from the test's dependency stack. */
const TABLE_ARN_IMPORT = /Fn::ImportValue.*TestDeps:ExportsOutputFnGetAttEngineering[0-9A-F]+Arn/;

/** The router's environment variables in the flag-on synth. */
function routerEnv(on: Template): Record<string, unknown> {
  const props = on.findResources('AWS::Lambda::Function')[functionId(on, 'voc-engineering-router')]?.Properties;
  return z.record(z.string(), z.unknown()).parse(props?.Environment?.Variables);
}

describe('the engineering bus', () => {
  it('is absent by default: no bus, rule, router, board, queue or function URL', () => {
    const off = template('off');
    expect(Object.keys(off.findResources('AWS::Events::EventBus'))).toStrictEqual([]);
    expect(JSON.stringify(off.toJSON())).not.toMatch(/voc-engineering-(router|board)|voc-eng-tasks/);
    expect(Object.keys(off.findResources('AWS::Lambda::Url'))).toStrictEqual([]);
  });

  it('is one custom bus with no archive', () => {
    const on = template('on');
    const buses = Object.values(on.findResources('AWS::Events::EventBus'));
    expect(buses.map((bus) => bus.Properties?.Name)).toStrictEqual([
      { 'Fn::Join': ['', ['voc-engineering-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] },
    ]);
    expect(Object.keys(on.findResources('AWS::Events::Archive'))).toStrictEqual([]);
  });

  it('has a bus policy that denies PutEvents to every principal but the board\'s role', () => {
    const on = template('on');
    const boardRole = functionRoleId(on, functionId(on, 'voc-engineering-board'));
    const policies = Object.values(on.findResources('AWS::Events::EventBusPolicy'));
    expect(policies.map((policy) => policy.Properties?.Statement)).toStrictEqual([{
      Sid: 'cdk-OnlyTheEngineeringPublishers', Effect: 'Deny', Principal: { AWS: '*' }, Action: 'events:PutEvents',
      Resource: { 'Fn::GetAtt': [busId(on), 'Arn'] },
      Condition: { ArnNotEquals: { 'aws:PrincipalArn': [{ 'Fn::GetAtt': [boardRole, 'Arn'] }] } },
    }]);
  });

  it('has ONE rule on the bus, matching every event of the account, with the inbox router its only target', () => {
    const on = template('on');
    const rules = Object.values(on.findResources('AWS::Events::Rule'))
      .filter((rule) => JSON.stringify(rule.Properties?.EventBusName ?? '').includes(`"${busId(on)}"`));
    expect(rules).toHaveLength(1);
    const router = functionId(on, 'voc-engineering-router');
    expect(rules[0]?.Properties?.EventPattern).toStrictEqual({ account: ['111111111111'] });
    expect(rules[0]?.Properties?.Targets).toMatchObject([{
      Arn: { 'Fn::GetAtt': [router, 'Arn'] }, RetryPolicy: { MaximumRetryAttempts: 2 },
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [dlqId(on), 'Arn'] } },
    }]);
    expect(rules[0]?.Properties?.Targets).toHaveLength(1);
  });

  it('sends the router\'s async invocations that fail every retry to the dead-letter queue', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    const configs = Object.values(on.findResources('AWS::Lambda::EventInvokeConfig'))
      .filter((config) => JSON.stringify(config.Properties?.FunctionName).includes(`"${router}"`));
    expect(configs.map((config) => config.Properties)).toMatchObject([{
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [dlqId(on), 'Arn'] } } },
    }]);
  });

  it('lets EventBridge send only the inbox rule\'s and the supervisor rule\'s undelivered events to the DLQ', () => {
    const on = template('on');
    const allows = Object.values(on.findResources('AWS::SQS::QueuePolicy'))
      .filter((policy) => JSON.stringify(policy.Properties?.Queues).includes(`"${dlqId(on)}"`))
      .flatMap((policy) => z.array(z.looseObject({ Effect: z.string() })).parse(policy.Properties?.PolicyDocument?.Statement))
      .filter((statement) => statement.Effect === 'Allow')
      .sort((a, b) => byCodeUnit(JSON.stringify(a.Condition), JSON.stringify(b.Condition)));
    const fromRule = (rule: RegExp) => ({
      Principal: { Service: 'events.amazonaws.com' }, Action: 'sqs:SendMessage',
      Condition: { ArnEquals: { 'aws:SourceArn': { 'Fn::GetAtt': [expect.stringMatching(rule), 'Arn'] } } },
    });
    // EngineeringBus… sorts before EngineeringRuntime….
    expect(allows).toHaveLength(2);
    expect(allows).toMatchObject([fromRule(/InboxRule/), fromRule(/SupervisorRule/)]);
  });

  it('sends the runtime\'s undelivered supervisor ticks to the same dead-letter queue, on the stack\'s key', () => {
    const on = template('on');
    const supervisorRules = Object.values(on.findResources('AWS::Events::Rule'))
      .filter((rule) => JSON.stringify(rule.Properties?.Name ?? '').includes('voc-engineering-supervisor'));
    expect(supervisorRules.map((rule) => rule.Properties?.Targets)).toMatchObject([[{
      DeadLetterConfig: { Arn: { 'Fn::GetAtt': [dlqId(on), 'Arn'] } },
    }]]);
    expect(on.findResources('AWS::SQS::Queue')[dlqId(on)]?.Properties?.KmsMasterKeyId).toBeDefined();
  });

  it('runs the inbox router as one arm64 Python function at its size', () => {
    const on = template('on');
    expect(on.findResources('AWS::Lambda::Function')[functionId(on, 'voc-engineering-router')]?.Properties).toMatchObject({
      Handler: 'engineering/bus/router.handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES['voc-engineering-router'],
    });
  });

  it('gives the router the table and the delivery function\'s name', () => {
    const env = routerEnv(template('on'));
    // The fixture's voc-engineering table, imported from the test's dependency stack.
    expect(JSON.stringify(env.ENGINEERING_TABLE)).toMatch(/Fn::ImportValue.*Engineering/);
    expect(JSON.stringify(env.ENGINEERING_DELIVERY_FUNCTION)).toContain('voc-engineering-delivery-');
  });

  it('gives the router every role\'s queue URL by role (ENGINEERING_ROLE_QUEUE_URLS, a JSON object)', () => {
    const on = template('on');
    const urls = JSON.stringify(routerEnv(on).ENGINEERING_ROLE_QUEUE_URLS);
    const missingRoles = ENGINEERING_QUEUE_ROLES.filter((role) => !urls.includes(`\\"${role}\\":\\"`));
    const missingQueues = roleQueueIds(on).filter((id) => !urls.includes(`{"Ref":"${id}"}`));
    expect({ missingRoles, missingQueues }).toStrictEqual({ missingRoles: [], missingQueues: [] });
  });

  it('has a queue per role of the bus schema, KMS-encrypted, redriving to the dead-letter queue', () => {
    const on = template('on');
    const ids = roleQueueIds(on);
    expect(ids).toHaveLength(ENGINEERING_QUEUE_ROLES.length);
    const queues = on.findResources('AWS::SQS::Queue');
    const redrives = new Set(ids.map((id) => JSON.stringify(queues[id]?.Properties?.RedrivePolicy?.deadLetterTargetArn)));
    expect([...redrives]).toStrictEqual([JSON.stringify({ 'Fn::GetAtt': [dlqId(on), 'Arn'] })]);
    expect([...ids, dlqId(on)].filter((id) => queues[id]?.Properties?.KmsMasterKeyId === undefined)).toStrictEqual([]);
  });

  it('keeps the queue roles in lockstep with lambda/engineering/bus/schema.py ROLES', () => {
    const schema = readFileSync(join(__dirname, '../../lambda/engineering/bus/schema.py'), 'utf8');
    const block = /^ROLES = frozenset\(\{([^}]*)\}\)/m.exec(schema)?.[1] ?? '';
    const roles = [...block.matchAll(/'([^']+)'/g)].map((match) => match[1] ?? '');
    expect(roles.length).toBeGreaterThan(0);
    expect([...roles].sort(byCodeUnit)).toStrictEqual([...ENGINEERING_QUEUE_ROLES].sort(byCodeUnit));
  });

  it('grants the router the table\'s item calls, a send on exactly the role queues and the key, nothing else', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    expect(actionsOf(on, router)).toStrictEqual(
      [...TABLE_ACTIONS, ...KEY_ACTIONS, 'logs:CreateLogStream', 'logs:PutLogEvents', 'sqs:SendMessage'].sort(byCodeUnit));
    // The sends: the role queues, and the DLQ as the failure destination. No invoke: the delivery function is the
    // runtime's and does not exist yet (the action list above has no lambda:InvokeFunction).
    const sends = statementsOf(on, router).filter((statement) => statement.Action === 'sqs:SendMessage')
      .map((statement) => statement.Resource);
    expect(sends).toStrictEqual([
      roleQueueIds(on).map((id) => ({ 'Fn::GetAtt': [id, 'Arn'] })), { 'Fn::GetAtt': [dlqId(on), 'Arn'] },
    ]);
    expect(keyServices(on, router)).toStrictEqual(['dynamodb.us-east-1.amazonaws.com', 'sqs.us-east-1.amazonaws.com']);
    const table = statementsOf(on, router).find((statement) => JSON.stringify(statement.Action).includes('dynamodb:'));
    expect(JSON.stringify(table?.Resource)).toMatch(TABLE_ARN_IMPORT);
  });

  it('runs the board API behind a function URL with IAM authentication and no resource-based permission', () => {
    const on = template('on');
    const board = functionId(on, 'voc-engineering-board');
    expect(on.findResources('AWS::Lambda::Function')[board]?.Properties).toMatchObject({
      Handler: 'engineering/board/api.handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES['voc-engineering-board'],
      Environment: {
        Variables: {
          AGENT_ROLE_NAME_PATTERN: AGENT_ROLE_NAME_PATTERN_JOIN,
          ENGINEERING_BUS_NAME: { Ref: busId(on) },
        },
      },
    });
    expect(functionUrlAuthTypes(on, board)).toStrictEqual(['AWS_IAM']);
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties).includes(`"${board}"`));
    expect(permissions).toStrictEqual([]);
  });

  it('grants the board the table\'s item calls, a put on exactly the bus and the key, nothing else', () => {
    const on = template('on');
    const board = functionId(on, 'voc-engineering-board');
    expect(actionsOf(on, board)).toStrictEqual(
      [...TABLE_ACTIONS, ...KEY_ACTIONS, 'events:PutEvents', 'logs:CreateLogStream', 'logs:PutLogEvents'].sort(byCodeUnit));
    const put = statementsOf(on, board).find((statement) => statement.Action === 'events:PutEvents');
    expect(put?.Resource).toStrictEqual({ 'Fn::GetAtt': [busId(on), 'Arn'] });
    expect(keyServices(on, board)).toStrictEqual(['dynamodb.us-east-1.amazonaws.com']);
  });

  it('lets only the rule invoke the router', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties?.FunctionName).includes(`"${router}"`));
    expect(permissions.map((permission) => permission.Properties?.Principal)).toStrictEqual(['events.amazonaws.com']);
  });
});
