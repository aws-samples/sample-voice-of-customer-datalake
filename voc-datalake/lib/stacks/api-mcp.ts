/**
 * VocApiStack's MCP surface: the `/mcp` resource, its Bearer-token authorizer and
 * the global MCP endpoint beneath it (`/mcp/global`, global-mcp.ts).
 * Resources are created on the stack itself — see api-context.ts.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import type { ApiStackContext } from './api-context';
import { BROWSER_PREFLIGHT, CORS_EXPOSE_HEADERS_VALUE, gatewayErrorCorsHeaders, restApiBaseUrl, type ApiGateway } from './api-gateway';
import { addMcpOAuth, mcpResourceMetadataUrl } from './api-mcp-oauth';
import { GlobalMcp } from './global-mcp';

/** The domain Lambdas MCP tools delegate to. */
export interface McpDelegates {
  metricsLambda: lambda.Function;
  projectsLambda: lambda.Function;
  settingsLambda: lambda.Function;
  memoryLambda: lambda.Function;
  agentsLambda: lambda.Function;
}

/** Must equal MCP_UNAUTHORIZED / the 401 message in lambda/api/mcp_global_handler.py (pinned by a test). */
export const MCP_UNAUTHORIZED_BODY =
  '{"jsonrpc": "2.0", "id": null, "error": {"code": -32001, "message": "Unauthorized: invalid, expired or revoked token"}}';

/**
 * The challenge a refused MCP credential gets (RFC 6750 §3, realm as the handler names it), naming the
 * protected-resource metadata (RFC 9728) an MCP client starts OAuth sign-in from (api-mcp-oauth.ts).
 */
export function mcpBearerChallenge(resourceMetadataUrl: string): string {
  return `Bearer realm="voc-mcp-global", resource_metadata="${resourceMetadataUrl}", error="invalid_token"`;
}

/**
 * The `/mcp/global` token authorizer: the global MCP function itself (`_authorize` in
 * mcp_global_handler.py), running the full credential check, never cached (TTL 0) so a
 * revoked token dies on its next request. Any presented credential, malformed or not, gets the
 * same Deny (so the same JSON-RPC 401); only a missing header is the API-wide UNAUTHORIZED.
 * Reusing the endpoint's function costs no new function, role or log group (VocApiStack sits
 * under a 425-resource gate).
 */
function mcpAuthorizerOptions(stack: cdk.Stack, handler: lambda.IFunction): apigateway.MethodOptions {
  const authorizer = new apigateway.TokenAuthorizer(stack, 'McpApiTokenAuthorizer', {
    handler,
    identitySource: 'method.request.header.Authorization',
    resultsCacheTtl: cdk.Duration.seconds(0),
    authorizerName: 'voc-mcp-token-authorizer',
  });
  return { authorizer, authorizationType: apigateway.AuthorizationType.CUSTOM };
}

/**
 * A Deny from the MCP authorizer (a dead credential) as the 401 an MCP client expects:
 * `WWW-Authenticate: Bearer …` plus the handler's JSON-RPC error. This is the documented way
 * to send that header from a REST API: a Lambda proxy response has `WWW-Authenticate`
 * remapped to `x-amzn-Remapped-WWW-Authenticate` (API Gateway "important notes"), while a
 * gateway response sets it as given. ACCESS_DENIED is API-wide, but the MCP authorizer is the
 * API's only Lambda authorizer and the API has no resource policy, so only it can raise one
 * (pinned by 'access denied gateway response' in api-stack-mcp.test.ts).
 */
function mcpAccessDeniedResponse(api: apigateway.RestApi, allowedOrigin: string, resourceMetadataUrl: string): void {
  api.addGatewayResponse('McpAccessDenied', {
    type: apigateway.ResponseType.ACCESS_DENIED,
    statusCode: '401',
    responseHeaders: {
      ...gatewayErrorCorsHeaders(allowedOrigin, ['Authorization']),
      'WWW-Authenticate': `'${mcpBearerChallenge(resourceMetadataUrl)}'`,
      'Access-Control-Expose-Headers': CORS_EXPOSE_HEADERS_VALUE,
      'Cache-Control': "'private, no-store'",
    },
    templates: { 'application/json': MCP_UNAUTHORIZED_BODY },
  });
}

export function createMcpApi(ctx: ApiStackContext, gateway: ApiGateway, delegates: McpDelegates,
  signingLayer: lambda.ILayerVersion): GlobalMcp {
  const { stack, allowedOrigin, apiLayer, apiCode: createApiLambdaCode } = ctx;
  const { api, authMethodOptions } = gateway;
  const { metricsLambda, projectsLambda, settingsLambda, memoryLambda, agentsLambda } = delegates;
  const { projectsTable, jobsTable, kmsKey, userPool } = ctx.props;

  // The per-project MCP server (`POST /mcp`, `/mcp/{proxy+}`, voc-mcp-api and its
  // role) was retired in 3.00.00. What stays is the `/mcp` resource as the parent
  // of `/mcp/global`; its authorizer is the global function (mcpAuthorizerOptions).
  const apiBaseUrl = restApiBaseUrl(stack, api);
  mcpAccessDeniedResponse(api, allowedOrigin, mcpResourceMetadataUrl(apiBaseUrl));

  // No method of its own: `/mcp` only parents `/mcp/global` (global-mcp.ts).
  const mcpResource = api.root.addResource('mcp');

  // Global MCP endpoint (/mcp/global) + personal token API (/connect/tokens) — global-mcp.ts.
  const globalMcp = new GlobalMcp(stack, 'GlobalMcp', {
    uniqueName: (baseName) => ctx.uniqueName(baseName),
    createApiLambdaCode, apiLayer, allowedOrigin, mcpResource, authMethodOptions, browserPreflight: BROWSER_PREFLIGHT,
    mcpMethodOptionsFor: (handler) => mcpAuthorizerOptions(stack, handler),
    apiRoot: api.root, projectsTable, jobsTable, kmsKey, userPool,
    domainFunctions: {
      METRICS_FUNCTION: metricsLambda, SETTINGS_FUNCTION: settingsLambda, MEMORY_FUNCTION: memoryLambda,
      PROJECTS_FUNCTION: projectsLambda, AGENTS_FUNCTION: agentsLambda,
    },
  });
  // OAuth sign-in for the same endpoint (api-mcp-oauth.ts, docs/mcp.md "OAuth sign-in").
  addMcpOAuth(stack, {
    api, apiBaseUrl, userPool, userPoolDomainPrefix: ctx.props.userPoolDomainPrefix,
    frontendDomainName: ctx.props.frontendDomainName, jobsTable, globalMcp, signingLayer,
    uniqueName: (baseName) => ctx.uniqueName(baseName),
  });
  return globalMcp;
}
