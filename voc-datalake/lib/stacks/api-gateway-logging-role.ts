/**
 * The API Gateway CloudWatch role, with an inline policy instead of the AWS managed
 * `service-role/AmazonAPIGatewayPushToCloudWatchLogs` (cdk-nag AwsSolutions-IAM4).
 *
 * CDK creates this role for `RestApi` (`cloudWatchRole`, on: the `disableCloudWatchRole` flag is false in
 * cdk.json) and sets it as the region's API Gateway ACCOUNT setting (`AWS::ApiGateway::Account`). That setting
 * is one per account and region: EVERY REST API there logs through whichever role was set last, including a
 * second VoC deployment (`-c deploymentPrefix`, docs/deployment.md → Two deployments). So the grants below
 * cover what any VoC deployment in this account and region writes, not only this stack's API; an API that is
 * not VoC's and sends ACCESS logs to its own group is not covered (execution logs of every API are).
 *
 * The managed policy grants CreateLogGroup, CreateLogStream, DescribeLogGroups, DescribeLogStreams,
 * PutLogEvents, GetLogEvents and FilterLogEvents on `*` (AWS managed policy reference). Kept, with the
 * resource types the Service Authorization Reference gives each (Amazon CloudWatch Logs, list_logs.html):
 *
 * - Execution logs: API Gateway creates and writes `API-Gateway-Execution-Logs_<api id>/<stage>` itself
 *   (API Gateway developer guide, set-up-logging.html), so CreateLogGroup (log-group), DescribeLogStreams
 *   (log-group), CreateLogStream and PutLogEvents (log-stream) on that AWS-chosen name prefix. One resource
 *   covers both types: `…:log-group:API-Gateway-Execution-Logs_*` matches the group and its streams.
 * - Access logs: the group this stack creates, `/aws/apigateway/<prefix->voc-analytics-api-<account>-<region>`.
 *   No CreateLogGroup (CloudFormation creates it). DescribeLogStreams needs the bare group ARN, the stream
 *   actions `…:<group>:*`.
 * - DescribeLogGroups on `*`: the action has no resource type (it lists the account's groups), and the managed
 *   policy grants it; kept because API Gateway's log delivery is not documented to work without it.
 * - Dropped: GetLogEvents and FilterLogEvents. They READ logs; pushing logs never calls them.
 */
import * as cdk from 'aws-cdk-lib';
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';

import { removeAwsManagedPolicy } from '../utils/lambda-log-grants';
import { acknowledgeNag, resourceFinding } from '../utils/nag-ack';

/** The managed policy replaced here. */
export const API_GATEWAY_PUSH_TO_LOGS_POLICY = 'service-role/AmazonAPIGatewayPushToCloudWatchLogs';

/** The prefix API Gateway gives every execution-log group it creates. */
const EXECUTION_LOG_GROUP_PREFIX = 'API-Gateway-Execution-Logs_';

function logGroupArn(stack: cdk.Stack, name: string): string {
  return stack.formatArn({ service: 'logs', resource: 'log-group', resourceName: name, arnFormat: cdk.ArnFormat.COLON_RESOURCE_NAME });
}

/**
 * Replace the managed policy on the CloudWatch role CDK created for `api`. `accessLogGroups` is the name
 * PATTERN of every VoC deployment's access-log group in this account and region (api-gateway.ts builds it).
 */
export function scopeApiGatewayLoggingRole(api: apigateway.RestApi, accessLogGroups: string): void {
  const role = api.node.tryFindChild('CloudWatchRole');
  const cfn = role?.node.defaultChild;
  const account = api.node.tryFindChild('Account');
  if (!(role instanceof iam.Role) || !(cfn instanceof iam.CfnRole) || account === undefined) {
    throw new Error(`${api.node.path}: no CloudWatchRole (cloudWatchRole must stay on)`);
  }
  const stack = cdk.Stack.of(api);
  const executionLogs = logGroupArn(stack, `${EXECUTION_LOG_GROUP_PREFIX}*`);
  const accessGroup = logGroupArn(stack, accessLogGroups);
  const accessStreams = `${accessGroup}:*`;
  removeAwsManagedPolicy(cfn, API_GATEWAY_PUSH_TO_LOGS_POLICY);
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'ExecutionLogs',
    actions: ['logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
    resources: [executionLogs],
  }));
  role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'AccessLogs',
    actions: ['logs:CreateLogStream', 'logs:DescribeLogStreams', 'logs:PutLogEvents'],
    resources: [accessGroup, accessStreams],
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
      reason: 'The API Gateway CloudWatch role is the account+region setting every REST API logs through: execution logs go to the API-Gateway-Execution-Logs_<api id>/<stage> groups API Gateway names and creates itself, and the access-log grant spans every VoC deployment\'s /aws/apigateway/*voc-analytics-api-<account>-<region> group (deploymentPrefix copies share the setting); the trailing :* is the log-stream part of the ARN (Service Authorization Reference, CloudWatch Logs)',
      findings: [resourceFinding(executionLogs), resourceFinding(accessGroup), resourceFinding(accessStreams)],
    },
    {
      id: 'AwsSolutions-IAM5',
      reason: 'logs:DescribeLogGroups has no resource type (Service Authorization Reference, CloudWatch Logs); API Gateway\'s managed logging policy grants it on "*" and its log delivery is not documented to work without it',
      findings: ['Resource::*'],
    },
  ]);
}
