/**
 * The agents API's reads of an engineering run (api-assistant-lambdas.ts; lambda/engineering/views.py): nothing by
 * default; with -c engineeringAgents=true the agents API gets the switch, the table and the bucket, exactly the reads
 * its views make, and the engineering package in its bundle. The reads are admin-only; the global MCP endpoint (whose
 * tokens never act as an admin) gets nothing of the module: its five engineering tools (7.53.00) reach the agents API
 * through the invoke it already holds, each admitted there for its one operation.
 */
import { describe, expect, it } from 'vitest';
import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';

import { byCodeUnit } from '../utils/compare';
import { GLOBAL_MCP_SERVICE_NAME } from '../utils/function-names';
import {
  actionsWithPrefix, apiTemplate, buildApiStack, policyStatementsOf, serviceEnvironment,
} from '../test-support/api-stack-template';
import type { VocApiStack } from './api-stack';
import { ENGINEERING_WORKSPACE_READER_SERVICES } from './dlq-alarms';
import { engineeringRunCaps } from './engineering-start';
import { RUN_REQUEST_PARTITIONS } from './api-assistant-lambdas';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';

// (7.50.00: and the readiness checks' settings, api-engineering-readiness.ts)
// (7.51.02: and the engineering bus, for a person's steering and answers: api-engineering-voice.ts)
const ENGINEERING_ENV = ['ENGINEERING_AGENTS', 'ENGINEERING_AGENT_NETWORK', 'ENGINEERING_APP_TOKENS_FUNCTION',
  'ENGINEERING_BOARD_FUNCTION', 'ENGINEERING_BUILD_MEMORY_MIB', 'ENGINEERING_BUS_NAME', 'ENGINEERING_HARNESS',
  'ENGINEERING_IMAGE_LANGUAGES',
  'ENGINEERING_MAX_SESSIONS',
  'ENGINEERING_PARAMETER_KEY', 'ENGINEERING_PARAMETER_PREFIX', 'ENGINEERING_RUN_CAP_USD', 'ENGINEERING_RUN_TOKEN_CAP',
  'ENGINEERING_START_FUNCTION', 'ENGINEERING_TABLE', 'ENGINEERING_USER_AUTH_FUNCTION', 'ENGINEERING_USER_AUTH_PREFIX',
  'ENGINEERING_WATERMARKS_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'];
// (7.57.00: and the GitHub App user authorizations, api-engineering-user-auth.ts; pinned in engineering-user-auth.test.ts)
let cachedOn: VocApiStack | undefined;
const onStack = (): VocApiStack => {
  cachedOn ??= buildApiStack({ engineeringAgents: true });
  return cachedOn;
};
let cachedTemplate: Template | undefined;
const on = (): Template => {
  cachedTemplate ??= Template.fromStack(onStack());
  return cachedTemplate;
};
const engineeringStatements = (template: Template) => policyStatementsOf(template, 'AgentsLambdaRole')
  .filter((statement) => /Engineering/.test(statement.resource));

describe('the engineering run reads', { timeout: SYNTH_TIMEOUT_MS }, () => {
  it('are off by default: no switch, no table or bucket, no grant on either', () => {
    const template = apiTemplate();
    const agentsEnv = Object.keys(serviceEnvironment(template, 'voc-agents-api'));
    const mcpEnv = Object.keys(serviceEnvironment(template, GLOBAL_MCP_SERVICE_NAME));
    expect([...agentsEnv, ...mcpEnv].filter((name) => name.startsWith('ENGINEERING_'))).toStrictEqual([]);
    expect(engineeringStatements(template)).toStrictEqual([]);
  });

  it('turn the agents API\'s routes on with the table and the workspace bucket', () => {
    const env = serviceEnvironment(on(), 'voc-agents-api');
    expect(Object.keys(env).filter((name) => name.startsWith('ENGINEERING_')).sort(byCodeUnit))
      .toStrictEqual(ENGINEERING_ENV);
    expect(env.ENGINEERING_AGENTS).toBe('on');
    expect(JSON.stringify(env.ENGINEERING_TABLE)).toMatch(/Fn::ImportValue.*Engineering/);
    expect(JSON.stringify(env.ENGINEERING_WORKSPACE_BUCKET)).toMatch(/Fn::ImportValue.*EngineeringWorkspace/);
  });

  it('grant the agents API reads of the table and the reports, and writes of the skills\' partitions alone', () => {
    const statements = engineeringStatements(on());
    const unconditioned = statements.filter((statement) => statement.condition === undefined);
    // (7.50.00: and the readiness probe's one create-only put, api-engineering-readiness.test.ts)
    expect(actionsWithPrefix(unconditioned, '')).toStrictEqual(
      ['dynamodb:GetItem', 'dynamodb:Query', 's3:GetObject', 's3:PutObject']);
    expect(JSON.stringify(statements)).not.toMatch(/Delete|BatchWrite/);
    const objects = statements.filter((statement) => statement.actions.includes('s3:GetObject'));
    // (7.51.00: and the run workspace's reads of the agents' own objects, below; 7.52.00: and the knowledge packs'
    // objects, for an approval's rendering and the docs' preview)
    expect(objects.map((statement) => statement.resource)).toStrictEqual([
      expect.stringMatching(/"\/ws\/default\/knowledge\/\*"/), expect.stringMatching(/"\/ws\/default\/reports\/\*"/),
      expect.stringMatching(/_transcripts/)]);
    const puts = statements.filter((statement) => statement.actions.includes('s3:PutObject'));
    expect(puts.map((statement) => [statement.actions, statement.resource])).toStrictEqual(
      [[['s3:PutObject'], expect.stringMatching(/"\/ws\/default\/_readiness\/\*"/)]]);
  });

  it('read the run workspace\'s objects exactly: transcripts, patches, gate records and manifests, no write', () => {
    // (7.51.00, api-engineering-run-reads.ts: an agent's thread, changes and gate, an ended run's manifest)
    const statements = policyStatementsOf(on(), 'AgentsLambdaRole');
    const reads = statements.filter((statement) => /_transcripts|_patches|_gate|_manifest/.test(
      `${statement.resource}${JSON.stringify(statement.condition ?? {})}`));
    // (7.53.00: and a flow's weekly cross-run Learn records, read and their weeks listed: GET /agents/engineering/learn)
    expect(reads.map((statement) => [statement.actions, statement.condition])).toStrictEqual([
      [['s3:GetObject'], undefined], [['s3:ListBucket'], { StringLike: { 's3:prefix': [
        'ws/default/runs/*/*/commits/*/_transcripts/*', 'ws/default/runs/*/*/commits/*/_patches/*',
        'ws/default/learn/*'] } }]]);
    // The exact object keys, in order: never a checkpoint, a finding, a seed or a run's other objects.
    const keys = [...reads[0]?.resource.matchAll(/"(\/ws\/[^"]*)"/g) ?? []].map((match) => match[1]);
    expect(keys).toStrictEqual(['/ws/default/runs/*/*/commits/*/_transcripts/*',
      '/ws/default/runs/*/*/commits/*/_patches/*', '/ws/default/runs/*/*/commits/*/_gate/*',
      '/ws/default/runs/*/_manifest/*', '/ws/default/learn/*']);
    expect(JSON.stringify(statements)).not.toMatch(/_checkpoints|_seed|s3:\*/);
  });

  it('list the workspace bucket only under the transcripts\', patches\' and cross-run records\' prefixes, in one statement', () => {
    const listings = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.some((action) => action.startsWith('s3:List')));
    // (the bucket itself, never an object pattern; no other listing reaches it, conditioned or not)
    expect(listings.map((statement) => [statement.actions, /\/ws\//.test(statement.resource)])).toStrictEqual(
      [[['s3:ListBucket'], false]]);
  });

  it('give the agents API no read of a run\'s own objects while the module is off', () => {
    expect(JSON.stringify(policyStatementsOf(apiTemplate(), 'AgentsLambdaRole'))).not.toMatch(
      /_transcripts|_patches|_manifest|ws\/default\/learn|ListBucket/);
  });

  it('read the skills\' history and the scorecards (WS#*#SKILL#*, WS#*#SCORE#*) with the one table read', () => {
    // (7.07.00: GET /agents/engineering/skills…, …/scorecards/<role> read with the GetItem and Query the run views
    // already have on the whole table, which covers those partitions; a narrower statement beside it would add nothing)
    const reads = engineeringStatements(on()).filter((statement) => statement.actions.includes('dynamodb:Query'));
    expect(reads.map((statement) => [...statement.actions].sort(byCodeUnit))).toStrictEqual([['dynamodb:GetItem', 'dynamodb:Query']]);
    expect(reads[0]?.condition).toBeUndefined();
    expect(JSON.stringify(reads)).not.toMatch(/BatchGet|Scan/);
  });

  it('write the skills\' and the Registry cards\' partitions with exactly the stores\' actions, keyed by dynamodb:LeadingKeys', () => {
    // (7.08.00: an administrator's accept, reject, rollback and benchmark, the skills store's transactions; 7.52.00: a
    // card made from a skill, its HEAD, create-only version and log rows and its listing row, nothing else; 7.53.00:
    // and the run requests' partition, below, in a statement of its own)
    const writes = policyStatementsOf(on(), 'AgentsLambdaRole').filter((statement) => /Engineering/.test(statement.resource)
      && statement.actions.some((action) => /^dynamodb:(Put|Update|ConditionCheck)/.test(action)));
    // (7.52.00: and the repositories' partitions, the knowledge flows' decisions: below)
    expect(writes.map((statement) => [...statement.actions].sort(byCodeUnit))).toStrictEqual(
      [['dynamodb:ConditionCheckItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        ['dynamodb:PutItem', 'dynamodb:UpdateItem'], ['dynamodb:PutItem', 'dynamodb:UpdateItem']]);
    expect(writes[0]?.condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#SKILL#*', 'WS#*#AGENTCARD#*'] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    });
    expect(writes.map((statement) => statement.resource)).toStrictEqual(
      Array.from({ length: 3 }, () => expect.stringMatching(/^\{"Fn::ImportValue":"[^"]*Engineering/)));
    // (the Registry is in-app only, owner decision 7.52.00: no AWS Agent Registry client, so no grant of it)
    expect(JSON.stringify(policyStatementsOf(on(), 'AgentsLambdaRole'))).not.toMatch(/agent-registry|bedrock-agentcore:.*Registry/);
  });

  it('write the repositories\' partitions (WS#*#REPO#*) with Put and Update only: approvals and tenets (7.52.00)', () => {
    // (an administrator's approval of a knowledge pack version with its docs' rendering, and an acceptance or rejection
    // of a tenets version: the stores' transactions; no delete, no ConditionCheckItem)
    const writes = policyStatementsOf(on(), 'AgentsLambdaRole').filter((statement) => /Engineering/.test(statement.resource)
      && JSON.stringify(statement.condition ?? {}).includes('REPO'));
    expect(writes.map((statement) => [...statement.actions].sort(byCodeUnit))).toStrictEqual(
      [['dynamodb:PutItem', 'dynamodb:UpdateItem']]);
    expect(writes[0]?.condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#REPO#*'] },
      Null: { 'dynamodb:LeadingKeys': 'false' },
    });
    // Never the docs' claims (the broker's) nor the start's push: this role reaches the broker only through the start.
    expect(JSON.stringify(policyStatementsOf(on(), 'AgentsLambdaRole'))).not.toMatch(/DOCS#|InvokeFunctionUrl/);
  });

  it('write the run requests\' partition alone, PutItem and UpdateItem by dynamodb:LeadingKeys, no delete (7.53.00)', () => {
    // (a local assistant's request for a Run now over MCP, an administrator's confirm or decline: run_requests.py)
    const writes = policyStatementsOf(on(), 'AgentsLambdaRole').filter((statement) => /Engineering/.test(statement.resource)
      && JSON.stringify(statement.condition ?? {}).includes('RUNREQ'));
    expect(writes.map((statement) => [[...statement.actions].sort(byCodeUnit), statement.condition])).toStrictEqual([[
      ['dynamodb:PutItem', 'dynamodb:UpdateItem'],
      { 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#RUNREQ#*'] }, Null: { 'dynamodb:LeadingKeys': 'false' } },
    ]]);
    expect(RUN_REQUEST_PARTITIONS).toBe('WS#*#RUNREQ#*');
  });

  it('give the agents API no write of the engineering table while the module is off', () => {
    const statements = policyStatementsOf(apiTemplate(), 'AgentsLambdaRole');
    expect(JSON.stringify(statements)).not.toMatch(/SKILL|AGENTCARD|RUNREQ|ConditionCheckItem/);
  });

  it('send a person\'s board actions to the board\'s function, by its name, which its own role writes', () => {
    const invokes = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.includes('lambda:InvokeFunction') && /voc-engineering-board/.test(statement.resource));
    expect(invokes.map((statement) => statement.actions)).toStrictEqual([['lambda:InvokeFunction']]);
    // (its unique name: the base name, then the account and region, as VocProcessingStack names it)
    expect(invokes.map((statement) => statement.resource)).toStrictEqual(
      [expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-board-",/)]);
    expect(JSON.stringify(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_BOARD_FUNCTION))
      .toMatch(/^"?\S*voc-engineering-board-/);
  });

  it('start a run through the start function alone, by its name: never the runtime\'s own function', () => {
    const invokes = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.includes('lambda:InvokeFunction'));
    const engineering = invokes.filter((statement) => /voc-engineering-/.test(statement.resource));
    expect(engineering.map((statement) => statement.actions)).toStrictEqual([['lambda:InvokeFunction'],
      ['lambda:InvokeFunction'], ['lambda:InvokeFunction'], ['lambda:InvokeFunction']]);
    // (7.45.00: and the GitHub Apps' token function, for an installation's read: engineering-app-tokens.test.ts)
    // (7.57.00: and the user authorizations' code exchange: engineering-user-auth.test.ts)
    expect(engineering.map((statement) => statement.resource)).toStrictEqual([
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-board-",/),
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-start-",/),
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-app-tokens-",/),
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-user-auth-",/)]);
    // The runtime itself (tick, launch, signal, end_run) is not this role's to invoke, in any form.
    expect(JSON.stringify(invokes)).not.toMatch(/voc-engineering-(runtime|delivery)/);
    expect(JSON.stringify(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_START_FUNCTION))
      .toMatch(/^"?\S*voc-engineering-start-/);
  });

  it('put a person\'s steering and answers on the engineering bus alone, from the API\'s own source (7.51.02)', () => {
    const puts = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.some((action) => action.startsWith('events:')));
    // One statement, one action, the one bus (VocProcessingStack's, by its name), held to the source and the two types.
    expect(puts.map((statement) => [statement.actions, JSON.parse(statement.resource), statement.condition])).toStrictEqual([[
      ['events:PutEvents'],
      { 'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':events:us-east-1:111111111111:event-bus/voc-engineering-',
        { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] },
      { StringEquals: { 'events:source': 'voc.engineering/api', 'events:detail-type': ['msg.answer', 'msg.steer'] } },
    ]]);
    // (the name the Agents API publishes to: steer_available)
    expect(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_BUS_NAME).toStrictEqual(
      { 'Fn::Join': ['', ['voc-engineering-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] });
  });

  it('never put an event without both conditions, another detail type or on another bus, nor any other events call', () => {
    const statements = policyStatementsOf(on(), 'AgentsLambdaRole');
    const events = statements.filter((statement) => JSON.stringify(statement).includes('events:'));
    expect(events.map((statement) => statement.actions)).toStrictEqual([['events:PutEvents']]);
    const condition = JSON.stringify(events[0]?.condition);
    // (no other detail type: a signal's, a board action's or a skill decision's; no wildcard; no other source)
    expect(condition).not.toMatch(/signal\.|task\.|skill\.|\*|StringLike|ForAnyValue|"events:source":\[/);
    expect(events[0]?.resource).not.toMatch(/\*|default/);
    // Off, no events call at all.
    expect(JSON.stringify(policyStatementsOf(apiTemplate(), 'AgentsLambdaRole'))).not.toMatch(/events:/);
  });

  it('name the Agents API\'s role with the module on (the bus\'s policy admits it by that ARN), generated without', () => {
    const roleName = (template: Template) => Object.entries(template.findResources('AWS::IAM::Role'))
      .find(([id]) => id.startsWith('AgentsLambdaRole'))?.[1]?.Properties?.RoleName;
    expect(roleName(on())).toStrictEqual(
      { 'Fn::Join': ['', ['voc-agents-api-', { Ref: 'AWS::AccountId' }, '-', { Ref: 'AWS::Region' }]] });
    expect(roleName(apiTemplate())).toBeUndefined();
  });

  it('cap every run it starts: 50 USD and 10 million tokens by default, the deployment\'s own when set', () => {
    const env = serviceEnvironment(on(), 'voc-agents-api');
    expect([env.ENGINEERING_RUN_CAP_USD, env.ENGINEERING_RUN_TOKEN_CAP]).toStrictEqual(['50', '10000000']);
    const scope = (context: Record<string, unknown>) => new cdk.App({ context });
    expect(engineeringRunCaps(scope({ engineeringRunCapUsd: '12.50', engineeringRunTokenCap: 2_000_000 })))
      .toStrictEqual({ ENGINEERING_RUN_CAP_USD: '12.50', ENGINEERING_RUN_TOKEN_CAP: '2000000' });
  });

  it.each([
    [{ engineeringRunCapUsd: '0' }], [{ engineeringRunCapUsd: '-5' }], [{ engineeringRunCapUsd: '1.005' }],
    [{ engineeringRunCapUsd: 'lots' }], [{ engineeringRunTokenCap: '1.5' }], [{ engineeringRunTokenCap: '0' }],
  ])('refuse a run cap that is not a positive number, so no run is uncapped (%j)', (context) => {
    expect(() => engineeringRunCaps(new cdk.App({ context }))).toThrow(/is a positive/);
  });

  it('write and delete the connections\' credentials where the broker reads them, and never read one back', () => {
    const statements = policyStatementsOf(on(), 'AgentsLambdaRole');
    const parameters = '{"Fn::Join":["",["arn:",{"Ref":"AWS::Partition"},":ssm:us-east-1:111111111111:parameter/voc/engineering/*"]]}';
    const ssm = statements.filter((statement) => statement.actions.some((action) => action.startsWith('ssm:')));
    // (7.57.00: and the user authorizations' own path, never read either: engineering-user-auth.test.ts)
    expect(ssm.map((statement) => [[...statement.actions].sort(byCodeUnit), statement.resource]))
      .toStrictEqual([[['ssm:DeleteParameter', 'ssm:PutParameter'], parameters],
        [['ssm:DeleteParameter', 'ssm:PutParameter'], expect.stringContaining('parameter/voc/engineering-user-auth/app/*')],
        [['ssm:DeleteParameter'], expect.stringContaining('parameter/voc/engineering-user-auth/user/*')]]);
    expect(ssm.map((statement) => statement.condition)).toStrictEqual([undefined, undefined, undefined]);
    // No read of a parameter in any form, so the Agents API never holds a stored credential in clear.
    expect(JSON.stringify(statements)).not.toMatch(/ssm:Get|ssm:\*|ssm:Describe/);
  });

  it('name the connections\' parameter path and key to the agents API', () => {
    const env = serviceEnvironment(on(), 'voc-agents-api');
    expect(env.ENGINEERING_PARAMETER_PREFIX).toBe('/voc/engineering/');
    expect(JSON.stringify(env.ENGINEERING_PARAMETER_KEY)).toContain('Fn::ImportValue');
  });

  it('encrypt a credential with the stack\'s key only through SSM and only for the connections\' parameters', () => {
    const statements = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.includes('kms:Encrypt') && /ssm\./.test(JSON.stringify(statement.condition)));
    // (7.57.00: the second, the Apps' OAuth clients alone: engineering-user-auth.test.ts)
    expect(statements.map((statement) => [...statement.actions].sort(byCodeUnit)))
      .toStrictEqual([['kms:Encrypt', 'kms:GenerateDataKey'], ['kms:Encrypt', 'kms:GenerateDataKey']]);
    expect(statements[0]?.condition).toStrictEqual({
      StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
      StringLike: {
        'kms:EncryptionContext:PARAMETER_ARN': {
          'Fn::Join': ['', ['arn:', { Ref: 'AWS::Partition' }, ':ssm:us-east-1:111111111111:parameter/voc/engineering/*']],
        },
      },
    });
    expect(statements[0]?.resource).toContain('Fn::ImportValue');
  });

  it('use the stack\'s key only through DynamoDB, S3 and SSM, each for what the role does there', () => {
    const keys = policyStatementsOf(on(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.some((action) => action.startsWith('kms:')));
    // Every statement on the key names the one service that calls KMS for it: none the role could use itself.
    const via = (service: string) => ({ 'kms:ViaService': `${service}.us-east-1.amazonaws.com` });
    expect(keys.map((statement) => [statement.condition, [...statement.actions].sort(byCodeUnit)])).toStrictEqual([
      [{ StringEquals: via('dynamodb') }, ['kms:Decrypt', 'kms:Encrypt', 'kms:GenerateDataKey',
        'kms:GenerateDataKeyWithoutPlaintext', 'kms:ReEncryptFrom', 'kms:ReEncryptTo']],
      [{ StringEquals: via('s3') }, ['kms:Decrypt']],
      [expect.objectContaining({ StringEquals: via('ssm') }), ['kms:Encrypt', 'kms:GenerateDataKey']],
      // (7.50.00: the readiness probe's create-only put, through S3)
      [{ StringEquals: via('s3') }, ['kms:GenerateDataKey']],
      // (7.57.00: the Apps' OAuth clients, through SSM)
      [expect.objectContaining({ StringEquals: via('ssm') }), ['kms:Encrypt', 'kms:GenerateDataKey']],
    ]);
    expect(new Set(keys.map((statement) => statement.resource)).size).toBe(1);
  });

  it('use the stack\'s key only through DynamoDB while the module is off', () => {
    const keys = policyStatementsOf(apiTemplate(), 'AgentsLambdaRole')
      .filter((statement) => statement.actions.some((action) => action.startsWith('kms:')));
    expect(keys.map((statement) => statement.condition)).toStrictEqual([
      { StringEquals: { 'kms:ViaService': 'dynamodb.us-east-1.amazonaws.com' } }]);
  });

  it('give the agents API no SSM grant while the module is off', () => {
    const statements = policyStatementsOf(apiTemplate(), 'AgentsLambdaRole');
    expect(JSON.stringify(statements)).not.toMatch(/ssm:|PARAMETER_ARN/);
  });

  it('give the MCP endpoint nothing of the module: its engineering tools (7.53.00) go through the agents API', () => {
    // (an MCP token is never an admin: each engineering tool is admitted by the agents API for its one operation)
    const env = serviceEnvironment(on(), GLOBAL_MCP_SERVICE_NAME);
    expect(Object.keys(env).filter((name) => name.startsWith('ENGINEERING_'))).toStrictEqual([]);
    expect(JSON.stringify(policyStatementsOf(on(), 'GlobalEndpointRole'))).not.toMatch(/Engineering|RUNREQ/);
  });
});

describe('the alarm on denied workspace reads (alerting, created at runtime only once an admin turns it on)', () => {
  it('names the readers\' services to the logs API only with the module, the agents API\'s among them', () => {
    expect(serviceEnvironment(apiTemplate(), 'voc-logs-api').OPS_ALERTS_ENGINEERING_SERVICES).toBeUndefined();
    expect(serviceEnvironment(on(), 'voc-logs-api').OPS_ALERTS_ENGINEERING_SERVICES)
      .toBe(ENGINEERING_WORKSPACE_READER_SERVICES.join(','));
    expect(serviceEnvironment(on(), 'voc-agents-api').POWERTOOLS_SERVICE_NAME).toBe(ENGINEERING_WORKSPACE_READER_SERVICES[0]);
  });
});

describe('the web app\'s engineering flag (owner decision 28: New engineering flow only with the module)', {
  timeout: SYNTH_TIMEOUT_MS,
}, () => {
  const engineeringFeature = (stack: VocApiStack): unknown => {
    const features: unknown = stack.runtimeConfig['features'];
    return typeof features === 'object' && features !== null ? Object.entries(features)
      .find(([key]) => key === 'engineering')?.[1] : undefined;
  };

  it('is off, with no output, by default', () => {
    expect(engineeringFeature(buildApiStack())).toBe(false);
    expect(Object.keys(apiTemplate().findOutputs('EngineeringAvailable'))).toStrictEqual([]);
  });

  it('is on, with the EngineeringAvailable output deploy:frontend reads, with -c engineeringAgents=true', () => {
    expect(engineeringFeature(onStack())).toBe(true);
    expect(Object.values(on().findOutputs('EngineeringAvailable')).map((output) => output.Value)).toStrictEqual(['true']);
  });
});
