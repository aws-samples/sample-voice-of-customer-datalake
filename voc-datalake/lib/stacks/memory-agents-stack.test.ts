/**
 * Infrastructure for Company context, Memory and Autonomous agents
 * (docs/memory.md, docs/autonomous-agents.md, docs/company-context.md).
 *
 * What is pinned, and why:
 *   - EXACT DynamoDB action sets per new role. "Never delete" is the product
 *     rule (forget = tombstone + archive; agents archive; runs are an audit
 *     trail), so an absent DeleteItem is asserted rather than assumed.
 *   - The conductor/persona panel reach project data ONLY through the Projects
 *     API (invoke by unqualified name), never the projects table.
 *   - The voc-agent-run contract the conductor handler implements: Decide's
 *     four result keys, the Choice values, the panel Map's concurrency, 24 h.
 *   - Every new route is Cognito-authenticated (the whole-template invariant in
 *     api-stack.test.ts covers the rest of the API; this names the new ones).
 *   - Each new policy stays under 70% of the inline IAM quota.
 */
import * as fs from 'fs';
import * as path from 'path';

import * as cdk from 'aws-cdk-lib';
import { Template } from 'aws-cdk-lib/assertions';
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { VocApiStack } from './api-stack';
import { VocCoreStack } from './core-stack';
import { apiStackDependencyProps, indexedTableFactory } from '../test-support/api-stack-fixture';
import { allowedActions, roleStatements, type NormalizedStatement } from '../test-support/iam-statements';
import { stateMachineDefinition, synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { EMBEDDING_MODEL_ID } from '../utils/model-allowlist';
import { byCodeUnit } from '../utils/compare';
import { itemAt } from '../test-support/guards';

const ENV = { account: '111111111111', region: 'us-east-1' };

/** IAM inline-policy quota and the warn fraction api-stack.test.ts uses. */
const INLINE_POLICY_LIMIT = 10_240;
const WARN_FRACTION = 0.7;

/**
 * A physical name as text. Names are `uniqueName()` results — an Fn::Join of
 * the base name and the account/region tokens — so the base name is matched
 * inside the serialized value rather than as a string prefix.
 */
function physicalName(value: unknown): string {
  return JSON.stringify(value);
}

function logicalIdStartingWith(template: Template, type: string, prefix: string): string {
  const ids = Object.keys(template.findResources(type)).filter((id) => id.startsWith(prefix));
  expect(ids, `expected exactly one ${type} ${prefix}*`).toHaveLength(1);
  return itemAt(ids, 0);
}

function statementsOfRole(template: Template, rolePrefix: string): NormalizedStatement[] {
  return roleStatements(template, logicalIdStartingWith(template, 'AWS::IAM::Role', rolePrefix));
}

const FunctionSchema = z.object({
  Properties: z.object({
    Handler: z.string(),
    Timeout: z.number(),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});

function functionProps(template: Template, prefix: string) {
  const id = logicalIdStartingWith(template, 'AWS::Lambda::Function', prefix);
  return FunctionSchema.parse(template.findResources('AWS::Lambda::Function')[id]).Properties;
}

function allActions(statements: NormalizedStatement[]): string[] {
  return statements.filter((s) => s.effect === 'Allow').flatMap((s) => s.actions);
}

/** `lambda:InvokeFunction` resources, serialized. */
function invokeResources(statements: NormalizedStatement[]): string {
  return statements.filter((s) => s.actions.includes('lambda:InvokeFunction')).map((s) => s.resource).join(' ');
}

const PolicySchema = z.object({ Properties: z.object({ PolicyDocument: z.unknown(), Roles: z.array(z.unknown()) }) });

/** Serialized size of the inline policy attached to the role `rolePrefix*`. */
function policyChars(template: Template, rolePrefix: string): number {
  const roleId = logicalIdStartingWith(template, 'AWS::IAM::Role', rolePrefix);
  const policies = Object.values(template.findResources('AWS::IAM::Policy'))
    .map((resource) => PolicySchema.parse(resource).Properties)
    .filter((policy) => JSON.stringify(policy.Roles).includes(`"${roleId}"`));
  expect(policies).toHaveLength(1);
  return JSON.stringify(itemAt(policies, 0).PolicyDocument).length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Processing: memory workers + agent runtime
// ─────────────────────────────────────────────────────────────────────────────

/** One synth for both processing suites (each whole-stack synth is the slow part). */
let processingTemplate: Template | undefined;
function processing(): Template {
  processingTemplate ??= synthProcessingTemplate({ withIndexes: true });
  return processingTemplate;
}

describe('memory workers (VocProcessingStack)', () => {
  let template: Template;
  beforeAll(() => { template = processing(); });

  it('runs each worker from the memory tree with a path-style handler', () => {
    expect(functionProps(template, 'MemoryWorkersMemoryExtractor').Handler).toBe('memory/extractor/handler.lambda_handler');
    expect(functionProps(template, 'MemoryWorkersMemoryScanner').Handler).toBe('memory/scanner/handler.lambda_handler');
    expect(functionProps(template, 'MemoryWorkersMemoryRetention').Handler).toBe('memory/retention/handler.lambda_handler');
  });

  it('gives the memory-extract queue a DLQ, KMS and a visibility timeout ≥ 6× the extractor timeout', () => {
    const queueId = logicalIdStartingWith(template, 'AWS::SQS::Queue', 'MemoryWorkersMemoryExtractQueue');
    const queue = z.object({ Properties: z.object({
      QueueName: z.unknown(),
      VisibilityTimeout: z.number(),
      KmsMasterKeyId: z.unknown(),
      RedrivePolicy: z.object({ maxReceiveCount: z.number() }),
    }) }).parse(template.findResources('AWS::SQS::Queue')[queueId]).Properties;
    expect(physicalName(queue.QueueName)).toContain('voc-memory-extract-');
    expect(queue.KmsMasterKeyId).toBeDefined();
    expect(queue.RedrivePolicy.maxReceiveCount).toBe(3);
    expect(queue.VisibilityTimeout).toBeGreaterThanOrEqual(6 * functionProps(template, 'MemoryWorkersMemoryExtractor').Timeout);
  });

  it('schedules the scanner every 15 minutes and retention once a day', () => {
    const schedules = Object.values(template.findResources('AWS::Events::Rule'))
      .map((rule) => z.object({ Properties: z.object({ Name: z.unknown(), ScheduleExpression: z.string() }) }).safeParse(rule).data?.Properties)
      .filter((p) => p !== undefined);
    const byName = (stem: string) => schedules.find((p) => physicalName(p.Name).includes(stem))?.ScheduleExpression;
    expect(byName('voc-memory-scanner-schedule')).toBe('rate(15 minutes)');
    expect(byName('voc-memory-retention-schedule')).toBe('cron(15 3 * * ? *)');
  });


  it('extractor: imports read-only, Titan V2 granted', () => {
    const s = statementsOfRole(template, 'MemoryWorkersMemoryExtractorRole');
    const s3 = s.filter((st) => st.actions.some((a) => a.startsWith('s3:')));
    expect(s3.map((st) => st.resource).join(' ')).toContain('/memory-imports/*');
    expect(s3.flatMap((st) => st.actions).filter((a) => /^s3:(Put|Delete)/.test(a))).toStrictEqual([]);
    expect(s.map((st) => st.resource).join(' ')).toContain(`foundation-model/${EMBEDDING_MODEL_ID}`);
  });

  it('scanner: Scan conversations, cursor rows, send to the queue — nothing else on tables', () => {
    const s = statementsOfRole(template, 'MemoryWorkersMemoryScannerRole');
    expect(allActions(s)).toContain('sqs:SendMessage');
    expect(allActions(s).some((a) => a.startsWith('bedrock:'))).toBe(false);
  });

  it('retention: archives in place on voc-memory only', () => {
    const s = statementsOfRole(template, 'MemoryWorkersMemoryRetentionRole');
    expect(allActions(s).filter((a) => a.startsWith('dynamodb:'))).toStrictEqual(
      expect.not.arrayContaining(['dynamodb:DeleteItem', 'dynamodb:BatchWriteItem']),
    );
  });
});

describe('agent runtime (VocProcessingStack)', () => {
  let template: Template;
  let definition: string;
  beforeAll(() => {
    template = processing();
    definition = stateMachineDefinition(template, 'AgentRuntimeAgentRunStateMachine');
  });

  it('runs each worker from the agents tree with a path-style handler', () => {
    expect(functionProps(template, 'AgentRuntimeAgentConductor').Handler).toBe('agents/conductor/handler.lambda_handler');
    expect(functionProps(template, 'AgentRuntimeAgentNodes').Handler).toBe('agents/nodes/handler.lambda_handler');
    expect(functionProps(template, 'AgentRuntimeAgentPersonaPanel').Handler).toBe('agents/persona_panel/handler.lambda_handler');
    expect(functionProps(template, 'AgentRuntimeAgentHeartbeat').Handler).toBe('agents/heartbeat/handler.lambda_handler');
  });

  it('names voc-agent-run and caps a run at 24 hours', () => {
    const id = logicalIdStartingWith(template, 'AWS::StepFunctions::StateMachine', 'AgentRuntimeAgentRunStateMachine');
    const machine = z.object({ Properties: z.object({
      StateMachineName: z.unknown(),
      LoggingConfiguration: z.object({ IncludeExecutionData: z.boolean(), Level: z.string() }),
    }) }).parse(template.findResources('AWS::StepFunctions::StateMachine')[id]).Properties;
    expect(physicalName(machine.StateMachineName)).toContain('voc-agent-run-');
    expect(definition.replace(/\s/g, '')).toContain('"TimeoutSeconds":86400');
    // Every transition logged, never a payload (documents and reviews).
    expect(machine.LoggingConfiguration).toStrictEqual({ IncludeExecutionData: false, Level: 'ALL' });
  });

  it('is the runtime\'s own rendered definition, with every placeholder substituted', () => {
    const asl = fs.readFileSync(path.join(__dirname, '../../lambda/agents/state_machine.asl.json'), 'utf8');
    for (const action of ['init', 'advance', 'fail', 'start', 'poll']) {
      expect(asl).toContain(`"action": "${action}"`);
    }
    const machines = template.findResources('AWS::StepFunctions::StateMachine');
    const id = logicalIdStartingWith(template, 'AWS::StepFunctions::StateMachine', 'AgentRuntimeAgentRunStateMachine');
    const substitutions = z.object({ Properties: z.object({ DefinitionSubstitutions: z.record(z.string(), z.unknown()) }) })
      .parse(machines[id]).Properties.DefinitionSubstitutions;
    expect(Object.keys(substitutions).sort(byCodeUnit)).toStrictEqual(['ConductorFunctionArn', 'NodesFunctionArn', 'PersonaPanelFunctionArn']);
    expect(JSON.stringify(substitutions.NodesFunctionArn)).toContain('AgentRuntimeAgentNodes');
  });


  it('conductor: invokes the Projects API by unqualified name, not the memory API', () => {
    const invokes = invokeResources(statementsOfRole(template, 'AgentRuntimeAgentConductorRole'));
    expect(invokes).toContain(':function:voc-projects-api-');
    expect(invokes).not.toContain('voc-memory-api');
    expect(invokes).not.toContain(':*');
  });

  it('conductor: feeds the memory-extract queue and never drives Step Functions', () => {
    const s = statementsOfRole(template, 'AgentRuntimeAgentConductorRole');
    expect(allActions(s)).toContain('sqs:SendMessage');
    expect(allActions(s).some((a) => a.startsWith('states:'))).toBe(false);
    expect(functionProps(template, 'AgentRuntimeAgentConductor').Environment.Variables).toHaveProperty('MEMORY_EXTRACT_QUEUE_URL');
  });


  it('nodes: invokes the reviews, projects and memory API Lambdas, named in its environment', () => {
    const invokes = invokeResources(statementsOfRole(template, 'AgentRuntimeAgentNodesRole'));
    for (const api of ['voc-projects-api', 'voc-metrics-api', 'voc-memory-api']) {
      expect(invokes).toContain(`:function:${api}-`);
    }
    expect(invokes).not.toContain(':*');
    const env = functionProps(template, 'AgentRuntimeAgentNodes').Environment.Variables;
    for (const key of ['PROJECTS_FUNCTION', 'METRICS_FUNCTION', 'MEMORY_FUNCTION', 'RAW_DATA_BUCKET']) {
      expect(env).toHaveProperty(key);
    }
  });


  it('persona panel: invokes the Projects API only', () => {
    const s = statementsOfRole(template, 'AgentRuntimeAgentPersonaPanelRole');
    expect(invokeResources(s)).toContain(':function:voc-projects-api-');
    expect(invokeResources(s)).not.toContain('voc-memory-api');
  });

  it('heartbeat: evaluates triggers and starts voc-agent-run, every 15 minutes', () => {
    const s = statementsOfRole(template, 'AgentRuntimeAgentHeartbeatRole');
    expect(allActions(s)).toContain('states:StartExecution');
    expect(Object.keys(functionProps(template, 'AgentRuntimeAgentHeartbeat').Environment.Variables)).toContain('AGENT_RUN_STATE_MACHINE_ARN');
  });

  it('grants no DeleteItem to any new worker role', () => {
    for (const prefix of ['MemoryWorkersMemory', 'AgentRuntimeAgent']) {
      const roleIds = Object.keys(template.findResources('AWS::IAM::Role')).filter((id) => id.startsWith(prefix));
      for (const roleId of roleIds) {
        expect(allActions(roleStatements(template, roleId)), roleId).not.toContain('dynamodb:DeleteItem');
      }
    }
  });

  it('keeps every new role policy under 70% of the inline IAM quota', () => {
    for (const prefix of [
      'MemoryWorkersMemoryExtractorRole', 'MemoryWorkersMemoryScannerRole', 'MemoryWorkersMemoryRetentionRole',
      'AgentRuntimeAgentConductorRole', 'AgentRuntimeAgentNodesRole', 'AgentRuntimeAgentPersonaPanelRole', 'AgentRuntimeAgentHeartbeatRole',
    ]) {
      expect(policyChars(template, prefix), prefix).toBeLessThan(INLINE_POLICY_LIMIT * WARN_FRACTION);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Api: memory + agents APIs, settings additions, stream delegation, routes
// ─────────────────────────────────────────────────────────────────────────────

function synthApi(): Template {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [], skipFrontendBuildCheck: true } });
  const deps = new cdk.Stack(app, 'TestDeps', { env: ENV });
  const table = indexedTableFactory(deps);
  const stack = new VocApiStack(app, 'TestApiStack', {
    env: ENV,
    ...apiStackDependencyProps(deps, ENV, table),
    brandName: 'TestBrand',
    enabledSources: [],
  });
  return Template.fromStack(stack);
}

/** One API synth shared by the API suite and the grants manifest suite. */
let apiTemplate: Template | undefined;
function api(): Template {
  apiTemplate ??= synthApi();
  return apiTemplate;
}

const MethodSchema = z.object({
  Properties: z.object({ HttpMethod: z.string(), AuthorizationType: z.string().optional(), ResourceId: z.unknown() }),
});
const ResourceSchema = z.object({ Properties: z.object({ PathPart: z.string(), ParentId: z.unknown() }) });

/** `METHOD /full/path` → AuthorizationType, for every method in the API. */
function routeAuthorization(template: Template): Map<string, string> {
  const resources = template.findResources('AWS::ApiGateway::Resource');
  const pathOf = (ref: unknown): string => {
    const id = z.object({ Ref: z.string() }).safeParse(ref).data?.Ref;
    const resource = id === undefined ? undefined : resources[id];
    if (!resource) return '';
    const parsed = ResourceSchema.parse(resource).Properties;
    return `${pathOf(parsed.ParentId)}/${parsed.PathPart}`;
  };
  const routes = new Map<string, string>();
  for (const method of Object.values(template.findResources('AWS::ApiGateway::Method'))) {
    const p = MethodSchema.parse(method).Properties;
    routes.set(`${p.HttpMethod} ${pathOf(p.ResourceId)}`, p.AuthorizationType ?? 'NONE');
  }
  return routes;
}

describe('memory + agents APIs (VocApiStack)', () => {
  let template: Template;
  beforeAll(() => { template = api(); });

  it('serves /memory, /agents and /workflows — collection and proxy — all behind Cognito', () => {
    const routes = routeAuthorization(template);
    const expected = ['/memory', '/agents', '/workflows'].flatMap((root) => [
      `GET ${root}`, `POST ${root}`, `ANY ${root}/{proxy+}`,
    ]);
    for (const route of expected) {
      expect(routes.get(route), route).toBe('COGNITO_USER_POOLS');
    }
    const fresh = [...routes.entries()].filter(([route]) => /^\S+ \/(memory|agents|workflows)(\/|$)/.test(route) && !route.startsWith('OPTIONS'));
    expect(fresh.filter(([, auth]) => auth !== 'COGNITO_USER_POOLS')).toStrictEqual([]);
  });

  it('memory API: feeds the memory-extract queue', () => {
    const s = statementsOfRole(template, 'MemoryLambdaRole');
    expect(allActions(s)).toContain('sqs:SendMessage');
  });

  it('memory API: imports put/get without delete, Titan V2, its own handler', () => {
    const s = statementsOfRole(template, 'MemoryLambdaRole');
    expect(allActions(s).filter((a) => a.startsWith('s3:Delete'))).toStrictEqual([]);
    expect(s.map((st) => st.resource).join(' ')).toContain('/memory-imports/*');
    expect(s.map((st) => st.resource).join(' ')).toContain(`foundation-model/${EMBEDDING_MODEL_ID}`);
    expect(functionProps(template, 'MemoryApi').Handler).toBe('memory_handler.lambda_handler');
  });

  it('agents API: starts + stops voc-agent-run', () => {
    const s = statementsOfRole(template, 'AgentsLambdaRole');
    expect(allActions(s)).toStrictEqual(expect.arrayContaining(['states:StartExecution', 'states:StopExecution', 'states:DescribeExecution']));
    expect(functionProps(template, 'AgentsApi').Handler).toBe('agents_handler.lambda_handler');
  });

  it('agents API: stops executions of voc-agent-run only', () => {
    const stop = statementsOfRole(template, 'AgentsLambdaRole').filter((st) => st.actions.includes('states:StopExecution'));
    expect(stop).toHaveLength(1);
    expect(itemAt(stop, 0).resource).toContain(':execution:');
    expect(itemAt(stop, 0).resource).toContain('FnGetAttAgentRun');
  });

  it('settings API: reads/writes the design-integrations secret and company-context/* (no delete)', () => {
    const s = statementsOfRole(template, 'SettingsLambdaRole');
    const secret = s.filter((st) => st.resource.includes('secret:design-integrations'));
    expect(secret.flatMap((st) => st.actions).sort(byCodeUnit)).toStrictEqual(['secretsmanager:GetSecretValue', 'secretsmanager:PutSecretValue']);
  });

  it('settings API: writes company-context/* without delete, and is told both names', () => {
    const s = statementsOfRole(template, 'SettingsLambdaRole');
    const companyContext = s.filter((st) => st.resource.includes('/company-context/*'));
    expect(companyContext.flatMap((st) => st.actions)).toStrictEqual(expect.arrayContaining(['s3:PutObject']));
    expect(companyContext.flatMap((st) => st.actions).filter((a) => a.startsWith('s3:Delete'))).toStrictEqual([]);
    expect(Object.keys(functionProps(template, 'SettingsApi').Environment.Variables)).toStrictEqual(
      expect.arrayContaining(['DESIGN_INTEGRATIONS_SECRET_ARN', 'RAW_DATA_BUCKET']),
    );
  });

  it('hands the stream assistant the memory and agents function names', () => {
    const vars = functionProps(template, 'ChatStreamApi').Environment.Variables;
    expect(vars).toHaveProperty('MEMORY_FUNCTION');
    expect(vars).toHaveProperty('AGENTS_FUNCTION');
  });

  it('keeps the new API role policies under 70% of the inline IAM quota', () => {
    for (const prefix of ['MemoryLambdaRole', 'AgentsLambdaRole', 'SettingsLambdaRole']) {
      expect(policyChars(template, prefix), prefix).toBeLessThan(INLINE_POLICY_LIMIT * WARN_FRACTION);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DynamoDB grants: the stack equals memory-agents-dynamodb-grants.json, which
// the backend suite enforces on every moto call (lambda/shared/test/strict_iam.py)
// ─────────────────────────────────────────────────────────────────────────────

const GrantsManifestSchema = z.object({
  tables: z.record(z.string(), z.string()),
  roles: z.record(z.string(), z.object({
    stack: z.enum(['processing', 'api']),
    entry: z.string(),
    grants: z.record(z.string(), z.array(z.string())),
  })),
});
const grantsManifest = GrantsManifestSchema.parse(JSON.parse(
  fs.readFileSync(path.join(__dirname, 'memory-agents-dynamodb-grants.json'), 'utf8'),
));

describe('memory + agents DynamoDB grants (memory-agents-dynamodb-grants.json)', () => {
  const roles = Object.entries(grantsManifest.roles);
  const tables = Object.keys(grantsManifest.tables);

  it('names every memory/agents Lambda role, each with an entry module that exists', () => {
    expect(roles.map(([role]) => role).sort(byCodeUnit)).toStrictEqual([
      'AgentRuntimeAgentConductorRole', 'AgentRuntimeAgentHeartbeatRole', 'AgentRuntimeAgentNodesRole',
      'AgentRuntimeAgentPersonaPanelRole', 'AgentsLambdaRole', 'MemoryLambdaRole',
      'MemoryWorkersMemoryExtractorRole', 'MemoryWorkersMemoryRetentionRole', 'MemoryWorkersMemoryScannerRole',
    ]);
    for (const [role, spec] of roles) {
      expect(fs.existsSync(path.join(__dirname, '../../lambda', spec.entry)), role).toBe(true);
    }
  });

  it.each(roles)('%s holds exactly the manifest actions on each table', (role, spec) => {
    const s = statementsOfRole(spec.stack === 'api' ? api() : processing(), role);
    for (const table of tables) {
      expect(allowedActions(s, 'dynamodb:', `FnGetAtt${table}`), `${role} on ${table}`)
        .toStrictEqual([...(spec.grants[table] ?? [])].sort(byCodeUnit));
    }
    // Nothing on a table the manifest does not name, and never a delete.
    const granted = new Set(Object.values(spec.grants).flat());
    expect(allActions(s).filter((a) => a.startsWith('dynamodb:') && !granted.has(a))).toStrictEqual([]);
    expect(allActions(s)).not.toContain('dynamodb:DeleteItem');
  });

  it('gives both session-cursor readers the BatchGetItem store.get_cursors sends', () => {
    for (const role of ['MemoryWorkersMemoryScannerRole', 'MemoryWorkersMemoryExtractorRole']) {
      expect(allowedActions(statementsOfRole(processing(), role), 'dynamodb:', 'FnGetAttMemory'), role)
        .toContain('dynamodb:BatchGetItem');
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// Core: tables + secret
// ─────────────────────────────────────────────────────────────────────────────

describe('memory + agents storage (VocCoreStack)', () => {
  let template: Template;
  beforeAll(() => {
    const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
    template = Template.fromStack(new VocCoreStack(app, 'TestCore', { env: ENV, brandName: 'TestBrand' }));
  });

  const TableSchema = z.object({
    DeletionPolicy: z.string(),
    Properties: z.object({
      TableName: z.unknown(),
      BillingMode: z.string(),
      PointInTimeRecoverySpecification: z.object({ PointInTimeRecoveryEnabled: z.boolean() }),
      SSESpecification: z.object({ SSEEnabled: z.boolean(), SSEType: z.string(), KMSMasterKeyId: z.unknown() }),
      GlobalSecondaryIndexes: z.array(z.object({ IndexName: z.string() })),
    }),
  });
  const table = (prefix: string) => TableSchema.parse(
    template.findResources('AWS::DynamoDB::Table')[logicalIdStartingWith(template, 'AWS::DynamoDB::Table', prefix)],
  );

  it.each([
    ['MemoryTable', 'voc-memory-', 'gsi1-by-memory-status'],
    ['AgentsTable', 'voc-agents-', 'gsi1-by-agents-listing'],
  ])('%s is RETAINed under its name, with its gsi1', (prefix, name, index) => {
    const t = table(prefix);
    expect(t.DeletionPolicy).toBe('Retain');
    expect(physicalName(t.Properties.TableName)).toContain(name);
    expect(t.Properties.GlobalSecondaryIndexes.map((i) => i.IndexName)).toStrictEqual([index]);
  });

  it.each(['MemoryTable', 'AgentsTable'])('%s is on-demand, KMS-encrypted, with PITR', (prefix) => {
    const t = table(prefix);
    expect(t.Properties.BillingMode).toBe('PAY_PER_REQUEST');
    expect(t.Properties.PointInTimeRecoverySpecification.PointInTimeRecoveryEnabled).toBe(true);
    expect(t.Properties.SSESpecification).toStrictEqual({ SSEEnabled: true, SSEType: 'KMS', KMSMasterKeyId: expect.anything() });
  });

  it('creates the voc/design-integrations secret, KMS-encrypted and RETAINed', () => {
    const secrets = Object.values(template.findResources('AWS::SecretsManager::Secret'))
      .map((s) => z.object({ DeletionPolicy: z.string().optional(), Properties: z.object({ Name: z.unknown(), KmsKeyId: z.unknown() }) }).parse(s))
      .filter((s) => physicalName(s.Properties.Name).includes('voc/design-integrations-'));
    expect(secrets).toHaveLength(1);
    expect(itemAt(secrets, 0).DeletionPolicy).toBe('Retain');
    expect(itemAt(secrets, 0).Properties.KmsKeyId).toBeDefined();
  });
});
