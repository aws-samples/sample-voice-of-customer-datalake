/**
 * Run harness: drives `runAssistant` with scripted Bedrock turns and records
 * every Converse request and toolset request it makes.
 */
import type { BaseEvent } from '@ag-ui/core';
import { beforeEach, vi } from 'vitest';
import type { ContentBlock } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseStreamParams } from '../../../bedrock/converse-stream.js';
import { ServiceError } from '../../../lib/errors.js';
import type { AssistantToolset, ToolsetOptions } from '../../types.js';
import { UNSET } from '../../tools/test-fixtures.js';
import { parseLambdaEvent } from '../event.js';
import { runAssistant, type RuntimeDeps } from '../run.js';
import {
  bedrockEvents,
  fakeClientTool,
  fakeServerTool,
  fakeToolset,
  lambdaEvent,
  recordingEmitter,
  streamOf,
  type ScriptedTurn,
} from './fakes.js';

const NOW = new Date('2026-03-01T12:00:00Z');

export const searchTool = fakeServerTool('search_feedback', async () => ({
  content: 'Found 3 complaints about delivery',
  sources: [{ feedback_id: 'f1', text: 'late' }, { feedback_id: 'f1', text: 'dup' }],
  webSources: [{ title: 'x', url: 'https://x.test' }],
}));

export const createProject = fakeClientTool('create_project', (input) => {
  const name: unknown = typeof input === 'object' && input !== null ? Reflect.get(input, 'name') : null;
  return typeof name === 'string' && name.length > 0
    ? { ok: true, args: { name: name.trim() } }
    : { ok: false, error: 'name is required' };
});

export const updateDocument = fakeClientTool(
  'update_document',
  () => ({ ok: true, args: { project_id: 'p1', document_id: 'd1', content: 'x', change_summary: 's' } }),
  { pack: 'project' },
);

export interface Harness {
  deps: RuntimeDeps;
  calls: ConverseStreamParams[];
  toolsetOptions: ToolsetOptions[];
}

export function harness(
  turns: ScriptedTurn[],
  toolset: AssistantToolset = fakeToolset([searchTool, createProject, updateDocument]),
): Harness {
  const calls: ConverseStreamParams[] = [];
  const toolsetOptions: ToolsetOptions[] = [];
  const script = [...turns];
  return {
    calls,
    toolsetOptions,
    deps: {
      converse: (params) => {
        calls.push({ ...params, messages: structuredClone(params.messages) });
        return streamOf(bedrockEvents(script.shift() ?? { text: 'done' }));
      },
      getToolset: (options) => {
        toolsetOptions.push(options);
        return toolset;
      },
      toolGuidance: () => 'TOOL GUIDANCE',
      // No admin override configured: the runtime falls back to the default model.
      resolveModel: async () => UNSET.value,
      webSearchConfigured: () => false,
      // No memories recalled unless a spec scripts them.
      recallMemory: async () => [],
      now: () => NOW,
    },
  };
}

export async function run(body: unknown, h: Harness, claims?: Record<string, string> | null): Promise<BaseEvent[]> {
  const { emitter, events } = recordingEmitter();
  await runAssistant(parseLambdaEvent(lambdaEvent(body, claims)), emitter, h.deps);
  return events;
}

/** Silence the runtime's structured logs and warnings for every case of the enclosing file. */
export function silenceConsole(): void {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
    vi.spyOn(console, 'warn').mockImplementation(() => {});
    vi.spyOn(console, 'error').mockImplementation(() => {});
  });
}

export function types(events: BaseEvent[]): string[] {
  return events.map((event) => (event.type === 'CUSTOM' ? `CUSTOM:${String(event.name)}` : event.type));
}

export function finished(events: BaseEvent[]): BaseEvent {
  const event = events.find((e) => e.type === 'RUN_FINISHED');
  if (!event) throw new ServiceError('no RUN_FINISHED');
  return event;
}

/** The first Bedrock call the harness recorded; fails the spec when there was none. */
export function firstCall(h: Harness): ConverseStreamParams {
  const call = h.calls.at(0);
  if (!call) throw new ServiceError('no Bedrock call was recorded');
  return call;
}

export function lastUserContent(params: ConverseStreamParams): ContentBlock[] {
  return params.messages.at(-1)?.content ?? [];
}
