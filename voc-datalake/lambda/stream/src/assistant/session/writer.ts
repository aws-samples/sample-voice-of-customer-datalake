/**
 * Ordered, coalescing, fire-and-forget writes of one run's session item.
 *
 * - `enqueue` never blocks and never throws: the stream keeps going whatever
 *   DynamoDB does.
 * - At most ONE write is in flight per run; a snapshot enqueued meanwhile
 *   replaces any older pending one (each snapshot is the whole conversation,
 *   so only the newest matters), and is written after the in-flight one, so
 *   writes land in order and the last enqueued is the last written.
 * - Revisions increase strictly within a run and are time-based across runs,
 *   so a newer run always outranks an older one. The put is conditional on the
 *   stored revision being older; a refusal means a newer writer owns the item
 *   (another run of this thread), so this run stops writing.
 * - A failed write is logged with an EMF metric and does not stop later writes.
 */

/** A put landed, or was refused because the stored revision is newer. Failures throw. */
export type PutOutcome = 'written' | 'superseded';

export type SessionPut = (item: Record<string, unknown>, revision: number) => Promise<PutOutcome>;

export interface SessionWriter {
  /** Queue a snapshot built for `revision`; the returned revision is the one it will carry. */
  enqueue(build: (revision: number) => Record<string, unknown> | null): number;
  /** Resolves once every queued write has landed or failed. Never rejects. */
  settled(): Promise<void>;
}

const METRIC_NAMESPACE = 'VoC';
export const SESSION_WRITE_FAILED_METRIC = 'AssistantSessionWriteFailed';

function recordWriteFailure(reason: string): void {
  console.log(JSON.stringify({
    _aws: {
      Timestamp: Date.now(),
      CloudWatchMetrics: [{
        Namespace: METRIC_NAMESPACE,
        Dimensions: [['Reason']],
        Metrics: [{ Name: SESSION_WRITE_FAILED_METRIC, Unit: 'Count' }],
      }],
    },
    Reason: reason,
    [SESSION_WRITE_FAILED_METRIC]: 1,
  }));
}

interface WriterState {
  lastRevision: number;
  pending: Record<string, unknown> | null;
  pendingRevision: number;
  chain: Promise<void>;
  draining: boolean;
  superseded: boolean;
}

function errorName(error: unknown): string {
  return error instanceof Error && error.name ? error.name : 'UnknownError';
}

export function createSessionWriter(put: SessionPut, nowMs: () => number): SessionWriter {
  const state: WriterState = {
    lastRevision: 0, pending: null, pendingRevision: 0, chain: Promise.resolve(), draining: false, superseded: false,
  };

  async function writeOne(item: Record<string, unknown>, revision: number): Promise<void> {
    try {
      if (await put(item, revision) === 'superseded') {
        state.superseded = true;
        console.warn('Assistant session: a newer revision owns this conversation; this run stops saving it');
      }
    } catch (error) {
      const name = errorName(error);
      console.error(`Assistant session write failed: ${name}`);
      recordWriteFailure(name);
    }
  }

  async function drain(): Promise<void> {
    while (state.pending !== null && !state.superseded) {
      const item = state.pending;
      const revision = state.pendingRevision;
      state.pending = null;
      await writeOne(item, revision);
    }
    state.draining = false;
  }

  function schedule(build: (revision: number) => Record<string, unknown> | null, revision: number): void {
    if (state.superseded) return;
    const item = buildSafely(build, revision);
    if (item === null) return;
    state.pending = item;
    state.pendingRevision = revision;
    if (!state.draining) {
      state.draining = true;
      state.chain = state.chain.then(drain);
    }
  }

  return {
    enqueue(build) {
      const revision = Math.max(state.lastRevision + 1, nowMs());
      state.lastRevision = revision;
      schedule(build, revision);
      return revision;
    },
    settled: () => state.chain,
  };
}

/** A snapshot that cannot be built (too large, or a bug) is skipped, never thrown into the stream. */
function buildSafely(
  build: (revision: number) => Record<string, unknown> | null,
  revision: number,
): Record<string, unknown> | null {
  try {
    const item = build(revision);
    if (item === null) {
      console.warn('Assistant session: snapshot exceeds the item cap even after trimming; not saved');
      recordWriteFailure('TooLarge');
    }
    return item;
  } catch (error) {
    const name = errorName(error);
    console.error(`Assistant session snapshot failed: ${name}`);
    recordWriteFailure(name);
    return null;
  }
}
