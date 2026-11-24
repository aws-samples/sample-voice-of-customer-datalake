import { describe, expect, it } from 'vitest';

import { WebSocket } from 'ws';

import { ManualClock } from './voice-fixtures.js';
import { END_SETTLE_MS, endConnection, type EndingSocket } from './wire-end.js';

const ENDED = '{"type":"ended","reason":"refused"}';

/** A socket that records what the end did, in order. */
class RecordingSocket implements EndingSocket {
  readyState: number = WebSocket.OPEN;
  readonly did: string[] = [];

  send(data: string): void {
    this.did.push(`send ${data}`);
  }

  close(code: number): void {
    this.did.push(`close ${code}`);
    this.readyState = WebSocket.CLOSING;
  }
}

describe('endConnection (L3, 7.71.02)', () => {
  it('sends nothing before the connection is a second old, then ended, then the close', () => {
    const clock = new ManualClock();
    const socket = new RecordingSocket();
    endConnection(socket, clock.now(), ENDED, 1008, END_SETTLE_MS, clock);
    clock.advance(END_SETTLE_MS - 1);
    expect(socket.did).toStrictEqual([]);
    clock.advance(1);
    expect(socket.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
  });

  it('ends a connection already a second old at once, and sends nothing to one the browser already left', () => {
    const clock = new ManualClock();
    const old = new RecordingSocket();
    endConnection(old, clock.now() - END_SETTLE_MS, ENDED, 1008, END_SETTLE_MS, clock);
    expect(old.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
    const left = new RecordingSocket();
    left.readyState = WebSocket.CLOSED;
    endConnection(left, clock.now(), ENDED, 1008, END_SETTLE_MS, clock);
    clock.advance(END_SETTLE_MS);
    expect(left.did).toStrictEqual([]);
  });
});
