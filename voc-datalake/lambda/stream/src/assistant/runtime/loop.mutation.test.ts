/**
 * Agent-loop pins the mutation run found missing. The run.* specs drive the
 * loop through `runAssistant` and look at the stream, so they never saw: the
 * round count and the empty source lists of the result, the exact messages of
 * the next turn, a turn that stops on `end_turn` with tool uses (or on
 * `tool_use` without any), the max-rounds notice and its log line, the tail
 * retry being limited to the FIRST turn and to a ValidationException that is
 * not about model availability, the per-step and exhaustion fallback logs,
 * and an interrupt's project id / summary fallbacks.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ConverseStreamOutput, Message } from '@aws-sdk/client-bedrock-runtime';
import type { ConverseStreamParams } from '../../bedrock/converse-stream.js';
import { cooldownUntil, markUnavailable } from '../../bedrock/model-fallback.js';
import { fakeContext } from '../tools/test-fixtures.js';
import type { AssistantToolDefinition } from '../types.js';
import {
  bedrockEvents,
  failingStream,
  fakeClientTool,
  fakeServerTool,
  fakeToolset,
  recordingEmitter,
  streamOf,
  type ScriptedTurn,
} from './__fixtures__/fakes.js';
import { searchTool, silenceConsole } from './__fixtures__/harness.js';
import { MAX_TOOL_ROUNDS, runAgentLoop, type LoopInput } from './loop.js';

silenceConsole();
beforeEach(() => {
  vi.mocked(console.warn).mockClear();
  vi.mocked(console.log).mockClear();
});
afterEach(() => cooldownUntil.clear());

const SONNET55 = 'global.anthropic.claude-sonnet-5-5';
const SONNET5 = 'global.anthropic.claude-sonnet-5';
const SONNET46 = 'global.anthropic.claude-sonnet-4-6';
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
const HAIKU = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';
const NOW = new Date('2026-03-01T12:00:00Z');
const QUESTION: Message[] = [{ role: 'user', content: [{ text: 'How are customers feeling?' }] }];
const TEXT_TAIL: Message[] = [{ role: 'user', content: [{ text: 'tail as text' }] }];

const metricsTool = fakeServerTool('get_metrics', async () => ({ content: 'metrics: 4' }));
const toolUse = (id: string, name = 'search_feedback') => ({ id, name, input: { query: 'late' } });

function named(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

type Step = ScriptedTurn | ConverseStreamOutput[] | Error;

/** A loop over scripted Bedrock calls; every call's params are recorded. */
function loop(steps: Step[], overrides: Partial<LoopInput> = {}, tools: AssistantToolDefinition[] = [searchTool, metricsTool]) {
  const calls: ConverseStreamParams[] = [];
  const script = [...steps];
  const { emitter, events } = recordingEmitter();
  const input: LoopInput = {
    converse: (params) => {
      calls.push({ ...params, messages: structuredClone(params.messages) });
      const step = script.shift() ?? { text: 'done' };
      if (step instanceof Error) return failingStream(step);
      return streamOf(Array.isArray(step) ? step : bedrockEvents(step));
    },
    messages: QUESTION,
    toolset: fakeToolset(tools),
    systemPrompt: 'SYSTEM',
    systemSuffix: '',
    modelId: SONNET55,
    ctx: fakeContext(),
    emitter,
    now: () => NOW,
    ...overrides,
  };
  return { input, calls, events, result: () => runAgentLoop(input) };
}

function warnings(): string[] {
  return vi.mocked(console.warn).mock.calls.map(([line]) => String(line));
}

describe('runAgentLoop — result and next turn', () => {
  it('reports one round and no sources for a direct answer', async () => {
    const result = await loop([{ text: 'Fine.' }]).result();
    expect(result).toMatchObject({ outcome: { type: 'success' }, rounds: 1, sources: [], webSources: [], modelId: SONNET55 });
    expect(result.sources).toStrictEqual([]);
    expect(result.webSources).toStrictEqual([]);
  });

  it('sends the assistant tool turn and the user tool results to the next turn', async () => {
    const run = loop([{ toolUses: [toolUse('c1'), toolUse('c2', 'get_metrics')] }, { text: 'Fine.' }]);
    const result = await run.result();

    expect([result.rounds, run.calls.length]).toStrictEqual([2, 2]);
    const next = run.calls[1]?.messages ?? [];
    expect(next.map((m) => [m.role, m.content?.map((block) => block.text ?? block.toolUse?.toolUseId ?? block.toolResult?.toolUseId)]))
      .toStrictEqual([['user', ['How are customers feeling?']], ['assistant', ['c1', 'c2']], ['user', ['c1', 'c2']]]);
    expect(vi.mocked(console.log)).toHaveBeenCalledWith(`Tool round 1/${MAX_TOOL_ROUNDS}: search_feedback, get_metrics`);
  });

  const raw = (stopReason: 'end_turn' | 'tool_use', withTool: boolean): ConverseStreamOutput[] => {
    const scripted = bedrockEvents({ text: 'x', ...(withTool ? { toolUses: [toolUse('c1')] } : {}) });
    return scripted.map((event) => (event.messageStop ? { messageStop: { stopReason } } : event));
  };

  it.each([
    ['end_turn with a tool use', raw('end_turn', true)],
    ['tool_use without a tool use', raw('tool_use', false)],
  ])('stops after a turn that ends on %s', async (_label, events) => {
    const run = loop([events]);
    expect((await run.result()).rounds).toBe(1);
    expect(run.calls).toHaveLength(1);
  });
});

describe('runAgentLoop — max rounds', () => {
  it('stops after MAX_TOOL_ROUNDS, says so in a closed text message and logs it', async () => {
    const run = loop(Array.from({ length: MAX_TOOL_ROUNDS + 1 }, (_, i) => ({ toolUses: [toolUse(`c${i}`)] })));
    const result = await run.result();

    expect(result.rounds).toBe(MAX_TOOL_ROUNDS);
    expect(run.calls).toHaveLength(MAX_TOOL_ROUNDS);
    const [start, content, end] = run.events.slice(-3);
    const messageId = Reflect.get(start ?? {}, 'messageId');
    expect([start, content, end]).toStrictEqual([
      { type: 'TEXT_MESSAGE_START', messageId, role: 'assistant' },
      {
        type: 'TEXT_MESSAGE_CONTENT', messageId,
        delta: '_Reached the maximum number of tool steps. Please ask a more specific question._',
      },
      { type: 'TEXT_MESSAGE_END', messageId },
    ]);
    expect(warnings()).toContain('Tool loop hit MAX_TOOL_ROUNDS=15; stopping.');
  });
});

describe('runAgentLoop — text-tail retry', () => {
  it('retries the first turn once with the text tail on a ValidationException', async () => {
    const run = loop([named('ValidationException', 'thinking block missing'), { text: 'Fine.' }], { fallbackMessages: TEXT_TAIL });
    await run.result();

    expect(run.calls.map((c) => [c.modelId, c.messages])).toStrictEqual([[SONNET55, QUESTION], [SONNET55, TEXT_TAIL]]);
    expect(warnings()).toContain('Bedrock rejected the structured tail; retrying with a text-rendered tail');
  });

  it('does not retry an error that is not a ValidationException', async () => {
    const failure = named('InternalServerException', 'boom');
    const run = loop([failure], { fallbackMessages: TEXT_TAIL });
    await expect(run.result()).rejects.toBe(failure);
    expect(run.calls).toHaveLength(1);
  });

  it('sends a ValidationException about model access to the next model with the structured messages', async () => {
    const run = loop([named('ValidationException', 'Access to model is denied'), { text: 'Fine.' }], { fallbackMessages: TEXT_TAIL });
    const result = await run.result();

    expect(run.calls.map((c) => [c.modelId, c.messages])).toStrictEqual([[SONNET55, QUESTION], [SONNET5, QUESTION]]);
    expect(result.modelId).toBe(SONNET5);
  });

  it('never retries a later turn with the text tail', async () => {
    const failure = named('ValidationException', 'thinking block missing');
    const run = loop([{ toolUses: [toolUse('c1')] }, failure], { fallbackMessages: TEXT_TAIL });
    await expect(run.result()).rejects.toBe(failure);
    expect(run.calls).toHaveLength(2);
  });
});

describe('runAgentLoop — model fallback logs', () => {
  const fallbackLines = () => warnings().filter((line) => line.includes('cannot serve now'));

  it('logs one step per next model and throws the first failure when every model fails', async () => {
    const first = named('ThrottlingException', 'first');
    const run = loop([first, ...['second', 'third', 'fourth', 'fifth'].map((label) => named('ThrottlingException', label))]);

    await expect(run.result()).rejects.toBe(first);
    expect(fallbackLines()).toStrictEqual([
      `Model ${SONNET55} cannot serve now (ThrottlingException); falling back to ${SONNET5}`,
      `Model ${SONNET5} cannot serve now (ThrottlingException); falling back to ${SONNET46}`,
      `Model ${SONNET46} cannot serve now (ThrottlingException); falling back to ${HAIKU55}`,
      `Model ${HAIKU55} cannot serve now (ThrottlingException); falling back to ${HAIKU}`,
    ]);
  });

  it('logs a cooldown fallback when the configured model is cooling down', async () => {
    markUnavailable(SONNET55);
    const run = loop([{ text: 'Fine.' }]);
    await run.result();

    expect(run.calls.map((c) => c.modelId)).toStrictEqual([SONNET5]);
    expect(fallbackLines()).toStrictEqual([`Model ${SONNET55} cannot serve now (cooldown); falling back to ${SONNET5}`]);
  });
});

describe('runAgentLoop — approval interrupts', () => {
  const approval = (args: Record<string, unknown>, summarize: (a: Record<string, unknown>) => string) => ({
    ...fakeClientTool('create_project', () => ({ ok: true, args })),
    summarize,
  });

  it.each([
    ['an empty project_id', ''],
    ['a non-string project_id', 42],
  ])('leaves the project id out of the metadata for %s', async (_label, projectId) => {
    const tool = approval({ project_id: projectId }, () => 'Create it');
    const result = await loop([{ toolUses: [{ id: 'c1', name: 'create_project', input: {} }] }], {}, [tool]).result();

    expect(result.outcome).toStrictEqual({
      type: 'interrupt',
      interrupts: [{
        id: 'approval:c1',
        reason: 'tool_approval',
        toolCallId: 'c1',
        message: 'Create it',
        expiresAt: '2026-03-01T12:30:00.000Z',
        metadata: { toolName: 'create_project', risk: 'write' },
      }],
    });
  });

  it('falls back to "Run <tool>" when the summary throws', async () => {
    const tool = approval({ project_id: 'p1' }, () => {
      throw new TypeError('bad args');
    });
    const result = await loop([{ toolUses: [{ id: 'c1', name: 'create_project', input: {} }] }], {}, [tool]).result();

    expect(result.outcome).toMatchObject({ interrupts: [{ message: 'Run create_project', metadata: { projectId: 'p1' } }] });
  });
});
