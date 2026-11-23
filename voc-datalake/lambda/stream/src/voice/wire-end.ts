/**
 * How the relay ends a connection on the wire (7.71.02; docs/voice-personas.md → The relay): its `ended {reason}`
 * message, then its close code, in that order, and late enough that AgentCore's proxy forwards both.
 *
 * On the b- deployment (2026-11-23) a refusal sent within milliseconds of the upgrade never reached the browser: the
 * host's refusal of a second connection (written in the upgrade's own callback, right behind the 101) and the
 * activation's refusal of a used URL (one DynamoDB call later). AgentCore's proxy forwarded neither the `ended`
 * message nor the close frame, so `ws` waited its fixed 30 seconds for the close handshake and then destroyed the
 * socket, which the browser saw as 1006 (the second connection closed exactly 30 s after it opened). A first
 * connection's `ready`, sent a few hundred milliseconds or more after its upgrade, always arrived. So an end:
 *
 * 1. sends nothing before the connection is `settleMs` old (the proxy's side of the upgrade is complete by then);
 * 2. sends `ended` and waits for its send callback (the frame handed to the socket), at most `sentWaitMs`;
 * 3. closes with its code, and terminates the socket if the close handshake has not finished `closeWaitMs` later, so
 *    a proxy that lost the close frame holds the browser a few seconds, not `ws`'s 30.
 *
 * The relay's specs pin this order on a local socket; that AgentCore's proxy forwards a refusal so ordered is checked
 * on a live deployment (docs/voice-personas.md → What to check on a live deployment).
 */
import { WebSocket } from 'ws';

import type { Clock } from './voice-session.js';

/** The waits of an end on the wire, in milliseconds. */
export interface EndWaits {
  readonly settleMs: number;
  readonly sentWaitMs: number;
  readonly closeWaitMs: number;
}

export const END_WAITS: EndWaits = { settleMs: 1000, sentWaitMs: 1000, closeWaitMs: 5000 };

/** The side of a `ws` WebSocket an end needs. */
export interface EndingSocket {
  readonly readyState: number;
  send(data: string, callback: (error?: Error) => void): void;
  close(code: number): void;
  terminate(): void;
}

/** Close `socket` with `code` once `message` was handed to it (or `sentWaitMs` passed); terminate it when the close
 *  handshake has not finished `closeWaitMs` after that. */
function closeAfterSending(socket: EndingSocket, message: string, code: number, waits: EndWaits, clock: Clock): void {
  const state = { closed: false, cancel: (): void => undefined };
  const close = (): void => {
    if (state.closed) return;
    state.closed = true;
    state.cancel();
    socket.close(code);
    clock.after(waits.closeWaitMs, () => {
      if (socket.readyState !== WebSocket.CLOSED) socket.terminate();
    });
  };
  state.cancel = clock.after(waits.sentWaitMs, close);
  socket.send(message, close);
}

/** End a connection opened at `openedAt` (the clock's time): `message` (its `ended`), then `code`, as the module
 *  says. Nothing goes to a socket that is no longer open (the browser left). */
export function endConnection(socket: EndingSocket, openedAt: number, message: string, code: number,
  waits: EndWaits, clock: Clock): void {
  const send = (): void => {
    if (socket.readyState === WebSocket.OPEN) closeAfterSending(socket, message, code, waits, clock);
  };
  const early = openedAt + waits.settleMs - clock.now();
  if (early > 0) clock.after(early, send);
  else send();
}
