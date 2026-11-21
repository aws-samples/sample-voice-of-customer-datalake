/**
 * One spoken interview with a persona: the browser's WebSocket on one side, Nova Sonic on the other (docs/
 * voice-personas.md → The relay). One per AgentCore session (one microVM per session id).
 *
 * - Start: the session row goes `minted` → `live` once (store.ts `activate`: the presigned URL is single use and
 *   lasts a minute), then the projects API's input is read and must name this session and its signed scope; any
 *   refusal is `ended {refused}` and close 1008. Then the first stream opens and the browser hears `ready`.
 * - Rollover: a Bedrock stream lasts at most 8 minutes, so at the persona's first finished turn after 7:00 of a
 *   stream's life (or at 7:45 whatever it is doing) a new stream opens with the same prompt and the conversation so far
 *   as its chat history (transcript.ts `history`, within Nova Sonic's 200 KB), the microphone moves to it, the old one
 *   closes. The meter sums every stream's usage.
 * - The meter, every minute and at the end: the session row's seconds, tokens and cost, and the month's (the
 *   deployment's) seconds and cost, whose new total is the budget check: at or over the month's minutes the persona
 *   says goodbye and the session ends (`budget`); with a minute left, a notice. The session's own limit ends it the
 *   same way (`session_limit`), with a notice a minute before.
 * - Wrap-up: a notice, a cross-modal turn asking the persona to say goodbye, then the end at its finished turn or after
 *   10 seconds.
 * - End (once, whatever asked: the person's End, a limit, the budget, a stream failure, the browser leaving): the
 *   stream closes, the last turns are written, the usage recorded, the row marked ended (only while live), the session
 *   leaves the live set, and the browser hears `ended {reason}` (after the writes: the projects API finalizes when the
 *   browser asks it to, once it heard this).
 */
import { errorName } from '../lib/error-name.js';
import { Conversation } from './conversation.js';
import { isBusyError, SonicStream, type SonicTransport } from './bedrock-stream.js';
import { logEvent } from './log.js';
import { Meter, centsOf } from './meter.js';
import { citeToolSpec, GOODBYE_TURN, systemPrompt } from './prompt.js';
import { browserMessageSchema, VOICE_CLOSE, type RelayMessage, type VoiceEndReason } from './protocol.js';
import { parseSessionInput, SCOPE_ID, SESSION_ID, type SessionInput } from './session-input.js';
import { audioEvent, openingEvents, textBlock, toolResultEvents, type HistoryEntry, type SonicOutput } from './sonic-events.js';
import type { VoiceStore } from './store.js';
import { Transcript } from './transcript.js';

export interface Clock {
  now(): number;
  /** Run `run` after `ms`; the function cancels it. */
  after(ms: number, run: () => void): () => void;
}

/** The browser's side, as the session sends to it. */
export interface ClientChannel {
  json(message: RelayMessage): void;
  audio(pcm: Buffer): void;
  close(code: number): void;
}

export interface SessionDeps {
  store: VoiceStore;
  transport: SonicTransport;
  clock: Clock;
  meter: () => Meter;
}

const MINUTE_MS = 60_000;
/** A stream's age at which the next finished turn rolls it over, and the age at which it rolls over regardless. */
const SOFT_ROLLOVER_MS = 7 * MINUTE_MS;
const HARD_ROLLOVER_MS = 7 * MINUTE_MS + 45_000;
const WRAP_UP_MS = 10_000;
/** The live cost is sent at most this often. */
const USAGE_EVERY_MS = 5000;
/** Microphone frames kept while the stream is not there yet (64 ms each: 4 seconds). */
const MAX_PENDING_FRAMES = 64;

interface Failure {
  reason: VoiceEndReason;
  code: number;
}

const refused: Failure = { reason: 'refused', code: VOICE_CLOSE.policy };

export class VoiceSession {
  private input: SessionInput | undefined;
  private transcript: Transcript | undefined;
  private conversation: Conversation | undefined;
  private readonly meter: Meter;
  private stream: SonicStream | undefined;
  private streams = 0;
  private activated = false;
  private startedAt = 0;
  private reported = { seconds: 0, cost: 0 };
  private minutesLeft = 0;
  private usageSentAt = 0;
  private budgetWarned = false;
  private rolling = false;
  private wrapping: VoiceEndReason | undefined;
  private pendingAudio: Buffer[] = [];
  private parts = 0;
  private writes: Promise<void> = Promise.resolve();
  private readonly timers = new Set<() => void>();
  private startup: Promise<Failure | undefined> = Promise.resolve(undefined);
  private ending: Promise<void> | undefined;
  private over = false;

  constructor(
    private readonly deps: SessionDeps,
    private readonly ids: { sessionId: string; scope: string },
    private readonly channel: ClientChannel,
  ) {
    this.meter = deps.meter();
  }

  /** Whether the session has ended (a later connection gets a session of its own, refused once this one was used). */
  get isOver(): boolean {
    return this.over;
  }

  async start(): Promise<void> {
    this.startup = this.startUp();
    const failure = await this.startup;
    if (failure !== undefined) await this.end(failure.reason, failure.code);
  }

  /** A microphone frame (raw PCM16LE at 16 kHz). */
  audio(pcm: Buffer): void {
    if (this.ending !== undefined || pcm.length === 0 || pcm.length % 2 !== 0) return;
    if (this.stream === undefined) {
      this.pendingAudio = [...this.pendingAudio, pcm].slice(-MAX_PENDING_FRAMES);
      return;
    }
    this.stream.send(audioEvent(pcm));
  }

  /** A JSON control message from the browser: `end` is the person's End; anything else is ignored. */
  control(text: string): void {
    try {
      if (browserMessageSchema.safeParse(JSON.parse(text)).success) void this.end('ended_by_person');
    } catch {
      logEvent('control_unreadable', { session_id: this.ids.sessionId });
    }
  }

  /** The browser's connection closed. */
  disconnected(): void {
    void this.end('disconnected');
  }

  private async startUp(): Promise<Failure | undefined> {
    const { sessionId, scope } = this.ids;
    try {
      if (!SESSION_ID.test(sessionId) || !SCOPE_ID.test(scope)) return refused;
      this.activated = await this.deps.store.activate(sessionId, new Date(this.deps.clock.now()));
      if (!this.activated) return refused;
      this.startedAt = this.deps.clock.now();
      const input = parseSessionInput(await this.deps.store.loadInput(sessionId), sessionId, scope);
      if (input === undefined) return refused;
      if (this.endRequested()) return undefined;
      this.begin(input);
      await this.openStream([]);
      if (this.endRequested()) return undefined;
      this.channel.json({ type: 'ready', voice_id: input.voiceId, session_seconds: input.sessionSeconds, minutes_left: input.minutesLeft });
      this.armLimits(input);
      logEvent('session_live', { session_id: sessionId, evidence: input.evidence.length });
      return undefined;
    } catch (error) {
      logEvent('session_failed', { session_id: sessionId, error: errorName(error) });
      return { reason: isBusyError(error) ? 'busy' : 'error', code: VOICE_CLOSE.error };
    }
  }

  private begin(input: SessionInput): void {
    this.input = input;
    this.minutesLeft = input.minutesLeft;
    const transcript = new Transcript(new Set(input.evidence.map((item) => item.feedback_id)),
      () => new Date(this.deps.clock.now()).toISOString());
    this.transcript = transcript;
    this.conversation = new Conversation(transcript, {
      send: (message) => { this.channel.json(message); },
      audio: (pcm) => { this.channel.audio(pcm); },
      toolResult: (toolUseId, result) => { this.toolResult(toolUseId, result); },
      assistantTurnEnded: () => { this.assistantTurnEnded(); },
    });
  }

  private timer(ms: number, run: () => void): void {
    const cancel = this.deps.clock.after(ms, () => {
      this.timers.delete(cancel);
      run();
    });
    this.timers.add(cancel);
  }

  /** Open a stream (the first, or a rollover's with `history`) and move the microphone to it. */
  private async openStream(history: HistoryEntry[]): Promise<void> {
    const input = this.input;
    if (input === undefined) return;
    const stream = new SonicStream(this.streams, this.deps.clock.now());
    this.streams += 1;
    stream.send(openingEvents({ voiceId: input.voiceId, systemPrompt: systemPrompt(input), tools: [citeToolSpec()], history }));
    const previous = this.stream;
    this.stream = stream;
    for (const frame of this.pendingAudio) stream.send(audioEvent(frame));
    this.pendingAudio = [];
    previous?.close();
    const output = await stream.start(this.deps.transport);
    void this.pump(stream, output);
    this.timer(HARD_ROLLOVER_MS, () => {
      if (stream === this.stream) void this.rollover();
    });
  }

  /** A stream's output, while it is the session's: usage from any stream (an old one's last usage still counts). */
  private async pump(stream: SonicStream, output: AsyncIterable<SonicOutput>): Promise<void> {
    try {
      for await (const event of output) this.handle(stream, event);
      if (stream === this.stream) await this.end('error', VOICE_CLOSE.error);
    } catch (error) {
      logEvent('stream_failed', { session_id: this.ids.sessionId, stream: stream.index, error: errorName(error) });
      if (stream === this.stream) await this.end(isBusyError(error) ? 'busy' : 'error', VOICE_CLOSE.error);
    }
  }

  private handle(stream: SonicStream, event: SonicOutput): void {
    if (event.kind === 'usage') {
      this.meter.record(stream.index, event.totals);
      this.sendUsage();
      return;
    }
    if (stream !== this.stream || this.ending !== undefined) return;
    this.conversation?.handle(event);
    this.writeParts(false);
  }

  private sendUsage(): void {
    const now = this.deps.clock.now();
    if (now - this.usageSentAt < USAGE_EVERY_MS) return;
    this.usageSentAt = now;
    this.channel.json({ type: 'usage', seconds: this.elapsedSeconds(), cents: centsOf(this.meter.costMicroUsd()) });
  }

  private toolResult(toolUseId: string, result: Record<string, unknown>): void {
    const stream = this.stream;
    stream?.send(toolResultEvents(stream.contentName('tool'), toolUseId, result));
  }

  private assistantTurnEnded(): void {
    if (this.wrapping !== undefined) {
      void this.end(this.wrapping);
      return;
    }
    const stream = this.stream;
    if (stream !== undefined && this.deps.clock.now() - stream.openedAt >= SOFT_ROLLOVER_MS) void this.rollover();
  }

  private async rollover(): Promise<void> {
    if (this.rolling || this.ending !== undefined || this.wrapping !== undefined || this.transcript === undefined) return;
    this.rolling = true;
    try {
      await this.openStream(this.transcript.history());
      logEvent('stream_rollover', { session_id: this.ids.sessionId, streams: this.streams });
    } catch (error) {
      logEvent('rollover_failed', { session_id: this.ids.sessionId, error: errorName(error) });
      await this.end(isBusyError(error) ? 'busy' : 'error', VOICE_CLOSE.error);
    } finally {
      this.rolling = false;
    }
  }

  private armLimits(input: SessionInput): void {
    const limitMs = input.sessionSeconds * 1000;
    if (limitMs > MINUTE_MS) this.timer(limitMs - MINUTE_MS, () => { this.channel.json({ type: 'notice', code: 'time_almost_up' }); });
    this.timer(limitMs, () => { this.wrapUp('session_limit'); });
    this.timer(MINUTE_MS, () => { void this.tick(); });
  }

  /** The minute's meter and the budget check; then the next minute's. */
  private async tick(): Promise<void> {
    if (this.endRequested()) return;
    await this.attempt('meter', () => this.recordMeter());
    if (this.endRequested()) return;
    this.channel.json({ type: 'budget', minutes_left: Math.round(this.minutesLeft * 10) / 10 });
    if (this.minutesLeft <= 0) {
      this.wrapUp('budget');
    } else if (this.minutesLeft <= 1 && !this.budgetWarned) {
      this.budgetWarned = true;
      this.channel.json({ type: 'notice', code: 'budget_almost_up' });
    }
    this.timer(MINUTE_MS, () => { void this.tick(); });
  }

  private elapsedSeconds(): number {
    return this.startedAt === 0 ? 0 : Math.floor((this.deps.clock.now() - this.startedAt) / 1000);
  }

  /** The session row's usage, then the month's: the seconds and the cost since the last record, its new total back. */
  private async recordMeter(): Promise<void> {
    const input = this.input;
    if (input === undefined) return;
    const seconds = this.elapsedSeconds();
    const cost = this.meter.costMicroUsd();
    await this.deps.store.recordUsage(this.ids.sessionId, { seconds, tokens: this.meter.tokens(), costMicroUsd: cost, streams: this.streams });
    const total = await this.deps.store.addMonthly(input.usageKey, seconds - this.reported.seconds,
      cost - this.reported.cost, new Date(this.deps.clock.now()));
    this.reported = { seconds, cost };
    this.minutesLeft = Math.max(0, (input.monthlySeconds - total) / 60);
  }

  private wrapUp(reason: VoiceEndReason): void {
    if (this.wrapping !== undefined || this.ending !== undefined) return;
    this.wrapping = reason;
    this.channel.json({ type: 'notice', code: 'wrapping_up' });
    const stream = this.stream;
    stream?.send(textBlock(stream.contentName('goodbye'), 'USER', GOODBYE_TURN, true));
    this.timer(WRAP_UP_MS, () => { void this.end(reason); });
  }

  /** The settled turns (all of them at the end) as the next write-once part, written in order. */
  private writeParts(all: boolean): void {
    const turns = this.transcript?.take(all) ?? [];
    if (turns.length === 0) return;
    this.parts += 1;
    const part = this.parts;
    const { sessionId } = this.ids;
    const body = JSON.stringify({ version: 1, session_id: sessionId, part, turns });
    this.writes = this.writes.then(() => this.attempt('transcript_part', async () => {
      await this.deps.store.writePart(sessionId, part, body);
      await this.deps.store.recordParts(sessionId, part);
    }));
  }

  /** A store call that must not stop the session or its end: its failure is logged by name. */
  private async attempt(operation: string, call: () => Promise<void>): Promise<void> {
    try {
      await call();
    } catch (error) {
      logEvent('store_failed', { session_id: this.ids.sessionId, operation, error: errorName(error) });
    }
  }

  /** Whether the end was asked for (a method: the end can be asked while an await of this session's is pending). */
  private endRequested(): boolean {
    return this.ending !== undefined;
  }

  /** End the session (once; every later call answers the same promise). */
  end(reason: VoiceEndReason, code: number = VOICE_CLOSE.normal): Promise<void> {
    this.ending ??= this.finish(reason, code);
    return this.ending;
  }

  private async finish(reason: VoiceEndReason, code: number): Promise<void> {
    await this.startup;
    for (const cancel of this.timers) cancel();
    this.timers.clear();
    this.stream?.close();
    const { sessionId } = this.ids;
    if (this.activated) {
      this.writeParts(true);
      await this.writes;
      await this.attempt('usage', () => this.recordMeter());
      await this.attempt('ended', () => this.deps.store.markEnded(sessionId, reason, new Date(this.deps.clock.now())));
      await this.attempt('live', () => this.deps.store.leaveLive(sessionId));
    }
    logEvent('session_ended', { session_id: sessionId, reason, parts: this.parts, streams: this.streams, seconds: this.elapsedSeconds() });
    this.channel.json({ type: 'ended', reason });
    this.channel.close(code);
    this.over = true;
  }
}
