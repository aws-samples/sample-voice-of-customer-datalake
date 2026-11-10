/**
 * Test fakes for the assistant runtime: a recording emitter, fake tools and
 * toolsets, scripted Bedrock streams, and AG-UI request builders.
 */
import type { BaseEvent, RunAgentInput } from '@ag-ui/core';
import type { ConverseStreamOutput, Tool } from '@aws-sdk/client-bedrock-runtime';
import type { ClientToolName, ForwardedProps, ServerToolName, ToolPack } from '../../contract.js';
import type {
  AssistantRunContext,
  AssistantToolDefinition,
  AssistantToolset,
  ClientToolDefinition,
  ClientToolValidation,
  ServerToolDefinition,
  ServerToolResult,
} from '../../types.js';
import type { Emitter } from '../emitter.js';
import { enforceLimits, parseForwardedProps, parseRunAgentInput } from '../input.js';
import { toolsetOf } from '../../tools/registry.js';

/** Envelope + forwardedProps + limits, as `run.ts` applies them — the specs' one-call parser. */
export function parseRunInput(bodyText: string): { input: RunAgentInput; props: ForwardedProps } {
  const input = parseRunAgentInput(bodyText);
  const props = parseForwardedProps(input);
  enforceLimits(input);
  return { input, props };
}

export function recordingEmitter(): { emitter: Emitter; events: BaseEvent[] } {
  const events: BaseEvent[] = [];
  return { emitter: { emit: (event) => events.push(event) }, events };
}

function spec(name: string): Tool {
  return { toolSpec: { name, description: `fake ${name}`, inputSchema: { json: { type: 'object' } } } };
}

export function fakeServerTool(
  name: ServerToolName,
  execute: (input: unknown, ctx: AssistantRunContext) => Promise<ServerToolResult>,
  pack: ToolPack = 'core',
): ServerToolDefinition {
  return { kind: 'server', name, pack, spec: spec(name), execute };
}

export function fakeClientTool(
  name: ClientToolName,
  validate: (input: unknown, ctx: AssistantRunContext) => ClientToolValidation,
  options: { risk?: 'write' | 'destructive'; pack?: ToolPack } = {},
): ClientToolDefinition {
  return {
    kind: 'client',
    name,
    pack: options.pack ?? 'core',
    spec: spec(name),
    risk: options.risk ?? 'write',
    validate,
    summarize: (args) => `Do ${name} with ${Object.keys(args).join(',')}`,
  };
}

export function fakeToolset(tools: AssistantToolDefinition[], packs: ToolPack[] = ['core']): AssistantToolset {
  return toolsetOf(packs, tools);
}

interface ScriptedToolUse {
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ScriptedTurn {
  reasoning?: string;
  signature?: string;
  text?: string;
  toolUses?: ScriptedToolUse[];
  usage?: { inputTokens: number; outputTokens: number; cacheReadInputTokens?: number; cacheWriteInputTokens?: number };
}

/** Render one scripted turn as the Bedrock ConverseStream event sequence. */
export function bedrockEvents(turn: ScriptedTurn): ConverseStreamOutput[] {
  const out: ConverseStreamOutput[] = [{ messageStart: { role: 'assistant' } }];
  const index = { value: 0 };
  if (turn.reasoning !== undefined) {
    out.push({ contentBlockDelta: { contentBlockIndex: index.value, delta: { reasoningContent: { text: turn.reasoning } } } });
    if (turn.signature) {
      out.push({ contentBlockDelta: { contentBlockIndex: index.value, delta: { reasoningContent: { signature: turn.signature } } } });
    }
    out.push({ contentBlockStop: { contentBlockIndex: index.value } });
    index.value += 1;
  }
  if (turn.text !== undefined) {
    out.push({ contentBlockDelta: { contentBlockIndex: index.value, delta: { text: turn.text } } });
    out.push({ contentBlockStop: { contentBlockIndex: index.value } });
    index.value += 1;
  }
  for (const use of turn.toolUses ?? []) {
    out.push({ contentBlockStart: { contentBlockIndex: index.value, start: { toolUse: { toolUseId: use.id, name: use.name } } } });
    out.push({ contentBlockDelta: { contentBlockIndex: index.value, delta: { toolUse: { input: JSON.stringify(use.input) } } } });
    out.push({ contentBlockStop: { contentBlockIndex: index.value } });
    index.value += 1;
  }
  const stopReason = (turn.toolUses ?? []).length > 0 ? 'tool_use' : 'end_turn';
  out.push({ messageStop: { stopReason } });
  const usage = turn.usage ?? { inputTokens: 10, outputTokens: 5 };
  out.push({
    metadata: {
      usage: { totalTokens: usage.inputTokens + usage.outputTokens, ...usage },
      metrics: { latencyMs: 1 },
    },
  });
  return out;
}

export async function* streamOf(events: ConverseStreamOutput[]): AsyncGenerator<ConverseStreamOutput> {
  for (const event of events) {
    yield await Promise.resolve(event);
  }
}

/** A Bedrock stream whose request fails before the first event. */
export async function* failingStream(failure: Error): AsyncGenerator<ConverseStreamOutput> {
  await Promise.resolve();
  if (failure.name) throw failure;
  yield* [];
}

const DEFAULT_PAGE = { kind: 'dashboard', path: '/' } as const;

export function runBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    threadId: 'thread-1',
    runId: 'run-1',
    messages: [{ id: 'u1', role: 'user', content: 'How are customers feeling?' }],
    tools: [],
    context: [],
    forwardedProps: { page: DEFAULT_PAGE },
    ...overrides,
  };
}

export function lambdaEvent(
  body: unknown,
  claims: Record<string, string> | null = { sub: 'user-sub-1', 'cognito:groups': 'users', email: 'a@example.com' },
): Record<string, unknown> {
  return {
    body: typeof body === 'string' ? body : JSON.stringify(body),
    headers: { origin: 'https://app.example.com' },
    requestContext: claims ? { authorizer: { claims } } : {},
  };
}
