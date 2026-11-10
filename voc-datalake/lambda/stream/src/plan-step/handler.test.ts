import { InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
import { describe, expect, it, vi } from 'vitest';
import { buildProxyEvent, createInternalApiInvoker, invokeDomainRoute } from '../assistant/tools/internal-api.js';
import { handler } from './handler.js';

const PLAN_CLAIMS = { sub: 'sub-1', 'cognito:groups': 'users', 'voc:acting_subject': 'sub-1', 'voc:principal': 'plan:pl_0123456789ab' };
const ok: InvocationResponse = { StatusCode: 200, Payload: new TextEncoder().encode(JSON.stringify({ statusCode: 200, body: '{"success":true}' })) };

describe('voc-plan-step handler', () => {
  it('answers an invalid event with a client-safe failure and logs no payload', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(await handler({ plan_id: 'pl_0123456789ab', step: { secret: 'x' } })).toStrictEqual({ status: 'failed', error: 'The plan step event is invalid.', model_calls: 0 });
    expect(JSON.stringify(log.mock.calls)).not.toContain('secret');
    log.mockRestore();
  });
});

describe('the write transport', () => {
  it('forwards the plan principal claims to the domain function', () => {
    const event = buildProxyEvent({ fn: 'projects', method: 'PUT', path: '/projects/p1', resource: '/projects/{proxy+}' }, PLAN_CLAIMS);
    expect(event.requestContext).toStrictEqual({ authorizer: { claims: PLAN_CLAIMS }, stage: 'v1' });
  });

  it('sends a PUT through invokeDomainRoute but the read-only invoker refuses it before invoking', async () => {
    const send = vi.fn((_command: InvokeCommand) => Promise.resolve(ok));
    const call = { fn: 'projects', method: 'PUT', path: '/projects/p1', resource: '/projects/{proxy+}' } as const;
    expect(await invokeDomainRoute({ send }, { projects: 'voc-projects-api' }, call, PLAN_CLAIMS)).toStrictEqual({ success: true });
    await expect(createInternalApiInvoker({ send }, { projects: 'voc-projects-api' })(call, PLAN_CLAIMS)).rejects.toMatchObject({ code: 'not_permitted' });
    expect(send).toHaveBeenCalledTimes(1);
  });
});
