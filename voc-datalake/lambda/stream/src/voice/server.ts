/**
 * The relay's HTTP server, the contract AgentCore Runtime holds a container to (S-15 findings, section 3): port 8080,
 * `GET /ping` for health, and the WebSocket on `/ws`, which AgentCore's endpoint proxies the browser's connection to
 * after checking its SigV4-presigned URL.
 *
 * - `/ping` answers `Healthy`, or `HealthyBusy` while a conversation is live, so AgentCore does not count a session
 *   that is talking as idle (its idle timer also resets on every frame).
 * - The upgrade needs `Upgrade: websocket`, version 13 and a key; anything else on `/ws`, or any other path, is a 400
 *   or a 404 and the socket is dropped. The session id and the scope arrive as AgentCore's headers (signed in the URL
 *   the projects API minted, so the browser cannot change them): the host decides what to do with the connection.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { Duplex } from 'node:stream';

import { MAX_VOICE_FRAME_BYTES } from './protocol.js';
import { WsConnection } from './ws-connection.js';
import { acceptKey } from './ws-frames.js';

/** AgentCore's headers as the container receives them (lower-cased by Node). */
export const SESSION_HEADER = 'x-amzn-bedrock-agentcore-runtime-session-id';
export const SCOPE_HEADER = 'x-amzn-bedrock-agentcore-runtime-custom-voc-scope';

export interface ConnectionIds {
  sessionId: string;
  scope: string;
}

export interface RelayHost {
  /** Whether a conversation is live in this microVM (`/ping` says HealthyBusy). */
  busy(): boolean;
  /** A new WebSocket on `/ws`, with AgentCore's headers. */
  connect(connection: WsConnection, ids: ConnectionIds, head: Buffer): void;
}

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? '';
}

function refuse(socket: Duplex, status: string): void {
  socket.end(`HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
}

function upgrade(host: RelayHost, request: IncomingMessage, socket: Duplex, head: Buffer): void {
  if (pathOf(request) !== '/ws') {
    refuse(socket, '404 Not Found');
    return;
  }
  const key = header(request, 'sec-websocket-key');
  if (header(request, 'upgrade').toLowerCase() !== 'websocket' || header(request, 'sec-websocket-version') !== '13'
    || key === '') {
    refuse(socket, '400 Bad Request');
    return;
  }
  socket.write(['HTTP/1.1 101 Switching Protocols', 'Upgrade: websocket', 'Connection: Upgrade',
    `Sec-WebSocket-Accept: ${acceptKey(key)}`, '', ''].join('\r\n'));
  const connection = new WsConnection(socket, MAX_VOICE_FRAME_BYTES);
  host.connect(connection, { sessionId: header(request, SESSION_HEADER), scope: header(request, SCOPE_HEADER) }, head);
}

/** The server (not yet listening): `/ping` and the `/ws` upgrade for `host`. */
export function createRelayServer(host: RelayHost, clock: () => number): Server {
  const server = createServer((request, response) => {
    if (request.method === 'GET' && pathOf(request) === '/ping') {
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({
        status: host.busy() ? 'HealthyBusy' : 'Healthy', time_of_last_update: Math.floor(clock() / 1000),
      }));
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    upgrade(host, request, socket, head);
  });
  return server;
}
