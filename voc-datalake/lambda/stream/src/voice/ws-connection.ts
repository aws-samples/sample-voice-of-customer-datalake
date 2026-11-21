/**
 * One server-side WebSocket over an upgraded socket (ws-frames.ts for the framing): whole messages up, frames down.
 *
 * - A message (one frame, or a first frame and its continuations) is at most `maxMessage` bytes: past it, or on a
 *   frame the parser refuses, the connection closes with the parser's code (1009 too big, 1002 protocol).
 * - Ping is answered with pong; a close is answered with a close and the socket ends; a send after close is dropped.
 * - `onClose` runs once, however the connection ended (the peer's close, a refused frame, the socket's end or error).
 */
import type { Duplex } from 'node:stream';

import { closePayload, encodeFrame, FrameError, FrameParser, OPCODE, type Frame } from './ws-frames.js';

export interface ConnectionHandlers {
  onText(text: string): void;
  onBinary(data: Buffer): void;
  onClose(): void;
}

/** Normal closure (RFC 6455 7.4.1), and the protocol-error code for an unknown opcode. */
const CLOSE_NORMAL = 1000;
const CLOSE_PROTOCOL = 1002;

export class WsConnection {
  private readonly parser: FrameParser;
  private fragments: Buffer[] = [];
  private fragmentOpcode = 0;
  private closed = false;
  private handlers: ConnectionHandlers | undefined;

  constructor(private readonly socket: Duplex, private readonly maxMessage: number) {
    this.parser = new FrameParser(maxMessage);
    socket.on('data', (chunk: Buffer) => { this.receive(chunk); });
    // http.Server keeps its sockets half-open: the peer's FIN without a close frame (AgentCore's proxy dropping the
    // connection) must end ours too, or the socket lingers.
    socket.on('end', () => {
      socket.end();
      this.finish();
    });
    socket.on('close', () => { this.finish(); });
    socket.on('error', () => { this.finish(); });
  }

  /** Where messages go; bytes that arrived before (the upgrade's head) are delivered once it is set. */
  attach(handlers: ConnectionHandlers, head: Buffer): void {
    this.handlers = handlers;
    if (head.length > 0) this.receive(head);
  }

  sendText(text: string): void {
    this.write(OPCODE.text, Buffer.from(text));
  }

  sendBinary(data: Buffer): void {
    this.write(OPCODE.binary, data);
  }

  /** Send a close frame and end the socket (a second close does nothing). */
  close(code: number, reason = ''): void {
    if (this.closed) return;
    this.write(OPCODE.close, closePayload(code, reason));
    this.socket.end();
    this.finish();
  }

  private write(opcode: number, payload: Buffer): void {
    if (!this.closed && this.socket.writable) this.socket.write(encodeFrame(opcode, payload));
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    try {
      for (const frame of this.parser.push(chunk)) this.frame(frame);
    } catch (error) {
      this.close(error instanceof FrameError ? error.closeCode : CLOSE_PROTOCOL, 'refused frame');
    }
  }

  private frame(frame: Frame): void {
    switch (frame.opcode) {
      case OPCODE.ping:
        this.write(OPCODE.pong, frame.payload);
        return;
      case OPCODE.pong:
        return;
      case OPCODE.close:
        this.close(frame.payload.length >= 2 ? frame.payload.readUInt16BE(0) : CLOSE_NORMAL);
        return;
      case OPCODE.text:
      case OPCODE.binary:
      case OPCODE.continuation:
        this.data(frame);
        return;
      default:
        throw new FrameError(CLOSE_PROTOCOL, 'unknown opcode');
    }
  }

  /** A data frame: a whole message when final, else one more fragment (a continuation must follow a start). */
  private data(frame: Frame): void {
    const starts = frame.opcode !== OPCODE.continuation;
    if (starts === this.fragments.length > 0) throw new FrameError(CLOSE_PROTOCOL, 'bad fragmentation');
    if (starts) this.fragmentOpcode = frame.opcode;
    this.fragments = [...this.fragments, frame.payload];
    const size = this.fragments.reduce((total, part) => total + part.length, 0);
    if (size > this.maxMessage) throw new FrameError(1009, 'message too big');
    if (!frame.fin) return;
    const message = Buffer.concat(this.fragments);
    this.fragments = [];
    if (this.fragmentOpcode === OPCODE.text) this.handlers?.onText(message.toString('utf8'));
    else this.handlers?.onBinary(message);
  }

  private finish(): void {
    if (this.closed) {
      return;
    }
    this.closed = true;
    this.handlers?.onClose();
  }
}
