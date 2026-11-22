/**
 * The relay's HTTP server, the contract AgentCore Runtime holds a container to (S-15 findings, section 3; AWS's
 * direct-code guide for Node): port 8080, `GET /ping` for health, `POST /invocations`, and the WebSocket on `/ws`,
 * which AgentCore's endpoint proxies the browser's connection to after checking its SigV4-presigned URL.
 *
 * - `/ping` answers `Healthy`, or `HealthyBusy` while a conversation is live, with `time_of_last_update` the moment
 *   that status last changed (never the time of the ping: a fresh time on every ping keeps the idle session timeout
 *   from ever firing, so an ended session would live until the runtime's `maxLifetime`).
 * - `POST /invocations` (the HTTP protocol's request route) answers 400 `{error: 'use /ws'}`: the relay talks only
 *   over its WebSocket.
 * - `/ws` is served by the `ws` package (docs/dependencies.md): the handshake (anything but a valid upgrade is a 400),
 *   the framing, the close handshake and the answer to a WebSocket ping (its own: the relay adds none), with every
 *   message at most `MAX_VOICE_FRAME_BYTES` (larger: close 1009) and no compression. Any other path is a 404 and the
 *   socket is dropped. The session id and the scope arrive as AgentCore's headers (signed in the URL the projects API
 *   minted, so the browser cannot change them): the host decides what to do with the connection.
 */
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { Duplex } from 'node:stream';

import { WebSocketServer, type WebSocket } from 'ws';

import { MAX_VOICE_FRAME_BYTES } from './protocol.js';

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
  /** A new WebSocket on `/ws`, open, with AgentCore's headers. */
  connect(socket: WebSocket, ids: ConnectionIds): void;
}

type PingStatus = 'Healthy' | 'HealthyBusy';

function header(request: IncomingMessage, name: string): string {
  const value = request.headers[name];
  return typeof value === 'string' ? value : '';
}

function pathOf(request: IncomingMessage): string {
  return (request.url ?? '').split('?')[0] ?? '';
}

function json(response: ServerResponse, status: number, body: unknown): void {
  response.writeHead(status, { 'Content-Type': 'application/json' });
  response.end(JSON.stringify(body));
}

/** `/ping`'s answer: the status, and when it last changed (seconds), kept across pings. */
function pingStatus(host: RelayHost, clock: () => number): () => { status: PingStatus; time_of_last_update: number } {
  const last: { status: PingStatus; changedAt: number } = { status: 'Healthy', changedAt: Math.floor(clock() / 1000) };
  return () => {
    const status: PingStatus = host.busy() ? 'HealthyBusy' : 'Healthy';
    if (status !== last.status) {
      last.status = status;
      last.changedAt = Math.floor(clock() / 1000);
    }
    return { status, time_of_last_update: last.changedAt };
  };
}

/** The server (not yet listening): `/ping`, `/invocations` and the `/ws` upgrade for `host`. */
export function createRelayServer(host: RelayHost, clock: () => number): Server {
  const sockets = new WebSocketServer({ noServer: true, maxPayload: MAX_VOICE_FRAME_BYTES, perMessageDeflate: false });
  const ping = pingStatus(host, clock);
  const server = createServer((request, response) => {
    const route = `${request.method ?? ''} ${pathOf(request)}`;
    if (route === 'GET /ping') {
      json(response, 200, ping());
      return;
    }
    request.resume();
    if (route === 'POST /invocations') {
      json(response, 400, { error: 'use /ws' });
      return;
    }
    response.writeHead(404);
    response.end();
  });
  server.on('upgrade', (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (pathOf(request) !== '/ws') {
      socket.end('HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
      return;
    }
    sockets.handleUpgrade(request, socket, head, (open) => {
      host.connect(open, { sessionId: header(request, SESSION_HEADER), scope: header(request, SCOPE_HEADER) });
    });
  });
  return server;
}
