/**
 * The RFC 6455 framing the relay's WebSocket needs, server side, with no dependency (the stream package has no `ws`,
 * and adding one needs the owner's yes: docs/dependencies.md). AgentCore Runtime proxies the browser's WebSocket to
 * the container's `/ws` (S-15 findings, section 3), so the peer is AgentCore's proxy, which masks its frames as every
 * client must.
 *
 * - Every client frame must be masked (RFC 6455 5.1) and carry no extension bits (none is negotiated).
 * - A frame whose payload is over `maxPayload` is refused before it is buffered (AgentCore's 32 KB frame limit,
 *   protocol.ts `MAX_VOICE_FRAME_BYTES`): the connection closes with 1009.
 * - Control frames (close, ping, pong) are at most 125 bytes and never fragmented.
 * - Server frames are never masked.
 */
import { hash } from 'node:crypto';

/** RFC 6455's key-accept GUID (section 1.3). */
const ACCEPT_GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

export const OPCODE = { continuation: 0, text: 1, binary: 2, close: 8, ping: 9, pong: 10 } as const;

const FIN = 0x80;
const MASKED = 0x80;
const RESERVED_BITS = 0x70;
const OPCODE_BITS = 0x0f;
const LENGTH_BITS = 0x7f;
const LENGTH_16 = 126;
const LENGTH_64 = 127;
const MASK_BYTES = 4;
const MAX_CONTROL_PAYLOAD = 125;

export interface Frame {
  readonly fin: boolean;
  readonly opcode: number;
  readonly payload: Buffer;
}

/** Why a peer's frames cannot be read: the close code says which (1002 protocol error, 1009 too big). */
export class FrameError extends Error {
  constructor(readonly closeCode: number, reason: string) {
    super(reason);
    this.name = 'FrameError';
  }
}

/**
 * The `Sec-WebSocket-Accept` answer to a client's `Sec-WebSocket-Key`. RFC 6455 4.2.2 fixes the digest as SHA-1 of the
 * key and the GUID: it only proves the server read the handshake, it authenticates nothing (AgentCore's SigV4 does).
 */
export function acceptKey(key: string): string {
  return hash('sha1', `${key}${ACCEPT_GUID}`, 'base64');
}

interface Header {
  readonly fin: boolean;
  readonly opcode: number;
  readonly offset: number;
  readonly length: number;
}

function payloadLength(buffer: Buffer, marker: number, maxPayload: number): { length: number; offset: number } | undefined {
  if (marker < LENGTH_16) return { length: marker, offset: 2 };
  const extended = marker === LENGTH_16 ? 2 : 8;
  if (buffer.length < 2 + extended) return undefined;
  const big = marker === LENGTH_16 ? BigInt(buffer.readUInt16BE(2)) : buffer.readBigUInt64BE(2);
  if (big > BigInt(maxPayload)) throw new FrameError(1009, 'frame too big');
  return { length: Number(big), offset: 2 + extended };
}

function readHeader(buffer: Buffer, maxPayload: number): Header | undefined {
  if (buffer.length < 2) return undefined;
  const first = buffer.readUInt8(0);
  const second = buffer.readUInt8(1);
  if ((first & RESERVED_BITS) !== 0) throw new FrameError(1002, 'reserved bits set');
  if ((second & MASKED) === 0) throw new FrameError(1002, 'client frame not masked');
  const opcode = first & OPCODE_BITS;
  const fin = (first & FIN) !== 0;
  const sized = payloadLength(buffer, second & LENGTH_BITS, maxPayload);
  if (sized === undefined) return undefined;
  if (sized.length > maxPayload) throw new FrameError(1009, 'frame too big');
  if (opcode >= OPCODE.close && (!fin || sized.length > MAX_CONTROL_PAYLOAD)) {
    throw new FrameError(1002, 'bad control frame');
  }
  return { fin, opcode, offset: sized.offset, length: sized.length };
}

/** One whole frame at the start of `buffer` and what follows it, or undefined while it is incomplete. */
function readFrame(buffer: Buffer, maxPayload: number): { frame: Frame; rest: Buffer } | undefined {
  const header = readHeader(buffer, maxPayload);
  if (header === undefined) return undefined;
  const start = header.offset + MASK_BYTES;
  const end = start + header.length;
  if (buffer.length < end) return undefined;
  const mask = buffer.subarray(header.offset, start);
  const payload = Buffer.from(buffer.subarray(start, end).map((byte, index) => byte ^ mask.readUInt8(index % MASK_BYTES)));
  return { frame: { fin: header.fin, opcode: header.opcode, payload }, rest: buffer.subarray(end) };
}

/** Client frames from the bytes as they arrive (a frame may span chunks, a chunk may hold several frames). */
export class FrameParser {
  private buffer: Buffer = Buffer.alloc(0);

  constructor(private readonly maxPayload: number) {}

  /** The frames `chunk` completes; throws FrameError on a frame that breaks the rules above. */
  push(chunk: Buffer): Frame[] {
    this.buffer = this.buffer.length === 0 ? chunk : Buffer.concat([this.buffer, chunk]);
    return this.drain([]);
  }

  private drain(frames: Frame[]): Frame[] {
    const read = readFrame(this.buffer, this.maxPayload);
    if (read === undefined) return frames;
    this.buffer = read.rest;
    return this.drain([...frames, read.frame]);
  }
}

/** A server frame (never masked, always final). */
export function encodeFrame(opcode: number, payload: Buffer): Buffer {
  const length = payload.length;
  if (length < LENGTH_16) return Buffer.concat([Buffer.from([FIN | opcode, length]), payload]);
  if (length <= 0xffff) {
    const header = Buffer.alloc(4);
    header.writeUInt8(FIN | opcode, 0);
    header.writeUInt8(LENGTH_16, 1);
    header.writeUInt16BE(length, 2);
    return Buffer.concat([header, payload]);
  }
  const header = Buffer.alloc(10);
  header.writeUInt8(FIN | opcode, 0);
  header.writeUInt8(LENGTH_64, 1);
  header.writeBigUInt64BE(BigInt(length), 2);
  return Buffer.concat([header, payload]);
}

/** A close frame's payload: the code, then the reason (at most 123 bytes of it). */
export function closePayload(code: number, reason = ''): Buffer {
  const head = Buffer.alloc(2);
  head.writeUInt16BE(code, 0);
  return Buffer.concat([head, Buffer.from(reason).subarray(0, MAX_CONTROL_PAYLOAD - 2)]);
}
