/**
 * Pins the web-search gateway target to connector version 1.2.0 (docs/radar.md).
 *
 * Why a custom resource: version 1.2.0 of the AWS-managed `web-search` connector
 * adds the request filters Radar's release scan relies on (`filters.domainFilter`,
 * `filters.publishedDateFilter`, used by `shared/web_search.search_web`), but a
 * target created WITHOUT `source.version` gets the connector's default (1.1.0)
 * and keeps it. The CloudFormation schema of `AWS::BedrockAgentCore::GatewayTarget`
 * cannot say so: its `ConnectorSource` has only `ConnectorId` and
 * `additionalProperties: false` (checked against the live us-east-1 registry
 * schema, 2026-10-17), so a `Version` key would fail template validation.
 *
 * So the version is set through the control-plane API, `UpdateGatewayTarget`
 * with `source.version`, on create and whenever this pin changes:
 *   - in place: the target keeps its id and NAME, so the gateway still exposes
 *     the tool as `web-search-tool___WebSearch` (`toolName`; and
 *     `shared/web_search.py` rediscovers it via tools/list if it ever drifted);
 *     CloudFormation's own `TargetConfiguration` updates are "No interruption"
 *     too, and an update without `source.version` keeps the pinned one (sticky);
 *   - `installLatestAwsSdk`: the Lambda runtime's bundled SDK may predate the
 *     `version` member, which an older model would silently drop.
 */
import * as cdk from 'aws-cdk-lib';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cr from 'aws-cdk-lib/custom-resources';
import { NagSuppressions } from 'cdk-nag';

import { cdkCustomResourceSuppressions, suppressAwsCustomResourceProvider } from '../utils/nag-suppressions';

/** The connector version the release scan's filters need (1.2.0+). */
export const WEB_SEARCH_CONNECTOR_VERSION = '1.2.0';
/** The AWS-managed connector and its one configuration, shared with the CloudFormation target. */
export const WEB_SEARCH_CONNECTOR_ID = 'web-search';
export const WEB_SEARCH_CONFIGURATION_NAME = 'WebSearch';
/** Its own custom-resource type, so it is never counted as another `Custom::AWS` call. */
export const WEB_SEARCH_CONNECTOR_PIN_TYPE = 'Custom::WebSearchConnectorVersion';

export interface ConnectorPinTarget {
  gateway: bedrockagentcore.CfnGateway;
  target: cdk.CfnResource;
  targetName: string;
}

export function pinWebSearchConnector(stack: cdk.Stack, { gateway, target, targetName }: ConnectorPinTarget): void {
  const call: cr.AwsSdkCall = {
    service: 'bedrock-agentcore-control',
    action: 'UpdateGatewayTarget',
    parameters: {
      gatewayIdentifier: gateway.attrGatewayIdentifier,
      targetId: target.getAtt('TargetId').toString(),
      name: targetName,
      targetConfiguration: { mcp: { connector: {
        source: { connectorId: WEB_SEARCH_CONNECTOR_ID, version: WEB_SEARCH_CONNECTOR_VERSION },
        configurations: [{ name: WEB_SEARCH_CONFIGURATION_NAME, parameterValues: {} }],
      } } },
      credentialProviderConfigurations: [{ credentialProviderType: 'GATEWAY_IAM_ROLE' }],
    },
    physicalResourceId: cr.PhysicalResourceId.of(`web-search-connector-${WEB_SEARCH_CONNECTOR_VERSION}`),
  };
  const pin = new cr.AwsCustomResource(stack, 'WebSearchConnectorVersion', {
    resourceType: WEB_SEARCH_CONNECTOR_PIN_TYPE,
    onCreate: call,
    onUpdate: call,
    policy: cr.AwsCustomResourcePolicy.fromStatements([
      new iam.PolicyStatement({
        // Target actions authorize against the GATEWAY resource (no target ARN type).
        actions: ['bedrock-agentcore:UpdateGatewayTarget'],
        resources: [gateway.attrGatewayArn],
      }),
    ]),
    installLatestAwsSdk: true,
  });
  pin.node.addDependency(target);
  NagSuppressions.addResourceSuppressions(pin, [...cdkCustomResourceSuppressions], true);
  suppressAwsCustomResourceProvider(stack, stack.node.id);
}
