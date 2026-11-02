/**
 * Every Lambda the app synthesizes logs to a log group with a retention period (lib/utils/log-retention.ts),
 * its role writes only that group, and no role holds an AWS managed logging policy (cdk-nag AwsSolutions-IAM4;
 * lib/utils/lambda-log-grants.ts, lib/stacks/api-gateway-logging-role.ts).
 *
 * Found in the 5.25.03 logging audit: the functions CDK creates for us (S3 auto-delete and bucket-notification
 * providers, BucketDeployment's singleton) had no LoggingConfig, so Lambda created their log groups with no
 * retention and those logs never expired. The cross-region export providers are added after aspects run
 * and are the documented exception.
 *
 * Read from the whole app's synthesized templates (bin/voc-datalake.ts): the groups and grants are made by
 * the log-retention aspect, which only the app applies, so a stack built alone would show none.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { ALL_FEATURES_CONTEXT } from '../test-support/all-features-context';
import { apiTemplate, apiTemplatePrefixed } from '../test-support/api-stack-template';
import { cleanupAssemblyDirs, synthApp, SYNTH_ACCOUNT, SYNTH_REGION, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import type { SynthResult } from '../test-support/synth-app';
import { byCodeUnit } from './compare';

const StatementSchema = z.object({
  Sid: z.string().optional(),
  Effect: z.string(),
  Action: z.union([z.string(), z.array(z.string())]),
  Resource: z.unknown(),
});
type Statement = z.infer<typeof StatementSchema>;
const DocumentSchema = z.object({ Statement: z.array(StatementSchema) });
const ResourceSchema = z.object({
  Type: z.string(),
  Properties: z.record(z.string(), z.unknown()).optional(),
  DependsOn: z.array(z.string()).optional(),
});
const TemplateSchema = z.object({ Resources: z.record(z.string(), ResourceSchema) });
type Resources = z.infer<typeof TemplateSchema>['Resources'];
const FunctionSchema = z.object({
  Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) }),
  LoggingConfig: z.object({ LogGroup: z.object({ Ref: z.string() }) }),
});
const InlinePoliciesSchema = z.array(z.object({ PolicyDocument: DocumentSchema })).optional();
const PolicySchema = z.object({ Roles: z.array(z.unknown()), PolicyDocument: DocumentSchema });

const LoggingSchema = z.object({ LogGroup: z.object({ Ref: z.string() }) });

/** Added by CDK during synthesis, after aspects: they cannot be reached (see log-retention.ts). */
const CROSS_REGION_PROVIDER = /^CustomCrossRegionExport(Reader|Writer)CustomResourceProviderHandler/;

const LOG_WRITES = ['logs:CreateLogStream', 'logs:PutLogEvents'];

/** The one statement a function's role carries for its logs. */
function ownGroupWrites(group: string): Statement {
  return { Effect: 'Allow', Action: LOG_WRITES, Resource: { 'Fn::GetAtt': [group, 'Arn'] } };
}

function asList(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [value];
}

function actionsOf(statement: Statement): string[] {
  return asList(statement.Action).map(String);
}

/** Every statement granted to a role: its inline `Policies` and every AWS::IAM::Policy naming it. */
function roleStatements(resources: Resources, roleId: string): Statement[] {
  const inline = InlinePoliciesSchema.parse(resources[roleId]?.Properties?.Policies) ?? [];
  const attached = Object.values(resources)
    .filter((resource) => resource.Type === 'AWS::IAM::Policy')
    .map((resource) => PolicySchema.parse(resource.Properties))
    .filter((policy) => policy.Roles.some((role) => JSON.stringify(role) === JSON.stringify({ Ref: roleId })));
  return [...inline, ...attached].flatMap((policy) => policy.PolicyDocument.Statement);
}

function resourcesOf(synth: SynthResult, stack: string): Resources {
  return TemplateSchema.parse(synth.template(stack)).Resources;
}

function logicalIdStartingWith(resources: Resources, type: string, prefix: string): string {
  const ids = Object.keys(resources).filter((id) => id.startsWith(prefix) && resources[id]?.Type === type);
  const [only, ...more] = ids;
  if (only === undefined || more.length > 0) throw new Error(`${type} ${prefix}*: ${ids.length} matches, want 1`);
  return only;
}

/** The log-group statements of the function whose logical id starts with `prefix`: [its group id, statements]. */
function functionLogGrants(resources: Resources, prefix: string): { group: string; statements: Statement[] } {
  const fn = FunctionSchema.parse(resources[logicalIdStartingWith(resources, 'AWS::Lambda::Function', prefix)]?.Properties);
  const group = fn.LoggingConfig.LogGroup.Ref;
  const statements = roleStatements(resources, fn.Role['Fn::GetAtt'][0])
    .filter((statement) => actionsOf(statement).some((action) => action.startsWith('logs:')));
  return { group, statements };
}

/** Per function: a problem line unless its role grants exactly the two writes on its own group, nothing else. */
function functionProblems(synth: SynthResult): string[] {
  const problems: string[] = [];
  for (const stack of synth.stackNames) {
    const resources = resourcesOf(synth, stack);
    for (const [id, resource] of Object.entries(resources)) {
      if (resource.Type !== 'AWS::Lambda::Function') continue;
      const { group, statements } = functionLogGrants(resources, id);
      const own = { 'Fn::GetAtt': [group, 'Arn'] };
      const writesOwn = statements.some((statement) => asList(statement.Resource).some((r) => JSON.stringify(r) === JSON.stringify(own))
        && JSON.stringify(actionsOf(statement).sort(byCodeUnit)) === JSON.stringify(LOG_WRITES));
      const createsGroups = statements.some((statement) => actionsOf(statement).includes('logs:CreateLogGroup'));
      if (!writesOwn || createsGroups) problems.push(`${stack}/${id}`);
    }
  }
  return problems.sort(byCodeUnit);
}

function rolesWithManagedPolicies(synth: SynthResult): string[] {
  return synth.stackNames.flatMap((stack) => Object.entries(resourcesOf(synth, stack))
    .filter(([, resource]) => resource.Type === 'AWS::IAM::Role' && resource.Properties?.ManagedPolicyArns !== undefined)
    .map(([id]) => `${stack}/${id}`));
}

const logsArn = (name: string): string => `arn:aws:logs:${SYNTH_REGION}:${SYNTH_ACCOUNT}:log-group:${name}`;

const PSEUDO: Readonly<Record<string, string>> = { 'AWS::AccountId': SYNTH_ACCOUNT, 'AWS::Region': SYNTH_REGION, 'AWS::Partition': 'aws' };
const JoinSchema = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) });
const PseudoRefSchema = z.object({ Ref: z.string().refine((name) => name in PSEUDO) });

/** A template value with `Fn::Join` and the account / region / partition pseudo-parameters written out. */
function flatten(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(flatten);
  const join = JoinSchema.safeParse(value);
  if (join.success) return join.data['Fn::Join'][1].map(flatten).map(String).join(join.data['Fn::Join'][0]);
  const ref = PseudoRefSchema.safeParse(value);
  return ref.success ? PSEUDO[ref.data.Ref] : value;
}

/** An IAM resource pattern (`*` = any run of characters) as a whole-string RegExp. */
function iamPattern(pattern: string): RegExp {
  return new RegExp(`^${pattern.split('*').map((part) => part.replace(/[.+?^${}()|[\]\\/]/g, '\\$&')).join('.*')}$`);
}

describe('Lambda log groups and log grants (retention, AwsSolutions-IAM4)', () => {
  let synth: SynthResult;
  // One whole-app synth per hook (the all-features one below), so each gets the per-synth timeout.
  beforeAll(() => { synth = synthApp(); }, SYNTH_TIMEOUT_MS);
  afterAll(() => { cleanupAssemblyDirs(); });

  it('gives every function a log group in its own stack with a retention period', () => {
    const problems: string[] = [];
    let checked = 0;
    for (const stack of synth.stackNames) {
      const { Resources } = TemplateSchema.parse(synth.template(stack));
      for (const [id, resource] of Object.entries(Resources)) {
        if (resource.Type !== 'AWS::Lambda::Function' || CROSS_REGION_PROVIDER.test(id)) continue;
        checked += 1;
        const logging = LoggingSchema.safeParse(resource.Properties?.LoggingConfig);
        const group = logging.success ? Resources[logging.data.LogGroup.Ref] : undefined;
        const retention = group?.Type === 'AWS::Logs::LogGroup' ? group.Properties?.RetentionInDays : undefined;
        if (typeof retention !== 'number') problems.push(`${stack}/${id}`);
      }
    }
    expect(checked).toBeGreaterThan(60);
    expect([...problems].sort(byCodeUnit)).toStrictEqual([]);
  });

  it('gives every function, CDK-created ones included, writes to its own log group only', () => {
    expect(functionProblems(synth)).toStrictEqual([]);
  });

  it('leaves no AWS managed policy on any role', () => {
    expect(rolesWithManagedPolicies(synth)).toStrictEqual([]);
  });

  describe('with every context-gated feature on', () => {
    let all: SynthResult;
    beforeAll(() => { all = synthApp({ ...ALL_FEATURES_CONTEXT }); }, SYNTH_TIMEOUT_MS);

    it('gives every function writes to its own log group only, and no role a managed policy', () => {
      expect(functionProblems(all)).toStrictEqual([]);
      expect(rolesWithManagedPolicies(all)).toStrictEqual([]);
    });
  });

  it('pins an API Lambda, the stream Lambda and the plan-step Lambda to their own groups', () => {
    const api = resourcesOf(synth, 'VocApiStack');
    const processing = resourcesOf(synth, 'VocProcessingStack');
    const metrics = functionLogGrants(api, 'MetricsApi');
    const stream = functionLogGrants(api, 'ChatStreamApi');
    const planStep = functionLogGrants(processing, 'AgentRuntimePlanStep');
    expect(metrics.statements).toStrictEqual([ownGroupWrites(metrics.group)]);
    expect(stream.statements).toStrictEqual([ownGroupWrites(stream.group)]);
    expect(planStep.statements).toStrictEqual([ownGroupWrites(planStep.group)]);
  });

  it('gives a role shared by two functions one statement naming both groups', () => {
    const processing = resourcesOf(synth, 'VocProcessingStack');
    const processor = functionLogGrants(processing, 'FeedbackProcessor');
    const aggregator = functionLogGrants(processing, 'AggregationProcessor');
    expect(processor.statements).toStrictEqual([{
      Effect: 'Allow', Action: LOG_WRITES,
      // minimizePolicies lists the merged resources sorted.
      Resource: [processor.group, aggregator.group].sort(byCodeUnit).map((group) => ({ 'Fn::GetAtt': [group, 'Arn'] })),
    }]);
  });

  it('pins a CDK Provider framework onEvent function and a CustomResourceProvider handler', () => {
    const core = resourcesOf(synth, 'VocCoreStack');
    const onEvent = functionLogGrants(core, 'CdnSigningKeysProviderframeworkonEvent');
    const autoDelete = functionLogGrants(core, 'CustomS3AutoDeleteObjectsCustomResourceProviderHandler');
    expect(onEvent.statements).toStrictEqual([ownGroupWrites(onEvent.group)]);
    expect(autoDelete.statements).toStrictEqual([ownGroupWrites(autoDelete.group)]);
  });

  it('gives the API Gateway account role the execution-log, access-log and list grants, set before the account', () => {
    const api = resourcesOf(synth, 'VocApiStack');
    const role = logicalIdStartingWith(api, 'AWS::IAM::Role', 'VocAnalyticsApiCloudWatchRole');
    const access = logsArn(`/aws/apigateway/*voc-analytics-api-${SYNTH_ACCOUNT}-${SYNTH_REGION}`);
    const statements = roleStatements(api, role).map((statement) => ({ ...statement, Resource: flatten(statement.Resource) }));
    expect(statements).toStrictEqual([
      {
        Sid: 'ExecutionLogs', Effect: 'Allow', Resource: logsArn('API-Gateway-Execution-Logs_*'),
        Action: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
      },
      {
        Sid: 'AccessLogs', Effect: 'Allow', Resource: [`${access}:*`, access], // minimizePolicies sorts them
        Action: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
      },
      { Sid: 'ListLogGroups', Effect: 'Allow', Action: 'logs:DescribeLogGroups', Resource: '*' },
    ]);
    const policy = logicalIdStartingWith(api, 'AWS::IAM::Policy', 'VocAnalyticsApiCloudWatchRoleDefaultPolicy');
    const account = logicalIdStartingWith(api, 'AWS::ApiGateway::Account', 'VocAnalyticsApiAccount');
    expect(api[account]?.DependsOn).toContain(policy);
  });

  it('covers the access-log group each deployment really creates, prefixed or not, with one pattern', () => {
    // VocApiStack alone (in process): the API Gateway role is built with the stack, not by the app's aspect.
    const shapes = [apiTemplate(), apiTemplatePrefixed()].map((template) => TemplateSchema.parse(template.toJSON()).Resources);
    const names = shapes.map((resources) => flatten(
      resources[logicalIdStartingWith(resources, 'AWS::Logs::LogGroup', 'ApiGatewayLogs')]?.Properties?.LogGroupName,
    ));
    const accessGrants = shapes.map((resources) => roleStatements(
      resources, logicalIdStartingWith(resources, 'AWS::IAM::Role', 'VocAnalyticsApiCloudWatchRole'),
    ).filter((statement) => statement.Sid === 'AccessLogs').map((statement) => flatten(statement.Resource)));
    const pattern = iamPattern(`/aws/apigateway/*voc-analytics-api-${SYNTH_ACCOUNT}-${SYNTH_REGION}`);
    expect(names).toStrictEqual([
      `/aws/apigateway/voc-analytics-api-${SYNTH_ACCOUNT}-${SYNTH_REGION}`,
      `/aws/apigateway/b-voc-analytics-api-${SYNTH_ACCOUNT}-${SYNTH_REGION}`,
    ]);
    expect(names.map((name) => pattern.test(String(name)))).toStrictEqual([true, true]);
    expect(accessGrants[1]).toStrictEqual(accessGrants[0]);
  }, SYNTH_TIMEOUT_MS);
});
