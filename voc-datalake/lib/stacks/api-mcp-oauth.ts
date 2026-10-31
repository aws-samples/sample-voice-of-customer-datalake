/**
 * OAuth sign-in for the global MCP server (VocApiStack) — docs/mcp.md → "OAuth sign-in".
 *
 * Created on VocApiStack, NOT in core-auth.ts: the Cognito resources hang off the user pool VocCoreStack
 * passes in, and every name derives from this API's own id.
 *
 *  - A `UserPoolResourceServer` whose identifier is the EXACT MCP URL (`<api>/v1/mcp/global`, canonical,
 *    no trailing slash) with the scopes `read` and `write` (`<mcp url>/read`, `<mcp url>/write`).
 *  - One public PKCE app client per client kind: Kiro, Claude Code, Cursor and — only when
 *    `-c mcpOAuthWebCallbacks` lists callbacks — one for web assistants (untested until signed in live).
 *    Authorization code only (no SRP / password / custom auth flow), ONLY the two MCP scopes — no
 *    `openid`, so Cognito issues no ID token and the client never holds an app session (the main API
 *    refuses any token not issued to the SPA's own client, shared/app_clients.py) — 1 h access tokens,
 *    30-day refresh tokens, token revocation, no user-existence errors, no secret. Callbacks: the relay URL
 *    (`<api>/v1/oauth/callback`) for every desktop client, plus Cursor's web callback
 *    (`-c mcpOAuthCursorCallbacks`, default its documented one) and the web list.
 *  - The anonymous facade routes on `voc-mcp-tokens-api` (`INTENTIONALLY_PUBLIC_OAUTH_ROUTES` in
 *    test-support/api-stack-template.ts), each throttled (MCP_OAUTH_METHOD_THROTTLE), through the same
 *    API-scoped invoke permission the `/connect` proxy already has (no new permission).
 *  - The OAuth facts in both MCP functions' environment (shared/mcp_oauth_config.py); `cryptography`
 *    (the signing layer) on the MCP endpoint function only, which verifies RS256 tokens.
 *  - The tokens role gains Put/Delete on the jobs table's `MCPOAUTH#…` partitions only (relay rows).
 *
 * Every URL is built from the RestApi id (`restApiBaseUrl`), never from `api.url`: the stage depends on
 * the methods, the methods on the functions, so a function env naming the stage would be a cycle.
 */
import * as cdk from 'aws-cdk-lib';
import * as apigateway from 'aws-cdk-lib/aws-apigateway';
import * as cognito from 'aws-cdk-lib/aws-cognito';
import type * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import { NagSuppressions } from 'cdk-nag';

import { booleanContextFlag } from '../utils/context-flag';
import type { GlobalMcp } from './global-mcp';
import { leadingKeys } from './global-mcp';

/** Must equal relay.PARTITION_PREFIX in lambda/shared/mcp_oauth_relay.py (pinned by a test). */
export const OAUTH_RELAY_PARTITION_PREFIX = 'MCPOAUTH#';
/** Cursor's documented web callback (it signs in through its website in practice, agent-mail live test). */
export const DEFAULT_CURSOR_WEB_CALLBACKS = ['https://www.cursor.com/agents/mcp/oauth/callback'];
export const MCP_OAUTH_REFRESH_DAYS = 30;

/**
 * The user pool's hosted-UI host (VocCoreStack's `UserPoolDomain` output names the same one): the
 * MCP functions' `COGNITO_DOMAIN_URL`, and `cognito.hostedUiDomain` in the SPA's config.json, the only
 * non-loopback origin besides the client's own callback the consent page navigates to.
 */
export function cognitoHostedUiHost(domainPrefix: string, region: string): string {
  return `${domainPrefix}.auth.${region}.amazoncognito.com`;
}
const MAX_CALLBACKS = 10;
/** No SRP, password, custom or choice-based sign-in on an MCP client (pinned by api-mcp-oauth.test.ts). */
const MCP_CLIENT_AUTH_FLOWS: cognito.AuthFlow = {
  userSrp: false, userPassword: false, adminUserPassword: false, custom: false, user: false,
};

/** Client kinds = CLIENT_KINDS in shared/mcp_oauth_config.py. */
export type McpOAuthClientKind = 'kiro' | 'claude-code' | 'cursor' | 'web';

const throttle = (rate: number, burst: number): apigateway.MethodDeploymentOptions =>
  ({ throttlingRateLimit: rate, throttlingBurstLimit: burst });
const DISCOVERY_THROTTLE = throttle(10, 20);
const FACADE_THROTTLE = throttle(10, 20);

/** Stage method settings for the anonymous facade (api-gateway.ts spreads them). */
export const MCP_OAUTH_METHOD_THROTTLE: Record<string, apigateway.MethodDeploymentOptions> = {
  '/.well-known/oauth-protected-resource/GET': DISCOVERY_THROTTLE,
  '/.well-known/oauth-protected-resource/mcp/global/GET': DISCOVERY_THROTTLE,
  '/.well-known/oauth-authorization-server/GET': DISCOVERY_THROTTLE,
  '/.well-known/openid-configuration/GET': DISCOVERY_THROTTLE,
  // Registration stores nothing, but nobody needs it more than a few times a minute.
  '/oauth/register/POST': throttle(5, 10),
  '/oauth/authorize/GET': FACADE_THROTTLE,
  '/oauth/callback/GET': FACADE_THROTTLE,
  // Each forwards to Cognito's token endpoint, whose own quota is per pool.
  '/oauth/token/POST': FACADE_THROTTLE,
  '/oauth/revoke/POST': FACADE_THROTTLE,
};

/** A list of exact HTTPS callbacks from CDK context (a JSON array or a comma-separated string). */
export function callbackListContext(value: unknown, key: string, fallback: readonly string[]): string[] {
  if (value === undefined || value === null || value === '') return [...fallback];
  const raw: unknown = typeof value === 'string' && value.trim().startsWith('[') ? JSON.parse(value) : value;
  const list = typeof raw === 'string' ? raw.split(',').map((item) => item.trim()).filter(Boolean) : raw;
  if (!Array.isArray(list) || list.length > MAX_CALLBACKS) {
    throw new Error(`${key} must list at most ${MAX_CALLBACKS} callback URLs`);
  }
  return list.map((item: unknown) => {
    if (typeof item !== 'string' || !isExactHttpsCallback(item)) {
      throw new Error(`${key}: ${JSON.stringify(item)} is not an exact https:// callback URL (no wildcard, query or fragment)`);
    }
    return item;
  });
}

function isExactHttpsCallback(url: string): boolean {
  if (url.length > 1024 || /[*\s#?]/.test(url)) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === 'https:' && parsed.username === '' && parsed.password === '' && parsed.hostname !== '';
  } catch {
    return false;
  }
}

export interface McpOAuthProps {
  api: apigateway.RestApi;
  /** `https://<id>.execute-api.<region>.<suffix>/v1` (restApiBaseUrl). */
  apiBaseUrl: string;
  userPool: cognito.IUserPool;
  /** The hosted-UI domain prefix of that pool (core-auth.ts `uniqueDnsName('voc')`). */
  userPoolDomainPrefix: string;
  frontendDomainName: string;
  jobsTable: dynamodb.ITable;
  globalMcp: GlobalMcp;
  /** cryptography, for RS256 verification on the MCP endpoint function (dependency-layers.ts). */
  signingLayer: lambda.ILayerVersion;
  uniqueName: (baseName: string) => string;
}

export class McpOAuth {
  public readonly resourceServer: cognito.UserPoolResourceServer;
  public readonly clients: Partial<Record<McpOAuthClientKind, cognito.UserPoolClient>> = {};

  constructor(private readonly stack: cdk.Stack, private readonly props: McpOAuthProps) {
    const mcpUrl = `${props.apiBaseUrl}/mcp/global`;
    const read = new cognito.ResourceServerScope({ scopeName: 'read', scopeDescription: 'Read VoC data as you' });
    const write = new cognito.ResourceServerScope({ scopeName: 'write', scopeDescription: 'Read and write VoC documents as you' });
    this.resourceServer = new cognito.UserPoolResourceServer(stack, 'McpOAuthResourceServer', {
      userPool: props.userPool,
      identifier: mcpUrl,
      userPoolResourceServerName: props.uniqueName('voc-mcp'),
      scopes: [read, write],
    });
    const scopes = [read, write].map((s) => cognito.OAuthScope.resourceServer(this.resourceServer, s));
    const relayUrl = `${props.apiBaseUrl}/oauth/callback`;
    const context = (key: string): unknown => stack.node.tryGetContext(key);
    const cursorCallbacks = callbackListContext(context('mcpOAuthCursorCallbacks'), 'mcpOAuthCursorCallbacks', DEFAULT_CURSOR_WEB_CALLBACKS);
    const webCallbacks = callbackListContext(context('mcpOAuthWebCallbacks'), 'mcpOAuthWebCallbacks', []);
    this.clients.kiro = this.client('McpOAuthKiroClient', 'voc-mcp-kiro', [relayUrl], scopes);
    this.clients['claude-code'] = this.client('McpOAuthClaudeCodeClient', 'voc-mcp-claude-code', [relayUrl], scopes);
    this.clients.cursor = this.client('McpOAuthCursorClient', 'voc-mcp-cursor', [relayUrl, ...cursorCallbacks], scopes);
    if (webCallbacks.length > 0) {
      this.clients.web = this.client('McpOAuthWebClient', 'voc-mcp-web', webCallbacks, scopes);
    }
    this.configureFunctions(mcpUrl, cursorCallbacks, webCallbacks);
    this.wireRoutes();
  }

  private client(id: string, name: string, callbackUrls: string[], scopes: cognito.OAuthScope[]): cognito.UserPoolClient {
    return new cognito.UserPoolClient(this.stack, id, {
      userPool: this.props.userPool,
      userPoolClientName: this.props.uniqueName(name),
      generateSecret: false,
      // Hosted-UI authorization code only: every explicit flow off leaves ALLOW_REFRESH_TOKEN_AUTH alone.
      authFlows: MCP_CLIENT_AUTH_FLOWS,
      oAuth: { flows: { authorizationCodeGrant: true }, scopes, callbackUrls, logoutUrls: callbackUrls },
      supportedIdentityProviders: [cognito.UserPoolClientIdentityProvider.COGNITO],
      accessTokenValidity: cdk.Duration.hours(1),
      idTokenValidity: cdk.Duration.hours(1),
      refreshTokenValidity: cdk.Duration.days(MCP_OAUTH_REFRESH_DAYS),
      enableTokenRevocation: true,
      preventUserExistenceErrors: true,
    });
  }

  private configureFunctions(mcpUrl: string, cursorCallbacks: string[], webCallbacks: string[]): void {
    const { stack, props } = this;
    const clientIds = Object.fromEntries(Object.entries(this.clients).map(([kind, client]) => [kind, client.userPoolClientId]));
    const environment: Record<string, string> = {
      MCP_RESOURCE_URL: mcpUrl,
      MCP_OAUTH_ISSUER: props.apiBaseUrl,
      MCP_OAUTH_CLIENTS: stack.toJsonString(clientIds),
      MCP_OAUTH_CURSOR_CALLBACKS: JSON.stringify(cursorCallbacks),
      MCP_OAUTH_WEB_CALLBACKS: JSON.stringify(webCallbacks),
      COGNITO_DOMAIN_URL: `https://${cognitoHostedUiHost(props.userPoolDomainPrefix, stack.region)}`,
      COGNITO_ISSUER: `https://cognito-idp.${stack.region}.${stack.urlSuffix}/${props.userPool.userPoolId}`,
      FRONTEND_URL: `https://${props.frontendDomainName}`,
      // RFC 8707 `resource`: dropped before Cognito unless the pool is known to accept it (docs/mcp.md).
      MCP_OAUTH_FORWARD_RESOURCE: String(booleanContextFlag(stack.node.tryGetContext('mcpOAuthResourceIndicator'),
        'mcpOAuthResourceIndicator', false, 'Use -c mcpOAuthResourceIndicator=true|false.')),
    };
    const { mcpFunction, tokensFunction } = props.globalMcp;
    for (const fn of [mcpFunction, tokensFunction]) {
      for (const [key, value] of Object.entries(environment)) fn.addEnvironment(key, value);
    }
    tokensFunction.addEnvironment('MCP_TOKEN_MINTING', String(tokenMintingEnabled(stack)));
    mcpFunction.addLayers(props.signingLayer);
    // The loopback relay's single-use rows (shared/mcp_oauth_relay.py): put + consume, nothing else.
    tokensFunction.addToRolePolicy(leadingKeys(props.jobsTable, ['PutItem', 'DeleteItem'], 'StringLike',
      `${OAUTH_RELAY_PARTITION_PREFIX}*`));
  }

  private wireRoutes(): void {
    const { api, globalMcp } = this.props;
    const integration = new apigateway.LambdaIntegration(globalMcp.tokensAlias,
      { proxy: true, scopePermissionToMethod: false });
    const anonymous = (resource: apigateway.IResource, verb: string): void => {
      const method = resource.addMethod(verb, integration, { authorizationType: apigateway.AuthorizationType.NONE });
      NagSuppressions.addResourceSuppressions(method, [
        { id: 'AwsSolutions-APIG4', reason: 'Deliberately anonymous OAuth facade/discovery route: an MCP client has no credential before it signs in (docs/mcp.md "OAuth sign-in"); throttled per method' },
        { id: 'AwsSolutions-COG4', reason: 'Deliberately anonymous OAuth facade/discovery route (see APIG4)' },
      ]);
    };
    const wellKnown = api.root.addResource('.well-known');
    const protectedResource = wellKnown.addResource('oauth-protected-resource');
    anonymous(protectedResource, 'GET');
    anonymous(protectedResource.addResource('mcp').addResource('global'), 'GET');
    anonymous(wellKnown.addResource('oauth-authorization-server'), 'GET');
    anonymous(wellKnown.addResource('openid-configuration'), 'GET');
    const oauth = api.root.addResource('oauth');
    anonymous(oauth.addResource('register'), 'POST');
    anonymous(oauth.addResource('authorize'), 'GET');
    anonymous(oauth.addResource('callback'), 'GET');
    anonymous(oauth.addResource('token'), 'POST');
    anonymous(oauth.addResource('revoke'), 'POST');
  }
}

/** Creates the MCP OAuth resources on `stack` (the class documents what they are). */
export function addMcpOAuth(stack: cdk.Stack, props: McpOAuthProps): McpOAuth {
  return new McpOAuth(stack, props);
}

/** `-c mcpTokenMinting=false` turns minting of `voc_tok_` tokens off; existing tokens stay valid. */
function tokenMintingEnabled(stack: cdk.Stack): boolean {
  return booleanContextFlag(stack.node.tryGetContext('mcpTokenMinting'), 'mcpTokenMinting', true,
    'Use -c mcpTokenMinting=true|false.');
}

/** The protected-resource metadata URL the 401 challenges name (RFC 9728, path-suffixed form). */
export function mcpResourceMetadataUrl(apiBaseUrl: string): string {
  return `${apiBaseUrl}/.well-known/oauth-protected-resource/mcp/global`;
}
