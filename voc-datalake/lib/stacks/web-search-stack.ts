import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { uniqueName } from '../utils/naming';

/**
 * VocWebSearchStack — AgentCore Gateway exposing the AWS-managed
 * `web-search` connector as an MCP tool.
 *
 * Used by AI Chat and Projects research for opt-in public-web grounding.
 * Queries are served entirely within AWS (no third-party search engine).
 *
 * This stack is ALWAYS deployed to us-east-1: the web-search connector is
 * only available there. The rest of the app can live in any region — the
 * chat-stream and research Lambdas call the gateway URL cross-region over
 * HTTPS with SigV4, and the gateway URL/ARN flow to those stacks via CDK
 * cross-region references (SSM-backed when regions differ).
 *
 * Opt-in via `"enableWebSearch": true` in cdk.context.json. When the app
 * region is not us-east-1, the account must also be bootstrapped in
 * us-east-1 (`cdk bootstrap aws://ACCOUNT/us-east-1`).
 *
 * Cost note: Web Search invocations are billed at $7 per 1,000 queries.
 * The feature is opt-in per request in both UIs.
 */
export class VocWebSearchStack extends cdk.Stack {
  public readonly gatewayUrl: string;
  public readonly gatewayArn: string;
  public readonly toolName: string;

  constructor(scope: Construct, id: string, props: cdk.StackProps) {
    super(scope, id, props);

    // Service role the Gateway assumes to reach the AWS-owned connector.
    // Trust is scoped to this account so another account's gateway cannot
    // assume it (confused-deputy protection per the AgentCore docs).
    const serviceRole = new iam.Role(this, 'WebSearchGatewayRole', {
      assumedBy: new iam.ServicePrincipal('bedrock-agentcore.amazonaws.com').withConditions({
        StringEquals: { 'aws:SourceAccount': this.account },
      }),
      description: 'Service role for the VoC web search AgentCore Gateway',
    });

    const gateway = new bedrockagentcore.CfnGateway(this, 'WebSearchGateway', {
      name: uniqueName('voc-web-search'),
      protocolType: 'MCP',
      // Inbound auth: callers (chat stream + research Lambdas) sign requests
      // with SigV4 and are authorized via bedrock-agentcore:InvokeGateway.
      authorizerType: 'AWS_IAM',
      roleArn: serviceRole.roleArn,
      description: 'VoC web search gateway (AWS-managed web-search connector)',
    });

    // Grant after gateway creation so the InvokeGateway statement can be
    // scoped to the concrete gateway ARN instead of a gateway/* wildcard.
    const servicePolicy = new iam.Policy(this, 'WebSearchGatewayRolePolicy', {
      statements: [
        new iam.PolicyStatement({
          sid: 'InvokeGateway',
          actions: ['bedrock-agentcore:InvokeGateway'],
          resources: [gateway.attrGatewayArn],
        }),
        new iam.PolicyStatement({
          sid: 'InvokeWebSearch',
          actions: ['bedrock-agentcore:InvokeWebSearch'],
          // Service-owned tool ARN (the account segment is literally "aws")
          // — checked per invocation when the gateway calls the connector.
          resources: [`arn:aws:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`],
        }),
      ],
    });
    servicePolicy.attachToRole(serviceRole);

    // The aws-cdk-lib L1 for GatewayTarget predates connector targets (its
    // Mcp union only models lambda/apiGateway/openApiSchema/smithyModel/
    // mcpServer), so declare the target as a raw CfnResource against the
    // CloudFormation schema, which does support Mcp.Connector.
    const targetName = 'web-search-tool';
    const target = new cdk.CfnResource(this, 'WebSearchGatewayTarget', {
      type: 'AWS::BedrockAgentCore::GatewayTarget',
      properties: {
        GatewayIdentifier: gateway.attrGatewayIdentifier,
        Name: targetName,
        TargetConfiguration: {
          Mcp: {
            Connector: {
              Source: { ConnectorId: 'web-search' },
              Configurations: [{ Name: 'WebSearch', ParameterValues: {} }],
            },
          },
        },
        CredentialProviderConfigurations: [
          { CredentialProviderType: 'GATEWAY_IAM_ROLE' },
        ],
      },
    });
    // Target provisioning exercises the service role, so make sure the
    // permissions exist before CloudFormation creates the target.
    target.node.addDependency(servicePolicy);

    this.gatewayUrl = gateway.attrGatewayUrl;
    this.gatewayArn = gateway.attrGatewayArn;
    // Gateways expose target tools MCP-prefixed as `${target}___${tool}`.
    // The runtime clients fall back to tools/list discovery if this drifts.
    this.toolName = `${targetName}___WebSearch`;

    new cdk.CfnOutput(this, 'WebSearchGatewayUrl', { value: this.gatewayUrl });
    new cdk.CfnOutput(this, 'WebSearchGatewayArn', { value: this.gatewayArn });
  }
}
