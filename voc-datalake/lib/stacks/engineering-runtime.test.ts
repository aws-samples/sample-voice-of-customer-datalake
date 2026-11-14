import { Match, type Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { policiesWithStatement } from '../test-support/engineering-template';
import {
  ACCOUNT, EnvSchema, count, functionEnv, policyText, runtimeStack, supervisorEnv,
} from '../test-support/engineering-runtime-fixture';
import { ENGINEERING_WORKSPACE_READER_SERVICES } from './dlq-alarms';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { benchmarkCaseIds } from './engineering-runtime';

const StatementsSchema = z.array(z.looseObject({
  Sid: z.string().optional(),
  Resource: z.unknown(),
  Condition: z.looseObject({ StringLike: z.looseObject({ 's3:prefix': z.array(z.string()).optional() }).optional() })
    .optional(),
}));

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

  it('runs voc-engineering-delivery on the supervisor\'s code with a role of its own, retried twice, failures to the DLQ', () => {
    const [dlq] = Object.keys(template.findResources('AWS::SQS::Queue'));
    const functions = template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: Match.stringLikeRegexp('^voc-engineering-(runtime|delivery)$') },
    });
    const roles = new Set(Object.values(functions).map((fn) => JSON.stringify(fn.Properties?.Role)));
    expect([Object.keys(functions).length, roles.size]).toStrictEqual([2, 2]);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-delivery',
      Role: { 'Fn::GetAtt': [Match.stringLikeRegexp('EngineeringDeliveryRole'), 'Arn'] },
    });
    expect(count(template, 'AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-delivery', Handler: 'engineering/runtime/handler.delivery_handler',
    })).toBe(1);
    expect(count(template, 'AWS::Lambda::EventInvokeConfig', {
      MaximumRetryAttempts: 2,
      DestinationConfig: { OnFailure: { Destination: { 'Fn::GetAtt': [dlq, 'Arn'] } } },
    })).toBe(1);
  });

  /** voc-engineering-start's function resource. */
  const startFunction = () => Object.values(template.findResources('AWS::Lambda::Function', {
    Properties: { FunctionName: 'voc-engineering-start' },
  }))[0];

  it('runs voc-engineering-start on the runtime\'s code with a role of its own, entered where only start_run runs', () => {
    const start = startFunction();
    // (the Agents API's grant names this function alone: api-engineering-reads.test.ts)
    expect([start?.Properties?.Handler, JSON.stringify(start?.Properties?.Role)]).toStrictEqual([
      'engineering/runtime/handler.start_handler', expect.stringMatching(/EngineeringStartRole/)]);
    // What a start reads (the hard cap's table, the rule it switches on, the images, the launcher's roles); no
    // benchmark cases: it runs no retrospective.
    const env = Object.keys(EnvSchema.parse(start?.Properties?.Environment).Variables);
    expect(['ENGINEERING_SETTINGS_TABLE', 'SUPERVISOR_RULE_NAME', 'ENGINEERING_AGENT_RUNTIMES', 'ENGINEERING_AGENT_ROLE_ARNS',
      'ENGINEERING_RUNTIME_FUNCTION', 'ENGINEERING_BENCHMARK_CASES'].map((name) => env.includes(name)))
      .toStrictEqual([true, true, true, true, true, false]);
    expect(count(template, 'AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: Match.stringLikeRegexp('EngineeringStart') }, MaximumRetryAttempts: 0,
    })).toBe(1);
  });

  it('writes the run within the API\'s wait and hands the coordinator\'s launch on to the runtime, which it may invoke', () => {
    const start = startFunction();
    // (30 s: the API waits 25 s, under API Gateway's 29; the launch runs in the runtime's 5 minutes)
    expect([start?.Properties?.Timeout, JSON.stringify(EnvSchema.parse(start?.Properties?.Environment).Variables
      .ENGINEERING_RUNTIME_FUNCTION)]).toStrictEqual([30, expect.stringMatching(/EngineeringSupervisor/)]);
    expect(policyText(template, 'EngineeringStartRole')).toMatch(/lambda:InvokeFunction[^\]]*function:/);
  });

  it('gives the start function only what a start needs: no session, no agent role, no bus, no delete, no rule off', () => {
    const start = policyText(template, 'EngineeringStartRole');
    expect(start).not.toMatch(/bedrock-agentcore|sts:|events:(PutEvents|DisableRule)|DeleteItem|dynamodb:Query|s3:|sqs:|bedrock:/);
    const actions = new Set(start.match(/"(dynamodb|events|lambda|kms):[A-Za-z]+"/g)
      ?.filter((name) => !/LeadingKeys|ViaService/.test(name)));
    expect([...actions].sort((a, b) => a.localeCompare(b, 'en'))).toStrictEqual([
      '"dynamodb:GetItem"', '"dynamodb:PutItem"', '"dynamodb:UpdateItem"', '"events:EnableRule"',
      '"kms:Decrypt"', '"kms:GenerateDataKey"', '"lambda:InvokeFunction"']);
    // Its writes stay in the runs' partitions and the registry; its other reads are a flow's month and the hard cap.
    expect(start).toMatch(/"WS#\*#RUN#\*","WS#\*#RUNS"/);
    // The agent roles trust only the two launchers, never the start function.
    expect(policyText(template, 'EngineeringAgentFixerRole')).not.toMatch(/EngineeringStartRole/);
  });

  it('configures no agent runtime by default, so every launch is refused until an image is named', () => {
    expect(supervisorEnv(template).ENGINEERING_AGENT_RUNTIMES).toBe('{}');
    expect(count(template, 'AWS::BedrockAgentCore::Runtime')).toBe(0);
  });

  it('adds no alarm unless asked (an alarm is a fixed cost)', () => {
    expect(count(template, 'AWS::CloudWatch::Alarm')).toBe(0);
    const withAlarm = runtimeStack({ engineeringAgents: 'true', engineeringSupervisorAlarm: 'true' }).template;
    // The supervisor's errors; its undelivered ticks are the engineering DLQ's, which alerting already watches.
    expect(count(withAlarm, 'AWS::CloudWatch::Alarm')).toBe(1);
  });

  it('has one fixed role per agent role, trusted only by the two launchers (the supervisor, the delivery)', () => {
    const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: Match.stringLikeRegexp('^voc-eng-') } });
    // The broker's and the board's 13 roles (connectors/identity.py AGENT_ROLES), named as their pattern reads them.
    expect(Object.keys(roles)).toHaveLength(13);
    template.hasResourceProperties('AWS::IAM::Role', { RoleName: 'voc-eng-gate-runner' });
    const launcher = (roleId: string) => Match.objectLike({
      Action: ['sts:AssumeRole', 'sts:TagSession'],
      Principal: { AWS: { 'Fn::GetAtt': [Match.stringLikeRegexp(roleId), 'Arn'] } },
    });
    template.hasResourceProperties('AWS::IAM::Role', {
      RoleName: 'voc-eng-fixer',
      AssumeRolePolicyDocument: Match.objectLike({
        Statement: [launcher('EngineeringSupervisorRole'), launcher('EngineeringDeliveryRole')],
      }),
    });
  });

  it('lets each launcher assume an agent role only with all four session tags', () => {
    const tagged = Match.objectLike({
      Action: ['sts:AssumeRole', 'sts:TagSession'],
      Condition: { Null: {
        'aws:RequestTag/ws': 'false', 'aws:RequestTag/run': 'false', 'aws:RequestTag/agent': 'false',
        'aws:RequestTag/connection': 'false',
      } },
    });
    // Every one of the 13 agent roles, both of its trust statements.
    expect(count(template, 'AWS::IAM::Role', {
      AssumeRolePolicyDocument: Match.objectLike({ Statement: [tagged, tagged] }),
    })).toBe(13);
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
    // No queue: an agent's run's messages are pushed to it (the delivery function) and read through the board.
    expect(agent).not.toMatch(/s3:DeleteObject|s3:\*|dynamodb:|iam:|lambda:\*|sqs:/);
  });

  it('lets an agent role call the board\'s and the broker\'s function URLs, and invoke them only through one', () => {
    const board = `${ACCOUNT}:function:voc-engineering-board`;
    const broker = `${ACCOUNT}:function:voc-engineering-broker`;
    const iamOnly = { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } };
    expect(fixerPoliciesWith(template, [
          Match.objectLike({ Sid: 'BoardUrl', Action: 'lambda:InvokeFunctionUrl', Resource: board, Condition: iamOnly }),
          Match.objectLike({ Sid: 'BrokerUrl', Action: 'lambda:InvokeFunctionUrl', Resource: broker, Condition: iamOnly }),
          Match.objectLike({
            Sid: 'BoardAndBrokerThroughUrls', Action: 'lambda:InvokeFunction', Resource: [board, broker],
            Condition: { Bool: { 'lambda:InvokedViaFunctionUrl': 'true' } },
          }),
    ])).toBe(1);
  });

  it('gives every agent role the broker\'s function URL alone, IAM-authenticated, and no other URL call', () => {
    const broker = `${ACCOUNT}:function:voc-engineering-broker`;
    const agentPolicies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: [{ Ref: Match.stringLikeRegexp('^EngineeringRuntimeEngineeringAgent') }] },
    });
    const UrlStatements = z.array(z.looseObject({
      Sid: z.string().optional(), Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown(),
      Condition: z.unknown().optional(),
    }));
    const urlCalls = Object.values(agentPolicies)
      .map((policy) => UrlStatements.parse(policy.Properties?.PolicyDocument?.Statement)
        .filter((statement) => [statement.Action].flat().includes('lambda:InvokeFunctionUrl')));
    expect(urlCalls).toHaveLength(13);
    for (const statements of urlCalls) {
      // Exactly the board's and the broker's, one function each, never a wildcard or another function.
      expect(statements.map((statement) => [statement.Sid, statement.Resource])).toStrictEqual([
        ['BoardUrl', `${ACCOUNT}:function:voc-engineering-board`], ['BrokerUrl', broker]]);
      expect(statements.map((statement) => statement.Condition)).toStrictEqual([
        { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } },
        { StringEquals: { 'lambda:FunctionUrlAuthType': 'AWS_IAM' } }]);
    }
  });

  it('hands the broker\'s function URL to the agents through the supervisor and the delivery', () => {
    for (const name of ['voc-engineering-runtime', 'voc-engineering-delivery', 'voc-engineering-start']) {
      expect(functionEnv(template, name).ENGINEERING_BROKER_URL).toBe('https://def456.lambda-url.us-east-1.on.aws/');
    }
  });

  it('lets the runtime\'s two roles speak on the bus only as the supervisor', () => {
    const { pins } = runtimeStack({ engineeringAgents: 'true' });
    expect([pins.get('Supervisor'), pins.get('Delivery')]).toStrictEqual(['voc.engineering/supervisor',
      'voc.engineering/supervisor']);
    for (const role of ['EngineeringSupervisorRole', 'EngineeringDeliveryRole']) {
      template.hasResourceProperties('AWS::IAM::Policy', {
        Roles: [{ Ref: Match.stringLikeRegexp(role) }],
        PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({
          Sid: 'SpeakAsTheSupervisor', Action: 'events:PutEvents',
          Condition: { StringEquals: { 'events:source': 'voc.engineering/supervisor' } },
        })]) }),
      });
    }
  });

  it('pins every agent role with a voice, and the runtime\'s two roles, to its own source on the bus as well', () => {
    const { pins } = runtimeStack({ engineeringAgents: 'true' });
    expect(pins.size).toBe(15);
    expect(pins.get('Fixer')).toBe('voc.engineering/agent/fixer/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}/${aws:PrincipalTag/agent}');
    expect(pins.get('Coordinator')).toBe('voc.engineering/conductor/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}');
    expect(policyText(template, 'EngineeringAgentFixerRole')).toContain(':event-bus/voc-engineering');
  });

  it('lets the coach speak on the bus only as its own run\'s coach (a run-scoped source)', () => {
    const { pins } = runtimeStack({ engineeringAgents: 'true' });
    expect(pins.get('Coach')).toBe('voc.engineering/coach/${aws:PrincipalTag/ws}/${aws:PrincipalTag/run}');
    expect(policyText(template, 'EngineeringAgentCoachRole')).toContain('PutOnTheBus');
  });

  it('lets each engineering role use the key only through the services that store its data', () => {
    const via = Match.objectLike({
      Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
      Condition: { StringEquals: { 'kms:ViaService': Match.anyValue() } },
    });
    for (const role of ['EngineeringAgentFixerRole', 'EngineeringSupervisorRole', 'EngineeringDeliveryRole']) {
      expect(count(template, 'AWS::IAM::Policy', {
        Roles: [{ Ref: Match.stringLikeRegexp(role) }],
        PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([via]) }),
      })).toBe(1);
      expect(policyText(template, role)).not.toMatch(/kms:Encrypt"|kms:ReEncrypt/);
    }
    // The delivery's failed invocations go to the encrypted DLQ: without SQS here their records would be lost.
    expect(count(template, 'AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('EngineeringDeliveryRole') }],
      PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({
        Action: ['kms:Decrypt', 'kms:GenerateDataKey'],
        Condition: { StringEquals: { 'kms:ViaService': Match.arrayWith(['sqs.us-east-1.amazonaws.com']) } },
      })]) }),
    })).toBe(1);
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
    // No AgentCore grant without a runtime (engineering-agentcore.test.ts has them).
    expect(supervisor).not.toMatch(/bedrock-agentcore|Microvm/);
    expect(supervisor).not.toMatch(/s3:DeleteObject|s3:PutObject|dynamodb:\*|s3:\*|iam:|gsi1|engineering\/runs\//);
    template.hasResourceProperties('AWS::Lambda::Function', {
      FunctionName: 'voc-engineering-runtime',
      Environment: { Variables: Match.objectLike({ ENGINEERING_TABLE: Match.anyValue() }) },
    });
  });

  it('gives the delivery only what a wake needs: the runs\' rows, the checkpoints, the launch, its DLQ (no runtime yet)', () => {
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('EngineeringDeliveryRole') }]) },
    });
    const statements = Object.values(policies)
      .flatMap((policy) => z.array(z.looseObject({ Action: z.union([z.string(), z.array(z.string())]) }))
        .parse(policy.Properties?.PolicyDocument?.Statement));
    expect(new Set(statements.flatMap((statement) => [statement.Action].flat()))).toStrictEqual(new Set([
      'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem',
      'events:PutEvents',
      'kms:Decrypt', 'kms:GenerateDataKey',
      's3:GetObject', 's3:ListBucket',
      'sqs:SendMessage',
      'sts:AssumeRole', 'sts:TagSession',
    ]));
  });

  it('lets the delivery touch the runs\' partitions only: never the registry of active runs, its rule or a delete', () => {
    template.hasResourceProperties('AWS::IAM::Policy', {
      Roles: [{ Ref: Match.stringLikeRegexp('EngineeringDeliveryRole') }],
      PolicyDocument: Match.objectLike({
        Statement: Match.arrayWith([Match.objectLike({
          Sid: 'RunRows',
          Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#RUN#*'] } },
        })]),
      }),
    });
    const delivery = policyText(template, 'EngineeringDeliveryRole');
    expect(delivery).not.toMatch(/WS#\*#RUNS|events:Put(Rule|Targets)|events:(Enable|Disable)|s3:PutObject|dynamodb:DeleteItem|InvokeAgentRuntimeCommand|iam:/);
    // Its one bus action, only as the supervisor (a wake's continuation is reported to the run).
    expect(delivery.match(/"events:[A-Z]\w*"/g)).toStrictEqual(['"events:PutEvents"']);
    expect(delivery).toMatch(/"Workspace\w*","Arn"\]\},"\/ws\/\*\/runs\/\*\/\*\/commits\/\*\/_checkpoints/);
  });

  /** The policies of `role` holding statement `sid`: `action` on the table, only on `keys`' partitions. */
  const keyedGrants = (role: string, sid: string, action: string | string[], keys: string) => policiesWithStatement(
    template, role, { Sid: sid, Action: action, Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [keys] } } });

  it.each(['EngineeringSupervisorRole', 'EngineeringDeliveryRole'])(
    'lets %s update the spend ledger\'s month partitions only (the same transaction as a priced session write)', (role) => {
      expect(keyedGrants(role, 'SpendLedger', 'dynamodb:UpdateItem', 'WS#default#SPEND#20??-??')).toHaveLength(1);
    });

  it.each([
    ['SpendTotals', 'dynamodb:GetItem', 'WS#default#SPEND#20??-??'],
    ['BudgetAlerts', ['dynamodb:GetItem', 'dynamodb:UpdateItem'], 'WS#default#BUDGET#20??-??'],
    ['HardCapSetting', 'dynamodb:GetItem', 'SETTINGS#engineering'],
  ])('gives the supervisor alone %s (%s on %s): a flow\'s month total, the alerts\' own partition', (sid, action, keys) => {
    expect(keyedGrants('EngineeringSupervisorRole', sid, action, keys)).toHaveLength(1);
    expect(policyText(template, 'EngineeringDeliveryRole')).not.toMatch(/#BUDGET#|SETTINGS#/);
  });

  it('gives the delivery role only UpdateItem on the spend ledger, whatever the statement', () => {
    const Statement = z.array(z.looseObject({ Action: z.union([z.string(), z.array(z.string())]), Condition: z.unknown().optional() }));
    const policies = template.findResources('AWS::IAM::Policy', {
      Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('EngineeringDeliveryRole') }]) },
    });
    const onLedger = Object.values(policies)
      .flatMap((policy) => Statement.parse(policy.Properties?.PolicyDocument?.Statement))
      .filter((statement) => JSON.stringify(statement.Condition ?? {}).includes('#SPEND#'));
    expect(onLedger.flatMap((statement) => [statement.Action].flat())).toStrictEqual(['dynamodb:UpdateItem']);
  });

  it('runs the delivery without what only the supervisor uses (its rule\'s name, the extra egress of a launch)', () => {
    const [fn] = Object.values(template.findResources('AWS::Lambda::Function', {
      Properties: { FunctionName: 'voc-engineering-delivery' },
    }));
    const env = Object.keys(EnvSchema.parse(fn?.Properties?.Environment).Variables);
    expect(env).toStrictEqual(expect.arrayContaining(['ENGINEERING_AGENT_ROLE_ARNS', 'ENGINEERING_BOARD_URL',
      'ENGINEERING_BUS_NAME',
      'ENGINEERING_AGENT_RUNTIMES',
      'ENGINEERING_SESSION_RATES', 'ENGINEERING_TABLE', 'ENGINEERING_TIMINGS', 'ENGINEERING_WORKSPACE_BUCKET',
      'RAW_DATA_BUCKET']));
    // Nor the benchmark's cases, nor the hard cap's table (only a start reads it).
    expect(env.filter((name) => ['SUPERVISOR_RULE_NAME', 'ENGINEERING_EXTRA_EGRESS', 'ENGINEERING_BENCHMARK_CASES',
      'ENGINEERING_SETTINGS_TABLE', 'ENGINEERING_MAX_SESSIONS'].includes(name))).toStrictEqual([]);
  });

  describe('the learning loop (a run\'s retrospective, lambda/engineering/learning/)', () => {
    /** The supervisor role's statement with `sid`. */
    function statement(sid: string): Record<string, unknown> | undefined {
      const policies = template.findResources('AWS::IAM::Policy', {
        Properties: { Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp('EngineeringSupervisorRole') }]) },
      });
      return Object.values(policies)
        .flatMap((policy) => StatementsSchema.parse(policy.Properties?.PolicyDocument?.Statement))
        .find((found) => found.Sid === sid);
    }

    it.each([
      ['LearningCoachSkills', ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'], 'WS#*#SKILL#*'],
      ['LearningRoleLessons', ['dynamodb:GetItem', 'dynamodb:Query', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        'WS#*#AMEM#ROLE#*'],
      ['LearningScorecards', 'dynamodb:PutItem', 'WS#*#SCORE#*'],
    ])('grants the runtime %s on those partitions only, never a delete', (sid, actions, partition) => {
      expect(statement(sid)).toMatchObject({
        Effect: 'Allow', Action: actions,
        Condition: { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [partition] } },
      });
    });

    it('never lets the runtime touch a person\'s memories, a knowledge pack or delete a learning row', () => {
      const supervisor = policyText(template, 'EngineeringSupervisorRole');
      expect(supervisor).not.toMatch(/AMEM#PERSON|AMEM#REPO|AMEM#\*|#KNOW|WS#\*"/);
      expect(supervisor.match(/dynamodb:DeleteItem/g)).toHaveLength(1);   // (the registry's, above)
    });

    it('reads only the gate records in the workspace bucket, never listing or writing them', () => {
      const gate = statement('LearningReadsGateRecords');
      expect(gate).toMatchObject({ Effect: 'Allow', Action: 's3:GetObject' });
      expect(JSON.stringify(gate?.Resource))
        .toMatch(/"Workspace\w*","Arn"\]\},"\/ws\/\*\/runs\/\*\/\*\/commits\/\*\/_gate\/attempt-\*\/record\.json"/);
    });

    it('never retries an asynchronous invocation of the runtime (each learning step is claimed once)', () => {
      const [fn] = Object.keys(template.findResources('AWS::Lambda::Function', {
        Properties: { FunctionName: 'voc-engineering-runtime' },
      }));
      expect(count(template, 'AWS::Lambda::EventInvokeConfig', {
        FunctionName: { Ref: fn }, MaximumRetryAttempts: 0,
      })).toBe(1);
    });

    it('hands the retrospective on to the runtime function itself, by name, and to nothing else', () => {
      const invoke = statement('LearningHandsOnToItself');
      expect(invoke).toMatchObject({ Effect: 'Allow', Action: 'lambda:InvokeFunction' });
      expect(JSON.stringify(invoke?.Resource)).toMatch(/:function:voc-engineering-runtime"\]\]\}$/);
      expect(policyText(template, 'EngineeringSupervisorRole').match(/lambda:InvokeFunction"/g)).toHaveLength(1);
    });

    it('lets the runtime call the allowlisted Claude models (the coach), and the delivery none', () => {
      const attachedTo = (role: string): number => count(template, 'AWS::IAM::ManagedPolicy', {
        Roles: Match.arrayWith([{ Ref: Match.stringLikeRegexp(role) }]),
        PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectLike({
          Sid: 'ClaudeProfiles', Action: 'bedrock:InvokeModel',
        })]) }),
      });
      expect(attachedTo('EngineeringSupervisorRole')).toBeGreaterThan(0);
      expect(attachedTo('EngineeringDeliveryRole')).toBe(0);
    });

    it('runs under a service the denied-reads alarm sums (it reads the gate records as missing when denied)', () => {
      expect(supervisorEnv(template).POWERTOOLS_SERVICE_NAME).toBe(ENGINEERING_WORKSPACE_READER_SERVICES[3]);
    });

    it('names the benchmark\'s shipped cases for the coach', () => {
      expect(benchmarkCaseIds()).toStrictEqual(
        ['duration-hours-feature', 'monorepo-units-bug', 'pagination-review', 'slug-cut-bug']);
      expect(supervisorEnv(template).ENGINEERING_BENCHMARK_CASES).toBe(JSON.stringify(benchmarkCaseIds()));
    });
  });
});
