/**
 * The API Gateway CloudWatch role, with an inline policy instead of the AWS managed
 * `service-role/AmazonAPIGatewayPushToCloudWatchLogs` (cdk-nag AwsSolutions-IAM4).
 *
 * CDK creates this role for `RestApi` (`cloudWatchRole`, on: the `disableCloudWatchRole` flag is false in
 * cdk.json) and sets it as the region's API Gateway ACCOUNT setting (`AWS::ApiGateway::Account`). That setting
 * is one per account and region: EVERY REST API there logs through whichever role was set last.
 *
 * API Gateway VALIDATES the role when the account setting is written, and it requires the log actions on
 * `Resource: "*"`. Measured in a Workshop Studio event account (2026-11-11), each role tried as the setting:
 *
 *   - 6.00–6.04's grants, scoped to `API-Gateway-Execution-Logs_*` and `log-group:*` ARNs: REFUSED ("The role ARN
 *     does not have required permissions configured"), still an hour later, so not IAM propagation. Every fresh
 *     account or region failed VocApiStack; existing deployments never re-ran the setting.
 *   - the managed policy's seven actions on `*`, inline: accepted;
 *   - the five WRITE actions on `*`, without the managed policy's two log READS (GetLogEvents, FilterLogEvents):
 *     accepted. That is what this grants: pushing logs never reads log events, so the role cannot read any.
 */
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';

import { removeAwsManagedPolicy } from '../utils/lambda-log-grants';
import { acknowledgeNag } from '../utils/nag-ack';

/** The managed policy replaced here. */
const API_GATEWAY_PUSH_TO_LOGS_POLICY = 'service-role/AmazonAPIGatewayPushToCloudWatchLogs';

/** The managed policy's actions minus its two log reads: what API Gateway checks, and all pushing logs calls. */
const API_GATEWAY_LOG_PUSH_ACTIONS = Object.freeze([
  'logs:CreateLogGroup', 'logs:CreateLogStream', 'logs:DescribeLogGroups', 'logs:DescribeLogStreams', 'logs:PutLogEvents',
]);

/** Replace the managed policy on the CloudWatch role CDK created for `api` with the write-only inline grant. */
export function scopeApiGatewayLoggingRole(api: apigateway.RestApi): void {
  const role = api.node.tryFindChild('CloudWatchRole');
  const cfn = role?.node.defaultChild;
  const account = api.node.tryFindChild('Account');
  if (!(role instanceof iam.Role) || !(cfn instanceof iam.CfnRole)) {
    throw new Error(`${api.node.path}: no CloudWatchRole (cloudWatchRole must stay on)`);
  }
  if (account === undefined) throw new Error(`${api.node.path}: no Account (the API Gateway account setting)`);
  removeAwsManagedPolicy(cfn, API_GATEWAY_PUSH_TO_LOGS_POLICY);
  const { policyDependable } = role.addToPrincipalPolicy(new iam.PolicyStatement({
    sid: 'PushLogs', actions: [...API_GATEWAY_LOG_PUSH_ACTIONS], resources: ['*'],
  }));
  // The account setting (and the stage after it) waits for the policy: with the managed policy gone, the role
  // has no permission until its DefaultPolicy exists, and API Gateway checks the role when it is set.
  if (policyDependable !== undefined) account.node.addDependency(policyDependable);
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM5',
    reason: 'API Gateway validates its account-level CloudWatch role and refuses the setting unless the log actions are granted on "*" (log-group-scoped grants failed every fresh deployment of 6.00-6.04); the role is the setting EVERY REST API of the account and region logs through, and it gets no log-event reads (GetLogEvents, FilterLogEvents)',
    findings: ['Resource::*'],
  }]);
}
