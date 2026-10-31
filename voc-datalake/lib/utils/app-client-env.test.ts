/**
 * `APP_CLIENT_IDS` (app-client-env.ts): every VocApiStack function knows the only app clients whose tokens
 * the REST API accepts — the SPA's web client and the board pool's client, never an MCP OAuth client
 * (security review of 5.58.00; lambda/shared/app_clients.py refuses every other client with a 401).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { renderCfnString } from '../test-support/cfn-render';
import { apiTemplate, readRepoFile } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { APP_CLIENT_IDS_ENV } from './app-client-env';

const FunctionSchema = z.object({
  Properties: z.object({
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }).optional(),
  }),
});

function appClientValues(): Map<string, string | undefined> {
  const functions = apiTemplate().findResources('AWS::Lambda::Function');
  return new Map(Object.entries(functions).map(([id, resource]) => {
    const value = FunctionSchema.parse(resource).Properties.Environment?.Variables[APP_CLIENT_IDS_ENV];
    return [id, value === undefined ? undefined : renderCfnString(value)];
  }));
}

beforeAll(() => {
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

describe('APP_CLIENT_IDS', () => {
  it('is set on every function of VocApiStack', () => {
    const missing = [...appClientValues()].filter(([, value]) => value === undefined).map(([id]) => id);
    expect(missing).toStrictEqual([]);
  });

  it('names exactly the web client and the board client, never an MCP OAuth client', () => {
    const values = new Set(appClientValues().values());
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
