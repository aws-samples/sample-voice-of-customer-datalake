/**
 * Administration → System → Logs diagnostics on the LogsApi role (lambda/shared/system_*.py):
 * what `GET /logs/system`, `/logs/system/request`, `/logs/system/queues` and
 * `/logs/system/environment` read, and the env vars that name it.
 *
 * Every name is a deterministic string built here — no cross-stack reference, no new export,
 * no new resource (the app is at its five-stack ceiling, and VocApiStack near its resource gate):
 *
 * - Lambda logs: `/aws/lambda/[<prefix>-]voc-*-<account>-<region>` (SYSTEM_LOG_GROUP_PATTERN);
 * - VocCoreStack's own Lambdas whose log group CloudFormation named
 *   (`<core stack>-<construct id><hash>-<random>`): one `<function>=<name prefix>` pair each
 *   (SYSTEM_EXTRA_LOG_GROUPS). CDK provider handlers are deliberately not listed;
 * - the state machines: `/aws/stepfunctions/[<prefix>-]voc-*-<account>-<region>`;
 * - the API stage's access log: `/aws/apigateway/[<prefix>-]voc-analytics-api-<account>-<region>`
 *   (api-gateway.ts names it the same way);
 * - the failure queues alerting watches (OPS_ALERTS_QUEUES, dlq-alarms.ts): peeked, never consumed.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import { NagSuppressions } from 'cdk-nag';
import type { ApiStackContext } from './api-context';

/**
 * VocCoreStack's application Lambdas with a CloudFormation-named log group: function short name →
 * the LogGroup's construct id (its logical id starts with it). Pinned against the synthesized
 * VocCoreStack by api-logs-diagnostics.test.ts, so a new one cannot be forgotten.
 */
export const CORE_LAMBDA_LOG_GROUPS: Readonly<Record<string, string>> = {
  'product-doc-extractor': 'ProductDocExtractorLambdaLogs',
  'cognito-custom-message': 'CustomMessageLambdaLogs',
  'admin-bootstrap': 'AdminBootstrapLambdaLogs',
  'cdn-signing-keys': 'CdnSigningKeysLambdaLogs',
  'board-pre-signup': 'BoardPreSignUpLambdaLogs',
  'board-custom-message': 'BoardCustomMessageLambdaLogs',
  // The image model's agreement custom resource (ImageModelAccess, bedrock-access-stack.ts; 5.45.00):
  // a refused agreement is logged there as a warning and never fails the deploy.
  'image-model-access': 'ImageModelAccessModelAgreementLambdaLogs',
};

export interface LogsDiagnosticsInputs {
  /** OPS_ALERTS_QUEUES as opsAlertsWiring() built it: `slug=queueName` pairs, comma-separated. */
  opsAlertsQueues: string;
  /** VocCoreStack's stack name (the prefix of its CloudFormation-named log groups). */
  coreStackName: string;
}

/** The queue names out of `slug=name,slug=name` (names carry account/region tokens, never `,` or `=`). */
export function queueNamesOf(opsAlertsQueues: string): string[] {
  return opsAlertsQueues.split(',').map((pair) => pair.split('=')[1] ?? '').filter((name) => name !== '');
}

function logGroupArn(stack: cdk.Stack, name: string): string {
  return stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME });
}

function grantLogSearch(ctx: ApiStackContext, role: iam.Role, inputs: LogsDiagnosticsInputs): Record<string, string> {
  const { stack } = ctx;
  const lambdaPattern = ctx.uniqueNamePattern('/aws/lambda/voc-*');
  const workflowPattern = ctx.uniqueNamePattern('/aws/stepfunctions/voc-*');
  const apiAccessLog = `/aws/apigateway/${ctx.uniqueName('voc-analytics-api')}`;
  const extras = Object.entries(CORE_LAMBDA_LOG_GROUPS)
    .map(([fn, constructId]) => [fn, `${inputs.coreStackName}-${constructId}`] as const);
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:DescribeLogGroups'], resources: [logGroupArn(stack, '*')] }));
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:StartQuery'],
    resources: [
      ...[lambdaPattern, workflowPattern, apiAccessLog].flatMap((name) => [logGroupArn(stack, name), logGroupArn(stack, `${name}:*`)]),
      // `<prefix>*` already covers the `:*` stream form.
      ...extras.map(([, prefix]) => logGroupArn(stack, `${prefix}*`)),
    ],
  }));
  role.addToPolicy(new iam.PolicyStatement({ actions: ['logs:GetQueryResults', 'logs:StopQuery'], resources: ['*'] }));
  return {
    SYSTEM_LOG_GROUP_PATTERN: lambdaPattern,
    SYSTEM_WORKFLOW_LOG_GROUP_PATTERN: workflowPattern,
    SYSTEM_API_ACCESS_LOG_GROUP: apiAccessLog,
    SYSTEM_EXTRA_LOG_GROUPS: extras.map(([fn, prefix]) => `${fn}=${prefix}`).join(','),
  };
}

function grantQueuePeek(ctx: ApiStackContext, role: iam.Role, inputs: LogsDiagnosticsInputs): void {
  const { stack } = ctx;
  const queueArns = queueNamesOf(inputs.opsAlertsQueues).map((name) => stack.formatArn({ service: 'sqs', resource: name }));
  if (queueArns.length === 0) return;
  // Peek only: ReceiveMessage with VisibilityTimeout=0. No DeleteMessage, no ChangeMessageVisibility.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['sqs:GetQueueUrl', 'sqs:GetQueueAttributes', 'sqs:ReceiveMessage'],
    resources: queueArns,
  }));
  // The queues' CMKs (the Core key, and the schedule DLQ's own key in VocIngestionStack) decrypt
  // ONLY through SQS and ONLY for these queues: no key ARN crosses a stack.
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['kms:Decrypt'],
    resources: ['*'],
    conditions: {
      StringEquals: { 'kms:ViaService': `sqs.${stack.region}.amazonaws.com` },
      'ForAnyValue:StringEquals': { 'kms:EncryptionContext:aws:sqs:arn': queueArns },
    },
  }));
  // ApproximateAgeOfOldestMessage per queue (one GetMetricData call); a read with no resource type.
  role.addToPolicy(new iam.PolicyStatement({ actions: ['cloudwatch:GetMetricData'], resources: ['*'] }));
}

/** Grants the diagnostics reads to the LogsApi role; returns the env vars that name what it reads. */
export function grantLogsDiagnostics(ctx: ApiStackContext, role: iam.Role, inputs: LogsDiagnosticsInputs): Record<string, string> {
  const environment = grantLogSearch(ctx, role, inputs);
  grantQueuePeek(ctx, role, inputs);
  NagSuppressions.addResourceSuppressions(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'System → Logs diagnostics (admin-only): DescribeLogGroups is a list call authorized against log-group:*; '
      + 'StartQuery is limited to this deployment\'s Lambda, Step Functions and API access log groups (name patterns) and '
      + 'to VocCoreStack\'s CloudFormation-named Lambda log groups (stack-name prefix + construct id); GetQueryResults, '
      + 'StopQuery and cloudwatch:GetMetricData support no resource type; kms:Decrypt is conditioned on kms:ViaService '
      + 'sqs and the SQS encryption context of exactly the failure queues.',
    appliesTo: [
      { regex: '/^Resource::arn:(?:<AWS::Partition>|[^:<]+):logs:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):log-group:\\*$/' },
      { regex: '/^Resource::arn:(?:<AWS::Partition>|[^:<]+):logs:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):log-group:\\/aws\\/(lambda|stepfunctions)\\/(.+-)?voc-\\*-<AWS::AccountId>-<AWS::Region>(:\\*)?$/' },
      { regex: '/^Resource::arn:(?:<AWS::Partition>|[^:<]+):logs:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):log-group:\\/aws\\/apigateway\\/(.+-)?voc-analytics-api-<AWS::AccountId>-<AWS::Region>:\\*$/' },
      { regex: '/^Resource::arn:(?:<AWS::Partition>|[^:<]+):logs:(?:<AWS::Region>|[^:<]+):(?:<AWS::AccountId>|[^:<]+):log-group:[A-Za-z0-9-]+-[A-Za-z]+LambdaLogs\\*$/' },
      'Resource::*',
    ],
  }], true);
  return environment;
}
