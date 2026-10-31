/**
 * MCP OAuth sign-in on VocApiStack (api-mcp-oauth.ts, docs/mcp.md "OAuth sign-in"): the Cognito
 * resource server and public clients, the anonymous facade's wiring and throttles, the functions'
 * environment and layers. The IAM of the tokens role is pinned in api-stack-mcp-global.test.ts and the
 * anonymous-route allowlist in api-stack.test.ts.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { renderCfnString } from '../test-support/cfn-render';
import {
  INTENTIONALLY_PUBLIC_OAUTH_ROUTES, apiMethods, apiTemplate, buildApiStack, functionIdForHandler, methodSettings, readRepoFile, synthApiTemplate,
} from '../test-support/api-stack-template';
import { itemAt } from '../test-support/guards';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { DEFAULT_CURSOR_WEB_CALLBACKS, MCP_OAUTH_METHOD_THROTTLE, MCP_OAUTH_REFRESH_DAYS, callbackListContext } from './api-mcp-oauth';

const API_ID = /\{Ref:VocAnalyticsApi[0-9A-F]{8}\}/g;
const BASE = 'https://{api}.execute-api.us-east-1.{Ref:AWS::URLSuffix}/v1';
// A resource server's Ref IS its identifier (the MCP URL, pinned in the first describe below).
const RESOURCE_SERVER = /\{Ref:McpOAuthResourceServer[0-9A-F]{8}\}/g;
const render = (value: unknown): string => renderCfnString(value).replace(API_ID, '{api}')
  .replace(RESOURCE_SERVER, `${BASE}/mcp/global`);

const ClientSchema = z.object({
  Properties: z.object({
    ClientName: z.unknown(),
    GenerateSecret: z.boolean().optional(),
    AllowedOAuthFlows: z.array(z.string()),
    AllowedOAuthFlowsUserPoolClient: z.boolean(),
    AllowedOAuthScopes: z.array(z.unknown()),
    ExplicitAuthFlows: z.array(z.string()).optional(),
    CallbackURLs: z.array(z.unknown()),
    AccessTokenValidity: z.number(),
    RefreshTokenValidity: z.number(),
    TokenValidityUnits: z.object({ AccessToken: z.string(), RefreshToken: z.string() }),
    EnableTokenRevocation: z.boolean(),
    PreventUserExistenceErrors: z.string(),
    SupportedIdentityProviders: z.array(z.string()),
  }),
});
type ClientProps = z.infer<typeof ClientSchema>['Properties'];

function mcpClients(template: Template): Record<string, ClientProps> {
  return Object.fromEntries(Object.entries(template.findResources('AWS::Cognito::UserPoolClient'))
    .filter(([id]) => id.startsWith('McpOAuth'))
    .map(([id, resource]) => [id.replace(/Client[0-9A-F]{8}$/, ''), ClientSchema.parse(resource).Properties]));
}

const EnvSchema = z.object({ Properties: z.object({
  Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  Layers: z.array(z.unknown()).optional(),
}) });

function functionProps(template: Template, handlerFile: string) {
  const id = functionIdForHandler(template, handlerFile);
  return EnvSchema.parse(template.toJSON().Resources[id]).Properties;
}

const envOf = (template: Template, handlerFile: string): Record<string, string> =>
  Object.fromEntries(Object.entries(functionProps(template, handlerFile).Environment.Variables).map(([k, v]) => [k, render(v)]));

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('Cognito resource server', () => {
  it('is identified by the exact MCP URL and carries the read and write scopes', () => {
    const servers = Object.values(apiTemplate().findResources('AWS::Cognito::UserPoolResourceServer'));
    expect(servers).toHaveLength(1);
    const props = z.object({ Properties: z.object({ Identifier: z.unknown(), Scopes: z.array(z.object({ ScopeName: z.string() })) }) })
      .parse(itemAt(servers, 0)).Properties;
    expect(render(props.Identifier)).toBe(`${BASE}/mcp/global`);
    expect(props.Scopes.map((s) => s.ScopeName)).toStrictEqual(['read', 'write']);
  });
});

describe('MCP OAuth app clients', () => {
  it('are exactly Kiro, Claude Code and Cursor by default (no web client without -c mcpOAuthWebCallbacks)', () => {
    expect(Object.keys(mcpClients(apiTemplate())).sort(byCodeUnit)).toStrictEqual(['McpOAuthClaudeCode', 'McpOAuthCursor', 'McpOAuthKiro']);
  });

  it('are public PKCE clients: code flow only, no secret, ONLY the MCP scopes (no openid = no ID token), no SRP/password flow, revocable', () => {
    for (const [name, props] of Object.entries(mcpClients(apiTemplate()))) {
      expect({
        secret: props.GenerateSecret ?? false,
        flows: props.AllowedOAuthFlows,
        oauthClient: props.AllowedOAuthFlowsUserPoolClient,
        scopes: props.AllowedOAuthScopes.map(render),
        authFlows: props.ExplicitAuthFlows,
        revocation: props.EnableTokenRevocation,
        userExistenceErrors: props.PreventUserExistenceErrors,
        providers: props.SupportedIdentityProviders,
        access: [props.AccessTokenValidity, props.TokenValidityUnits.AccessToken],
        refresh: [props.RefreshTokenValidity, props.TokenValidityUnits.RefreshToken],
      }, name).toStrictEqual({
        secret: false,
        flows: ['code'],
        oauthClient: true,
        scopes: [`${BASE}/mcp/global/read`, `${BASE}/mcp/global/write`],
        authFlows: ['ALLOW_REFRESH_TOKEN_AUTH'],
        revocation: true,
        userExistenceErrors: 'ENABLED',
        providers: ['COGNITO'],
        access: [60, 'minutes'],
        refresh: [MCP_OAUTH_REFRESH_DAYS * 24 * 60, 'minutes'],
      });
    }
  });

  it('call back only to the relay, plus Cursor its web callback', () => {
    const clients = mcpClients(apiTemplate());
    const relay = `${BASE}/oauth/callback`;
    expect(clients.McpOAuthKiro?.CallbackURLs.map(render)).toStrictEqual([relay]);
    expect(clients.McpOAuthClaudeCode?.CallbackURLs.map(render)).toStrictEqual([relay]);
    expect(clients.McpOAuthCursor?.CallbackURLs.map(render)).toStrictEqual([relay, ...DEFAULT_CURSOR_WEB_CALLBACKS]);
  });

  it('adds the web client with exactly the configured callbacks', () => {
    const template = synthApiTemplate({ mcpOAuthWebCallbacks: '["https://assistant.example.com/oauth/callback"]' });
    const web = mcpClients(template).McpOAuthWeb;
    expect(web?.CallbackURLs.map(render)).toStrictEqual(['https://assistant.example.com/oauth/callback']);
    expect(JSON.parse(envOf(template, 'mcp_global_handler.py').MCP_OAUTH_WEB_CALLBACKS ?? '[]'))
      .toStrictEqual(['https://assistant.example.com/oauth/callback']);
  }, SYNTH_TIMEOUT_MS);
});

describe('callback context lists', () => {
  it.each([
    ['["http://insecure.example.com/cb"]'], ['["https://*.example.com/cb"]'], ['["https://example.com/cb?x=1"]'],
    ['["https://example.com/cb#f"]'], ['[7]'], [JSON.stringify(Array.from({ length: 11 }, (_, i) => `https://e.example.com/${i}`))],
  ])('refuses %s at synth', (value) => {
    expect(() => callbackListContext(value, 'mcpOAuthWebCallbacks', [])).toThrow(/mcpOAuthWebCallbacks/);
  });

  it('accepts a JSON array, a comma list, or nothing (the fallback)', () => {
    expect(callbackListContext('https://a.example.com/cb, https://b.example.com/cb', 'k', [])).toStrictEqual(
      ['https://a.example.com/cb', 'https://b.example.com/cb']);
    expect(callbackListContext(undefined, 'k', ['https://c.example.com/cb'])).toStrictEqual(['https://c.example.com/cb']);
  });
});

describe('the anonymous facade', () => {
  it('routes every OAuth route to the tokens function, and nothing else is under /oauth or /.well-known', () => {
    const template = apiTemplate();
    const tokensFn = functionIdForHandler(template, 'mcp_tokens_handler.py');
    const surface = apiMethods(template).filter((m) => m.httpMethod !== 'OPTIONS'
      && (m.path.startsWith('/oauth') || m.path.startsWith('/.well-known')));
    expect(surface.map((m) => m.route).sort(byCodeUnit)).toStrictEqual([...INTENTIONALLY_PUBLIC_OAUTH_ROUTES].sort(byCodeUnit));
    for (const method of surface) expect(method.integrationFunctionId, method.route).toBe(tokensFn);
  });

  it('throttles every one of those methods at the stage', () => {
    const settings = new Map(methodSettings(apiTemplate()).map((s) => [s.key, s]));
    for (const route of INTENTIONALLY_PUBLIC_OAUTH_ROUTES) {
      const [verb = '', path = ''] = route.split(' ');
      const key = `${path}/${verb}`;
      const expected = MCP_OAUTH_METHOD_THROTTLE[key];
      expect(expected, `${key} has no MCP_OAUTH_METHOD_THROTTLE entry`).toBeDefined();
      const found = settings.get(key);
      expect(found, `${key} has no method-level throttle`).toBeDefined();
      expect([found?.rate, found?.burst], key).toStrictEqual([expected?.throttlingRateLimit, expected?.throttlingBurstLimit]);
    }
  });
});

describe('function environment and layers', () => {
  it('hands both MCP functions the same OAuth facts, built from the API id (no stage cycle)', () => {
    const mcp = envOf(apiTemplate(), 'mcp_global_handler.py');
    const tokens = envOf(apiTemplate(), 'mcp_tokens_handler.py');
    const facts = (env: Record<string, string>) => ({
      resource: env.MCP_RESOURCE_URL,
      issuer: env.MCP_OAUTH_ISSUER,
      cognitoDomain: env.COGNITO_DOMAIN_URL,
      // The pool id is VocCoreStack's export (an Fn::ImportValue of the user pool's Ref).
      cognitoIssuer: (env.COGNITO_ISSUER ?? '').replace(/\/\{.*UserPool.*\}$/, '/{pool}'),
      frontend: env.FRONTEND_URL,
      forwardResource: env.MCP_OAUTH_FORWARD_RESOURCE,
      clientKinds: Object.keys(z.record(z.string(), z.string())
        .parse(JSON.parse(z.string().parse(env.MCP_OAUTH_CLIENTS).replace(/\{Ref:[^}]+\}/g, 'id')))).sort(byCodeUnit),
    });
    const expected = {
      resource: `${BASE}/mcp/global`, issuer: BASE, cognitoDomain: 'https://voc-test.auth.us-east-1.amazoncognito.com',
      cognitoIssuer: 'https://cognito-idp.us-east-1.{Ref:AWS::URLSuffix}/{pool}', frontend: 'https://app.example.invalid',
      forwardResource: 'false', clientKinds: ['claude-code', 'cursor', 'kiro'],
    };
    expect({ mcp: facts(mcp), tokens: facts(tokens) }).toStrictEqual({ mcp: expected, tokens: expected });
    expect([tokens.MCP_TOKEN_MINTING, mcp.MCP_TOKEN_MINTING]).toStrictEqual(['true', undefined]);
  });

  it('tells the SPA the same hosted UI (config.json cognito.hostedUiDomain), the consent page\'s only non-loopback sign-in origin', () => {
    const stack = buildApiStack();
    const cognito = z.object({ cognito: z.object({ hostedUiDomain: z.string() }) }).parse(stack.resolve(stack.runtimeConfig)).cognito;
    expect(`https://${cognito.hostedUiDomain}`).toBe(envOf(apiTemplate(), 'mcp_tokens_handler.py').COGNITO_DOMAIN_URL);
  }, SYNTH_TIMEOUT_MS);

  it('turns minting off and forwards resource only when the context says so', () => {
    const template = synthApiTemplate({ mcpTokenMinting: 'false', mcpOAuthResourceIndicator: 'true' });
    expect(envOf(template, 'mcp_tokens_handler.py').MCP_TOKEN_MINTING).toBe('false');
    expect(envOf(template, 'mcp_global_handler.py').MCP_OAUTH_FORWARD_RESOURCE).toBe('true');
    expect(() => synthApiTemplate({ mcpTokenMinting: 'nope' })).toThrow(/mcpTokenMinting/);
  }, SYNTH_TIMEOUT_MS);

  it('gives cryptography to the MCP endpoint function only (it verifies RS256), not to the tokens API', () => {
    const layerIds = (handler: string) => (functionProps(apiTemplate(), handler).Layers ?? []).map(render);
    expect(layerIds('mcp_global_handler.py').some((id) => id.includes('SigningDepsLayer'))).toBe(true);
    expect(layerIds('mcp_tokens_handler.py').some((id) => id.includes('SigningDepsLayer'))).toBe(false);
  });

  it('keeps the env keys in lockstep with shared/mcp_oauth_config.py', () => {
    const source = readRepoFile('lambda', 'shared', 'mcp_oauth_config.py');
    const keys = Object.keys(envOf(apiTemplate(), 'mcp_global_handler.py'))
      .filter((key) => key.startsWith('MCP_OAUTH') || ['MCP_RESOURCE_URL', 'COGNITO_DOMAIN_URL', 'COGNITO_ISSUER', 'FRONTEND_URL'].includes(key));
    expect(keys).toHaveLength(9);
    for (const key of keys) expect(source, key).toContain(`'${key}'`);
  });
});
