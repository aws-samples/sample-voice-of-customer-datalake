/**
 * The agents API's reads of an engineering run (api-assistant-lambdas.ts; lambda/engineering/views.py): nothing by
 * default; with -c engineeringAgents=true the agents API gets the switch, the table and the bucket, exactly the reads
 * its views make, and the engineering package in its bundle. The reads are admin-only, so the global MCP endpoint
 * (whose tokens never act as an admin) gets no engineering tool and nothing of the module.
 */
import { describe, expect, it } from 'vitest';
import { Template } from 'aws-cdk-lib/assertions';

import { byCodeUnit } from '../utils/compare';
import { GLOBAL_MCP_SERVICE_NAME } from '../utils/function-names';
import {
  actionsWithPrefix, apiTemplate, buildApiStack, policyStatementsOf, serviceEnvironment,
} from '../test-support/api-stack-template';
import type { VocApiStack } from './api-stack';
import { ENGINEERING_WORKSPACE_READER_SERVICES } from './dlq-alarms';

const ENGINEERING_ENV = ['ENGINEERING_AGENTS', 'ENGINEERING_BOARD_FUNCTION', 'ENGINEERING_TABLE', 'ENGINEERING_WORKSPACE_BUCKET'];
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
