import { describe, expect, it } from 'vitest';
import type { Server } from 'node:http';

import { Meter, pricesFor } from './meter.js';
import { relayHost, startRelay, systemClock } from './relay-host.js';
import { createRelayServer, SCOPE_HEADER, SESSION_HEADER } from './server.js';
import { closedAfterEach, connect, httpJson, listening, until, whenListening, type Client } from './ws-fixtures.js';
import { FakeStore, FakeTransport, ManualClock, PROJECT_ID, SESSION_ID, sessionInput } from './voice-fixtures.js';

const { servers, clients } = closedAfterEach();
/** An end's waits on the wire (wire-end.ts), short for a spec: a tenth of a second's settle. */
const WAITS = { settleMs: 100, sentWaitMs: 200, closeWaitMs: 1000 };

/** The relay host behind a real server, with the store, the model and the clock as doubles. */
async function relay(store = new FakeStore()) {
  store.input = sessionInput();
  const transport = new FakeTransport();
  const prices = pricesFor('amazon.nova-2-5-sonic', 'us-west-2');
  const clock = new ManualClock();
  const host = relayHost({ store, transport, clock, meter: () => new Meter(prices) }, { waits: WAITS, clock: systemClock });
  const server = await listening(createRelayServer(host, () => clock.now()));
  servers.push(server);
  return { store, transport, host, server };
}

async function client(server: Server): Promise<Client> {
  const opened = await connect(server, { [SESSION_HEADER]: SESSION_ID, [SCOPE_HEADER]: PROJECT_ID });
  clients.push(opened);
  return opened;
}

describe('relayHost', () => {
  it('refuses a second connection while a conversation is live, with ended refused and 1008', async () => {
    const run = await relay();
    run.store.gate = new Promise(() => { /* the first session stays starting */ });
    await client(run.server);
    const second = await client(run.server);
    expect(await second.closed).toBe(1008);
    expect(second.texts).toStrictEqual([{ type: 'ended', reason: 'refused' }]);
    expect((await httpJson(run.server, 'GET', '/ping')).body).toMatchObject({ status: 'HealthyBusy' });
  });

  it('sends a refusal no sooner than the settle after the upgrade, ended then 1008 (L3)', async () => {
    const run = await relay();
    run.store.activation = 'used';
    const opened = Date.now();
    const browser = await client(run.server);
    const heard = new Promise<number>((resolve) => { browser.socket.once('message', () => { resolve(Date.now()); }); });
    expect(await browser.closed).toBe(1008);
    expect(browser.texts).toStrictEqual([{ type: 'ended', reason: 'refused' }]);
    // (a timer may fire a millisecond early by the wall clock)
    expect(await heard - opened).toBeGreaterThanOrEqual(WAITS.settleMs - 5);
  });

  it('gives a connection after the conversation ended a session of its own', async () => {
    const run = await relay();
    run.store.activation = 'used';
    const first = await client(run.server);
    await first.closed;
    const second = await client(run.server);
    await second.closed;
    expect(run.store.calls.filter((call) => call.startsWith('activate'))).toHaveLength(2);
    expect(run.host.busy()).toBe(false);
  });

  it('carries the microphone, the person\'s End and the persona\'s audio, cut to 32 KB frames', async () => {
    const run = await relay();
    const browser = await client(run.server);
    await until(() => run.transport.streams.length === 1);
    browser.socket.send(Buffer.from([1, 2]));
    run.transport.stream(0).emit('audioOutput', { contentId: 'a', content: Buffer.alloc(40_000).toString('base64') });
    await until(() => browser.binaries.length === 2 && run.transport.stream(0).bodies('audioInput').length === 1);
    browser.socket.send('{"type":"end"}');
    expect(await browser.closed).toBe(1000);
    expect([browser.binaries, run.store.ended]).toStrictEqual([[32_768, 7232], 'ended_by_person']);
  });

  it('ends the conversation when the connection drops', async () => {
    const run = await relay();
    const browser = await client(run.server);
    await until(() => run.transport.streams.length === 1);
    browser.socket.terminate();
    await until(() => run.store.ended !== undefined);
    expect(run.store.ended).toBe('disconnected');
  });
});

describe('startRelay', () => {
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
    expect((await httpJson(server, 'GET', '/ping')).body).toMatchObject({ status: 'Healthy' });
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
