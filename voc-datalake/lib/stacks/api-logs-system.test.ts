/**
 * Administration → System → Logs (GET /logs/system, /request, /queues, /environment): the LogsApi
 * role may search exactly this deployment's Lambda, Step Functions and API access log groups plus
 * VocCoreStack's CloudFormation-named Lambda log groups, and peek (never consume) the failure
 * queues; the Lambda gets every name it reads (lambda/shared/system_log_sources.py, system_queues.py).
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { apiTemplateAllPlugins, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { CORE_LAMBDA_LOG_GROUPS, queueNamesOf } from './api-logs-diagnostics';

const FnJoin = z.object({ 'Fn::Join': z.tuple([z.string(), z.array(z.unknown())]) });
const PseudoRef = z.object({ Ref: z.string().startsWith('AWS::') });

/** A synthesized value as text, pseudo-parameter Refs written `<AWS::Region>`; anything else `<?>`. */
function asText(value: unknown): string {
  if (typeof value === 'string') return value;
  const pseudo = PseudoRef.safeParse(value);
  if (pseudo.success) return `<${pseudo.data.Ref}>`;
  const joined = FnJoin.safeParse(value);
  return joined.success ? joined.data['Fn::Join'][1].map(asText).join(joined.data['Fn::Join'][0]) : '<?>';
}

// The test app pins its env (api-stack-template.ts), so formatArn renders it literally.
const TEST_ENV = 'us-east-1:111111111111';
const ARN_HEAD = `arn:<AWS::Partition>:logs:${TEST_ENV}:log-group:`;
const SUFFIX = '-<AWS::AccountId>-<AWS::Region>';
const LAMBDA_PATTERN = `/aws/lambda/voc-*${SUFFIX}`;
const WORKFLOW_PATTERN = `/aws/stepfunctions/voc-*${SUFFIX}`;
const API_ACCESS_LOG = `/aws/apigateway/voc-analytics-api${SUFFIX}`;
// The test app's dependency stack stands in for VocCoreStack (api-stack-template.ts).
const CORE_STACK = 'TestDeps';

/** The LogsApi role's statements as `sorted actions` → rendered resources (+ condition). */
function grants(prefix: string): Map<string, { resources: string[]; condition: unknown }> {
  const statements = policyStatementsOf(apiTemplateAllPlugins(), 'LogsLambdaRole')
    .filter((s) => s.actions.some((action) => action.startsWith(prefix)));
  return new Map(statements.map((s) => {
    const parsed: unknown = JSON.parse(s.resource);
    const resources = (Array.isArray(parsed) ? parsed : [parsed]).map(asText);
    return [[...s.actions].sort(byCodeUnit).join(','), { resources, condition: s.condition }] as const;
  }));
}

function logsEnv(): Record<string, string> {
  const env = serviceEnvironment(apiTemplateAllPlugins(), 'voc-logs-api');
  return Object.fromEntries(Object.entries(env).map(([key, value]) => [key, asText(value)]));
}

describe('the logs API searches this deployment\'s logs', () => {
  it('gets every log source by name', () => {
    const env = logsEnv();
    expect({
      lambda: env.SYSTEM_LOG_GROUP_PATTERN,
      workflow: env.SYSTEM_WORKFLOW_LOG_GROUP_PATTERN,
      api: env.SYSTEM_API_ACCESS_LOG_GROUP,
      extra: env.SYSTEM_EXTRA_LOG_GROUPS,
    }).toStrictEqual({
      lambda: LAMBDA_PATTERN,
      workflow: WORKFLOW_PATTERN,
      api: API_ACCESS_LOG,
      extra: Object.entries(CORE_LAMBDA_LOG_GROUPS).map(([fn, id]) => `${fn}=${CORE_STACK}-${id}`).join(','),
    });
  }, SYNTH_TIMEOUT_MS);

  it('says whether web search is deployed (GET /logs/system/environment)', () => {
    expect(logsEnv().WEB_SEARCH_ENABLED).toMatch(/^(true|false)$/);
  }, SYNTH_TIMEOUT_MS);

  it('holds exactly the four Logs actions', () => {
    expect([...grants('logs:').keys()].sort(byCodeUnit))
      .toStrictEqual(['logs:DescribeLogGroups', 'logs:GetQueryResults,logs:StopQuery', 'logs:StartQuery']);
  }, SYNTH_TIMEOUT_MS);

  it('starts queries only on the deployment\'s own log groups', () => {
    const startQuery = grants('logs:').get('logs:StartQuery')?.resources ?? [];
    const expected = [
      ...[LAMBDA_PATTERN, WORKFLOW_PATTERN, API_ACCESS_LOG].flatMap((name) => [`${ARN_HEAD}${name}`, `${ARN_HEAD}${name}:*`]),
      ...Object.values(CORE_LAMBDA_LOG_GROUPS).map((id) => `${ARN_HEAD}${CORE_STACK}-${id}*`),
    ];
    expect(startQuery).toStrictEqual(expected);
  }, SYNTH_TIMEOUT_MS);

  it('lists log groups on log-group:* and reads query ids on *, which have no resource type', () => {
    const logs = grants('logs:');
    expect(logs.get('logs:DescribeLogGroups')?.resources).toStrictEqual([`${ARN_HEAD}*`]);
    expect(logs.get('logs:GetQueryResults,logs:StopQuery')?.resources).toStrictEqual(['*']);
  }, SYNTH_TIMEOUT_MS);
});

describe('the logs API peeks the failure queues', () => {
  const queueArns = () => queueNamesOf(logsEnv().OPS_ALERTS_QUEUES ?? '')
    .map((name) => `arn:<AWS::Partition>:sqs:${TEST_ENV}:${name}`);

  it('reads exactly the queues alerting watches, with no delete', () => {
    const sqs = grants('sqs:');
    expect([...sqs.keys()]).toStrictEqual(['sqs:GetQueueAttributes,sqs:GetQueueUrl,sqs:ReceiveMessage']);
    const arns = queueArns();
    expect(arns.length).toBeGreaterThanOrEqual(5);
    expect(sqs.get('sqs:GetQueueAttributes,sqs:GetQueueUrl,sqs:ReceiveMessage')?.resources).toStrictEqual(arns);
  }, SYNTH_TIMEOUT_MS);

  it('decrypts only through SQS and only for those queues', () => {
    const decrypt = [...grants('kms:').entries()]
      .find(([actions, grant]) => actions === 'kms:Decrypt' && grant.resources[0] === '*');
    expect(decrypt).toBeDefined();
    const condition = z.object({
      StringEquals: z.object({ 'kms:ViaService': z.unknown() }),
      'ForAnyValue:StringEquals': z.object({ 'kms:EncryptionContext:aws:sqs:arn': z.array(z.unknown()) }),
    }).parse(decrypt?.[1].condition);
    expect(asText(condition.StringEquals['kms:ViaService'])).toBe('sqs.us-east-1.amazonaws.com');
    expect(condition['ForAnyValue:StringEquals']['kms:EncryptionContext:aws:sqs:arn'].map(asText)).toStrictEqual(queueArns());
  }, SYNTH_TIMEOUT_MS);

  it('reads queue age metrics with GetMetricData only', () => {
    expect(grants('cloudwatch:GetMetricData').get('cloudwatch:GetMetricData')?.resources).toStrictEqual(['*']);
  }, SYNTH_TIMEOUT_MS);
});
