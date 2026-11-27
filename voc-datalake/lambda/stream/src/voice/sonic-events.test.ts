import { describe, expect, it } from 'vitest';

import { audioEvent, closingEvents, openingEvents, parseOutput, toolResultEvents } from './sonic-events.js';

const bytes = (value: unknown): Uint8Array => new TextEncoder().encode(JSON.stringify(value));

/** An input event's name (`event.<name>`). */
function nameOf(one: Record<string, unknown>): string | undefined {
  const event: unknown = one.event;
  return typeof event === 'object' && event !== null ? Object.keys(event)[0] : undefined;
}

/** The body of a `promptStart` input event, or `{}`. */
function promptStartOf(one: unknown): object {
  const event: unknown = typeof one === 'object' && one !== null && 'event' in one ? one.event : undefined;
  const body: unknown = typeof event === 'object' && event !== null && 'promptStart' in event ? event.promptStart : undefined;
  return typeof body === 'object' && body !== null ? body : {};
}

describe('openingEvents', () => {
  const events = openingEvents({
    voiceId: 'matthew', systemPrompt: 'You are Maria.', tools: [{ toolSpec: { name: 'cite' } }],
    history: [{ role: 'USER', text: 'Hi' }, { role: 'ASSISTANT', text: 'Hello' }],
  });

  it('opens the session with MEDIUM endpointing, then the prompt with the voice at 24 kHz and the tools', () => {
    expect(events[0]).toStrictEqual({ event: { sessionStart: {
      inferenceConfiguration: { maxTokens: 1024, topP: 0.9, temperature: 0.7 },
      turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' },
    } } });
    expect(events[1]).toMatchObject({ event: { promptStart: {
      audioOutputConfiguration: { mediaType: 'audio/lpcm', sampleRateHertz: 24_000, voiceId: 'matthew', encoding: 'base64' },
      toolConfiguration: { tools: [{ toolSpec: { name: 'cite' } }], toolChoice: { auto: {} } },
    } } });
  });

  it('names no tool settings at all for a session without tools (the product interviewer)', () => {
    const [, prompt] = openingEvents({ voiceId: 'matthew', systemPrompt: 'You are an AI interviewer.', tools: [], history: [] });
    expect(Object.keys(promptStartOf(prompt)).sort((a, b) => a.localeCompare(b))).toStrictEqual(
      ['audioOutputConfiguration', 'promptName', 'textOutputConfiguration']);
  });

  it('sends the system prompt, then each history turn, then opens the microphone at 16 kHz', () => {
    expect(events.slice(2).map(nameOf)).toStrictEqual([
      'contentStart', 'textInput', 'contentEnd', 'contentStart', 'textInput', 'contentEnd', 'contentStart', 'textInput',
      'contentEnd', 'contentStart',
    ]);
    expect(events[5]).toMatchObject({ event: { contentStart: { role: 'USER', type: 'TEXT', interactive: false } } });
    expect(events.at(-1)).toMatchObject({ event: { contentStart: {
      type: 'AUDIO', role: 'USER', interactive: true, audioInputConfiguration: { sampleRateHertz: 16_000 },
    } } });
  });
});

describe('input events', () => {
  it('sends audio as base64, a tool result as JSON text, and closes audio, prompt and session', () => {
    expect(audioEvent(Buffer.from([1, 2]))).toStrictEqual({ event: { audioInput: { promptName: 'voc-voice', contentName: 'voc-audio', content: 'AQI=' } } });
    expect(toolResultEvents('t1', 'use-1', { ok: true })[1]).toStrictEqual({ event: { toolResult: { promptName: 'voc-voice', contentName: 't1', content: '{"ok":true}' } } });
    expect(closingEvents().map(nameOf)).toStrictEqual(['contentEnd', 'promptEnd', 'sessionEnd']);
  });
});

describe('parseOutput', () => {
  it('reads a block\'s stage from its additional fields, final when absent or unreadable', () => {
    const start = (fields?: string) => parseOutput(bytes({ event: { contentStart: { contentId: 'c', role: 'ASSISTANT', type: 'TEXT', additionalModelFields: fields } } }));
    expect(start('{"generationStage":"SPECULATIVE"}')).toStrictEqual({ kind: 'contentStart', contentId: 'c', role: 'ASSISTANT', type: 'TEXT', stage: 'speculative' });
    expect([start(), start('not json'), start('{"generationStage":"FINAL"}')])
      .toMatchObject([{ stage: 'final' }, { stage: 'final' }, { stage: 'final' }]);
  });

  it('reads text, audio, the end of a block and a tool use', () => {
    expect(parseOutput(bytes({ event: { textOutput: { contentId: 'c', role: 'USER', content: 'hi' } } })))
      .toStrictEqual({ kind: 'text', contentId: 'c', role: 'USER', content: 'hi' });
    expect(parseOutput(bytes({ event: { audioOutput: { contentId: 'a', content: 'AQI=' } } })))
      .toStrictEqual({ kind: 'audio', contentId: 'a', content: 'AQI=' });
    expect(parseOutput(bytes({ event: { contentEnd: { contentId: 'a', stopReason: 'INTERRUPTED', type: 'AUDIO' } } })))
      .toStrictEqual({ kind: 'contentEnd', contentId: 'a', stopReason: 'INTERRUPTED', type: 'AUDIO' });
    expect(parseOutput(bytes({ event: { toolUse: { toolName: 'cite', toolUseId: 'u', content: '{}' } } })))
      .toStrictEqual({ kind: 'toolUse', toolName: 'cite', toolUseId: 'u', content: '{}' });
  });

  it('reads the start of a response', () => {
    expect(parseOutput(bytes({ event: { completionStart: { completionId: 'c-1', sessionId: 's' } } })))
      .toStrictEqual({ kind: 'completionStart' });
  });

  it('reads the usage totals, and anything else as other', () => {
    const usage = { details: { total: { input: { speechTokens: 157, textTokens: 953 }, output: { speechTokens: 143, textTokens: 41 } } } };
    expect(parseOutput(bytes({ event: { usageEvent: usage } }))).toStrictEqual({ kind: 'usage', totals: { speech_in: 157, speech_out: 143, text_in: 953, text_out: 41 } });
    expect([parseOutput(bytes({ event: { completionEnd: {} } })), parseOutput(new TextEncoder().encode('{')), parseOutput(bytes([]))])
      .toStrictEqual([{ kind: 'other' }, { kind: 'other' }, { kind: 'other' }]);
  });
});
