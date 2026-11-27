/**
 * The voice relay specs' doubles: a clock moved by hand, the store as calls, Nova Sonic as a feed the spec writes
 * output events into (and reads the relay's input events back from), the browser's channel as what it received, and
 * the projects API's session input.
 */
import { InputQueue, type SonicTransport } from './bedrock-stream.js';
import { SessionGoneError } from './store.js';
import type { RelayMessage, VoiceEndReason } from './protocol.js';
import type { MonthTotals, SessionUsage, VoiceStore } from './store.js';
import type { ClientChannel, Clock } from './voice-session.js';

export const SESSION_ID = '0f8fad5b-d9cb-469f-a165-70867728950e';
export const PROJECT_ID = 'proj_1';

interface Timer {
  id: number;
  at: number;
  run: () => void;
}

export class ManualClock implements Clock {
  current = Date.UTC(2026, 10, 21, 12, 0, 0);
  private timers: Timer[] = [];
  private ids = 0;

  now(): number {
    return this.current;
  }

  after(ms: number, run: () => void): () => void {
    this.ids += 1;
    const id = this.ids;
    this.timers = [...this.timers, { id, at: this.current + ms, run }];
    return () => { this.timers = this.timers.filter((timer) => timer.id !== id); };
  }

  /** Move time forward by `ms`, running each timer that falls due, earliest first, at its own time. */
  advance(ms: number): void {
    this.runUntil(this.current + ms);
  }

  private runUntil(target: number): void {
    const due = [...this.timers].sort((a, b) => a.at - b.at).find((timer) => timer.at <= target);
    if (due === undefined) {
      this.current = target;
      return;
    }
    this.timers = this.timers.filter((timer) => timer.id !== due.id);
    this.current = due.at;
    due.run();
    this.runUntil(target);
  }
}

/** Let every pending promise and its continuations run. */
export async function settle(rounds = 25): Promise<void> {
  await Array.from({ length: rounds }).reduce<Promise<void>>(
    (previous) => previous.then(() => new Promise((resolve) => { setImmediate(resolve); })), Promise.resolve());
}

export class FakeStore implements VoiceStore {
  readonly calls: string[] = [];
  readonly parts = new Map<number, unknown>();
  readonly usage: SessionUsage[] = [];
  readonly monthly: Array<{ key: string; seconds: number; cost: number }> = [];
  ended: VoiceEndReason | undefined;
  activation = true;
  input: unknown = undefined;
  monthTotal = 0;
  monthCost = 0;
  /** The session row is gone: its updates fail as the real store's do. */
  gone = false;
  /** Activation waits for it (a spec's race with the browser leaving). */
  gate: Promise<void> = Promise.resolve();
  /** The session row's usage write waits for it (a spec's race of a minute's meter with the end). */
  usageGate: Promise<void> = Promise.resolve();

  async activate(sessionId: string): Promise<boolean> {
    this.calls.push(`activate:${sessionId}`);
    await this.gate;
    return this.activation;
  }

  loadInput(sessionId: string): Promise<unknown> {
    this.calls.push(`loadInput:${sessionId}`);
    return Promise.resolve(this.input);
  }

  writePart(_sessionId: string, part: number, body: string): Promise<void> {
    const parsed: unknown = JSON.parse(body);
    this.parts.set(part, parsed);
    return Promise.resolve();
  }

  recordParts(_sessionId: string, parts: number): Promise<void> {
    this.calls.push(`recordParts:${parts}`);
    return this.gone ? Promise.reject(new SessionGoneError()) : Promise.resolve();
  }

  async recordUsage(_sessionId: string, usage: SessionUsage): Promise<void> {
    this.usage.push(usage);
    await this.usageGate;
    if (this.gone) throw new SessionGoneError();
  }

  addMonthly(key: string, seconds: number, cost: number): Promise<MonthTotals> {
    this.monthly.push({ key, seconds, cost });
    this.monthTotal += seconds;
    this.monthCost += cost;
    return Promise.resolve({ seconds: this.monthTotal, costMicroUsd: this.monthCost });
  }

  markEnded(_sessionId: string, reason: VoiceEndReason): Promise<void> {
    this.ended = reason;
    return Promise.resolve();
  }

  leaveLive(sessionId: string): Promise<void> {
    this.calls.push(`leaveLive:${sessionId}`);
    return Promise.resolve();
  }
}

/** One stream the fake model opened: the relay's input events as it sent them, and the output the spec writes. */
export class FakeModelStream {
  readonly received: Array<Record<string, unknown>> = [];
  readonly output = new InputQueue();
  inputEnded = false;
  error: Error | undefined;

  /** The model's stream fails with `error` (after what it already sent). */
  fail(error: Error): void {
    this.error = error;
    this.output.end();
  }

  /** One output event, `{event: {<name>: body}}`, as Nova Sonic sends it. */
  emit(name: string, body: Record<string, unknown>): void {
    this.output.push(new TextEncoder().encode(JSON.stringify({ event: { [name]: body } })));
  }

  /** The names of the input events received, in order (`event.<name>`). */
  names(): string[] {
    return this.received.map((one) => Object.keys(recordOf(one.event))[0] ?? '');
  }

  /** The bodies of the input events named `name`, in order. */
  bodies(name: string): Array<Record<string, unknown>> {
    return this.received.map((one) => recordOf(recordOf(one.event)[name])).filter((body) => Object.keys(body).length > 0);
  }
}

function recordOf(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null ? Object.fromEntries(Object.entries(value)) : {};
}

function eventsOf(bytes: Uint8Array): Record<string, unknown> {
  const parsed: unknown = JSON.parse(new TextDecoder().decode(bytes));
  return recordOf(parsed);
}

export class FakeTransport implements SonicTransport {
  readonly streams: FakeModelStream[] = [];
  /** The error the next open fails with. */
  openError: Error | undefined;

  open(input: AsyncIterable<Uint8Array>): Promise<AsyncIterable<Uint8Array>> {
    if (this.openError !== undefined) return Promise.reject(this.openError);
    const stream = new FakeModelStream();
    this.streams.push(stream);
    void (async () => {
      for await (const bytes of input) stream.received.push(eventsOf(bytes));
      stream.inputEnded = true;
    })();
    return Promise.resolve((async function* output() {
      yield* stream.output;
      if (stream.error !== undefined) throw stream.error;
    })());
  }

  stream(index: number): FakeModelStream {
    const stream = this.streams[index];
    if (stream === undefined) throw new RangeError(`no stream ${index}`);
    return stream;
  }
}

export class FakeChannel implements ClientChannel {
  readonly messages: RelayMessage[] = [];
  readonly audioFrames: Buffer[] = [];
  closedWith: number | undefined;

  json(message: RelayMessage): void {
    this.messages.push(message);
  }

  audio(pcm: Buffer): void {
    this.audioFrames.push(pcm);
  }

  end(reason: VoiceEndReason, code: number): void {
    this.messages.push({ type: 'ended', reason });
    this.closedWith = code;
  }

  /** The messages of one type, in order. */
  of<T extends RelayMessage['type']>(type: T): Array<Extract<RelayMessage, { type: T }>> {
    return this.messages.filter((message): message is Extract<RelayMessage, { type: T }> => message.type === type);
  }
}

/** The projects API's session input (evidence.json), with `overrides`. */
export function sessionInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    version: 1,
    session_id: SESSION_ID,
    project_id: PROJECT_ID,
    project_name: 'Checkout redesign',
    persona: {
      persona_id: 'persona_1', name: 'Maria', tagline: 'Busy parent',
      goals_motivations: { primary_goal: 'Fast delivery' }, pain_points: { primary_frustration: 'Late parcels' },
    },
    evidence: [
      { feedback_id: 'fb1', text: 'My delivery took nine days.', verbatim: true, source_platform: 'app_store',
        category: 'delivery', sentiment_label: 'negative', date: '2026-11-01' },
      { feedback_id: 'fb2', text: 'Support was kind.', verbatim: true, source_platform: 'zendesk',
        category: 'support', sentiment_label: 'positive', date: '2026-11-02' },
    ],
    voice_id: 'tiffany',
    voice_gender: 'feminine',
    language: 'en',
    session_seconds: 900,
    monthly_seconds: 18_000,
    minutes_left: 250,
    usage_key: 'VOICEUSE#DEPLOYMENT#2026-11',
    session_cost_cap_microusd: 750_000,
    monthly_cost_cap_microusd: 15_000_000,
    ...overrides,
  };
}

/** A product interview's session input (evidence.json, 7.104.00), with `overrides`. */
export function productInput(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  const shared = Object.fromEntries(Object.entries(sessionInput()).filter(([key]) => key !== 'persona' && key !== 'evidence'));
  return {
    ...shared,
    kind: 'product_interview',
    questions: [{ field: 'product_name', question: '' }, { field: 'target_users', question: 'Who buys it first?' }],
    known: { one_liner: 'Track every parcel in one place.' },
    ...overrides,
  };
}
