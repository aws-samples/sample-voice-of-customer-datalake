import { describe, expect, it, vi } from 'vitest';
import type { Server } from 'node:http';

import type { RawData, WebSocket } from 'ws';

import { createRelayServer, SCOPE_HEADER, SESSION_HEADER, type ConnectionIds, type RelayHost } from './server.js';
import { closedAfterEach, connect, httpJson, listening, silentPeer, until, upgradeStatus, type Client } from './ws-fixtures.js';

/** RFC 6455's sample nonce (section 1.3), built here so no key-shaped literal sits in the source. */
const SAMPLE_NONCE = Buffer.from('the sample nonce').toString('base64');

const START_MS = 1_763_726_400_000;
const HEADERS = { [SESSION_HEADER]: 'sid-1', [SCOPE_HEADER]: 'proj_1' };

/** A host that echoes every message back (text as `echo:<text>`), records what it was given, and can be made busy. */
class EchoHost implements RelayHost {
  readonly ids: ConnectionIds[] = [];
  readonly texts: string[] = [];
  readonly sizes: number[] = [];
  closes = 0;
  live = false;
  socket: WebSocket | undefined;

  busy(): boolean {
    return this.live;
  }

  connect(socket: WebSocket, ids: ConnectionIds): void {
    this.ids.push(ids);
    this.socket = socket;
    socket.on('message', (data: RawData, isBinary: boolean) => {
      if (!Buffer.isBuffer(data)) return;
      this.sizes.push(data.length);
      if (isBinary) socket.send(data);
      else {
        this.texts.push(data.toString('utf8'));
        socket.send(`"echo:${data.toString('utf8')}"`);
      }
    });
    socket.on('error', () => { /* its close follows */ });
    socket.on('close', () => { this.closes += 1; });
  }
}

const { servers, clients } = closedAfterEach();

async function serving(host: RelayHost, clock: () => number = () => START_MS): Promise<Server> {
  const server = await listening(createRelayServer(host, clock));
  servers.push(server);
  return server;
}

async function opened(host: EchoHost): Promise<Client> {
  const client = await connect(await serving(host), HEADERS);
  clients.push(client);
  return client;
}

describe('relay server: the HTTP contract', () => {
  it('answers /ping Healthy, then HealthyBusy, dated when the status changed and never by the ping itself', async () => {
    const host = new EchoHost();
    const clock = { now: START_MS };
    const server = await serving(host, () => clock.now);
    clock.now += 30_000;
    const idle = await httpJson(server, 'GET', '/ping');
    host.live = true;
    const busy = await httpJson(server, 'GET', '/ping');
    clock.now += 60_000;
    const stillBusy = await httpJson(server, 'GET', '/ping');
    expect([idle.body, busy.body, stillBusy.body]).toStrictEqual([
      { status: 'Healthy', time_of_last_update: 1_763_726_400 },
      { status: 'HealthyBusy', time_of_last_update: 1_763_726_430 },
      { status: 'HealthyBusy', time_of_last_update: 1_763_726_430 },
    ]);
  });

  it('answers POST /invocations 400 (the relay talks over /ws only) and any other route 404', async () => {
    const server = await serving(new EchoHost());
    const answers = await Promise.all([
      httpJson(server, 'POST', '/invocations'), httpJson(server, 'GET', '/invocations'), httpJson(server, 'GET', '/'),
    ]);
    expect(answers).toStrictEqual([
      { status: 400, body: { error: 'use /ws' } }, { status: 404, body: null }, { status: 404, body: null },
    ]);
  });

  it('upgrades /ws with AgentCore\'s session and scope headers', async () => {
    const host = new EchoHost();
    await opened(host);
    expect(host.ids).toStrictEqual([{ sessionId: 'sid-1', scope: 'proj_1' }]);
  });

  it('refuses another path with 404 and an upgrade that is not a WebSocket handshake with 400', async () => {
    const host = new EchoHost();
    const server = await serving(host);
    const statuses = await Promise.all([
      upgradeStatus(server, { Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': SAMPLE_NONCE }, '/other'),
      upgradeStatus(server, { Upgrade: 'websocket', 'Sec-WebSocket-Version': '13' }),
      upgradeStatus(server, { Upgrade: 'websocket', 'Sec-WebSocket-Version': '7', 'Sec-WebSocket-Key': SAMPLE_NONCE }),
    ]);
    expect(statuses).toStrictEqual([404, 400, 400]);
    expect(host.ids).toStrictEqual([]);
  });
});

describe('relay server: the WebSocket', () => {
  it('delivers text and binary messages of each length form, a fragmented one whole, and answers a ping once', async () => {
    const host = new EchoHost();
    const client = await opened(host);
    client.socket.send('hel', { fin: false });
    client.socket.send('lo', { fin: true });
    client.socket.send(Buffer.from([1, 2]));
    client.socket.send(Buffer.alloc(300, 7));
    client.socket.ping('p');
    await until(() => client.binaries.length === 2 && client.pongs.length === 1);
    expect(host.texts).toStrictEqual(['hello']);
    expect([client.texts, client.binaries]).toStrictEqual([['echo:hello'], [2, 300]]);
    expect(client.pongs).toStrictEqual([Buffer.from('p')]);
  });

  it('answers a close with a close, reports it once and drops a send after it', async () => {
    const host = new EchoHost();
    const client = await opened(host);
    client.socket.close(1000);
    await until(() => host.closes === 1);
    host.socket?.send('"late"');
    host.socket?.close(1000);
    expect([await client.closed, client.texts, host.closes]).toStrictEqual([1000, [], 1]);
  });

  it('destroys a socket whose close is never answered five seconds after the close, not ws\'s 30 (F1, 7.71.03)', async () => {
    const host = new EchoHost();
    const peer = await silentPeer(await serving(host), HEADERS, SAMPLE_NONCE);
    await until(() => host.socket !== undefined);
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      host.socket?.close(1008);
      vi.advanceTimersByTime(4999);
      await new Promise((resolve) => { setImmediate(resolve); });
      expect(host.closes).toBe(0);
      vi.advanceTimersByTime(1);
      vi.useRealTimers();
      await until(() => host.closes === 1);
    } finally {
      vi.useRealTimers();
      peer.destroy();
    }
  });

  it('closes with 1009 on a message over 32 KB, in one frame or in fragments, and sends only valid close codes', async () => {
    const host = new EchoHost();
    const whole = await opened(host);
    whole.socket.send(Buffer.alloc(40_000));
    const fragments = await opened(host);
    fragments.socket.send(Buffer.alloc(20_000), { fin: false });
    fragments.socket.send(Buffer.alloc(20_000), { fin: true });
    expect([await whole.closed, await fragments.closed]).toStrictEqual([1009, 1009]);
    expect([host.sizes, whole.errors, fragments.errors]).toStrictEqual([[], [], []]);
  });
});
