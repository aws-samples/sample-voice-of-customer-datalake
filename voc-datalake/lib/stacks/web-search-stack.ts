import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as bedrockagentcore from 'aws-cdk-lib/aws-bedrockagentcore';
import { Construct } from 'constructs';
import { uniqueName } from '../utils/naming';
import { BedrockModelAccess, AnthropicUseCaseConfig } from './bedrock-access-stack';

/**
 * VocWebSearchStack — the us-east-1 AI-enablement stack. Two independent
 * halves, each switched on or off by the caller:
 *
 *   1. an AgentCore Gateway exposing the AWS-managed `web-search` connector
 *      as an MCP tool (`deployWebSearch`);
 *   2. Bedrock model access — the Anthropic use-case submission and the model
 *      agreements (`anthropicUseCase`).
 *
 * They live together because they are the same deployment unit: both must sit
 * in us-east-1 (the web-search connector exists only there; the
 * PutUseCaseForModelAccess API works only there), both are one-shot account
 * enablement built from custom resources, and neither depends on the core
 * stack chain. Keeping them apart put the app at six CloudFormation templates,
 * one over Workshop Studio's ceiling of five.
 *
 * ⚠️ The stack is named for the web-search half only, for a deliberate reason:
 * the CDK id determines the CloudFormation export names that VocProcessingStack
 * and VocApiStack import. Renaming it would recreate the gateway (whose
 * physical name is deterministic, so the new one would collide with the live
 * one) and churn both consumer templates. The name is inherited debt, not a
 * description — rename it only as part of a planned migration.
 *
 * Callers must not construct this stack with BOTH halves off: the result has no
 * resources, and the workshop template converter strips CDKMetadata, so it
 * would emit an invalid `Resources: {}`. Use shouldDeployAiEnablement().
 *
 * Web-search half: used by AI Chat and Projects research for opt-in
 * public-web grounding. Queries are served entirely within AWS (no
 * third-party search engine). The rest of the app can live in any region —
 * the chat-stream and research Lambdas call the gateway URL cross-region over
 * HTTPS with SigV4, and the gateway URL/ARN flow to those stacks via CDK
 * cross-region references (SSM-backed when regions differ).
 *
 * Deployed BY DEFAULT; flag semantics live in
 * lib/utils/web-search-default.ts (single source of truth). When the app
 * region is not us-east-1, the account must also be bootstrapped in
 * us-east-1 (`cdk bootstrap aws://ACCOUNT/us-east-1`).
 *
 * Cost note: Web Search invocations are billed at $7 per 1,000 queries.
 * The feature is opt-in per request in both UIs.
 */
export interface VocWebSearchStackProps extends cdk.StackProps {
  /**
   * Create the AgentCore Gateway half. When false, the gateway, its role and
   * its target are not synthesized at all and the `gateway*` properties are
   * undefined — consumers already treat them as optional and skip the wiring.
   */
  deployWebSearch: boolean;

  /**
   * Create the Bedrock model-access half. Omit for accounts that already have
   * Anthropic access; the agreements are then neither created nor needed.
   */
  anthropicUseCase?: AnthropicUseCaseConfig;

  /** Region the model agreements are created in. See BedrockModelAccessProps. */
  modelRegion?: string;

  /** @default false */
  skipUseCaseSubmission?: boolean;
}

export class VocWebSearchStack extends cdk.Stack {
  /** Undefined when `deployWebSearch` is false. */
  public readonly gatewayUrl?: string;
  public readonly gatewayArn?: string;
  public readonly toolName?: string;

  constructor(scope: Construct, id: string, props: VocWebSearchStackProps) {
    super(scope, id, props);

    if (props.anthropicUseCase) {
      new BedrockModelAccess(this, 'BedrockModelAccess', {
        anthropicUseCase: props.anthropicUseCase,
        modelRegion: props.modelRegion,
        skipUseCaseSubmission: props.skipUseCaseSubmission,
      });
    }

    if (!props.deployWebSearch) {
      // Gateway half off. The stack still holds the model-access half — the
      // caller is responsible for not constructing it with both halves off.
      return;
    }

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
          resources: [`arn:${this.partition}:bedrock-agentcore:${this.region}:aws:tool/web-search.v1`],
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
