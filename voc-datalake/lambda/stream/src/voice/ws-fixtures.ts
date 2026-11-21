/**
 * A raw WebSocket client for the relay server's specs: the handshake over `http.request`, masked frames up, and the
 * server's (unmasked) frames read back, so the specs pin the wire format itself rather than a library's view of it.
 */
import { randomBytes } from 'node:crypto';
import { request } from 'node:http';
import type { Server } from 'node:http';
import type { Socket } from 'node:net';

/** A client frame: masked with a random key, its length in the shortest form. */
export function maskedFrame(opcode: number, payload: Buffer, fin = true): Buffer {
  const mask = randomBytes(4);
  const masked = Buffer.from(payload.map((byte, index) => byte ^ mask.readUInt8(index % 4)));
  const first = (fin ? 0x80 : 0) | opcode;
  const length = payload.length;
  const head = length < 126 ? Buffer.from([first, 0x80 | length])
    : Buffer.concat([Buffer.from([first, 0x80 | 126]), Buffer.from([length >> 8, length & 0xff])]);
  return Buffer.concat([head, mask, masked]);
}

export interface ServerFrame {
  opcode: number;
  payload: Buffer;
}

/** The server's frames in `bytes` (unmasked, short or 16-bit lengths: what the specs send back). */
export function serverFrames(bytes: Buffer): ServerFrame[] {
  if (bytes.length < 2) return [];
  const marker = bytes.readUInt8(1) & 0x7f;
  const offset = marker === 126 ? 4 : 2;
  const length = marker === 126 ? bytes.readUInt16BE(2) : marker;
  const frame = { opcode: bytes.readUInt8(0) & 0x0f, payload: bytes.subarray(offset, offset + length) };
  return [frame, ...serverFrames(bytes.subarray(offset + length))];
}

export interface Client {
  socket: Socket;
  status: number;
  /** Every byte the server sent after the handshake. */
  received(): Buffer;
}

/** Open `/ws` (or `path`) with AgentCore's headers; resolves after the 101, or with the refusal's status. */
export function connect(server: Server, headers: Record<string, string>, path = '/ws'): Promise<Client> {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return new Promise((resolve, reject) => {
    const outgoing = request({
      port, host: '127.0.0.1', path,
      headers: {
        Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': randomBytes(16).toString('base64'), ...headers,
      },
    });
    outgoing.on('upgrade', (response, socket) => {
      const chunks: Buffer[] = [];
      socket.on('data', (chunk: Buffer) => { chunks.push(chunk); });
      resolve({ socket, status: response.statusCode ?? 0, received: () => Buffer.concat(chunks) });
    });
    outgoing.on('response', (response) => {
      response.resume();
      resolve({ socket: response.socket, status: response.statusCode ?? 0, received: () => Buffer.alloc(0) });
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Listen on a free local port. */
export function listening(server: Server): Promise<Server> {
  return new Promise((resolve) => { server.listen(0, '127.0.0.1', () => { resolve(server); }); });
}

/** Resolves once `server` listens (at once when it already does). */
export function whenListening(server: Server): Promise<void> {
  if (server.listening) return Promise.resolve();
  return new Promise((resolve) => { server.once('listening', () => { resolve(); }); });
}

export function closed(server: Server): Promise<void> {
  return new Promise((resolve) => { server.close(() => { resolve(); }); });
}
