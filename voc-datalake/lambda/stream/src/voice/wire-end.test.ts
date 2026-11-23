import { describe, expect, it } from 'vitest';

import { WebSocket } from 'ws';

import { ManualClock } from './voice-fixtures.js';
import { END_WAITS, endConnection, type EndingSocket } from './wire-end.js';

const ENDED = '{"type":"ended","reason":"refused"}';

/** A socket that records what the end did, in order; its send callback runs when the spec says the frame went. */
class RecordingSocket implements EndingSocket {
  readyState: number = WebSocket.OPEN;
  readonly did: string[] = [];
  private sent: (() => void) | undefined;

  send(data: string, callback: (error?: Error) => void): void {
    this.did.push(`send ${data}`);
    this.sent = () => { callback(); };
  }

  close(code: number): void {
    this.did.push(`close ${code}`);
    this.readyState = WebSocket.CLOSING;
  }

  terminate(): void {
    this.did.push('terminate');
    this.readyState = WebSocket.CLOSED;
  }

  /** The socket wrote the frame: its send callback. */
  written(): void {
    this.sent?.();
  }
}

function ending(openedAgoMs = 0) {
  const clock = new ManualClock();
  const socket = new RecordingSocket();
  endConnection(socket, clock.now() - openedAgoMs, ENDED, 1008, END_WAITS, clock);
  return { clock, socket };
}

describe('endConnection (L3, 7.71.02)', () => {
  it('sends nothing before the connection is a second old, then ended, then the close once the frame is written', () => {
    const { clock, socket } = ending();
    clock.advance(END_WAITS.settleMs - 1);
    expect(socket.did).toStrictEqual([]);
    clock.advance(1);
    expect(socket.did).toStrictEqual([`send ${ENDED}`]);
    socket.written();
    expect(socket.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
    clock.advance(END_WAITS.sentWaitMs);
    expect(socket.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
  });

  it('closes after a bounded wait when the send never answers, and only once', () => {
    const { clock, socket } = ending(END_WAITS.settleMs);
    expect(socket.did).toStrictEqual([`send ${ENDED}`]);
    clock.advance(END_WAITS.sentWaitMs);
    socket.written();
    expect(socket.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
  });

  it('terminates a socket whose close handshake has not finished a few seconds after its close', () => {
    const { clock, socket } = ending(END_WAITS.settleMs);
    socket.written();
    clock.advance(END_WAITS.closeWaitMs - 1);
    expect(socket.did.at(-1)).toBe('close 1008');
    clock.advance(1);
    expect(socket.did.at(-1)).toBe('terminate');
  });

  it('leaves a socket whose close handshake finished, and sends nothing to one the browser already left', () => {
    const closed = ending(END_WAITS.settleMs);
    closed.socket.written();
    closed.socket.readyState = WebSocket.CLOSED;
    closed.clock.advance(END_WAITS.closeWaitMs);
    expect(closed.socket.did).toStrictEqual([`send ${ENDED}`, 'close 1008']);
    const clock = new ManualClock();
    const left = new RecordingSocket();
    left.readyState = WebSocket.CLOSED;
    endConnection(left, clock.now(), ENDED, 1008, END_WAITS, clock);
    clock.advance(END_WAITS.settleMs + END_WAITS.closeWaitMs);
    expect(left.did).toStrictEqual([]);
  });
});
