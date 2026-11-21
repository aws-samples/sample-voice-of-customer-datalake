import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { createRelayServer, SCOPE_HEADER, SESSION_HEADER, type ConnectionIds, type RelayHost } from './server.js';
import type { WsConnection } from './ws-connection.js';
import { OPCODE } from './ws-frames.js';
import { closed, connect, listening, maskedFrame, serverFrames, type Client } from './ws-fixtures.js';
import { settle } from './voice-fixtures.js';

/** A host that echoes every message back, records what it was given, and can be made busy. */
class EchoHost implements RelayHost {
  readonly ids: ConnectionIds[] = [];
  readonly texts: string[] = [];
  closes = 0;
  live = false;
  connection: WsConnection | undefined;

  busy(): boolean {
    return this.live;
  }

  connect(connection: WsConnection, ids: ConnectionIds, head: Buffer): void {
    this.ids.push(ids);
    this.connection = connection;
    connection.attach({
      onText: (text) => { this.texts.push(text); connection.sendText(`echo:${text}`); },
      onBinary: (data) => { connection.sendBinary(data); },
      onClose: () => { this.closes += 1; },
    }, head);
  }
}

const servers: Server[] = [];
const clients: Client[] = [];
afterEach(async () => {
  for (const client of clients.splice(0)) client.socket.destroy();
  await Promise.all(servers.splice(0).map(closed));
});

async function serving(host: RelayHost): Promise<Server> {
  const server = await listening(createRelayServer(host, () => 1_763_726_400_000));
  servers.push(server);
  return server;
}

async function ping(server: Server): Promise<unknown> {
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  const response = await fetch(`http://127.0.0.1:${port}/ping`);
  return response.json();
}

async function opened(host: EchoHost): Promise<Client> {
  const client = await connect(await serving(host), { [SESSION_HEADER]: 'sid-1', [SCOPE_HEADER]: 'proj_1' });
  clients.push(client);
  return client;
}

describe('relay server', () => {
  it('answers /ping Healthy, and HealthyBusy while a conversation is live', async () => {
    const host = new EchoHost();
    const server = await serving(host);
    const idle = await ping(server);
    host.live = true;
    expect([idle, await ping(server)]).toStrictEqual([
      { status: 'Healthy', time_of_last_update: 1_763_726_400 }, { status: 'HealthyBusy', time_of_last_update: 1_763_726_400 },
    ]);
  });

  it('upgrades /ws with AgentCore\'s session and scope headers', async () => {
    const host = new EchoHost();
    const client = await opened(host);
    expect(client.status).toBe(101);
    expect(host.ids).toStrictEqual([{ sessionId: 'sid-1', scope: 'proj_1' }]);
  });

  it('refuses another path with 404 and a bad upgrade with 400', async () => {
    const host = new EchoHost();
    const server = await serving(host);
    const elsewhere = await connect(server, {}, '/other');
    const old = await connect(server, { 'Sec-WebSocket-Version': '8' });
    clients.push(elsewhere, old);
    expect([elsewhere.status, old.status]).toStrictEqual([404, 400]);
    expect(host.ids).toStrictEqual([]);
  });
});

describe('relay connection', () => {
  it('delivers text and binary messages, a fragmented one whole, and answers ping with pong', async () => {
    const host = new EchoHost();
    const client = await opened(host);
    client.socket.write(Buffer.concat([
      maskedFrame(OPCODE.text, Buffer.from('hel'), false), maskedFrame(OPCODE.continuation, Buffer.from('lo')),
      maskedFrame(OPCODE.binary, Buffer.from([1, 2])), maskedFrame(OPCODE.ping, Buffer.from('p')),
      maskedFrame(OPCODE.pong, Buffer.from('q')),
    ]));
    await settle();
    expect(host.texts).toStrictEqual(['hello']);
    expect(serverFrames(client.received())).toStrictEqual([
      { opcode: OPCODE.text, payload: Buffer.from('echo:hello') }, { opcode: OPCODE.binary, payload: Buffer.from([1, 2]) },
      { opcode: OPCODE.pong, payload: Buffer.from('p') },
    ]);
  });

  it('answers a close with a close, then reports the close once and drops later sends', async () => {
    const host = new EchoHost();
    const client = await opened(host);
    client.socket.write(maskedFrame(OPCODE.close, Buffer.from([0x03, 0xe8])));
    await settle();
    host.connection?.sendText('late');
    host.connection?.close(1000);
    expect(serverFrames(client.received())).toStrictEqual([{ opcode: OPCODE.close, payload: Buffer.from([0x03, 0xe8]) }]);
    expect(host.closes).toBe(1);
  });

  it('closes with 1009 on a frame over 32 KB and with 1002 on a continuation that starts nothing', async () => {
    const big = await opened(new EchoHost());
    big.socket.write(maskedFrame(OPCODE.binary, Buffer.alloc(40_000)).subarray(0, 4));
    const stray = await opened(new EchoHost());
    stray.socket.write(maskedFrame(OPCODE.continuation, Buffer.from('x')));
    await settle();
    expect(serverFrames(big.received())[0]?.payload.readUInt16BE(0)).toBe(1009);
    expect(serverFrames(stray.received())[0]?.payload.readUInt16BE(0)).toBe(1002);
  });

  it('closes with 1002 on an unknown opcode', async () => {
    const client = await opened(new EchoHost());
    client.socket.write(maskedFrame(3, Buffer.from('x')));
    await settle();
    expect(serverFrames(client.received())[0]?.payload.readUInt16BE(0)).toBe(1002);
  });
});
