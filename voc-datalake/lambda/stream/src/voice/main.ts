/**
 * The voice relay's entry point: AgentCore Runtime runs it as `relay.js` (direct code deployment, NODE_22; the CDK
 * asset bundles this file with esbuild: lib/stacks/voice-relay.ts) and holds it to port 8080 (relay-host.ts).
 */
import { startRelay } from './relay-host.js';

export const relay = startRelay(process.env);
