/**
 * Assist workers (api-assist-workers.ts, shared/assist_jobs.py):
 * each long-running route answers 202 and runs its model call on a 15-minute
 * twin of its API Lambda. These cases pin that the twin IS the same function
 * (code, handler, role, runtime, layers, environment), only longer-lived, at its
 * own pinned MemorySize (lib/sizing/policy.ts) and never retried; that the API Lambda can name and invoke it; that settings
 * and scrapers can write the job row; and that /chat/stream runs 15 minutes.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiMethods, apiTemplate } from '../test-support/api-stack-template';
import { IamPolicySchema, isAttachedToRole, statementActions } from '../test-support/iam-statements';
import type { IamStatement } from '../test-support/iam-statements';
import { itemAt } from '../test-support/guards';
import { MEMORY_SIZES } from '../sizing/policy';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const FunctionSchema = z.object({
  Properties: z.object({
    Handler: z.string(),
    Code: z.unknown(),
    Role: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.string()]) }),
    Runtime: z.string(),
    Architectures: z.array(z.string()),
    Layers: z.array(z.unknown()),
    MemorySize: z.number(),
    Timeout: z.number(),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
    LoggingConfig: z.object({ LogGroup: z.object({ Ref: z.string() }) }),
    FunctionName: z.unknown(),
  }),
});
type FunctionProperties = z.infer<typeof FunctionSchema>['Properties'];

const LogGroupSchema = z.object({
  Properties: z.object({ LogGroupName: z.unknown(), RetentionInDays: z.number() }),
});
const EventInvokeConfigSchema = z.object({
  Properties: z.object({
    FunctionName: z.object({ Ref: z.string() }),
    Qualifier: z.string(),
    MaximumRetryAttempts: z.number().optional(),
    MaximumEventAgeInSeconds: z.number().optional(),
  }),
});

/** The one function whose logical id is `constructId` plus CDK's 8-hex suffix. */
function fn(constructId: string): { logicalId: string; props: FunctionProperties } {
  const matches = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
    .filter(([logicalId]) => new RegExp(`^${constructId}[0-9A-F]{8}$`).test(logicalId));
  expect(matches, `exactly one ${constructId}`).toHaveLength(1);
  const [logicalId, resource] = itemAt(matches, 0);
  return { logicalId, props: FunctionSchema.parse(resource).Properties };
}

/** Every statement of every inline policy attached to `roleLogicalId`. */
function roleStatements(roleLogicalId: string): IamStatement[] {
  return Object.values(apiTemplate().findResources('AWS::IAM::Policy'))
    .map((resource) => IamPolicySchema.parse(resource).Properties)
    .filter((policy) => isAttachedToRole(policy, roleLogicalId))
    .flatMap((policy) => policy.PolicyDocument.Statement);
}

const roleOf = (props: FunctionProperties): string => props.Role['Fn::GetAtt'][0];

const TWINS = [
  { api: 'ProjectsApi', twin: 'ProjectsAssistWorker', name: 'voc-projects-assist' },
  { api: 'SettingsApi', twin: 'SettingsAssistWorker', name: 'voc-settings-assist' },
  { api: 'ScrapersApi', twin: 'ScrapersAssistWorker', name: 'voc-scrapers-assist' },
] as const;

describe.each(TWINS)('the $twin twin of $api', ({ api, twin, name }) => {
  it('is the same function: code asset, handler, role, runtime, layers, environment', () => {
    const a = fn(api).props;
    const t = fn(twin).props;
    const same = (p: FunctionProperties) => ({
      Code: p.Code, Handler: p.Handler, Role: p.Role, Runtime: p.Runtime,
      Architectures: p.Architectures, Layers: p.Layers,
      Environment: p.Environment,
    });
    expect(same(t)).toStrictEqual(same(a));
  });

  it('runs at its own pinned size (lib/sizing/policy.ts), not the API function\'s', () => {
    expect(fn(twin).props.MemorySize).toBe(MEMORY_SIZES[name]);
  });

  it('runs for 15 minutes under its own name', () => {
    const t = fn(twin).props;
    expect(t.Timeout).toBe(900);
    expect(JSON.stringify(t.FunctionName)).toContain(`"${name}-"`);
  });

  it('logs to its own two-week log group', () => {
    const a = fn(api).props;
    const t = fn(twin).props;
    expect(t.LoggingConfig.LogGroup.Ref).not.toBe(a.LoggingConfig.LogGroup.Ref);
    const group = LogGroupSchema.parse(apiTemplate().toJSON().Resources[t.LoggingConfig.LogGroup.Ref]).Properties;
    expect(JSON.stringify(group.LogGroupName)).toContain(`/aws/lambda/${name}-`);
    expect(group.RetentionInDays).toBe(14);
  });

  it('is never retried by Lambda and drops a start older than an hour', () => {
    const { logicalId } = fn(twin);
    const configs = Object.values(apiTemplate().findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => EventInvokeConfigSchema.parse(resource).Properties)
      .filter((config) => config.FunctionName.Ref === logicalId);
    expect(configs).toHaveLength(1);
    const config = itemAt(configs, 0);
    expect([config.Qualifier, config.MaximumRetryAttempts, config.MaximumEventAgeInSeconds])
      .toStrictEqual(['$LATEST', 0, 3600]);
  });

  it('has no API Gateway integration or invoke permission', () => {
    const { logicalId } = fn(twin);
    expect(apiMethods(apiTemplate()).filter((m) => JSON.stringify(m).includes(logicalId))).toStrictEqual([]);
    const permissions = Object.values(apiTemplate().findResources('AWS::Lambda::Permission'))
      .filter((resource) => JSON.stringify(resource).includes(logicalId));
    expect(permissions).toStrictEqual([]);
  });

  it('is named in the API Lambda\'s ASSIST_WORKER_FUNCTION', () => {
    expect(JSON.stringify(fn(api).props.Environment.Variables.ASSIST_WORKER_FUNCTION)).toContain(`"${name}-"`);
  });

  it('may be invoked by the API Lambda\'s role, by its unqualified ARN', () => {
    const invokes = roleStatements(roleOf(fn(api).props))
      .filter((statement) => statementActions(statement).includes('lambda:InvokeFunction'))
      .filter((statement) => JSON.stringify(statement.Resource).includes(`:function:${name}-`));
    expect(invokes).toHaveLength(1);
    const invoke = itemAt(invokes, 0);
    expect(statementActions(invoke)).toStrictEqual(['lambda:InvokeFunction']);
    expect(JSON.stringify(invoke.Resource)).not.toContain('*');
  });
});

describe.each(['SettingsApi', 'ScrapersApi'])('%s writes assist job rows', (api) => {
  it('is handed the jobs table in JOBS_TABLE', () => {
    expect(JSON.stringify(fn(api).props.Environment.Variables.JOBS_TABLE)).toMatch(/Jobs/);
  });

  it('may get, put and update items on the jobs table, and nothing else there', () => {
    const onJobs = roleStatements(roleOf(fn(api).props))
      .filter((statement) => /Jobs/.test(JSON.stringify(statement.Resource)));
    const actions = [...new Set(onJobs.flatMap(statementActions))].sort(byCodeUnit);
    expect(actions).toStrictEqual(['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem']);
  });
});

describe('the AI assistant stream runs for 15 minutes', () => {
  it('gives the chat-stream Lambda a 900 s timeout', () => {
    const matches = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter(([logicalId]) => /^ChatStreamApi[0-9A-F]{8}$/.test(logicalId));
    expect(matches).toHaveLength(1);
    expect(z.object({ Properties: z.object({ Timeout: z.number() }) }).parse(itemAt(matches, 0)[1]).Properties.Timeout)
      .toBe(900);
  });

  it('lets the /chat/stream integration wait 900000 ms', () => {
    const MethodSchema = z.object({
      Properties: z.object({
        HttpMethod: z.string(),
        Integration: z.object({ TimeoutInMillis: z.number().optional(), ResponseTransferMode: z.string().optional() }).loose(),
      }).loose(),
    });
    const streaming = Object.values(apiTemplate().findResources('AWS::ApiGateway::Method'))
      .map((resource) => MethodSchema.safeParse(resource))
      .flatMap((parsed) => (parsed.success ? [parsed.data.Properties] : []))
      .filter((method) => method.Integration.ResponseTransferMode === 'STREAM');
    expect(streaming).toHaveLength(1);
    expect(itemAt(streaming, 0).Integration.TimeoutInMillis).toBe(900_000);
  });
});
