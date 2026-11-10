/**
 * The API Gateway CloudWatch role, with an inline policy instead of the AWS managed
 * `service-role/AmazonAPIGatewayPushToCloudWatchLogs` (cdk-nag AwsSolutions-IAM4).
 *
 * CDK creates this role for `RestApi` (`cloudWatchRole`, on: the `disableCloudWatchRole` flag is false in
 * cdk.json) and sets it as the region's API Gateway ACCOUNT setting (`AWS::ApiGateway::Account`). That setting
 * is one per account and region: EVERY REST API there logs through whichever role was set last, including a
 * second VoC deployment (`-c deploymentPrefix`, docs/deployment.md → Two deployments) and any REST API that is
 * not VoC's. So the grants below cover what EVERY REST API in this account and region writes: narrowing them to
 * VoC's own groups would silently stop another API's access logs the moment VoC deploys.
 *
 * The managed policy grants CreateLogGroup, CreateLogStream, DescribeLogGroups, DescribeLogStreams,
 * PutLogEvents, GetLogEvents and FilterLogEvents on `*` (AWS managed policy reference). Kept, with the
 * resource types the Service Authorization Reference gives each (Amazon CloudWatch Logs, list_logs.html):
 *
 * - Execution logs: API Gateway creates and writes `API-Gateway-Execution-Logs_<api id>/<stage>` itself
 *   (API Gateway developer guide, set-up-logging.html), so CreateLogGroup (log-group), DescribeLogStreams
 *   (log-group), CreateLogStream and PutLogEvents (log-stream) on that AWS-chosen name prefix. One resource
 *   covers both types: `…:log-group:API-Gateway-Execution-Logs_*` matches the group and its streams.
 * - Access logs: a REST API's access-log group is named by whoever owns that API (VoC's is
 *   `/aws/apigateway/<prefix->voc-analytics-api-<account>-<region>`), so the stream writes cover every log group
 *   of the account and region (`…:log-group:*`, which matches each group and its streams). No CreateLogGroup:
 *   an access-log destination must exist before a stage can name it (API Gateway set-up-logging.html).
 * - DescribeLogGroups on `*`: the action has no resource type (it lists the account's groups), and the managed
 *   policy grants it; kept because API Gateway's log delivery is not documented to work without it.
 * - Dropped: GetLogEvents and FilterLogEvents. They READ logs; pushing logs never calls them.
 */
import * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';

import { logGroupArn, removeAwsManagedPolicy } from '../utils/lambda-log-grants';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';

/** The managed policy replaced here. */
const API_GATEWAY_PUSH_TO_LOGS_POLICY = 'service-role/AmazonAPIGatewayPushToCloudWatchLogs';

/** The prefix API Gateway gives every execution-log group it creates. */
const EXECUTION_LOG_GROUP_PREFIX = 'API-Gateway-Execution-Logs_';

/** Replace the managed policy on the CloudWatch role CDK created for `api`. */
export function scopeApiGatewayLoggingRole(api: apigateway.RestApi): void {
  const role = api.node.tryFindChild('CloudWatchRole');
  const cfn = role?.node.defaultChild;
  const account = api.node.tryFindChild('Account');
  if (!(role instanceof iam.Role) || !(cfn instanceof iam.CfnRole) || account === undefined) {
    throw new Error(`${api.node.path}: no CloudWatchRole (cloudWatchRole must stay on)`);
  }
  const stack = cdk.Stack.of(api);
  const executionLogs = logGroupArn(stack, `${EXECUTION_LOG_GROUP_PREFIX}*`);
  const anyLogGroup = logGroupArn(stack, '*');
  removeAwsManagedPolicy(cfn, API_GATEWAY_PUSH_TO_LOGS_POLICY);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ExecutionLogs',
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
    resources: [executionLogs],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'AccessLogs',
    actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
    resources: [anyLogGroup],
  }));
  const { policyDependable } = role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ListLogGroups', actions: ['logs:DescribeLogGroups'], resources: ['*'],
  }));
  // The account setting (and the stage after it) waits for the policy: with the managed policy gone, the role
  // has no permission until its DefaultPolicy exists, and API Gateway checks the role when it is set.
  if (policyDependable !== undefined) account.node.addDependency(policyDependable);
  acknowledgeNag(role, [
    {
      id: 'AwsSolutions-IAM5',
      reason: 'The API Gateway CloudWatch role is the account+region setting EVERY REST API logs through, VoC\'s and any other: execution logs go to the API-Gateway-Execution-Logs_<api id>/<stage> groups API Gateway names and creates itself, and access logs go to a group each API\'s owner names, so the stream writes (no CreateLogGroup) cover every log group of the account and region; narrowing it would stop another API\'s access logs',
      findings: [resourceFinding(executionLogs), resourceFinding(anyLogGroup)],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'logs:DescribeLogGroups has no resource type (Service Authorization Reference, CloudWatch Logs); API Gateway\'s managed logging policy grants it on "*" and its log delivery is not documented to work without it',
      findings: ['Resource::*'],
    },
  ]);
}
