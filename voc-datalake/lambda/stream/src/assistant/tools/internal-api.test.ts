import { InvokeCommand, type InvocationResponse } from '@aws-sdk/client-lambda';
import { describe, expect, it, vi } from 'vitest';
import {
  buildProxyEvent,
  CHAT_CONTEXT_RESOURCE,
  createInternalApiInvoker,
  functionNamesFromEnv,
  MEMORY_RETRIEVE_RESOURCE,
  WORKFLOW_VALIDATE_RESOURCE,
  type ApiCall,
  type ApiFunction,
} from './internal-api.js';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

const CLAIMS = {
  sub: 'sub-1',
  'cognito:groups': '[admins]',
  'cognito:username': 'alice',
  email: 'alice@example.com',
};

function proxy(statusCode: number, body?: unknown): InvocationResponse {
  return {
    StatusCode: 200,
    Payload: encoder.encode(JSON.stringify({ statusCode, body: body === undefined ? undefined : JSON.stringify(body) })),
  };
}

const DEFAULT_FUNCTIONS = { metrics: 'voc-metrics-api', projects: 'voc-projects-api' } as const;

function setup(response: InvocationResponse, functionNames: Partial<Record<ApiFunction, string>> = DEFAULT_FUNCTIONS) {
  const send = vi.fn<(command: InvokeCommand) => Promise<InvocationResponse>>(() => Promise.resolve(response));
  const invoke = createInternalApiInvoker({ send }, functionNames);
  return { send, invoke };
}

function sentEvent(send: ReturnType<typeof setup>['send']): Record<string, unknown> {
  const command = send.mock.calls.at(0)?.[0];
  const payload = command?.input.Payload;
  return payload instanceof Uint8Array ? JSON.parse(decoder.decode(payload)) : {};
}

const JOBS_CALL: ApiCall = {
  fn: 'projects',
  method: 'GET',
  path: '/projects/p1/jobs',
  resource: '/projects/{project_id}/jobs',
  pathParameters: { project_id: 'p1' },
};

describe('buildProxyEvent', () => {
  it('builds the REST v1 proxy shape the Powertools resolver routes on', () => {
    const event = buildProxyEvent({
      fn: 'metrics',
      method: 'GET',
      path: '/metrics/summary',
      resource: '/metrics/{proxy+}',
      pathParameters: { proxy: 'summary' },
      query: { days: 7, include: true, skipped: undefined },
    }, CLAIMS);

    expect(event).toStrictEqual({
      httpMethod: 'GET',
      path: '/metrics/summary',
      resource: '/metrics/{proxy+}',
      queryStringParameters: { days: '7', include: 'true' },
      pathParameters: { proxy: 'summary' },
      body: null,
      headers: { 'Content-Type': 'application/json' },
      requestContext: { authorizer: { claims: CLAIMS }, stage: 'v1' },
      isBase64Encoded: false,
    });
  });

  it('forwards only the known claim keys, and only string values', () => {
    // A variable, not a literal: the extra `token` key must reach the builder past excess-property checks.
    const claimsWithToken = { sub: 's', 'cognito:groups': '', token: 'secret' };
    const event = buildProxyEvent(JOBS_CALL, claimsWithToken);
    expect(event.requestContext).toStrictEqual({ authorizer: { claims: { sub: 's' } }, stage: 'v1' });
  });
});

describe('createInternalApiInvoker', () => {
  it('invokes the configured function synchronously and returns the parsed body', async () => {
    const { send, invoke } = setup(proxy(200, { success: true, jobs: [] }));

    await expect(invoke(JOBS_CALL, CLAIMS)).resolves.toStrictEqual({ success: true, jobs: [] });
    expect(send.mock.calls[0]?.[0].input).toMatchObject({
      FunctionName: 'voc-projects-api',
      InvocationType: 'RequestResponse',
    });
    expect(sentEvent(send)).toMatchObject({ httpMethod: 'GET', path: '/projects/p1/jobs' });
  });

  it('allows the chat-context POST with its JSON body', async () => {
    const { send, invoke } = setup(proxy(200, { project: {}, personas: [], documents: [] }));
    await invoke({
      fn: 'projects',
      method: 'POST',
      path: '/projects/p1/chat-context',
      resource: CHAT_CONTEXT_RESOURCE,
      body: { selected_document_ids: ['d1'] },
    }, CLAIMS);
    expect(sentEvent(send)).toMatchObject({ httpMethod: 'POST', body: '{"selected_document_ids":["d1"]}' });
  });

  it('refuses any other POST before invoking', async () => {
    const { send, invoke } = setup(proxy(200, {}));
    await expect(invoke({ fn: 'projects', method: 'POST', path: '/projects', resource: '/projects' }, CLAIMS))
      .rejects.toMatchObject({ code: 'not_permitted' });
    expect(send).not.toHaveBeenCalled();
  });

  it('allows the memory-recall and workflow-validate POSTs on their owning functions only', async () => {
    const { send, invoke } = setup(proxy(200, {}), { memory: 'voc-memory-api', agents: 'voc-agents-api', projects: 'p' });
    await invoke({ fn: 'memory', method: 'POST', path: '/memory/retrieve', resource: MEMORY_RETRIEVE_RESOURCE, body: { query: 'q' } }, CLAIMS);
    await invoke({ fn: 'agents', method: 'POST', path: '/workflows/validate', resource: WORKFLOW_VALIDATE_RESOURCE, body: {} }, CLAIMS);
    expect(send.mock.calls.map((call) => call[0].input.FunctionName)).toStrictEqual(['voc-memory-api', 'voc-agents-api']);
    // The right resource on the wrong function is refused.
    await expect(invoke({ fn: 'projects', method: 'POST', path: '/memory/retrieve', resource: MEMORY_RETRIEVE_RESOURCE }, CLAIMS))
      .rejects.toMatchObject({ code: 'not_permitted' });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['memory', '/memory/m1/forget', MEMORY_RETRIEVE_RESOURCE],
    ['agents', '/agents/a1/run', WORKFLOW_VALIDATE_RESOURCE],
    ['projects', '/projects/p1/documents/merge', CHAT_CONTEXT_RESOURCE],
    ['projects', '/projects//chat-context', CHAT_CONTEXT_RESOURCE],
    ['projects', '/projects/p1/chat-context/x', CHAT_CONTEXT_RESOURCE],
    ['projects', '/projects/p1/documents', CHAT_CONTEXT_RESOURCE],
    ['memory', '/memory/forget', MEMORY_RETRIEVE_RESOURCE],
  ] as const)('refuses a %s write path smuggled under an allowlisted read resource (%s)', async (fn, path, resource) => {
    const { send, invoke } = setup(proxy(200, {}), { memory: 'm', agents: 'a', projects: 'p' });
    await expect(invoke({ fn, method: 'POST', path, resource }, CLAIMS)).rejects.toMatchObject({ code: 'not_permitted' });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an unconfigured function and a blank subject before invoking', async () => {
    const { send, invoke } = setup(proxy(200, {}));
    await expect(invoke({ fn: 'scrapers', method: 'GET', path: '/scrapers', resource: '/scrapers' }, CLAIMS))
      .rejects.toMatchObject({ code: 'not_configured' });
    await expect(invoke(JOBS_CALL, { sub: '  ' })).rejects.toMatchObject({ code: 'not_permitted' });
    expect(send).not.toHaveBeenCalled();
  });

  it('never relays 5xx text', async () => {
    const { invoke } = setup(proxy(500, { error: 'Internal server error', message: 'Traceback (most recent call…' }));
    const failure = invoke(JOBS_CALL, CLAIMS);
    await expect(failure).rejects.toMatchObject({ code: 'unavailable' });
    await expect(failure).rejects.not.toThrow('Traceback');
  });

  it.each([
    ['no payload', { StatusCode: 200 }],
    ['a non-proxy payload', { StatusCode: 200, Payload: encoder.encode('[1,2]') }],
    ['a non-JSON body', { StatusCode: 200, Payload: encoder.encode(JSON.stringify({ statusCode: 200, body: '<html>' })) }],
  ])('treats %s as unavailable', async (_label, response: InvocationResponse) => {
    const { invoke } = setup(response);
    await expect(invoke(JOBS_CALL, CLAIMS)).rejects.toMatchObject({ code: 'unavailable' });
  });
});

describe('functionNamesFromEnv', () => {
  it('reads every function env var and skips unset ones', () => {
    expect(functionNamesFromEnv({
      METRICS_FUNCTION: 'm',
      PROJECTS_FUNCTION: 'p',
      FEEDBACK_FORMS_FUNCTION: 'f',
      SETTINGS_FUNCTION: 's',
      SCRAPERS_FUNCTION: 'c',
      MEMORY_FUNCTION: 'y',
      AGENTS_FUNCTION: 'a',
    })).toStrictEqual({ metrics: 'm', projects: 'p', feedbackForms: 'f', settings: 's', scrapers: 'c', memory: 'y', agents: 'a' });
    expect(functionNamesFromEnv({ PROJECTS_FUNCTION: 'p', SETTINGS_FUNCTION: '' })).toStrictEqual({ projects: 'p' });
  });
});

describe('the event carries no empty maps', () => {
  it('sends null query and path parameters when none are set', () => {
    const event = buildProxyEvent({ ...JOBS_CALL, pathParameters: {}, query: { skipped: undefined } }, CLAIMS);
    expect([event.queryStringParameters, event.pathParameters]).toStrictEqual([null, null]);
    expect(buildProxyEvent({ fn: 'metrics', method: 'GET', path: '/x', resource: '/x' }, CLAIMS).queryStringParameters).toBeNull();
  });
});

describe('every refusal and failure names its cause', () => {
  const LABELS = [
    ['metrics', 'Metrics'],
    ['projects', 'Projects'],
    ['feedbackForms', 'Feedback forms'],
    ['settings', 'Settings'],
    ['scrapers', 'Scrapers'],
    ['memory', 'Memory'],
    ['agents', 'Autonomous agents'],
  ] as const;
  const call = (fn: ApiFunction): ApiCall => ({ fn, method: 'GET', path: '/x', resource: '/x' });

  it.each(LABELS)('names the unconfigured %s API', async (fn, label) => {
    const { invoke } = setup(proxy(200, {}), {});
    await expect(invoke(call(fn), CLAIMS)).rejects.toThrow(`The ${label} API is not configured for the assistant.`);
  });

  it.each(LABELS)('names the failing %s service', async (fn, label) => {
    const { invoke } = setup(proxy(503, {}), { [fn]: 'f' });
    await expect(invoke(call(fn), CLAIMS)).rejects.toThrow(`The ${label} service failed (HTTP 503). Try again later.`);
  });

  it.each([['an Error', new Error('arn:aws:iam::123'), 'Error'], ['a non-Error', 'boom', 'unknown']])(
    'names the unreachable service and logs only the route and the error name, for %s',
    async (_label, failure, name) => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      const send = vi.fn<(command: InvokeCommand) => Promise<InvocationResponse>>(() => Promise.reject(failure));
      const invoke = createInternalApiInvoker({ send }, DEFAULT_FUNCTIONS);
      await expect(invoke(JOBS_CALL, CLAIMS)).rejects.toThrow('The Projects service could not be reached. Try again later.');
      expect(warn.mock.calls).toStrictEqual([[`internal-api: invoke failed for GET /projects/{project_id}/jobs: ${name}`]]);
      warn.mockRestore();
    },
  );

  it('refuses a write and a blank subject with their own sentences', async () => {
    const { invoke } = setup(proxy(200, {}));
    await expect(invoke({ fn: 'projects', method: 'POST', path: '/projects', resource: '/projects' }, CLAIMS))
      .rejects.toThrow('The assistant can only read data; that request is not allowed.');
    await expect(invoke(JOBS_CALL, { sub: ' ' })).rejects.toThrow('The caller identity is missing.');
  });

  it.each([
    [401, { message: 'expired' }, 'not_permitted', 'Not permitted — the signed-in user does not have access to this: expired'],
    [403, {}, 'not_permitted', 'Not permitted — the signed-in user does not have access to this.'],
    [404, undefined, 'not_found', 'Not found.'],
    [404, ['nope'], 'not_found', 'Not found.'],
    [404, { error: '', message: 'gone' }, 'not_found', 'Not found: gone'],
    [413, { error: 7 }, 'too_large', 'Too large.'],
    [400, { error: 'e'.repeat(201) }, 'invalid_input', `Invalid request: ${'e'.repeat(200)}…`],
    [499, { error: 'x' }, 'invalid_input', 'Invalid request: x'],
    [300, { error: 'x' }, 'unavailable', 'The Projects service failed (HTTP 300). Try again later.'],
    [399, { error: 'x' }, 'unavailable', 'The Projects service failed (HTTP 399). Try again later.'],
    [199, { ok: true }, 'unavailable', 'The Projects service failed (HTTP 199). Try again later.'],
  ])('maps HTTP %i with body %j to %s: %s', async (status, body, code, message) => {
    const { invoke } = setup(proxy(status, body));
    await expect(invoke(JOBS_CALL, CLAIMS)).rejects.toMatchObject({ code, message });
  });

  it('accepts the 2xx edges and an empty body', async () => {
    await expect(setup(proxy(200, { a: 1 })).invoke(JOBS_CALL, CLAIMS)).resolves.toStrictEqual({ a: 1 });
    await expect(setup(proxy(299, { a: 2 })).invoke(JOBS_CALL, CLAIMS)).resolves.toStrictEqual({ a: 2 });
    await expect(setup(proxy(204)).invoke(JOBS_CALL, CLAIMS)).resolves.toBeUndefined();
    await expect(setup(proxy(200, null)).invoke(JOBS_CALL, CLAIMS)).resolves.toBeNull();
  });

  it('refuses a valid answer that came with a FunctionError', async () => {
    const { invoke } = setup({ StatusCode: 200, FunctionError: 'Unhandled', Payload: proxy(200, { a: 1 }).Payload });
    await expect(invoke(JOBS_CALL, CLAIMS)).rejects.toMatchObject({
      code: 'unavailable', message: 'The Projects service could not be reached. Try again later.',
    });
  });
});
