/**
 * Wiring server-side session persistence into one assistant run.
 *
 * `createSessionEmitter` wraps the SSE emitter for the WHOLE run (so the
 * RUN_ERROR of a failed run is recorded too). Until a recorder is attached
 * events pass straight through; once attached, every event is also folded into
 * the recorder. A terminal event (RUN_FINISHED / RUN_ERROR) is recorded FIRST,
 * so the revision of the final save is known, and the SPA is told it in a
 * CUSTOM `assistant.session` event just before the terminal event.
 *
 * `startRunSession` reads the stored conversation (bounded by LOAD_TIMEOUT_MS so
 * a slow table never delays the answer) and builds the recorder over the run's
 * thread. Every failure here disables persistence for the run; none reaches the
 * stream.
 */
import { EventType, type BaseEvent, type Message, type RunAgentInput } from '@ag-ui/core';
import { CUSTOM_EVENTS, type PageContext } from '../contract.js';
import { events, type Emitter } from '../runtime/emitter.js';
import { createSessionRecorder, type SessionRecorder } from './recorder.js';
import { isStorableThreadId } from './record.js';
import { createSessionWriter } from './writer.js';
import type { SessionStore, StoredSession } from './store.js';

const LOAD_TIMEOUT_MS = 1500;

export interface SessionPersistence {
  store: SessionStore;
  nowMs: () => number;
}

export interface SessionEmitter extends Emitter {
  /** Start recording; `settled` is the writer's settle promise, returned by {@link SessionEmitter.settled}. */
  attach(recorder: SessionRecorder, settled: () => Promise<void>): void;
  /** Every queued session write has landed or failed. Never rejects. */
  settled(): Promise<void>;
}

function isTerminal(event: BaseEvent): boolean {
  return event.type === EventType.RUN_FINISHED || event.type === EventType.RUN_ERROR;
}

export function createSessionEmitter(inner: Emitter): SessionEmitter {
  const state: { recorder: SessionRecorder | null; settled: () => Promise<void> } = {
    recorder: null,
    settled: () => Promise.resolve(),
  };
  return {
    emit(event) {
      const { recorder } = state;
      if (recorder === null) {
        inner.emit(event);
        return;
      }
      if (isTerminal(event)) {
        const revision = recorder.observe(event);
        if (revision !== null) inner.emit(events.custom(CUSTOM_EVENTS.session, { revision }));
        inner.emit(event);
        return;
      }
      inner.emit(event);
      recorder.observe(event);
    },
    attach(recorder, settled) {
      state.recorder = recorder;
      state.settled = settled;
    },
    settled: () => state.settled(),
  };
}

async function loadWithin(store: SessionStore, callerSub: string, threadId: string): Promise<StoredSession | null> {
  const timer: { id: ReturnType<typeof setTimeout> | undefined } = { id: undefined };
  const timeout = new Promise<null>((resolve) => {
    timer.id = setTimeout(() => resolve(null), LOAD_TIMEOUT_MS);
  });
  try {
    return await Promise.race([store.load(callerSub, threadId), timeout]);
  } catch (error) {
    console.warn(`Assistant session: could not read the stored conversation (${error instanceof Error ? error.name : 'UnknownError'}); saving without it`);
    return null;
  } finally {
    clearTimeout(timer.id);
  }
}

/**
 * The thread as it will be stored: the run's input messages, each replaced by
 * its stored copy when one exists (the stored copy keeps the sources /
 * navigation metadata the wire copy drops, and never holds attachment data).
 */
export function mergeHistory(wire: readonly Message[], stored: readonly Message[]): Message[] {
  const byId = new Map(stored.map((m) => [m.id, m]));
  return wire.map((m) => {
    const kept = byId.get(m.id);
    return kept?.role === m.role ? kept : m;
  });
}

export interface RunSessionInput {
  callerSub: string;
  input: RunAgentInput;
  page: PageContext;
}

/**
 * Start persisting this run: attach a recorder to `emitter` and queue the
 * first write (the user turn, status running). A no-op when persistence is off
 * or the thread id cannot name a stored conversation.
 */
export async function startRunSession(
  emitter: SessionEmitter,
  persistence: SessionPersistence | undefined,
  { callerSub, input, page }: RunSessionInput,
): Promise<void> {
  if (persistence === undefined) return;
  if (!isStorableThreadId(input.threadId)) {
    console.warn('Assistant session: thread id is not a storable conversation id; not saving this run');
    return;
  }
  const { store, nowMs } = persistence;
  const stored = await loadWithin(store, callerSub, input.threadId);
  const writer = createSessionWriter((item, revision) => store.put(callerSub, item, revision), nowMs);
  const recorder = createSessionRecorder({
    callerSub,
    threadId: input.threadId,
    runId: input.runId,
    page,
    history: mergeHistory(input.messages, stored?.messages ?? []),
    createdAt: stored?.createdAt ?? new Date(nowMs()).toISOString(),
  }, writer, nowMs);
  emitter.attach(recorder, () => writer.settled());
  recorder.flush();
}
