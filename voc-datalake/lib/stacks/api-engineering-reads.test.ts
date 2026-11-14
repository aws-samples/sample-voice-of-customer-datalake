/**
 * The agents API's reads of an engineering run (api-assistant-lambdas.ts; lambda/engineering/views.py): nothing by
 * default; with -c engineeringAgents=true the agents API gets the switch, the table and the bucket, exactly the reads
 * its views make, and the engineering package in its bundle. The reads are admin-only, so the global MCP endpoint
 * (whose tokens never act as an admin) gets no engineering tool and nothing of the module.
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

const ENGINEERING_ENV = ['ENGINEERING_AGENTS', 'ENGINEERING_BOARD_FUNCTION', 'ENGINEERING_PARAMETER_KEY',
  'ENGINEERING_PARAMETER_PREFIX', 'ENGINEERING_RUN_CAP_USD', 'ENGINEERING_RUN_TOKEN_CAP', 'ENGINEERING_START_FUNCTION',
  'ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'];
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

describe('the engineering run reads', () => {
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

  it('grant the agents API only reads of the table and the reports: no write of any kind', () => {
    const statements = engineeringStatements(on());
    expect(actionsWithPrefix(statements, '')).toStrictEqual(['dynamodb:GetItem', 'dynamodb:Query', 's3:GetObject']);
    expect(JSON.stringify(statements)).not.toMatch(/Delete|Put|Update|BatchWrite/);
    const objects = statements.filter((statement) => statement.actions.includes('s3:GetObject'));
    expect(objects.map((statement) => statement.resource)).toStrictEqual([expect.stringMatching(/"\/ws\/default\/reports\/\*"/)]);
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
      ['lambda:InvokeFunction']]);
    expect(engineering.map((statement) => statement.resource)).toStrictEqual([
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-board-",/),
      expect.stringMatching(/:lambda:[^"]*:function:voc-engineering-start-",/)]);
    // The runtime itself (tick, launch, signal, end_run) is not this role's to invoke, in any form.
    expect(JSON.stringify(invokes)).not.toMatch(/voc-engineering-(runtime|delivery)/);
    expect(JSON.stringify(serviceEnvironment(on(), 'voc-agents-api').ENGINEERING_START_FUNCTION))
      .toMatch(/^"?\S*voc-engineering-start-/);
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
    expect(ssm.map((statement) => [[...statement.actions].sort(byCodeUnit), statement.resource]))
      .toStrictEqual([[['ssm:DeleteParameter', 'ssm:PutParameter'], parameters]]);
    expect(ssm[0]?.condition).toBeUndefined();
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
    expect(statements.map((statement) => [...statement.actions].sort(byCodeUnit)))
      .toStrictEqual([['kms:Encrypt', 'kms:GenerateDataKey']]);
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

  it('give the MCP endpoint nothing: the reads are admin-only and an MCP token is never an admin, so no tool', () => {
    const env = serviceEnvironment(on(), GLOBAL_MCP_SERVICE_NAME);
    expect(Object.keys(env).filter((name) => name.startsWith('ENGINEERING_'))).toStrictEqual([]);
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

describe('the web app\'s engineering flag (owner decision 28: New engineering flow only with the module)', () => {
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
