/**
 * The namespace subscribe handler (lib/utils/realtime.ts REALTIME_SUBSCRIBE_HANDLER_CODE), RUN: the
 * APPSYNC_JS module is written to a temp file with its one import (`util` from @aws-appsync/utils, which
 * exists only inside AppSync) replaced by a stub, and imported.
 */
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { REALTIME_SUBSCRIBE_HANDLER_CODE } from './realtime';

const IMPORT_LINE = "import { util } from '@aws-appsync/utils';";
const SUB = '0a1b2c3d-1111-4222-8333-444455556666';

const HandlerModuleSchema = z.object({
  ownChannel: z.function(),
  onSubscribe: z.function(),
});

const state: { dir: string; ownChannel: (segments: unknown, sub: unknown) => unknown; onSubscribe: (ctx: unknown) => unknown } = {
  dir: '',
  ownChannel: () => undefined,
  onSubscribe: () => undefined,
};

class Unauthorized extends Error {}

beforeAll(async () => {
  if (!REALTIME_SUBSCRIBE_HANDLER_CODE.startsWith(IMPORT_LINE)) throw new Error('the handler no longer starts with its util import');
  state.dir = mkdtempSync(join(tmpdir(), 'realtime-subscribe-'));
  const file = join(state.dir, 'handler.mjs');
  const stub = 'const util = { unauthorized() { throw new globalThis.RealtimeUnauthorized(); } };';
  writeFileSync(file, REALTIME_SUBSCRIBE_HANDLER_CODE.replace(IMPORT_LINE, stub));
  Object.assign(globalThis, { RealtimeUnauthorized: Unauthorized });
  const loaded: unknown = await import(pathToFileURL(file).href);
  const parsed = HandlerModuleSchema.parse(loaded);
  state.ownChannel = (segments, sub) => Reflect.apply(parsed.ownChannel, undefined, [segments, sub]);
  state.onSubscribe = (ctx) => Reflect.apply(parsed.onSubscribe, undefined, [ctx]);
});

afterAll(() => {
  rmSync(state.dir, { recursive: true, force: true });
});

const ctxFor = (path: string, sub: string | undefined) => ({
  info: { channel: { path, segments: path.split('/').filter(Boolean) } },
  identity: sub === undefined ? undefined : { sub },
});

describe('the own-channel subscribe handler', () => {
  it('allows exactly /<namespace>/<own sub>', () => {
    expect(state.ownChannel(['jobs', SUB], SUB)).toBe(true);
    expect(() => state.onSubscribe(ctxFor(`/jobs/${SUB}`, SUB))).not.toThrow();
  });

  it.each([
    ['another person', `/jobs/ffffffff-1111-4222-8333-444455556666`],
    ['a wildcard', '/jobs/*'],
    ['the whole namespace', '/jobs'],
    ['a deeper path', `/jobs/${SUB}/x`],
    ['a wildcard under the own sub', `/jobs/${SUB}/*`],
  ])('refuses %s', (_label, path) => {
    expect(() => state.onSubscribe(ctxFor(path, SUB))).toThrow(Unauthorized);
  });

  it('refuses a caller without a sub (an IAM principal, a malformed identity)', () => {
    expect(() => state.onSubscribe(ctxFor(`/jobs/${SUB}`, undefined))).toThrow(Unauthorized);
    expect(() => state.onSubscribe(ctxFor('/jobs/', ''))).toThrow(Unauthorized);
    expect(state.ownChannel('jobs', SUB)).toBe(false);
  });
});
