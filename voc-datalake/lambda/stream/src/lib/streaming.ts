/**
 * Lambda Response Streaming utilities.
 *
 * Uses the `awslambda` global injected by the Node.js 22 managed runtime
 * to wrap handlers with `streamifyResponse` and emit SSE events.
 */

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

/** Runtime-injected global – not available at bundle time. */
function getAwsLambda(): AwsLambdaRuntime {
  // eslint-disable-next-line @typescript-eslint/consistent-type-assertions -- globalThis requires assertion for runtime-injected properties
  const runtime = (globalThis as unknown as { awslambda?: AwsLambdaRuntime }).awslambda;
  if (!runtime) {
    throw new Error('awslambda global not available — must run inside Lambda managed runtime');
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

/** Allowed origins for CORS. */
function getAllowedOrigin(requestOrigin?: string): string {
  const allowed = process.env.ALLOWED_ORIGIN ?? '*';
  if (allowed === '*') return '*';
  if (requestOrigin && requestOrigin === allowed) return allowed;
  return allowed;
}

/**
 * Wraps the raw response stream with HTTP headers so API Gateway
 * (or the Function URL) returns the correct content-type.
 */
export function wrapStreamWithHeaders(
  responseStream: NodeJS.WritableStream,
  origin?: string,
): NodeJS.WritableStream {
  return getAwsLambda().HttpResponseStream.from(responseStream, {
    statusCode: 200,
    headers: {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      Connection: 'keep-alive',
      'Access-Control-Allow-Origin': getAllowedOrigin(origin),
      'Access-Control-Allow-Credentials': 'true',
    },
  });
}

/** Send a single SSE event. */
export function sendSSE(
  stream: NodeJS.WritableStream,
  event: Record<string, unknown>,
): void {
  stream.write(`data: ${JSON.stringify(event)}\n\n`);
}

/** Send an error SSE event and close the stream. */
export function sendErrorAndClose(
  stream: NodeJS.WritableStream,
  message: string,
  errorType?: string,
  statusCode?: number,
): void {
  sendSSE(stream, {
    type: 'error',
    success: false,
    error: message,
    ...(errorType ? { errorType } : {}),
    ...(statusCode ? { statusCode } : {}),
  });
  sendSSE(stream, { type: 'done' });
  stream.end();
}
