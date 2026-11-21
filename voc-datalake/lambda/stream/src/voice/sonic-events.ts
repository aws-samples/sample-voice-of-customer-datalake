/**
 * Nova Sonic's bidirectional event protocol (S-15 findings, section 2; the Nova 2 Sonic user guide's input and output
 * events), as the relay speaks it: the events that open a stream, the audio and text the conversation adds, the tool
 * results, the close; and the output events read back, parsed leniently (an event of another shape is `other`).
 *
 * Every input event is `{event: {<name>: {...}}}` as UTF-8 JSON in one chunk. One prompt per stream; each content
 * block has its own `contentName`.
 */
import { z } from 'zod';

import { VOICE_INPUT_SAMPLE_RATE, VOICE_OUTPUT_SAMPLE_RATE } from './protocol.js';

const PROMPT_NAME = 'voc-voice';
const AUDIO_CONTENT = 'voc-audio';
/** Nova Sonic's inference settings for a conversation (S-15 findings 6.1). */
const INFERENCE = { maxTokens: 1024, topP: 0.9, temperature: 0.7 } as const;
const LPCM = { mediaType: 'audio/lpcm', sampleSizeBits: 16, channelCount: 1, encoding: 'base64', audioType: 'SPEECH' } as const;
const TEXT_PLAIN = { mediaType: 'text/plain' } as const;

export type SonicEvent = Record<string, unknown>;
type HistoryRole = 'USER' | 'ASSISTANT';

export interface HistoryEntry {
  role: HistoryRole;
  text: string;
}

export interface StreamSetup {
  voiceId: string;
  systemPrompt: string;
  tools: readonly Record<string, unknown>[];
  history: readonly HistoryEntry[];
}

function event(name: string, body: Record<string, unknown>): SonicEvent {
  return { event: { [name]: body } };
}

/** One non-interactive text block (the system prompt, a history turn) or an interactive user text turn. */
export function textBlock(contentName: string, role: 'SYSTEM' | HistoryRole, text: string, interactive = false): SonicEvent[] {
  return [
    event('contentStart', {
      promptName: PROMPT_NAME, contentName, type: 'TEXT', interactive, role, textInputConfiguration: TEXT_PLAIN,
    }),
    event('textInput', { promptName: PROMPT_NAME, contentName, content: text }),
    event('contentEnd', { promptName: PROMPT_NAME, contentName }),
  ];
}

/** A stream's opening: the session, the prompt (voice, tools), the system prompt, the history, the microphone. */
export function openingEvents(setup: StreamSetup): SonicEvent[] {
  return [
    event('sessionStart', {
      inferenceConfiguration: INFERENCE, turnDetectionConfiguration: { endpointingSensitivity: 'MEDIUM' },
    }),
    event('promptStart', {
      promptName: PROMPT_NAME,
      textOutputConfiguration: TEXT_PLAIN,
      audioOutputConfiguration: { ...LPCM, sampleRateHertz: VOICE_OUTPUT_SAMPLE_RATE, voiceId: setup.voiceId },
      toolUseOutputConfiguration: { mediaType: 'application/json' },
      toolConfiguration: { tools: setup.tools, toolChoice: { auto: {} } },
    }),
    ...textBlock('voc-system', 'SYSTEM', setup.systemPrompt),
    ...setup.history.flatMap((entry, index) => textBlock(`voc-history-${index + 1}`, entry.role, entry.text)),
    event('contentStart', {
      promptName: PROMPT_NAME, contentName: AUDIO_CONTENT, type: 'AUDIO', interactive: true, role: 'USER',
      audioInputConfiguration: { ...LPCM, sampleRateHertz: VOICE_INPUT_SAMPLE_RATE },
    }),
  ];
}

/** One microphone frame (raw PCM16LE from the browser), base64 as Nova Sonic takes it. */
export function audioEvent(pcm: Buffer): SonicEvent {
  return event('audioInput', { promptName: PROMPT_NAME, contentName: AUDIO_CONTENT, content: pcm.toString('base64') });
}

/** A tool's result block. */
export function toolResultEvents(contentName: string, toolUseId: string, result: unknown): SonicEvent[] {
  return [
    event('contentStart', {
      promptName: PROMPT_NAME, contentName, interactive: false, type: 'TOOL', role: 'TOOL',
      toolResultInputConfiguration: { toolUseId, type: 'TEXT', textInputConfiguration: TEXT_PLAIN },
    }),
    event('toolResult', { promptName: PROMPT_NAME, contentName, content: JSON.stringify(result) }),
    event('contentEnd', { promptName: PROMPT_NAME, contentName }),
  ];
}

/** The close: the microphone's block, the prompt, the session. */
export function closingEvents(): SonicEvent[] {
  return [
    event('contentEnd', { promptName: PROMPT_NAME, contentName: AUDIO_CONTENT }),
    event('promptEnd', { promptName: PROMPT_NAME }),
    event('sessionEnd', {}),
  ];
}

// ── Output ─────────────────────────────────────────────────────────────────────────────────────────────────────

const count = z.number().int().nonnegative().catch(0);
const tokens = z.object({ speechTokens: count, textTokens: count }).catch({ speechTokens: 0, textTokens: 0 });
const role = z.string().catch('');

const outputSchema = z.object({
  event: z.object({
    contentStart: z.object({
      contentId: z.string().catch(''), role, type: z.string().catch(''),
      additionalModelFields: z.string().optional().catch(undefined),
    }).optional(),
    textOutput: z.object({ contentId: z.string().catch(''), role, content: z.string().catch('') }).optional(),
    audioOutput: z.object({ contentId: z.string().catch(''), content: z.string().catch('') }).optional(),
    contentEnd: z.object({ contentId: z.string().catch(''), stopReason: z.string().catch(''), type: z.string().catch('') }).optional(),
    toolUse: z.object({ toolName: z.string().catch(''), toolUseId: z.string().catch(''), content: z.string().catch('') }).optional(),
    usageEvent: z.object({
      details: z.object({ total: z.object({ input: tokens, output: tokens }) }),
    }).optional(),
  }),
});

export interface TokenTotals {
  speech_in: number;
  speech_out: number;
  text_in: number;
  text_out: number;
}

export type SonicOutput =
  | { kind: 'contentStart'; contentId: string; role: string; type: string; stage: 'speculative' | 'final' }
  | { kind: 'text'; contentId: string; role: string; content: string }
  | { kind: 'audio'; contentId: string; content: string }
  | { kind: 'contentEnd'; contentId: string; stopReason: string; type: string }
  | { kind: 'toolUse'; toolName: string; toolUseId: string; content: string }
  | { kind: 'usage'; totals: TokenTotals }
  | { kind: 'other' };

const stageSchema = z.object({ generationStage: z.string() });

/** `additionalModelFields` is a JSON string, `{"generationStage":"SPECULATIVE"|"FINAL"}`; absent is final. */
function stageOf(fields: string | undefined): 'speculative' | 'final' {
  if (fields === undefined) return 'final';
  try {
    const parsed = stageSchema.safeParse(JSON.parse(fields));
    return parsed.success && parsed.data.generationStage === 'SPECULATIVE' ? 'speculative' : 'final';
  } catch {
    return 'final';
  }
}

function decoded(bytes: Uint8Array): unknown {
  try {
    return JSON.parse(Buffer.from(bytes).toString('utf8'));
  } catch {
    return undefined;
  }
}

/** One output chunk's event. */
export function parseOutput(bytes: Uint8Array): SonicOutput {
  const parsed = outputSchema.safeParse(decoded(bytes));
  if (!parsed.success) return { kind: 'other' };
  const body = parsed.data.event;
  if (body.contentStart) {
    const { contentId, role: speaker, type, additionalModelFields } = body.contentStart;
    return { kind: 'contentStart', contentId, role: speaker, type, stage: stageOf(additionalModelFields) };
  }
  if (body.textOutput) return { kind: 'text', ...body.textOutput };
  if (body.audioOutput) return { kind: 'audio', ...body.audioOutput };
  if (body.contentEnd) return { kind: 'contentEnd', ...body.contentEnd };
  if (body.toolUse) return { kind: 'toolUse', ...body.toolUse };
  if (body.usageEvent) {
    const { input, output } = body.usageEvent.details.total;
    return { kind: 'usage', totals: {
      speech_in: input.speechTokens, speech_out: output.speechTokens, text_in: input.textTokens, text_out: output.textTokens,
    } };
  }
  return { kind: 'other' };
}
