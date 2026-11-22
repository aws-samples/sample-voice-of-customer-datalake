/**
 * A real `ws` client for the relay server's specs: it connects as AgentCore's proxy does (its headers on `/ws`), and
 * records every message, the pongs, the close code and any error the client saw (an invalid frame or close code from
 * the relay is one), so the specs pin what reaches the wire.
 */
import { request, type Server } from 'node:http';

import { afterEach } from 'vitest';

import { WebSocket, type RawData } from 'ws';

export interface Client {
  socket: WebSocket;
  /** The text messages, parsed as JSON. */
  readonly texts: unknown[];
  /** The binary messages' lengths. */
  readonly binaries: number[];
  readonly pongs: Buffer[];
  readonly errors: string[];
  /** The close code, once the connection closed. */
  readonly closed: Promise<number>;
}

function parsed(text: string): unknown {
  const value: unknown = JSON.parse(text);
  return value;
}

function portOf(server: Server): number {
  const address = server.address();
  return typeof address === 'object' && address !== null ? address.port : 0;
}

/** Open `path` on `server` with AgentCore's headers; resolves once open (rejects on a refused handshake). */
export function connect(server: Server, headers: Record<string, string>, path = '/ws'): Promise<Client> {
  const socket = new WebSocket(`ws://127.0.0.1:${portOf(server)}${path}`, { headers });
  const client: Omit<Client, 'closed'> = { socket, texts: [], binaries: [], pongs: [], errors: [] };
  socket.on('message', (data: RawData, isBinary: boolean) => {
    // The default binaryType delivers each message as one Buffer.
    if (!Buffer.isBuffer(data)) return;
    if (isBinary) client.binaries.push(data.length);
    else client.texts.push(parsed(data.toString('utf8')));
  });
  socket.on('pong', (data: Buffer) => { client.pongs.push(data); });
  const closed = new Promise<number>((resolve) => { socket.on('close', (code: number) => { resolve(code); }); });
  return new Promise((resolve, reject) => {
    socket.on('error', (error: Error) => {
      client.errors.push(error.message);
      reject(error);
    });
    socket.on('open', () => { resolve({ ...client, closed }); });
  });
}

/** The status an upgrade request with only `headers` gets: 101 when accepted, else the refusal's (a handshake no
 *  WebSocket client would send, so it goes over plain HTTP). */
export function upgradeStatus(server: Server, headers: Record<string, string>, path = '/ws'): Promise<number> {
  return new Promise((resolve, reject) => {
    const outgoing = request({ port: portOf(server), host: '127.0.0.1', path, headers: { Connection: 'Upgrade', ...headers } });
    outgoing.on('upgrade', (response, socket) => {
      socket.destroy();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on('response', (response) => {
      response.resume();
      resolve(response.statusCode ?? 0);
    });
    outgoing.on('error', reject);
    outgoing.end();
  });
}

/** Resolves once `ready()` holds, checking as I/O runs (rejects after `ms`). */
export async function until(ready: () => boolean, ms = 2000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!ready()) {
    if (Date.now() > deadline) throw new RangeError(`still waiting after ${ms} ms`);
    await new Promise((resolve) => { setTimeout(resolve, 2); });
  }
}

/** A request's status and JSON body (or null without one). */
export async function httpJson(server: Server, method: string, path: string): Promise<{ status: number; body: unknown }> {
  const response = await fetch(`http://127.0.0.1:${portOf(server)}${path}`, { method });
  const text = await response.text();
  return { status: response.status, body: text === '' ? null : parsed(text) };
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

/** What a spec opens, closed after each of its tests (the clients first: a server's close waits for its sockets). */
export function closedAfterEach(): { servers: Server[]; clients: Client[] } {
  const opened: { servers: Server[]; clients: Client[] } = { servers: [], clients: [] };
  afterEach(async () => {
    for (const client of opened.clients.splice(0)) client.socket.terminate();
    await Promise.all(opened.servers.splice(0).map(closed));
  });
  return opened;
}

/** Close `server`, ending the connections it still holds. */
export function closed(server: Server): Promise<void> {
  return new Promise((resolve) => {
    server.close(() => { resolve(); });
    server.closeAllConnections();
  });
}
