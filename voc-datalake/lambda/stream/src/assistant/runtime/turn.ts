/**
 * Stream one Bedrock turn and translate its live deltas into AG-UI events.
 *
 *   reasoning deltas → REASONING_START / REASONING_MESSAGE_START /
 *                      REASONING_MESSAGE_CONTENT* / REASONING_MESSAGE_END / REASONING_END
 *   text deltas      → TEXT_MESSAGE_START / TEXT_MESSAGE_CONTENT* (… END at turn end)
 *
 * Tool calls are NOT emitted here: their arguments must be validated (client
 * tools) before they reach the SPA, so the loop emits them after the turn.
 */
import { randomUUID } from 'node:crypto';
import type { ConverseStreamOutput } from '@aws-sdk/client-bedrock-runtime';
import {
  createTurnState,
  finishTurn,
  processStreamEvent,
  type TurnSink,
  type TurnState,
} from '../../bedrock/stream-processor.js';
import { events, type Emitter } from './emitter.js';

export interface TurnIds {
  /** The assistant message id for this turn (TEXT_MESSAGE + parentMessageId). */
  messageId: string;
}

interface LiveState {
  textOpen: boolean;
  reasoningId: string | null;
}

function createSink(emitter: Emitter, ids: TurnIds) {
  const live: LiveState = { textOpen: false, reasoningId: null };
  const closeReasoning = () => {
    if (live.reasoningId === null) return;
    emitter.emit(events.reasoningMessageEnd(live.reasoningId));
    emitter.emit(events.reasoningEnd(live.reasoningId));
    live.reasoningId = null;
  };
  const sink: TurnSink = {
    onReasoning(delta) {
      if (live.reasoningId === null) {
        live.reasoningId = randomUUID();
        emitter.emit(events.reasoningStart(live.reasoningId));
        emitter.emit(events.reasoningMessageStart(live.reasoningId));
      }
      emitter.emit(events.reasoningContent(live.reasoningId, delta));
    },
    onText(delta) {
      closeReasoning();
      if (!live.textOpen) {
        live.textOpen = true;
        emitter.emit(events.textStart(ids.messageId));
      }
      emitter.emit(events.textContent(ids.messageId, delta));
    },
    onBlockStop(kind) {
      if (kind === 'reasoning') closeReasoning();
    },
  };
  const close = () => {
    closeReasoning();
    if (live.textOpen) emitter.emit(events.textEnd(ids.messageId));
    live.textOpen = false;
  };
  return { sink, close };
}

/** Consume one Bedrock stream; always leaves no AG-UI message open. */
export async function streamTurn(
  stream: AsyncIterable<ConverseStreamOutput>,
  emitter: Emitter,
  ids: TurnIds,
): Promise<TurnState> {
  const state = createTurnState();
  const { sink, close } = createSink(emitter, ids);
  try {
    for await (const event of stream) {
      processStreamEvent(event, state, sink);
    }
    finishTurn(state, sink);
  } finally {
    close();
  }
  return state;
}
