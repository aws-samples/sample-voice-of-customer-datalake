/**
 * How the relay ends a connection on the wire (7.71.02; docs/voice-personas.md → The relay): its `ended {reason}`
 * message, then its close code, in that order, and late enough that AgentCore's proxy forwards both.
 *
 * On the b- deployment (2026-11-23) a refusal sent within milliseconds of the upgrade never reached the browser: the
 * host's refusal of a second connection (written in the upgrade's own callback, right behind the 101) and the
 * activation's refusal of a used URL (one DynamoDB call later). AgentCore's proxy forwarded neither the `ended`
 * message nor the close frame, so `ws` waited its default 30 seconds for the close handshake and then destroyed the
 * socket, which the browser saw as 1006 (the second connection closed exactly 30 s after it opened). A first
 * connection's `ready`, sent a few hundred milliseconds or more after its upgrade, always arrived. So an end sends
 * nothing before the connection is `END_SETTLE_MS` old (the proxy's side of the upgrade is complete by then), then
 * `ended` and the close. `ws` writes the two frames in that order, and destroys a socket whose close handshake has not
 * finished five seconds after the close (server.ts passes it `closeTimeout`), so a proxy that lost the close frame
 * holds the browser a few seconds, not 30.
 *
 * The relay's specs pin this order on a local socket; that AgentCore's proxy forwards a refusal so ordered is checked
 * on a live deployment (docs/voice-personas.md → What to check on a live deployment).
 */
import { WebSocket } from 'ws';

import type { Clock } from './voice-session.js';

/** How old a connection is before anything of its end goes on the wire, in milliseconds. */
export const END_SETTLE_MS = 1000;

/** The side of a `ws` WebSocket an end needs. */
export interface EndingSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code: number): void;
}

/** End a connection opened at `openedAt` (the clock's time) once it is `settleMs` old: `message` (its `ended`), then
 *  `code`. Nothing goes to a socket that is no longer open (the browser left). */
export function endConnection(socket: EndingSocket, openedAt: number, message: string, code: number,
  settleMs: number, clock: Clock): void {
  const send = (): void => {
    if (socket.readyState !== WebSocket.OPEN) return;
    socket.send(message);
    socket.close(code);
  };
  const early = openedAt + settleMs - clock.now();
  if (early > 0) clock.after(early, send);
  else send();
}
