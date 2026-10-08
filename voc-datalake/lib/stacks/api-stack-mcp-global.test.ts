/**
 * The global MCP endpoint and its token API (global-mcp.ts, todofeatures §6.3)
 * stay least-privilege and in step with the Python they deploy.
 *
 * Every number and name here is read from the Python source rather than
 * restated, so a partition key, a domain env key or a route renamed on one side
 * fails here instead of at the first tool call after a deploy.
 */
import { describe, expect, it } from 'vitest';

import {
  actionsWithPrefix, apiMethods, apiTemplate, functionIdForHandler, methodThrottles, policyStatementsOf,
  readRepoFile, serviceEnvironment,
} from '../test-support/api-stack-template';
import { itemAt } from '../test-support/guards';
import { byCodeUnit } from '../utils/compare';

const pythonString = (file: string, name: string) => {
  const value = new RegExp(`^${name}: Final = '([^']+)'`, 'm').exec(readRepoFile('lambda', 'shared', file))?.[1];
  expect(value, `could not read ${name} from ${file}`).toBeDefined();
  return value ?? '';
};

/** DOMAIN_FUNCTION_ENV in mcp_global_tools.py: env key → domain. */
function domainEnvKeys(): string[] {
  const table = /DOMAIN_FUNCTION_ENV[^=]*=\s*\{([\s\S]*?)\}/.exec(readRepoFile('lambda', 'shared', 'mcp_global_tools.py'))?.[1];
  const keys = [...(table ?? '').matchAll(/:\s*'([A-Z_]+)'/g)].map((m) => itemAt(m, 1));
  expect(keys.length, 'DOMAIN_FUNCTION_ENV parsed to nothing').toBeGreaterThan(0);
  return keys;
}

/** Every route a global tool builds, as `METHOD /path` with `{}` for interpolated segments. */
function toolRoutes(): string[] {
  const source = readRepoFile('lambda', 'shared', 'mcp_global_tools.py');
  return [...source.matchAll(/RouteRequest\(DOMAIN_[A-Z]+, '([A-Z]+)', f?['"]([^'"]+)['"]/g)]
    .map((m) => `${itemAt(m, 1)} ${collapsePlaceholders(itemAt(m, 2))}`);
}

/** Every `{…}` f-string placeholder as `{}` — a linear scan, no backtracking regex. */
function collapsePlaceholders(path: string): string {
  return path.split('{').map((part, i) => {
    if (i === 0) return part;
    const close = part.indexOf('}');
    return close < 0 ? `{${part}` : `{}${part.slice(close + 1)}`;
  }).join('');
}

const GLOBAL_ROLE = 'GlobalEndpointRole';
const TOKENS_ROLE = 'TokensApiRole';

/** DynamoDB statements on one table (the invoke statement also names `ProjectsApi`). */
const onTable = (statements: ReturnType<typeof policyStatementsOf>, table: string) =>
  statements.filter((s) => s.resource.includes(table) && s.actions.some((a) => a.startsWith('dynamodb:')));

describe('global MCP endpoint wiring', () => {
  it('serves POST /mcp/global from mcp_global_handler behind the MCP token authorizer', () => {
    const method = apiMethods(apiTemplate()).find((m) => m.path === '/mcp/global' && m.httpMethod === 'POST');
    expect(method?.integrationFunctionId).toBe(functionIdForHandler(apiTemplate(), 'mcp_global_handler.py'));
    expect(method?.authorizationType).toBe('CUSTOM');
    expect(method?.hasAuthorizerId).toBe(true);
  });

  it('serves every /connect/tokens route from the tokens Lambda behind Cognito', () => {
    const tokensFn = functionIdForHandler(apiTemplate(), 'mcp_tokens_handler.py');
    const routes = apiMethods(apiTemplate())
      .filter((m) => m.path.startsWith('/connect/tokens') && m.httpMethod !== 'OPTIONS');
    expect(routes.map((m) => `${m.httpMethod} ${m.path}`).sort(byCodeUnit)).toStrictEqual([
      'DELETE /connect/tokens/{token_id}', 'GET /connect/tokens', 'GET /connect/tokens/{token_id}', 'POST /connect/tokens',
    ]);
    for (const route of routes) {
      expect(route.integrationFunctionId, route.path).toBe(tokensFn);
      expect(route.authorizationType, route.path).toBe('COGNITO_USER_POOLS');
    }
  });

  it('throttles the endpoint at 20 rps / 40', () => {
    expect(methodThrottles(apiTemplate(), ['/mcp/global/POST'])).toStrictEqual({
      '/mcp/global/POST': { rate: 20, burst: 40 },
    });
  });

  it('hands the handler every domain function name it reads, plus the pool and both tables', () => {
    const env = serviceEnvironment(apiTemplate(), 'voc-mcp-global-api');
    expect(domainEnvKeys().filter((key) => !(key in env))).toStrictEqual([]);
    for (const key of ['USER_POOL_ID', 'PROJECTS_TABLE', 'JOBS_TABLE', 'ALLOWED_ORIGIN']) {
      expect(env[key], key).toBeDefined();
    }
    expect(['FEEDBACK_TABLE', 'AGGREGATES_TABLE', 'MEMORY_TABLE', 'AGENTS_TABLE'].filter((key) => key in env))
      .toStrictEqual([]);
  });

  it('builds only routes that API Gateway wires (the browser reaches them the same way)', () => {
    const shape = (path: string) => path.split('/').map((s) => (s.startsWith('{') ? '{}' : s)).join('/');
    const wired = apiMethods(apiTemplate());
    const exact = new Set(wired.map((m) => `${m.httpMethod} ${shape(m.path)}`));
    const proxies = wired.filter((m) => m.path.endsWith('/{proxy+}')).map((m) => m.path.slice(0, -'{proxy+}'.length));
    const routes = toolRoutes();
    expect(routes.length).toBeGreaterThan(10);
    const unwired = routes.filter((route) => {
      const [verb = '', path = ''] = route.split(' ');
      return !exact.has(`${verb} ${shape(path)}`) && !proxies.some((prefix) => path.startsWith(prefix));
    });
    expect(unwired).toStrictEqual([]);
  });
});

describe('global MCP endpoint IAM', () => {
  const statements = () => policyStatementsOf(apiTemplate(), GLOBAL_ROLE);

  it('touches the projects table only as GetItem/UpdateItem on the global token partition', () => {
    const projects = onTable(statements(), 'Projects');
    expect(projects.length).toBeGreaterThan(0);
    expect(actionsWithPrefix(projects, 'dynamodb:')).toStrictEqual(['dynamodb:GetItem', 'dynamodb:UpdateItem']);
    for (const statement of projects) {
      expect(statement.condition).toStrictEqual({
        'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [pythonString('mcp_global_tokens.py', 'GLOBAL_TOKEN_PK')] },
      });
    }
  });

  it('only appends audit rows, in the audit partitions of the jobs table', () => {
    const jobs = onTable(statements(), 'Jobs');
    expect(actionsWithPrefix(jobs, 'dynamodb:')).toStrictEqual(['dynamodb:PutItem']);
    expect(itemAt(jobs, 0).condition).toStrictEqual({
      'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': [`${pythonString('mcp_global_tokens.py', 'AUDIT_PK_PREFIX')}*`] },
    });
  });

  it('reads no data table directly', () => {
    const tables = statements().filter((s) => s.actions.some((a) => a.startsWith('dynamodb:'))).map((s) => s.resource);
    for (const forbidden of ['Feedback', 'Aggregates', 'Memory', 'Agents', 'Conversations']) {
      expect(tables.filter((r) => r.includes(forbidden)), forbidden).toStrictEqual([]);
    }
  });

  it('may invoke exactly the five domain functions, by unqualified ARN', () => {
    const invoke = statements().filter((s) => s.actions.includes('lambda:InvokeFunction'));
    expect(invoke).toHaveLength(1);
    const { resource } = itemAt(invoke, 0);
    expect(['MetricsApi', 'SettingsApi', 'MemoryApi', 'ProjectsApi', 'AgentsApi'].filter((fn) => !resource.includes(fn)))
      .toStrictEqual([]);
    expect((resource.match(/Api[0-9A-F]{8}/g) ?? []).length).toBe(domainEnvKeys().length);
    expect(resource).not.toContain(':*');
  });

  it('holds exactly the two Cognito reads the minter checks need, on this pool', () => {
    const cognito = statements().filter((s) => s.actions.some((a) => a.startsWith('cognito-idp:')));
    expect(actionsWithPrefix(cognito, 'cognito-idp:'))
      .toStrictEqual(['cognito-idp:AdminGetUser', 'cognito-idp:AdminListGroupsForUser']);
    expect(itemAt(cognito, 0).resource).toContain('UserPool');
  });
});

describe('MCP token API IAM', () => {
  const statements = () => policyStatementsOf(apiTemplate(), TOKENS_ROLE);

  it('writes only the global token partition, and reads project META only to check a pin', () => {
    const projects = onTable(statements(), 'Projects');
    const byPartition = Object.fromEntries(projects.map((s) => [JSON.stringify(s.condition), [...s.actions].sort(byCodeUnit)]));
    const tokenPartition = pythonString('mcp_global_tokens.py', 'GLOBAL_TOKEN_PK');
    expect(byPartition).toStrictEqual({
      [JSON.stringify({ 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [tokenPartition] } })]:
        ['dynamodb:BatchGetItem', 'dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:Query', 'dynamodb:UpdateItem'],
      [JSON.stringify({ 'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['PROJECT#*'] } })]: ['dynamodb:GetItem'],
    });
  });

  it('only queries the audit partitions, and holds no delete, Cognito or invoke', () => {
    const all = statements();
    const jobs = onTable(all, 'Jobs');
    expect(actionsWithPrefix(jobs, 'dynamodb:')).toStrictEqual(['dynamodb:Query']);
    expect(actionsWithPrefix(all, 'dynamodb:').filter((a) => a.includes('Delete'))).toStrictEqual([]);
    expect(actionsWithPrefix(all, 'cognito-idp:')).toStrictEqual([]);
    expect(actionsWithPrefix(all, 'lambda:')).toStrictEqual([]);
  });
});
