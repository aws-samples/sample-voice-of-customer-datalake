/**
 * `APP_CLIENT_IDS` (app-client-env.ts): every VocApiStack function knows the only app clients whose tokens
 * the REST API accepts — the SPA's web client and the board pool's client, never an MCP OAuth client
 * (security review of 5.61.00; lambda/shared/app_clients.py refuses every other client with a 401).
 */
import { beforeAll, describe, expect, it } from 'vitest';

import { renderCfnString } from '../test-support/cfn-render';
import { LambdaEnvSchema, apiTemplate, readRepoFile } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { APP_CLIENT_IDS_ENV, isApiHandler } from './app-client-env';

interface FunctionEnv { id: string; handler: string; value: string | undefined }

function functionEnvs(): FunctionEnv[] {
  const functions = apiTemplate().findResources('AWS::Lambda::Function');
  return Object.entries(functions).map(([id, resource]) => {
    const { Handler, Environment } = LambdaEnvSchema.parse(resource).Properties;
    const value = Environment?.Variables[APP_CLIENT_IDS_ENV];
    return { id, handler: Handler ?? '', value: value === undefined ? undefined : renderCfnString(value) };
  });
}

const STREAM_ID = /^ChatStreamApi[0-9A-F]{8}$/;

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('APP_CLIENT_IDS', () => {
  it('is set on every API handler and the assistant stream, on nothing else (no set-never-read env)', () => {
    const envs = functionEnvs();
    const wrong = envs.filter((fn) => (isApiHandler(fn.handler) || STREAM_ID.test(fn.id)) !== (fn.value !== undefined));
    expect(wrong.map((fn) => `${fn.id} ${fn.handler}`)).toStrictEqual([]);
    expect(envs.filter((fn) => fn.value !== undefined).length).toBeGreaterThan(20);
  });

  it('skips the global MCP endpoint, which verifies its own credentials', () => {
    expect(isApiHandler('mcp_global_handler.lambda_handler')).toBe(false);
    expect(isApiHandler('settings_handler.lambda_handler')).toBe(true);
    expect(isApiHandler('handler.lambda_handler')).toBe(false);
  });

  it('names exactly the web client and the board client, never an MCP OAuth client', () => {
    const values = new Set(functionEnvs().filter((fn) => fn.value !== undefined).map((fn) => fn.value));
    expect(values.size).toBe(1);
    const [value = ''] = [...values];
    // The two cross-stack imports from the core stack's test double: web client first, then the board client.
    const parts = value.split(',').map((part) => /ExportsOutputRef([A-Za-z]+?)[0-9A-F]{8,}/.exec(part)?.[1]);
    expect(parts).toStrictEqual(['UserPoolClient', 'BoardUserPoolBoardClient']);
    expect(value).not.toMatch(/McpOAuth/);
  });

  it('keeps the variable name in lockstep with lambda/shared/app_clients.py', () => {
    expect(readRepoFile('lambda', 'shared', 'app_clients.py')).toContain(`APP_CLIENT_IDS_ENV: Final = '${APP_CLIENT_IDS_ENV}'`);
  });
});
