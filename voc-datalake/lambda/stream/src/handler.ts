/**
 * Streaming assistant Lambda handler (Node.js 22).
 *
 * `POST /chat/stream` (API Gateway REST, Cognito authorizer, STREAM transfer
 * mode) speaks AG-UI 1.0: the body is a `RunAgentInput`, the response is a
 * stream of AG-UI events as SSE frames. The run itself lives in
 * `assistant/runtime/run.ts`; this file only wires real dependencies to it.
 */
import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';

import { startHeartbeat, streamifyResponse, wrapStreamWithHeaders } from './lib/streaming.js';
import { measureInvocationCost } from './lib/invocation-cost.js';
import { converseStream } from './bedrock/converse-stream.js';
import { resolveModelOverride } from './bedrock/model-override.js';
import { isWebSearchConfigured } from './tools/web-search.js';
import { getAssistantToolset, toolGuidance } from './assistant/tools/registry.js';
import { createStreamEmitter } from './assistant/runtime/emitter.js';
import { parseLambdaEvent, type LambdaEvent } from './assistant/runtime/event.js';
import { runAssistant, type RuntimeDeps } from './assistant/runtime/run.js';
import { createMemoryRecall } from './assistant/runtime/memory-recall.js';
import { getInternalApiInvoker } from './assistant/tools/internal-api.js';
import { createDynamoSessionStore } from './assistant/session/store.js';

// ── AWS Clients (module-level for connection reuse) ──
const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}), {
  marshallOptions: { removeUndefinedValues: true },
});

const AGGREGATES_TABLE = process.env.AGGREGATES_TABLE ?? '';
// Server-side session persistence (assistant/session/): unset = not saved.
const CONVERSATIONS_TABLE = process.env.CONVERSATIONS_TABLE ?? '';

const deps: RuntimeDeps = {
  converse: converseStream,
  getToolset: getAssistantToolset,
  toolGuidance,
  // The assistant is the "chat" AI surface of the admin model picker.
  resolveModel: () => resolveModelOverride(docClient, AGGREGATES_TABLE, 'chat'),
  webSearchConfigured: isWebSearchConfigured,
  recallMemory: createMemoryRecall(getInternalApiInvoker()),
  now: () => new Date(),
  ...(CONVERSATIONS_TABLE
    ? { sessions: { store: createDynamoSessionStore(docClient, CONVERSATIONS_TABLE), nowMs: () => Date.now() } }
    : {}),
};

/** The run, with the heartbeat and the stream closed however it ends. */
async function runAndClose(event: LambdaEvent, stream: NodeJS.WritableStream) {
  // Keepalive comments for the whole run: a slow tool call or first token
  // would otherwise leave the edge-optimized API idle long enough to cut it.
  const stopHeartbeat = startHeartbeat(stream);
  try {
    return await runAssistant(event, createStreamEmitter(stream), deps);
  } finally {
    stopHeartbeat();
    stream.end();
  }
}

async function streamRun(rawEvent: unknown, responseStream: NodeJS.WritableStream): Promise<void> {
  const event = parseLambdaEvent(rawEvent);
  const { persisted } = await runAndClose(event, wrapStreamWithHeaders(responseStream));
  // The client already has every event; the last session write lands after
  // the stream is closed, and before the invocation ends (a frozen Lambda
  // would drop it). Runs to completion even when the client disconnected.
  await persisted;
}

// One `invocation_cost` line per run, covering the final session write too
// (lib/invocation-cost.ts; the sizing policy's CPU figure for this function).
export const handler = streamifyResponse(measureInvocationCost(streamRun));
