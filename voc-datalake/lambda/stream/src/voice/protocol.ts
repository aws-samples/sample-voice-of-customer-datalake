/**
 * The voice personas' wire contract (7.69.00, `-c voicePersonas=true`, docs/voice-personas.md): what the relay
 * (this folder, an AgentCore Runtime; voice-session.ts) and the SPA's voice session (frontend
 * src/pages/ProjectDetail/voice/useVoiceSession.ts) send each other over
 * the runtime's WebSocket, and the catalogue both read (the model's voices and our locales it speaks).
 *
 * Browser-safe (the SPA imports it through `@stream/voice/protocol`): zod only, no Node built-in, no AWS SDK.
 *
 * - Browser → relay: binary frames of raw PCM16LE mono at `VOICE_INPUT_SAMPLE_RATE` (`MIC_FRAME_SAMPLES` per
 *   frame), and one JSON control message, `{type: 'end'}`.
 * - Relay → browser: binary frames of raw PCM16LE mono at `VOICE_OUTPUT_SAMPLE_RATE` (the persona's voice), and the
 *   JSON messages of `relayMessageSchema`. Every frame either way is at most `MAX_VOICE_FRAME_BYTES`.
 * - Audio is never stored by either side: only the captions' text becomes the transcript.
 */
import { z } from 'zod';

/** The microphone's rate the relay forwards to Nova Sonic, and the rate the persona's voice comes back at. */
export const VOICE_INPUT_SAMPLE_RATE = 16_000;
export const VOICE_OUTPUT_SAMPLE_RATE = 24_000;
/** Samples per microphone frame: 64 ms at 16 kHz, 2,048 bytes, 16 frames a second (AgentCore allows 250). */
export const MIC_FRAME_SAMPLES = 1024;
/** The largest WebSocket frame either side sends: AgentCore's quota says 64 KB, its troubleshooting 32 KB. */
export const MAX_VOICE_FRAME_BYTES = 32 * 1024;
/** One caption's text at most (a turn longer than this is clipped, never split). */
export const MAX_CAPTION_CHARS = 4000;
/** Feedback ids one `cite` names at most. */
export const MAX_CITED_IDS = 10;

/** The WebSocket close codes the relay uses: normal, a refused or reused session, a frame too big, an error. */
export const VOICE_CLOSE = { normal: 1000, policy: 1008, tooBig: 1009, error: 1011 } as const;

/**
 * Nova 2 / 2.5 Sonic's 16 voices (the model cards, read 2026-11-21): only `tiffany` and `matthew` speak every
 * supported language (polyglot), the others their own locale. `gender` is what the persona's prompt states, so the
 * languages with grammatical gender agree with the voice; it is never inferred from a persona's name.
 */
export const VOICE_IDS = [
  'tiffany', 'matthew', 'amy', 'olivia', 'kiara', 'arjun', 'ambre', 'florian', 'beatrice', 'lorenzo', 'tina', 'lennart',
  'lupe', 'carlos', 'carolina', 'leo',
] as const;
export type VoiceId = (typeof VOICE_IDS)[number];

export interface VoiceSpec {
  readonly id: VoiceId;
  readonly gender: 'feminine' | 'masculine';
  readonly locale: string;
  readonly polyglot: boolean;
}

export const VOICES: readonly VoiceSpec[] = [
  { id: 'tiffany', gender: 'feminine', locale: 'en-US', polyglot: true },
  { id: 'matthew', gender: 'masculine', locale: 'en-US', polyglot: true },
  { id: 'amy', gender: 'feminine', locale: 'en-GB', polyglot: false },
  { id: 'olivia', gender: 'feminine', locale: 'en-AU', polyglot: false },
  { id: 'kiara', gender: 'feminine', locale: 'en-IN', polyglot: false },
  { id: 'arjun', gender: 'masculine', locale: 'en-IN', polyglot: false },
  { id: 'ambre', gender: 'feminine', locale: 'fr-FR', polyglot: false },
  { id: 'florian', gender: 'masculine', locale: 'fr-FR', polyglot: false },
  { id: 'beatrice', gender: 'feminine', locale: 'it-IT', polyglot: false },
  { id: 'lorenzo', gender: 'masculine', locale: 'it-IT', polyglot: false },
  { id: 'tina', gender: 'feminine', locale: 'de-DE', polyglot: false },
  { id: 'lennart', gender: 'masculine', locale: 'de-DE', polyglot: false },
  { id: 'lupe', gender: 'feminine', locale: 'es-US', polyglot: false },
  { id: 'carlos', gender: 'masculine', locale: 'es-US', polyglot: false },
  { id: 'carolina', gender: 'feminine', locale: 'pt-BR', polyglot: false },
  { id: 'leo', gender: 'masculine', locale: 'pt-BR', polyglot: false },
];

/** Our 9 UI locales the model speaks (it also speaks Italian and Hindi, which are no UI locale); ja, ko, pl and zh it
 *  does not (lambda/shared/voice_sessions.py UNSUPPORTED_LANGUAGES). */
export const VOICE_LANGUAGES = ['en', 'de', 'es', 'fr', 'pt'] as const;

/** Why a session ended, as the relay says in `ended` and the session row's `end_reason` records it. */
export const VOICE_END_REASONS = [
  'ended_by_person', 'session_limit', 'budget', 'busy', 'error', 'disconnected', 'refused',
] as const;
export type VoiceEndReason = (typeof VOICE_END_REASONS)[number];

const role = z.enum(['user', 'assistant']);
const feedbackId = z.string().regex(/^[A-Za-z0-9_-]{1,128}$/);

/** The JSON messages the relay sends the browser. */
export const relayMessageSchema = z.discriminatedUnion('type', [
  /** The model's stream is up: speak now. `minutes_left` is the deployment's month, after this session's start. */
  z.object({
    type: z.literal('ready'), voice_id: z.enum(VOICE_IDS), session_seconds: z.number().int().positive(),
    minutes_left: z.number().nonnegative(),
  }),
  /** A live caption: the person's words as the model heard them, or the persona's. `speculative` text may still
   *  change; `final` is what was said. `turn` numbers the conversation's turns from 1. `text` is the WHOLE turn's
   *  text so far at that stage (the relay accumulates it): replace the turn's caption, never append. */
  z.object({
    type: z.literal('caption'), role, stage: z.enum(['speculative', 'final']),
    text: z.string().max(MAX_CAPTION_CHARS), turn: z.number().int().positive(),
  }),
  /** The person spoke over the persona (barge-in): stop playback and drop what is queued. */
  z.object({ type: z.literal('interrupted') }),
  z.object({ type: z.literal('turn_end'), role, turn: z.number().int().positive() }),
  /** The persona cited reviews of its evidence pack in a turn (ids outside the pack never reach the browser). */
  z.object({ type: z.literal('citation'), turn: z.number().int().positive(), feedback_ids: z.array(feedbackId).max(MAX_CITED_IDS) }),
  /** The session so far: its seconds and its estimated cost in US cents (Nova Sonic's tokens, from its usage). */
  z.object({ type: z.literal('usage'), seconds: z.number().int().nonnegative(), cents: z.number().nonnegative() }),
  /** The deployment's minutes left this month (checked by the relay every minute). */
  z.object({ type: z.literal('budget'), minutes_left: z.number().nonnegative() }),
  /** A spoken and visual notice: one minute left, the month's budget nearly used, or the persona saying goodbye. */
  z.object({ type: z.literal('notice'), code: z.enum(['time_almost_up', 'budget_almost_up', 'wrapping_up']) }),
  z.object({ type: z.literal('ended'), reason: z.enum(VOICE_END_REASONS) }),
]);
export type RelayMessage = z.infer<typeof relayMessageSchema>;

/** The JSON messages the browser sends the relay (audio is binary). */
export const browserMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('end') }),
]);
