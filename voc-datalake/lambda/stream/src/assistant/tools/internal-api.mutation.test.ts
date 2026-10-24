/**
 * What the mutation run found no spec exercised: the process-wide invoker. It
 * is built once per container, over ONE LambdaClient with two attempts, and
 * reads the function names from the environment.
 */
import type { InvokeCommand } from '@aws-sdk/client-lambda';
import { afterEach, describe, expect, it, vi } from 'vitest';

const lambda = vi.hoisted(() => {
  const configs: unknown[] = [];
  const sent: InvokeCommand[] = [];
  return { configs, sent };
});

vi.mock('@aws-sdk/client-lambda', async (importOriginal) => {
  const original = await importOriginal<typeof import('@aws-sdk/client-lambda')>();
  class FakeLambdaClient {
    constructor(config: unknown) {
      lambda.configs.push(config);
    }

    send(command: InvokeCommand): Promise<unknown> {
      lambda.sent.push(command);
      const payload = JSON.stringify({ statusCode: 200, body: '{"ok":true}' });
      return Promise.resolve({ StatusCode: 200, Payload: new TextEncoder().encode(payload) });
    }
  }
  return { ...original, LambdaClient: FakeLambdaClient };
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('getInternalApiInvoker', () => {
  it('builds one invoker over one two-attempt client and the env function names', async () => {
    vi.stubEnv('METRICS_FUNCTION', 'voc-metrics-api');
    const { getInternalApiInvoker } = await import('./internal-api.js');

    const first = getInternalApiInvoker();
    expect(getInternalApiInvoker()).toBe(first);
    expect(lambda.configs).toStrictEqual([{ maxAttempts: 2 }]);

    await expect(first({ fn: 'metrics', method: 'GET', path: '/metrics/summary', resource: '/metrics/summary' }, { sub: 's' }))
      .resolves.toStrictEqual({ ok: true });
    expect(lambda.sent.map((command) => command.input.FunctionName)).toStrictEqual(['voc-metrics-api']);
  });
});
