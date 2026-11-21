import { afterEach, describe, expect, it } from 'vitest';
import { Duplex } from 'node:stream';
import type { Server } from 'node:http';

import { Meter, pricesFor } from './meter.js';
import { relayHost, startRelay, systemClock } from './relay-host.js';
import type { RelayHost } from './server.js';
import { WsConnection } from './ws-connection.js';
import { OPCODE } from './ws-frames.js';
import { closed, maskedFrame, serverFrames, whenListening } from './ws-fixtures.js';
import { FakeStore, FakeTransport, ManualClock, PROJECT_ID, SESSION_ID, sessionInput, settle } from './voice-fixtures.js';

/** A socket double: what the relay wrote, and a way to send it the client's bytes or end it. */
function socket() {
  const written: Buffer[] = [];
  const duplex = new Duplex({
    read() { /* pushed by the spec */ },
    write(chunk: Buffer, _encoding, done) {
      written.push(chunk);
      done();
    },
  });
  return { duplex, frames: () => serverFrames(Buffer.concat(written)) };
}

function host(store = new FakeStore()) {
  store.input = sessionInput();
  const transport = new FakeTransport();
  const prices = pricesFor('amazon.nova-2-5-sonic', 'us-west-2');
  return { store, transport, host: relayHost({ store, transport, clock: new ManualClock(), meter: () => new Meter(prices) }) };
}

function connect(relay: RelayHost) {
  const client = socket();
  relay.connect(new WsConnection(client.duplex, 32 * 1024), { sessionId: SESSION_ID, scope: PROJECT_ID }, Buffer.alloc(0));
  return client;
}

const texts = (frames: ReturnType<ReturnType<typeof socket>['frames']>) => frames
  .filter((frame) => frame.opcode === OPCODE.text).map((frame) => JSON.parse(frame.payload.toString('utf8')) as unknown);

describe('relayHost', () => {
  it('refuses a second connection while a conversation is live, with ended refused and 1008', async () => {
    const run = host();
    run.store.gate = new Promise(() => { /* the first session stays starting */ });
    connect(run.host);
    const second = connect(run.host);
    await settle();
    expect(run.host.busy()).toBe(true);
    expect(texts(second.frames())).toStrictEqual([{ type: 'ended', reason: 'refused' }]);
    expect(second.frames().at(-1)?.payload.readUInt16BE(0)).toBe(1008);
  });

  it('gives a connection after the conversation ended a session of its own', async () => {
    const run = host();
    run.store.activation = false;
    connect(run.host);
    await settle();
    connect(run.host);
    await settle();
    expect(run.store.calls.filter((call) => call.startsWith('activate'))).toHaveLength(2);
    expect(run.host.busy()).toBe(false);
  });

  it('carries the microphone, the person\'s End and the persona\'s audio, cut to 32 KB frames', async () => {
    const run = host();
    const client = connect(run.host);
    await settle();
    client.duplex.push(maskedFrame(OPCODE.binary, Buffer.from([1, 2])));
    run.transport.stream(0).emit('audioOutput', { contentId: 'a', content: Buffer.alloc(40_000).toString('base64') });
    await settle();
    client.duplex.push(maskedFrame(OPCODE.text, Buffer.from('{"type":"end"}')));
    await settle();
    expect(run.transport.stream(0).bodies('audioInput')).toHaveLength(1);
    expect(client.frames().filter((frame) => frame.opcode === OPCODE.binary).map((frame) => frame.payload.length)).toStrictEqual([32_768, 7232]);
    expect(run.store.ended).toBe('ended_by_person');
  });

  it('ends the conversation when the connection closes', async () => {
    const run = host();
    const client = connect(run.host);
    await settle();
    client.duplex.push(null);
    await settle();
    expect(run.store.ended).toBe('disconnected');
  });
});

describe('startRelay', () => {
  const servers: Server[] = [];
  afterEach(async () => {
    await Promise.all(servers.splice(0).map(closed));
  });

  it('refuses to start without its configuration, naming what is missing', () => {
    expect(() => startRelay({ VOICE_MODEL_ID: 'amazon.nova-2-5-sonic' }))
      .toThrow('The voice relay needs VOICE_REGION, PROJECTS_TABLE, AGGREGATES_TABLE, RAW_DATA_BUCKET');
  });

  it('listens and answers /ping', async () => {
    const server = startRelay({
      VOICE_MODEL_ID: 'amazon.nova-2-5-sonic', VOICE_REGION: 'us-west-2', PROJECTS_TABLE: 'p', AGGREGATES_TABLE: 'a',
      RAW_DATA_BUCKET: 'b', PORT: '0',
    });
    servers.push(server);
    await whenListening(server);
    const address = server.address();
    const port = typeof address === 'object' && address !== null ? address.port : 0;
    const body = await (await fetch(`http://127.0.0.1:${port}/ping`)).json() as { status: string };
    expect(body.status).toBe('Healthy');
  });
});

describe('systemClock', () => {
  it('runs a timer when it is due, and never one that was cancelled', async () => {
    const ran: string[] = [];
    systemClock.after(1, () => { ran.push('due'); });
    const cancel = systemClock.after(1, () => { ran.push('cancelled'); });
    cancel();
    await new Promise((resolve) => { setTimeout(resolve, 20); });
    expect([ran, systemClock.now() > 0]).toStrictEqual([['due'], true]);
  });
});
