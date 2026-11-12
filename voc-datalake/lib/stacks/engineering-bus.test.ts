/**
 * The engineering bus (engineering-bus.ts, docs/autonomous-engineering.md): absent by default; with
 * -c engineeringAgents=true, one custom bus with no archive, ONE rule sending every event to the inbox router, which
 * pushes to the delivery function (no queue per role or agent: only the DLQ), and the board API behind an
 * IAM-authenticated function URL with no resource-based permission, each role holding exactly the calls its code
 * makes.
 */
import { describe, expect, it } from 'vitest';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { ENGINEERING_DLQ_BASE_NAME } from './dlq-alarms';
import { ENGINEERING_REPORTS_FUNCTION_BASE_NAME } from './engineering-bus';
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
/** The fixture's workspace bucket, imported from the test's dependency stack. */
const WORKSPACE_IMPORT = /Fn::ImportValue.*TestDeps:ExportsOutput\w*EngineeringWorkspace/;

/** The router's environment variables in the flag-on synth. */
function routerEnv(on: Template): Record<string, unknown> {
  const props = on.findResources('AWS::Lambda::Function')[functionId(on, 'voc-engineering-router')]?.Properties;
  return z.record(z.string(), z.unknown()).parse(props?.Environment?.Variables);
}

describe('the engineering bus', () => {
  it('is absent by default: no bus, rule, router, board, queue or function URL', () => {
    const off = template('off');
    expect(Object.keys(off.findResources('AWS::Events::EventBus'))).toStrictEqual([]);
    expect(JSON.stringify(off.toJSON())).not.toMatch(/voc-engineering-(router|board|reports)|voc-eng-tasks/);
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

  it('has a bus policy that denies PutEvents to every principal but the board\'s role, the runtime\'s two and the agent roles', () => {
    const on = template('on');
    const [boardRole, supervisorRole, deliveryRole] = ['voc-engineering-board', 'voc-engineering-runtime',
      'voc-engineering-delivery'].map((name) => functionRoleId(on, functionId(on, name)));
    const agentRoles = Object.keys(on.findResources('AWS::IAM::Role'))
      .filter((id) => /EngineeringAgent.*Role/.test(id)).sort(byCodeUnit);
    expect(agentRoles).toHaveLength(13);
    // Every agent role speaks (the coach as its run's coach).
    const speaking = agentRoles;
    const statements = Object.values(on.findResources('AWS::Events::EventBusPolicy'))
      .map((policy) => z.looseObject({ Sid: z.string(), Condition: z.unknown() }).parse(policy.Properties?.Statement));
    const only = statements.find((statement) => statement.Sid === 'cdk-OnlyTheEngineeringPublishers');
    const allowed = z.object({ ArnNotEquals: z.object({ 'aws:PrincipalArn': z.array(z.unknown()) }) })
      .parse(only?.Condition).ArnNotEquals['aws:PrincipalArn'];
    expect(allowed).toStrictEqual([boardRole, ...speaking, supervisorRole, deliveryRole]
      .map((id) => ({ 'Fn::GetAtt': [id, 'Arn'] })));
    expect(JSON.stringify(only)).toContain(busId(on));
  });

  it('pins the board and the runtime\'s two roles to their own service source on the bus', () => {
    const statements = Object.values(template('on').findResources('AWS::Events::EventBusPolicy'))
      .map((policy) => JSON.stringify(policy.Properties?.Statement)).filter((text) => text.includes('OwnSourceOnly'));
    const source = (sid: string): string | undefined => /"StringNotEquals":\{"events:source":"([^"]+)"\}/
      .exec(statements.find((text) => text.includes(`cdk-OwnSourceOnly${sid}"`)) ?? '')?.[1];
    expect(['Board', 'Supervisor', 'Delivery'].map(source)).toStrictEqual(['voc.engineering/board',
      'voc.engineering/supervisor', 'voc.engineering/supervisor']);
  });

  it('denies each publisher every bus source but its own, whatever its own policy says', () => {
    const statements = Object.values(template('on').findResources('AWS::Events::EventBusPolicy'))
      .map((policy) => JSON.stringify(policy.Properties?.Statement)).filter((text) => text.includes('OwnSourceOnly'));
    // One per agent role (the coach's included), the board's, and the runtime's two.
    expect([statements.length, statements.some((text) => text.includes('Coach'))]).toStrictEqual([16, true]);
    const fixer = statements.find((text) => text.includes('cdk-OwnSourceOnlyFixer'));
    expect(fixer).toContain('"Effect":"Deny"');
    expect(fixer).toContain('"StringNotEquals":{"events:source":"voc.engineering/agent/fixer/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}"}');
    expect(fixer).toMatch(/"ArnEquals":\{"aws:PrincipalArn":\{"Fn::GetAtt":\["[^"]*EngineeringAgentFixerRole/);
  });

  it('writes the bus policy one statement at a time (each resource waits for the one before)', () => {
    const policies = Object.entries(template('on').findResources('AWS::Events::EventBusPolicy'));
    expect(policies).toHaveLength(17);
    const ids = new Set(policies.map(([id]) => id));
    // Each policy's one dependency among them: the one written before it.
    const before = new Map(policies.map(([id, policy]) => [id,
      z.array(z.string()).parse([policy.DependsOn ?? []].flat()).filter((dep) => ids.has(dep))]));
    const first = [...before].filter(([, deps]) => deps.length === 0).map(([id]) => id);
    expect(first).toHaveLength(1);
    // Walking back from every other policy, one step at a time, reaches all 17: one chain, no fan-out.
    const next = new Map([...before].filter(([, deps]) => deps.length === 1).map(([id, [dep]]) => [dep, id]));
    expect(next.size).toBe(16);
    let at: string | undefined = first[0];
    const seen: string[] = [];
    while (at !== undefined) {
      seen.push(at);
      at = next.get(at);
    }
    expect(seen).toHaveLength(17);
  });

  it('hands the agent roles the real board and broker, and no role queue (they serve every run)', () => {
    const on = template('on');
    const fixer = JSON.stringify(on.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('EngineeringAgentFixerRole') }] },
    }));
    const board = functionId(on, 'voc-engineering-board');
    const broker = functionId(on, 'voc-engineering-broker');
    expect(fixer).toContain(`{"Fn::GetAtt":["${board}","Arn"]}`);
    expect(fixer).toContain(`{"Fn::GetAtt":["${broker}","Arn"]}`);
    expect(fixer).not.toContain('sqs:');
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

  it('has no queue but the dead-letter queue, KMS-encrypted: every message is pushed per run', () => {
    const on = template('on');
    const queues = on.findResources('AWS::SQS::Queue');
    // Every engineering queue's name starts with voc-eng (voc-engineering-dlq; the old role queues were voc-eng-tasks-).
    expect(queueIds(on, 'voc-eng')).toStrictEqual([dlqId(on)]);
    expect(queues[dlqId(on)]?.Properties?.KmsMasterKeyId).toBeDefined();
    expect(routerEnv(on)).not.toHaveProperty('ENGINEERING_ROLE_QUEUE_URLS');
  });

  it('grants the router the table\'s item calls, an invoke on exactly the delivery function, its failure records and the key', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    expect(actionsOf(on, router)).toStrictEqual([...TABLE_ACTIONS, ...KEY_ACTIONS, 'lambda:InvokeFunction',
      'logs:CreateLogStream', 'logs:PutLogEvents', 'sqs:SendMessage'].sort(byCodeUnit));
    expect(keyServices(on, router)).toStrictEqual(['dynamodb.us-east-1.amazonaws.com', 'sqs.us-east-1.amazonaws.com']);
    const table = statementsOf(on, router).find((statement) => JSON.stringify(statement.Action).includes('dynamodb:'));
    expect(JSON.stringify(table?.Resource)).toMatch(TABLE_ARN_IMPORT);
  });

  it('lets the router invoke only the delivery function, by its name, and send only its failure records', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    // By name: the delivery function is the runtime's and is not deployed by this stack.
    const invokes = statementsOf(on, router).filter((statement) => statement.Action === 'lambda:InvokeFunction')
      .map((statement) => JSON.stringify(statement.Resource));
    expect(invokes).toHaveLength(1);
    expect(invokes[0]).toContain(':function:voc-engineering-delivery-');
    // The one send: the DLQ, as the failure destination.
    const sends = statementsOf(on, router).filter((statement) => statement.Action === 'sqs:SendMessage')
      .map((statement) => statement.Resource);
    expect(sends).toStrictEqual([{ 'Fn::GetAtt': [dlqId(on), 'Arn'] }]);
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

  it('grants the board the table\'s item calls and its inbox query, a put on exactly the bus and the key, nothing else', () => {
    const on = template('on');
    const board = functionId(on, 'voc-engineering-board');
    expect(actionsOf(on, board)).toStrictEqual(
      [...TABLE_ACTIONS, 'dynamodb:Query', ...KEY_ACTIONS, 'events:PutEvents', 'logs:CreateLogStream',
        'logs:PutLogEvents'].sort(byCodeUnit));
    const put = statementsOf(on, board).find((statement) => statement.Action === 'events:PutEvents');
    expect(put?.Resource).toStrictEqual({ 'Fn::GetAtt': [busId(on), 'Arn'] });
    expect(keyServices(on, board)).toStrictEqual(['dynamodb.us-east-1.amazonaws.com']);
  });

  it('runs the report builder as one arm64 Python function with the table and the workspace bucket', () => {
    const on = template('on');
    const props = on.findResources('AWS::Lambda::Function')[functionId(on, ENGINEERING_REPORTS_FUNCTION_BASE_NAME)]
      ?.Properties;
    expect(props).toMatchObject({
      Handler: 'engineering/reports/handler.handler', Runtime: 'python3.14', Architectures: ['arm64'],
      MemorySize: OPTIONAL_FUNCTION_SIZES[ENGINEERING_REPORTS_FUNCTION_BASE_NAME],
    });
    const env = z.record(z.string(), z.unknown()).parse(props?.Environment?.Variables);
    expect(JSON.stringify(env.ENGINEERING_TABLE)).toMatch(/Fn::ImportValue.*Engineering/);
    expect(JSON.stringify(env.ENGINEERING_WORKSPACE_BUCKET)).toMatch(WORKSPACE_IMPORT);
  });

  it('lets nothing invoke the report builder yet and keeps its failed async builds in the DLQ', () => {
    const on = template('on');
    const reports = functionId(on, ENGINEERING_REPORTS_FUNCTION_BASE_NAME);
    // Its callers (the run coordinator, the supervisor, the broker) come later.
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties).includes(`"${reports}"`));
    expect(permissions).toStrictEqual([]);
    const configs = Object.values(on.findResources('AWS::Lambda::EventInvokeConfig'))
      .filter((config) => JSON.stringify(config.Properties?.FunctionName).includes(`"${reports}"`));
    expect(configs.map((config) => config.Properties)).toMatchObject([{
      MaximumRetryAttempts: 0, DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [dlqId(on), 'Arn'] } } },
    }]);
  });

  it('grants the report builder its table, bucket and key calls and its failure records, nothing else', () => {
    const on = template('on');
    const reports = functionId(on, ENGINEERING_REPORTS_FUNCTION_BASE_NAME);
    expect(actionsOf(on, reports)).toStrictEqual([
      'dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:UpdateItem', ...KEY_ACTIONS, 'logs:CreateLogStream',
      'logs:PutLogEvents', 's3:GetObject', 's3:ListBucket', 's3:PutObject', 'sqs:SendMessage',
    ].sort(byCodeUnit));
    expect(keyServices(on, reports)).toStrictEqual(
      ['dynamodb.us-east-1.amazonaws.com', 's3.us-east-1.amazonaws.com', 'sqs.us-east-1.amazonaws.com']);
  });

  it('scopes the report builder to reading the runs\' objects and writing the reports', () => {
    const on = template('on');
    const statements = statementsOf(on, functionId(on, ENGINEERING_REPORTS_FUNCTION_BASE_NAME));
    const resourceOf = (action: string) => JSON.stringify(statements.find((statement) => statement.Action === action)
      ?.Resource);
    expect({
      get: resourceOf('s3:GetObject'), put: resourceOf('s3:PutObject'), list: resourceOf('s3:ListBucket'),
    }).toStrictEqual({
      // The one workspace spelled out: an IAM `*` crosses `/`, so `ws/*/reports/*` would reach run objects too.
      get: expect.stringMatching(/"\/ws\/default\/runs\/\*"/), put: expect.stringMatching(/"\/ws\/default\/reports\/\*"/),
      list: expect.stringMatching(WORKSPACE_IMPORT),
    });
    expect(JSON.parse(resourceOf('sqs:SendMessage'))).toStrictEqual({ 'Fn::GetAtt': [dlqId(on), 'Arn'] });
  });

  it('lets the report builder list only under the runs\' keys', () => {
    const on = template('on');
    const list = statementsOf(on, functionId(on, ENGINEERING_REPORTS_FUNCTION_BASE_NAME))
      .find((statement) => statement.Action === 's3:ListBucket');
    expect(list?.['Condition']).toStrictEqual({ StringLike: { 's3:prefix': ['ws/default/runs/*'] } });
  });

  it('lets only the rule invoke the router', () => {
    const on = template('on');
    const router = functionId(on, 'voc-engineering-router');
    const permissions = Object.values(on.findResources('AWS::Lambda::Permission'))
      .filter((permission) => JSON.stringify(permission.Properties?.FunctionName).includes(`"${router}"`));
    expect(permissions.map((permission) => permission.Properties?.Principal)).toStrictEqual(['events.amazonaws.com']);
  });
});
