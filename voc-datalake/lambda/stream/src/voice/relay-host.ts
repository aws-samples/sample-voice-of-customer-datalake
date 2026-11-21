/**
 * The relay process (docs/voice-personas.md → The relay): its configuration from the runtime's environment
 * (lib/stacks/voice-relay.ts sets it), the server, and the one conversation a microVM holds (AgentCore runs one
 * microVM per session id).
 *
 * - A connection while a conversation is live is refused: `ended {refused}` and close 1008. One after the
 *   conversation ended gets a session of its own, which its activation refuses (the row is no longer `minted`).
 * - It listens on 0.0.0.0:8080 because AgentCore's proxy reaches the container over its network interface; the
 *   container is never reachable from outside AgentCore, whose endpoint checks every request's SigV4 signature.
 */
import type { Server } from 'node:http';

import { ConfigurationError } from '../lib/errors.js';
import { bedrockTransport } from './bedrock-stream.js';
import { Meter, pricesFor } from './meter.js';
import { MAX_VOICE_FRAME_BYTES, VOICE_CLOSE } from './protocol.js';
import { createRelayServer, type RelayHost } from './server.js';
import { awsStoreDeps, createVoiceStore } from './store.js';
import { VoiceSession, type ClientChannel, type Clock, type SessionDeps } from './voice-session.js';
import type { WsConnection } from './ws-connection.js';

const DEFAULT_PORT = 8080;
const REQUIRED = ['VOICE_MODEL_ID', 'VOICE_REGION', 'PROJECTS_TABLE', 'AGGREGATES_TABLE', 'RAW_DATA_BUCKET'] as const;

/** The browser's side of a connection; audio longer than a frame may carry goes as several frames. */
function channelOf(connection: WsConnection): ClientChannel {
  return {
    json: (message) => { connection.sendText(JSON.stringify(message)); },
    audio: (pcm) => {
      const frames = Math.ceil(pcm.length / MAX_VOICE_FRAME_BYTES);
      for (const index of Array.from({ length: frames }, (_, at) => at)) {
        connection.sendBinary(pcm.subarray(index * MAX_VOICE_FRAME_BYTES, (index + 1) * MAX_VOICE_FRAME_BYTES));
      }
    },
    close: (code) => { connection.close(code); },
  };
}

/** The host of one microVM's conversations. */
export function relayHost(deps: SessionDeps): RelayHost {
  const state: { current: VoiceSession | undefined } = { current: undefined };
  return {
    busy: () => state.current !== undefined && !state.current.isOver,
    connect(connection, ids, head) {
      if (state.current !== undefined && !state.current.isOver) {
        connection.sendText(JSON.stringify({ type: 'ended', reason: 'refused' }));
        connection.close(VOICE_CLOSE.policy);
        return;
      }
      const session = new VoiceSession(deps, ids, channelOf(connection));
      state.current = session;
      connection.attach({
        onText: (text) => { session.control(text); },
        onBinary: (data) => { session.audio(data); },
        onClose: () => { session.disconnected(); },
      }, head);
      void session.start();
    },
  };
}

export const systemClock: Clock = {
  now: () => Date.now(),
  after(ms, run) {
    const handle = setTimeout(run, ms);
    return () => { clearTimeout(handle); };
  },
};

/** Read the environment, build the AWS clients and start listening. */
export function startRelay(env: Readonly<Record<string, string | undefined>>): Server {
  const missing = REQUIRED.filter((name) => (env[name] ?? '') === '');
  if (missing.length > 0) throw new ConfigurationError(`The voice relay needs ${missing.join(', ')}`);
  const value = (name: (typeof REQUIRED)[number]): string => env[name] ?? '';
  const region = value('VOICE_REGION');
  const modelId = value('VOICE_MODEL_ID');
  const store = createVoiceStore({
    projectsTable: value('PROJECTS_TABLE'), aggregatesTable: value('AGGREGATES_TABLE'), bucket: value('RAW_DATA_BUCKET'), region,
  }, awsStoreDeps(region));
  const prices = pricesFor(modelId, region);
  const host = relayHost({ store, transport: bedrockTransport(modelId, region), clock: systemClock, meter: () => new Meter(prices) });
  const server = createRelayServer(host, () => systemClock.now());
  server.listen(Number(env.PORT ?? DEFAULT_PORT), '0.0.0.0');
  return server;
}
