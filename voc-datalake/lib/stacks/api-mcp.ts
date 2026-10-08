/**
 * VocApiStack's MCP surface: the `/mcp` resource, its Bearer-token shape
 * authorizer and the global MCP endpoint beneath it (`/mcp/global`, global-mcp.ts).
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';
import type { ApiStackContext } from './api-context';
import type { ApiGateway } from './api-gateway';
import { GlobalMcp } from './global-mcp';

/** The domain Lambdas MCP tools delegate to. */
export interface McpDelegates {
  metricsLambda: lambda.Function;
  projectsLambda: lambda.Function;
  settingsLambda: lambda.Function;
  memoryLambda: lambda.Function;
  agentsLambda: lambda.Function;
}

export function createMcpApi(ctx: ApiStackContext, gateway: ApiGateway, delegates: McpDelegates): GlobalMcp {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const { api, authMethodOptions } = gateway;
  const { metricsLambda, projectsLambda, settingsLambda, memoryLambda, agentsLambda } = delegates;
  const { projectsTable, jobsTable, kmsKey, userPool } = ctx.props;

  // The per-project MCP server (`POST /mcp`, `/mcp/{proxy+}`, voc-mcp-api and its
  // role) was retired in 3.00.00. What stays is the `/mcp` resource as the parent
  // of `/mcp/global` and the bearer-token SHAPE authorizer in front of it; the
  // global handler does the real credential check on every request.

  // Inline Node.js token-format authorizer (validates Bearer voc_* shape; mcp_global_handler does the real check)
  const mcpAuthorizerLogGroup = ctx.logGroup('McpAuthorizerLogs', ctx.uniqueName('voc-mcp-authorizer'));
  const mcpAuthorizerFn = new lambda.Function(stack, 'McpTokenAuthorizer', {
    functionName: ctx.uniqueName('voc-mcp-token-authorizer'),
    runtime: lambda.Runtime.NODEJS_22_X,
    architecture: lambda.Architecture.ARM_64,
    handler: 'index.handler',
    code: lambda.Code.fromInline(`
exports.handler = async (event) => {
  const token = event.authorizationToken || '';
  const methodArn = event.methodArn;
  if (!token.startsWith('Bearer voc_') || token.length < 20) {
    throw new Error('Unauthorized');
  }
  const arnParts = methodArn.split(':');
  const region = arnParts[3];
  const accountId = arnParts[4];
  const apiGatewayArnParts = arnParts[5].split('/');
  const restApiId = apiGatewayArnParts[0];
  const stage = apiGatewayArnParts[1];
  const resourceArn = 'arn:aws:execute-api:' + region + ':' + accountId + ':' + restApiId + '/' + stage + '/*/mcp*';
  return {
    principalId: 'mcp-client',
    policyDocument: {
      Version: '2012-10-17',
      Statement: [{
        Action: 'execute-api:Invoke',
        Effect: 'Allow',
        Resource: resourceArn,
      }],
    },
  };
};
`),
    timeout: cdk.Duration.seconds(3),
    memorySize: 128,
    logGroup: mcpAuthorizerLogGroup,
  });
  NagSuppressions.addResourceSuppressions(mcpAuthorizerFn, [
    { id: 'AwsSolutions-L1', reason: 'Node.js 22 is the latest LTS runtime available in CDK for inline Lambda authorizers' },
  ], true);

  const mcpTokenAuthorizer = new apigateway.TokenAuthorizer(stack, 'McpApiTokenAuthorizer', {
    handler: mcpAuthorizerFn,
    identitySource: 'method.request.header.Authorization',
    resultsCacheTtl: cdk.Duration.seconds(300),
    authorizerName: 'voc-mcp-token-authorizer',
  });

  const mcpMethodOptions: apigateway.MethodOptions = {
    authorizer: mcpTokenAuthorizer,
    authorizationType: apigateway.AuthorizationType.CUSTOM,
  };

  // No method of its own: `/mcp` only parents `/mcp/global` (global-mcp.ts).
  const mcpResource = api.root.addResource('mcp');

  // Global MCP endpoint (/mcp/global) + personal token API (/connect/tokens) — global-mcp.ts.
  return new GlobalMcp(stack, 'GlobalMcp', {
    uniqueName: (baseName) => ctx.uniqueName(baseName),
    createApiLambdaCode, apiLayer, allowedOrigin, mcpResource, mcpMethodOptions, authMethodOptions,
    apiRoot: api.root, projectsTable, jobsTable, kmsKey, userPool,
    domainFunctions: {
      METRICS_FUNCTION: metricsLambda, SETTINGS_FUNCTION: settingsLambda, MEMORY_FUNCTION: memoryLambda,
      PROJECTS_FUNCTION: projectsLambda, AGENTS_FUNCTION: agentsLambda,
    },
  });
}
