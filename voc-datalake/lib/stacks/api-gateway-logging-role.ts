/**
 * The API Gateway CloudWatch role KEEPS the AWS managed `service-role/AmazonAPIGatewayPushToCloudWatchLogs`
 * (cdk-nag AwsSolutions-IAM4, acknowledged here).
 *
 * CDK creates this role for `RestApi` (`cloudWatchRole`, on: the `disableCloudWatchRole` flag is false in
 * cdk.json) and sets it as the region's API Gateway ACCOUNT setting (`AWS::ApiGateway::Account`). That setting
 * is one per account and region: EVERY REST API there logs through whichever role was set last.
 *
 * Why the managed policy stays: API Gateway VALIDATES the role when the account setting is written. 6.00–6.04
 * replaced the managed policy with an equivalent, narrower inline policy (execution-log, access-log and list
 * grants), and API Gateway refused it: "The role ARN does not have required permissions configured. Please grant
 * trust permission for API Gateway and add the required role policy." The same call still failed an hour later,
 * so this is not IAM propagation (Workshop Studio test event, 2026-11-11). Existing deployments never saw it: the
 * account setting is created once per account and region, so only a FRESH account or region failed, and its
 * VocApiStack rolled back. With the managed policy attached, the setting is accepted.
 */
import type * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as iam from 'aws-cdk-lib/aws-iam';

import { acknowledgeNag } from '../utils/nag-ack';

/** The AWS managed policy API Gateway requires on its account-level CloudWatch role. */
export const API_GATEWAY_PUSH_TO_LOGS_POLICY = 'service-role/AmazonAPIGatewayPushToCloudWatchLogs';

/** Acknowledge the managed policy on the CloudWatch role CDK created for `api`, and check it is still attached. */
export function acknowledgeApiGatewayLoggingRole(api: apigateway.RestApi): void {
  const role = api.node.tryFindChild('CloudWatchRole');
  if (!(role instanceof iam.Role)) {
    throw new Error(`${api.node.path}: no CloudWatchRole (cloudWatchRole must stay on)`);
  }
  const managed = role.node.defaultChild;
  if (!(managed instanceof iam.CfnRole) || !JSON.stringify(api.stack.resolve(managed.managedPolicyArns)).includes(API_GATEWAY_PUSH_TO_LOGS_POLICY)) {
    throw new Error(`${role.node.path}: ${API_GATEWAY_PUSH_TO_LOGS_POLICY} must stay attached (API Gateway refuses the account setting without it)`);
  }
  acknowledgeNag(role, [{
    id: 'AwsSolutions-IAM4',
    reason: 'API Gateway validates its account-level CloudWatch role against this managed policy and refuses the account setting with a narrower inline policy ("The role ARN does not have required permissions configured"), which failed every fresh deployment of 6.00-6.04',
    findings: [`Policy::arn:<AWS::Partition>:iam::aws:policy/${API_GATEWAY_PUSH_TO_LOGS_POLICY}`],
  }]);
}
