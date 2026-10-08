/**
 * Internal API invoker — read-only delegation from the assistant to the Python
 * domain API Lambdas.
 *
 * Generalises the removed project-chat Projects client and mirrors
 * `lambda/shared/mcp_delegate.py`: the assistant does not re-implement a route,
 * it invokes the Lambda that owns it with a synthetic API Gateway REST (v1)
 * proxy event whose authorizer claims are the CALLER'S forwarded claims. Every
 * route's validation, error mapping and authorization therefore applies to the
 * assistant exactly as it applies to the signed-in user's own requests.
 *
 * Only GET is allowed, plus the internal reads that are POSTs (`READ_POSTS`:
 * project chat context, memory recall, workflow validation — each pinned to
 * its owning function). Writes never go through here — they
 * are client tools executed by the SPA after human approval.
 *
 * The Powertools resolver routes on `httpMethod` + `path`; `resource` and
 * `pathParameters` are set for fidelity with what API Gateway delivers.
 */
import { InvokeCommand, LambdaClient, type InvocationResponse } from '@aws-sdk/client-lambda';
import { z } from 'zod';
import type { CallerClaims } from '../types.js';
import { AssistantToolError } from './errors.js';
import { clip, firstString, isRecord } from './format.js';

const API_FUNCTIONS = ['metrics', 'projects', 'feedbackForms', 'settings', 'scrapers', 'memory', 'agents'] as const;
export type ApiFunction = (typeof API_FUNCTIONS)[number];

/** Env var holding each function's name (set by the stack). */
const API_FUNCTION_ENV: Record<ApiFunction, string> = {
  metrics: 'METRICS_FUNCTION',
  projects: 'PROJECTS_FUNCTION',
  feedbackForms: 'FEEDBACK_FORMS_FUNCTION',
  settings: 'SETTINGS_FUNCTION',
  scrapers: 'SCRAPERS_FUNCTION',
  memory: 'MEMORY_FUNCTION',
  agents: 'AGENTS_FUNCTION',
};

const API_LABEL: Record<ApiFunction, string> = {
  metrics: 'Metrics',
  projects: 'Projects',
  feedbackForms: 'Feedback forms',
  settings: 'Settings',
  scrapers: 'Scrapers',
  memory: 'Memory',
  agents: 'Autonomous agents',
};

/** A read despite the verb: the project chat context. */
export const CHAT_CONTEXT_RESOURCE = '/projects/{project_id}/chat-context';
/** A read despite the verb: semantic memory recall (top-K for a query; refreshes `last_used_at` only). */
export const MEMORY_RETRIEVE_RESOURCE = '/memory/retrieve';
/** A read despite the verb: dry-run validation of a workflow definition (stores nothing). */
export const WORKFLOW_VALIDATE_RESOURCE = '/workflows/validate';

/**
 * The only non-GET routes this invoker may call, each pinned to the function
 * that owns it — reads that carry a body. Anything else that is not a GET is
 * refused before an invoke.
 */
const READ_POSTS: ReadonlyMap<string, ApiFunction> = new Map([
  [CHAT_CONTEXT_RESOURCE, 'projects'],
  [MEMORY_RETRIEVE_RESOURCE, 'memory'],
  [WORKFLOW_VALIDATE_RESOURCE, 'agents'],
]);

type QueryValue = string | number | boolean | undefined;

export interface ApiCall {
  fn: ApiFunction;
  method: 'GET' | 'POST';
  /** Concrete path without the stage prefix, e.g. `/projects/p1/jobs`. */
  path: string;
  /** Templated route, e.g. `/projects/{project_id}/jobs`. */
  resource: string;
  pathParameters?: Record<string, string>;
  query?: Record<string, QueryValue>;
  body?: unknown;
}

/** Invoke a route as the caller; resolves to the parsed 2xx JSON body. */
export type ApiInvoker = (call: ApiCall, claims: CallerClaims) => Promise<unknown>;

export interface LambdaInvoker {
  send(command: InvokeCommand): Promise<InvocationResponse>;
}

const proxyResponseSchema = z.object({
  statusCode: z.number().int(),
  body: z.string().nullish(),
});

/** What `parseJson` answers for text that is not JSON (distinct from a JSON `null`). */
const NOT_JSON: unique symbol = Symbol();

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const MAX_ERROR_TEXT = 200;

/** Only these claim keys are forwarded, and only when they are strings. */
const FORWARDED_CLAIM_KEYS = ['sub', 'cognito:groups', 'cognito:username', 'email'] as const;

function forwardedClaims(claims: CallerClaims): Record<string, string> {
  const out: Record<string, string> = {};
  for (const key of FORWARDED_CLAIM_KEYS) {
    const value = claims[key];
    if (typeof value === 'string' && value.length > 0) out[key] = value;
  }
  return out;
}

/** API Gateway delivers strings; booleans as `true`/`false` (see mcp_delegate `_stringify`). */
function queryParameters(query: ApiCall['query']): Record<string, string> | null {
  if (!query) return null;
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined) continue;
    out[key] = String(value);
  }
  return Object.keys(out).length > 0 ? out : null;
}

/** The synthetic REST proxy event, exported for the shape tests. */
export function buildProxyEvent(call: ApiCall, claims: CallerClaims): Record<string, unknown> {
  return {
    httpMethod: call.method,
    path: call.path,
    resource: call.resource,
    queryStringParameters: queryParameters(call.query),
    pathParameters: call.pathParameters && Object.keys(call.pathParameters).length > 0
      ? { ...call.pathParameters }
      : null,
    body: call.body === undefined ? null : JSON.stringify(call.body),
    // No Authorization header (the domain function must not see a token) and
    // no Accept-Encoding (this module decodes plain JSON).
    headers: { 'Content-Type': 'application/json' },
    requestContext: {
      authorizer: { claims: forwardedClaims(claims) },
      stage: 'v1',
    },
    isBase64Encoded: false,
  };
}

/** A concrete path matches a resource template when each `{param}` stands for exactly one non-empty segment. */
function pathMatchesResource(path: string, resource: string): boolean {
  const pathSegments = path.split('/');
  const templateSegments = resource.split('/');
  if (pathSegments.length !== templateSegments.length) return false;
  return templateSegments.every((segment, i) => {
    const concrete = pathSegments[i];
    // Stryker disable next-line Regex: the templates are the READ_POSTS resources only, whose segments are a bare word or a whole `{param}`, so either anchor alone matches the same set
    return /^\{\w+\}$/.test(segment) ? Boolean(concrete) : concrete === segment;
  });
}

/**
 * GET, or one of `READ_POSTS` called on its owning function. The resolver
 * routes on `path`, not `resource`, so a read POST must also carry a path that
 * IS that resource — otherwise an allowlisted resource could smuggle a write path.
 */
function assertAllowed(call: ApiCall): void {
  if (call.method === 'GET') return;
  // Only 'POST' remains of the method union here.
  if (READ_POSTS.get(call.resource) === call.fn
    && pathMatchesResource(call.path, call.resource)) return;
  throw new AssistantToolError('not_permitted', 'The assistant can only read data; that request is not allowed.');
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return NOT_JSON;
  }
}

/** `error ?? message` from an error body, clipped; undefined when absent. */
function errorText(body: unknown): string | undefined {
  if (!isRecord(body)) return undefined;
  const text = firstString(body.error, body.message);
  return text === undefined ? undefined : clip(text, MAX_ERROR_TEXT);
}

function statusError(fn: ApiFunction, status: number, body: unknown): AssistantToolError {
  const detail = errorText(body);
  const suffix = detail ? `: ${detail}` : '.';
  if (status === 403 || status === 401) {
    return new AssistantToolError('not_permitted', `Not permitted — the signed-in user does not have access to this${suffix}`);
  }
  if (status === 404) return new AssistantToolError('not_found', `Not found${suffix}`);
  if (status === 413) return new AssistantToolError('too_large', `Too large${suffix}`);
  if (status >= 400 && status < 500) return new AssistantToolError('invalid_input', `Invalid request${suffix}`);
  // 5xx text is internal; never relay it.
  return new AssistantToolError('unavailable', `The ${API_LABEL[fn]} service failed (HTTP ${status}). Try again later.`);
}

function unreachable(fn: ApiFunction): AssistantToolError {
  return new AssistantToolError('unavailable', `The ${API_LABEL[fn]} service could not be reached. Try again later.`);
}

function decodeResponse(fn: ApiFunction, response: InvocationResponse): unknown {
  const unavailable = unreachable(fn);
  if (response.FunctionError || !response.Payload) throw unavailable;
  const proxy = proxyResponseSchema.safeParse(parseJson(decoder.decode(response.Payload)));
  if (!proxy.success) throw unavailable;
  const { statusCode, body } = proxy.data;
  const parsedBody = body ? parseJson(body) : undefined;
  if (statusCode < 200 || statusCode >= 300) throw statusError(fn, statusCode, parsedBody);
  if (parsedBody === NOT_JSON) throw unavailable;
  return parsedBody;
}

export function createInternalApiInvoker(
  client: LambdaInvoker,
  functionNames: Partial<Record<ApiFunction, string>>,
): ApiInvoker {
  return async (call, claims) => {
    assertAllowed(call);
    if (!claims.sub.trim()) {
      throw new AssistantToolError('not_permitted', 'The caller identity is missing.');
    }
    const functionName = functionNames[call.fn];
    if (!functionName) {
      throw new AssistantToolError('not_configured', `The ${API_LABEL[call.fn]} API is not configured for the assistant.`);
    }
    const response = await client.send(new InvokeCommand({
      FunctionName: functionName,
      InvocationType: 'RequestResponse',
      Payload: encoder.encode(JSON.stringify(buildProxyEvent(call, claims))),
    })).catch((err: unknown) => {
      // Route only — never the event, which may carry user input.
      console.warn(`internal-api: invoke failed for ${call.method} ${call.resource}: ${err instanceof Error ? err.name : 'unknown'}`);
      throw unreachable(call.fn);
    });
    return decodeResponse(call.fn, response);
  };
}

/** Function names from the environment. */
export function functionNamesFromEnv(env: NodeJS.ProcessEnv = process.env): Partial<Record<ApiFunction, string>> {
  const out: Partial<Record<ApiFunction, string>> = {};
  for (const fn of API_FUNCTIONS) {
    const name = env[API_FUNCTION_ENV[fn]];
    if (name) out[fn] = name;
  }
  return out;
}

const defaultInvoker: { instance?: ApiInvoker } = {};

/** The process-wide invoker (lazy: one LambdaClient per container). */
export function getInternalApiInvoker(): ApiInvoker {
  defaultInvoker.instance ??= createInternalApiInvoker(
    new LambdaClient({ maxAttempts: 2 }),
    functionNamesFromEnv(),
  );
  return defaultInvoker.instance;
}
