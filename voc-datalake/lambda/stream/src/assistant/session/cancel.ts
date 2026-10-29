/**
 * Stop, server side (5.35, E2E 5.34: Stop cleared the screen while the run went on spending
 * Bedrock, and a reload showed the full answer).
 *
 * The SPA's abort cannot reach this Lambda: API Gateway response streaming does not end the
 * invocation when the client goes away (and the handler keeps running so the session is saved
 * either way). So Stop ALSO calls `POST /chat/conversations/{id}/cancel {runId}`, which writes a
 * marker item (record.ts `cancelKey`), and this watch polls it while the run streams. When the
 * marker names this run, the watch aborts its signal: the Bedrock stream in flight is cancelled
 * (converse-stream.ts passes it to the SDK), no further model turn or tool round starts
 * (loop.ts), and the run ends with the CUSTOM `assistant.stopped` event, saved as `stopped`.
 *
 * One read every POLL_INTERVAL_MS at most, one in flight at a time; a failed read is logged
 * once and retried on the next tick (a run is never failed by its watch). The timer is
 * unref'd so it never holds the runtime open.
 */
import type { SessionPersistence } from './run-session.js';
import { isStorableThreadId } from './record.js';
import { errorName } from './writer.js';

const POLL_INTERVAL_MS = 1500;

export interface CancelWatch {
  /** Aborted once the user stopped this run. */
  signal: AbortSignal;
  /** End the polling (the run finished). Idempotent. */
  stop(): void;
}

export interface CancelTarget {
  callerSub: string;
  threadId: string;
  runId: string;
}

/** Poll `check` until it says stop (then abort) or `stop()` is called. */
export function createCancelWatch(check: () => Promise<boolean>, intervalMs: number = POLL_INTERVAL_MS): CancelWatch {
  const controller = new AbortController();
  const state = { inFlight: false, warned: false };
  async function poll(): Promise<void> {
    if (state.inFlight || controller.signal.aborted) return;
    state.inFlight = true;
    try {
      if (await check()) {
        console.log(JSON.stringify({ event: 'assistant_run_stopped' }));
        controller.abort();
        clearInterval(timer);
      }
    } catch (error) {
      if (!state.warned) console.warn(`Assistant stop check failed: ${errorName(error)}; retrying`);
      state.warned = true;
    } finally {
      state.inFlight = false;
    }
  }
  const timer = setInterval(() => {
    void poll();
  }, intervalMs);
  timer.unref();
  return { signal: controller.signal, stop: () => clearInterval(timer) };
}

/** A watch for this run, or undefined when sessions are off or the thread cannot be stored. */
export function watchForStop(persistence: SessionPersistence | undefined, target: CancelTarget): CancelWatch | undefined {
  if (persistence === undefined || !isStorableThreadId(target.threadId)) return undefined;
  const { store, stopPollMs } = persistence;
  return createCancelWatch(() => store.cancelRequested(target.callerSub, target.threadId, target.runId), stopPollMs);
}
