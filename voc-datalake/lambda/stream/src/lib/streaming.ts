/**
 * Lambda Response Streaming utilities.
 *
 * Uses the `awslambda` global injected by the Node.js 22 managed runtime
 * to wrap handlers with `streamifyResponse` and emit SSE events.
 */
import { ConfigurationError } from './errors.js';

/**
 * Type declarations for the Lambda streaming runtime global.
 * These are injected by the Node.js managed runtime and not available at bundle time.
 */
interface AwsLambdaRuntime {
  streamifyResponse: (
    handler: (event: unknown, responseStream: NodeJS.WritableStream, context: unknown) => Promise<void>,
  ) => (event: unknown, context: unknown) => Promise<void>;
  HttpResponseStream: {
    from: (
      responseStream: NodeJS.WritableStream,
      metadata: { statusCode: number; headers: Record<string, string> },
    ) => NodeJS.WritableStream;
  };
}

function isFunction(value: unknown): boolean {
  return typeof value === 'function';
}

/** An object or a function (a class): anything properties can be read from. */
function isObjectLike(value: unknown): value is object {
  return (typeof value === 'object' && value !== null) || typeof value === 'function';
}

/** The runtime global, checked member by member rather than asserted.
 *
 * `HttpResponseStream` is a CLASS in the managed Node runtime, so `typeof` answers
 * 'function', not 'object'. Requiring an object made every cold start throw and the
 * chat answer 502 (production, 2026-10-05). Accept either, and only demand `from`. */
function isAwsLambdaRuntime(value: unknown): value is AwsLambdaRuntime {
  if (typeof value !== 'object' || value === null) return false;
  const responseStream: unknown = Reflect.get(value, 'HttpResponseStream');
  return isFunction(Reflect.get(value, 'streamifyResponse'))
    && isObjectLike(responseStream)
    && isFunction(Reflect.get(responseStream, 'from'));
}

/** Runtime-injected global – not available at bundle time. */
function getAwsLambda(): AwsLambdaRuntime {
  const runtime: unknown = Reflect.get(globalThis, 'awslambda');
  if (!isAwsLambdaRuntime(runtime)) {
    throw new ConfigurationError('awslambda global not available — must run inside Lambda managed runtime');
  }
  return runtime;
}

/**
 * Wraps a handler so the Lambda runtime streams the response body.
 */
export function streamifyResponse(
  handler: (event: unknown, responseStream: NodeJS.WritableStream, context: unknown) => Promise<void>,
): (event: unknown, context: unknown) => Promise<void> {
  return getAwsLambda().streamifyResponse(handler);
}

/**
 * CORS headers for the SSE response (issue #267 item 10).
 *
 * The API serves exactly one origin, `ALLOWED_ORIGIN` (the frontend domain, or
 * '*' only in a dev deploy), so the request's Origin cannot change the answer —
 * the old per-request comparison returned `allowed` on both of its branches.
 *
 * No `Access-Control-Allow-Credentials`: the client authenticates with a bearer
 * header, never cookies, and every Python API Lambda answers with
 * `allow_credentials=False` (shared/api.py). Sending it with '*' is also a
 * combination browsers reject outright.
 */
function corsHeaders(): Record<string, string> {
  const allowed = process.env.ALLOWED_ORIGIN ?? '*';
  if (allowed === '*') return { 'Access-Control-Allow-Origin': '*' };
  return { 'Access-Control-Allow-Origin': allowed, Vary: 'Origin' };
}

/**
 * Wraps the raw response stream with HTTP headers so API Gateway
 * (or the Function URL) returns the correct content-type.
 */
export function wrapStreamWithHeaders(responseStream: NodeJS.WritableStream): NodeJS.WritableStream {
  return getAwsLambda().HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      ...corsHeaders(),
    },
  });
}

/**
 * Write one SSE frame: `data: <json>\n\n`. AG-UI events are serialised as-is.
 */
export function writeSSE(stream: NodeJS.WritableStream, payload: unknown): void {
  stream.write(`data: ${JSON.stringify(payload)}\n\n`);
}

/**
 * Keepalive cadence. The production API is EDGE-optimized, and API Gateway cuts
 * an edge-optimized response stream after 30 s with no bytes (5 min regional).
 * A run is silent for that long whenever a tool call or the model's first token
 * takes a while, so a comment frame goes out at half the tightest limit.
 */
export const HEARTBEAT_INTERVAL_MS = 15_000;

/** An SSE comment: every SSE parser (and the SPA's `parseSseLine`) skips it. */
export const HEARTBEAT_FRAME = ': keepalive\n\n';

/**
 * Write a keepalive comment frame every `intervalMs` until the returned stop
 * function is called. The timer is unref'd so it never holds the runtime open.
 */
export function startHeartbeat(stream: NodeJS.WritableStream, intervalMs: number = HEARTBEAT_INTERVAL_MS): () => void {
  const timer = setInterval(() => {
    stream.write(HEARTBEAT_FRAME);
  }, intervalMs);
  timer.unref();
  return () => {
    clearInterval(timer);
  };
}
