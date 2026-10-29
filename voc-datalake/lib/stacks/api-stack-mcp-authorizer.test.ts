/**
 * `/mcp/global`'s authorizer and its 401 (5.35 prod e2e): a dead token must reach an MCP client as a
 * 401 WITH `WWW-Authenticate: Bearer …`. A Lambda proxy response cannot carry that header (API
 * Gateway remaps it to `x-amzn-Remapped-WWW-Authenticate`), so the refusal is the authorizer's
 * Deny, answered by the ACCESS_DENIED gateway response. Pinned here: the authorizer IS the global
 * MCP function (the real check), uncached, and the ACCESS_DENIED response is the MCP 401 — which
 * is only safe while the MCP authorizer is the API's one Lambda authorizer and no resource policy
 * can deny.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiMethods, apiTemplate, functionIdForHandler } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { MCP_BEARER_CHALLENGE, MCP_UNAUTHORIZED_BODY } from './api-mcp';

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const AuthorizerSchema = z.object({
  Properties: z.object({
    Name: z.string(),
    Type: z.string(),
    AuthorizerUri: z.unknown().optional(),
    AuthorizerResultTtlInSeconds: z.number().optional(),
  }),
});

const GatewayResponseSchema = z.object({
  Properties: z.object({
    ResponseType: z.string(),
    StatusCode: z.string().optional(),
    ResponseParameters: z.record(z.string(), z.string()).optional(),
    ResponseTemplates: z.record(z.string(), z.string()).optional(),
  }),
});

function authorizers(): z.infer<typeof AuthorizerSchema>['Properties'][] {
  return Object.values(apiTemplate().findResources('AWS::ApiGateway::Authorizer'))
    .map((r) => AuthorizerSchema.parse(r).Properties);
}

function mcpAuthorizer(): z.infer<typeof AuthorizerSchema>['Properties'] {
  const found = authorizers().find((a) => a.Name === 'voc-mcp-token-authorizer');
  if (found === undefined) throw new Error('no voc-mcp-token-authorizer in the template');
  return found;
}

describe('the /mcp/global token authorizer', () => {
  it('is the global MCP function itself, so a dead token is refused by the gateway', () => {
    const mcpFunctionId = functionIdForHandler(apiTemplate(), 'mcp_global_handler.py');
    expect(JSON.stringify(mcpAuthorizer().AuthorizerUri)).toContain(`"${mcpFunctionId}"`);
    // The retired inline Node shape-checker is gone (no function reads `authorizationToken` inline).
    const inline = Object.values(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter((fn) => JSON.stringify(fn).includes('authorizationToken'));
    expect(inline).toHaveLength(0);
  });

  it('is never cached, so a revocation takes effect on the next request', () => {
    expect(mcpAuthorizer().AuthorizerResultTtlInSeconds).toBe(0);
  });

  it('guards every /mcp/global method', () => {
    const mcp = apiMethods(apiTemplate()).filter((m) => m.path === '/mcp/global' && m.httpMethod !== 'OPTIONS');
    const guarded = mcp.map((m) => `${m.httpMethod} ${m.authorizationType}${m.hasAuthorizerId ? ' +authorizer' : ''}`);
    guarded.sort(byCodeUnit);
    expect(guarded).toStrictEqual(['DELETE CUSTOM +authorizer', 'GET CUSTOM +authorizer', 'POST CUSTOM +authorizer']);
  });
});

describe('access denied gateway response', () => {
  function accessDenied(): z.infer<typeof GatewayResponseSchema>['Properties'] {
    const found = Object.values(apiTemplate().findResources('AWS::ApiGateway::GatewayResponse'))
      .map((r) => GatewayResponseSchema.parse(r).Properties)
      .filter((p) => p.ResponseType === 'ACCESS_DENIED');
    expect(found).toHaveLength(1);
    const [only] = found;
    if (only === undefined) throw new Error('no ACCESS_DENIED gateway response');
    return only;
  }

  it('answers a refused MCP credential with a 401 and the Bearer challenge', () => {
    const props = accessDenied();
    expect(props.StatusCode).toBe('401');
    expect(props.ResponseParameters?.['gatewayresponse.header.WWW-Authenticate']).toBe(`'${MCP_BEARER_CHALLENGE}'`);
    expect(MCP_BEARER_CHALLENGE).toMatch(/^Bearer realm="voc-mcp-global"/);
  });

  it('lets a browser read the challenge and tells a cache the 401 varies by credential', () => {
    const headers = accessDenied().ResponseParameters ?? {};
    expect((headers['gatewayresponse.header.Access-Control-Expose-Headers'] ?? '').toLowerCase()).toContain('www-authenticate');
    expect((headers['gatewayresponse.header.Vary'] ?? '').toLowerCase()).toContain('authorization');
  });

  it('keeps the JSON-RPC error body the handler sends', () => {
    const body: unknown = JSON.parse(accessDenied().ResponseTemplates?.['application/json'] ?? 'null');
    expect(body).toStrictEqual(JSON.parse(MCP_UNAUTHORIZED_BODY));
    expect(body).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: -32001 } });
  });

  it('can only be raised by the MCP authorizer: one Lambda authorizer, no resource policy', () => {
    const lambdaAuthorizers = authorizers().filter((a) => a.Type === 'TOKEN' || a.Type === 'REQUEST');
    expect(lambdaAuthorizers.map((a) => a.Name)).toStrictEqual(['voc-mcp-token-authorizer']);
    const apis = Object.values(apiTemplate().findResources('AWS::ApiGateway::RestApi'));
    for (const api of apis) expect(JSON.stringify(api)).not.toContain('"Policy"');
  });
});
