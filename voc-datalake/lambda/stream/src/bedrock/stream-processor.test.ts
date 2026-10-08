/**
 * Tests for the Bedrock turn accumulator.
 */
import { describe, it, expect, vi } from 'vitest';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import { createTurnState, finishTurn, parseToolInput, processStreamEvent, type TurnSink } from './stream-processor.js';

function recordingSink() {
  const calls: string[] = [];
  const sink: TurnSink = {
    onText: vi.fn((d: string) => calls.push(`text:${d}`)),
    onReasoning: vi.fn((d: string) => calls.push(`reasoning:${d}`)),
    onBlockStop: vi.fn((k: string) => calls.push(`stop:${k}`)),
  };
  return { sink, calls };
}

function apply(events: ConverseStreamOutput[]) {
  const state = createTurnState();
  const { sink, calls } = recordingSink();
  for (const event of events) processStreamEvent(event, state, sink);
  finishTurn(state, sink);
  return { state, calls };
}

describe('processStreamEvent', () => {
  it('collects reasoning (with signature), text and tool use in arrival order', () => {
    const { state, calls } = apply([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { text: 'think' } } } },
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { signature: 'sig' } } } },
      { contentBlockStop: { contentBlockIndex: 0 } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'Hel' } } },
      { contentBlockDelta: { contentBlockIndex: 1, delta: { text: 'lo' } } },
      { contentBlockStop: { contentBlockIndex: 1 } },
      { contentBlockStart: { contentBlockIndex: 2, start: { toolUse: { toolUseId: 'tu', name: 'search_feedback' } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '{"query":' } } } },
      { contentBlockDelta: { contentBlockIndex: 2, delta: { toolUse: { input: '"x"}' } } } },
      { contentBlockStop: { contentBlockIndex: 2 } },
      { messageStop: { stopReason: 'tool_use' } },
      { metadata: { usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 }, metrics: { latencyMs: 1 } } },
    ]);

    expect(state.content).toStrictEqual([
      { reasoningContent: { reasoningText: { text: 'think', signature: 'sig' } } },
      { text: 'Hello' },
      { toolUse: { toolUseId: 'tu', name: 'search_feedback', input: { query: 'x' } } },
    ]);
    expect(state.toolUses).toStrictEqual([{ toolUseId: 'tu', name: 'search_feedback', input: { query: 'x' } }]);
    expect({ text: state.text, stopReason: state.stopReason, usage: state.usage }).toStrictEqual({
      text: 'Hello', stopReason: 'tool_use', usage: { inputTokens: 1, outputTokens: 2, totalTokens: 3 },
    });
    expect(calls).toStrictEqual(['reasoning:think', 'stop:reasoning', 'text:Hel', 'text:lo', 'stop:text', 'stop:toolUse']);
  });

  it('keeps redacted reasoning bytes', () => {
    const bytes = new Uint8Array([1, 2, 3]);
    const { state } = apply([
      { contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent: { redactedContent: bytes } } } },
      { messageStop: { stopReason: 'end_turn' } },
    ]);
    expect(state.content).toStrictEqual([{ reasoningContent: { redactedContent: bytes } }]);
  });

  it('closes a block left open when the stream ends without messageStop', () => {
    const { state } = apply([{ contentBlockDelta: { contentBlockIndex: 0, delta: { text: 'cut' } } }]);
    expect(state.content).toStrictEqual([{ text: 'cut' }]);
    expect(state.stopReason).toBeNull();
  });

  it('defaults the stop reason to end_turn', () => {
    const { state } = apply([{ messageStop: { stopReason: undefined } }]);
    expect(state.stopReason).toBe('end_turn');
  });
});

describe('parseToolInput', () => {
  it.each([
    ['', {}],
    ['not json', {}],
    ['[1,2]', {}],
    ['"str"', {}],
    ['{"a":{"b":[1,null,true]}}', { a: { b: [1, null, true] } }],
  ])('parses %j', (raw, expected) => {
    expect(parseToolInput(raw)).toStrictEqual(expected);
  });
});

// The mutation run found the block boundaries, partial events, the
// "first matching handler wins" rule and the reasoning shapes unpinned.
const USAGE = { inputTokens: 1, outputTokens: 2, totalTokens: 3 };
const METADATA = { metadata: { usage: USAGE, metrics: { latencyMs: 1 } } };

/** Bedrock events as they may arrive at runtime: partial, or carrying two members. */
function isLooseEvent(value: unknown): value is ConverseStreamOutput {
  return typeof value === 'object' && value !== null;
}
function looseEvent(value: unknown): ConverseStreamOutput {
  if (!isLooseEvent(value)) throw new Error('an event is an object');
  return value;
}

const textDelta = (text: string) => looseEvent({ contentBlockDelta: { contentBlockIndex: 0, delta: { text } } });
const reasoningDelta = (reasoningContent: unknown) => looseEvent({ contentBlockDelta: { contentBlockIndex: 0, delta: { reasoningContent } } });
const toolStart = (toolUse: unknown) => looseEvent({ contentBlockStart: { contentBlockIndex: 0, start: { toolUse } } });

describe('processStreamEvent — block boundaries', () => {
  it('a contentBlockStop splits two text blocks', () => {
    const { state, calls } = apply([textDelta('a'), { contentBlockStop: { contentBlockIndex: 0 } }, textDelta('b')]);
    expect(state.content).toStrictEqual([{ text: 'a' }, { text: 'b' }]);
    expect(calls).toStrictEqual(['text:a', 'stop:text', 'text:b', 'stop:text']);
  });

  it('a new kind closes the open block without a contentBlockStop', () => {
    const { state, calls } = apply([
      reasoningDelta({ text: 'r' }), textDelta('t'), toolStart({ toolUseId: 'id', name: 'n' }),
    ]);
    expect(state.content).toStrictEqual([
      { reasoningContent: { reasoningText: { text: 'r' } } },
      { text: 't' },
      { toolUse: { toolUseId: 'id', name: 'n', input: {} } },
    ]);
    expect(calls).toStrictEqual(['reasoning:r', 'stop:reasoning', 'text:t', 'stop:text', 'stop:toolUse']);
  });

  it('reasoning after text closes the text block', () => {
    const { state, calls } = apply([textDelta('t'), reasoningDelta({ text: 'r' })]);
    expect(state.content).toStrictEqual([{ text: 't' }, { reasoningContent: { reasoningText: { text: 'r' } } }]);
    expect(calls).toStrictEqual(['text:t', 'stop:text', 'reasoning:r', 'stop:reasoning']);
  });

  it('messageStop closes the open block itself', () => {
    const state = createTurnState();
    const { sink, calls } = recordingSink();
    for (const event of [textDelta('t'), looseEvent({ messageStop: { stopReason: 'end_turn' } })]) processStreamEvent(event, state, sink);
    expect(state.content).toStrictEqual([{ text: 't' }]);
    expect(calls).toStrictEqual(['text:t', 'stop:text']);
  });

  it('defaults a tool use without id or name', () => {
    expect(apply([toolStart({})]).state.toolUses).toStrictEqual([{ toolUseId: '', name: 'unknown', input: {} }]);
  });
});

describe('processStreamEvent — partial and stray events', () => {
  const toolChunk = { contentBlockDelta: { contentBlockIndex: 0, delta: { toolUse: { input: '{}' } } } };
  const messageStart = { messageStart: { role: 'assistant' } };

  it.each([
    ['a delta without a body', { contentBlockDelta: { contentBlockIndex: 0 } }],
    ['a delta with an empty body', { contentBlockDelta: { contentBlockIndex: 0, delta: {} } }],
    ['a start without a body', { contentBlockStart: { contentBlockIndex: 0 } }],
    ['a tool-input chunk with no tool use open', toolChunk],
    ['an empty text delta', textDelta('')],
    ['a messageStart', messageStart],
  ])('ignores %s', (_label, event) => {
    const { state, calls } = apply([looseEvent(event)]);
    expect(state).toStrictEqual(createTurnState());
    expect(calls).toStrictEqual([]);
  });

  it('keeps the usage when a later event carries none', () => {
    expect(apply([looseEvent(METADATA), looseEvent(messageStart)]).state.usage).toStrictEqual(USAGE);
  });

  it.each([
    ['reasoning', reasoningDelta({ text: 'r' })],
    ['text', textDelta('t')],
    ['an empty text delta', textDelta('')],
    ['a tool-input chunk', toolChunk],
    ['a tool-use start', toolStart({ toolUseId: 'id', name: 'n' })],
    ['a contentBlockStop', { contentBlockStop: { contentBlockIndex: 0 } }],
    ['a messageStop', { messageStop: { stopReason: 'end_turn' } }],
  ])('an event handled as %s ignores the metadata it also carries', (_label, event) => {
    expect(apply([looseEvent({ ...event, ...METADATA })]).state.usage).toBeNull();
  });
});

describe('processStreamEvent — reasoning shapes', () => {
  it.each([
    ['text without a signature', [{ text: 't' }], [{ reasoningContent: { reasoningText: { text: 't' } } }]],
    ['a signature without text', [{ signature: 's' }], [{ reasoningContent: { reasoningText: { text: '', signature: 's' } } }]],
    ['nothing at all', [{}], []],
    ['redacted bytes followed by a signature', [{ redactedContent: new Uint8Array([7]) }, { signature: 's' }],
      [{ reasoningContent: { redactedContent: new Uint8Array([7]) } }]],
  ])('keeps %s', (_label, deltas, content) => {
    expect(apply(deltas.map(reasoningDelta)).state.content).toStrictEqual(content);
  });
});

describe('parseToolInput — non-object JSON', () => {
  it.each(['null', '42', 'true'])('turns %s into {}', (raw) => {
    expect(parseToolInput(raw)).toStrictEqual({});
  });
});
