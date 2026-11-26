/**
 * A chat run counts its model calls to the workspace it acts in (lib/usage-meter.ts): the cost rollup's
 * `bedrock_usage` lines carry it, so the platform console's cost per workspace includes the assistant.
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { currentAttribution, resetAttribution } from '../../lib/usage-meter.js';
import { lambdaEvent, recordingEmitter, runBody } from './__fixtures__/fakes.js';
import { harness } from './__fixtures__/harness.js';
import { parseLambdaEvent } from './event.js';
import { runAssistant } from './run.js';

const WS = 'ws_01JC3Q8ZK6V7W9X2Y4A5B6C7D8';

/** One run, its request naming `workspace` in `X-Workspace-Id` (none when undefined). */
async function runIn(workspace: string | undefined): Promise<void> {
  const event = lambdaEvent(runBody());
  if (workspace !== undefined) event.headers = { origin: 'https://app.example.com', 'X-Workspace-Id': workspace };
  await runAssistant(parseLambdaEvent(event), recordingEmitter().emitter, harness([{ text: 'x' }]).deps);
}

beforeEach(() => resetAttribution());

describe("a chat run's model calls", () => {
  it('count to the workspace the request names', async () => {
    await runIn(WS);
    expect(currentAttribution()).toBe(WS);
  });

  it('count to the deployment for a request that names none', async () => {
    await runIn(undefined);
    expect(currentAttribution()).toBe('DEPLOYMENT');
  });
});
