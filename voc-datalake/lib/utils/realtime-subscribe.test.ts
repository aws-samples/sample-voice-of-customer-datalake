/**
 * The namespace subscribe handler (lib/utils/realtime.ts REALTIME_SUBSCRIBE_HANDLER_CODE), RUN: the
 * APPSYNC_JS module is written to a temp file with its one import (`util` from @aws-appsync/utils, which
 * exists only inside AppSync) replaced by a stub, and imported. Only `onSubscribe` is exported (APPSYNC_JS
 * refuses to call an exported function from inside the module), so every case goes through it.
 *
 * Only AppSync can show that it compiles. To re-check after changing the handler, copy it with `onSubscribe`
 * renamed to `request`, `export function response(ctx) { return null; }` appended and the channel read from
 * `ctx.arguments` (an evaluator context has no `ctx.info.channel`), then run
 * `aws appsync evaluate-code --runtime name=APPSYNC_JS,runtimeVersion=1.0.0 --function request
 *  --code file://handler.js --context file://ctx.json` with ctx.json = `{"identity":{"sub":"abc"},
 *  "arguments":{"channel":{"segments":["jobs","abc"]}}}`: it answers `null`, another sub `Unauthorized`.
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

const HandlerModuleSchema = z.object({ onSubscribe: z.function() });

const state: { dir: string; exportNames: string[]; onSubscribe: (ctx: unknown) => unknown } = {
  dir: '',
  exportNames: [],
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
  const exports = z.record(z.string(), z.unknown()).parse(loaded);
  state.exportNames = Object.keys(exports).sort((a, b) => a.localeCompare(b));
  const parsed = HandlerModuleSchema.parse(exports);
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
  it('exports onSubscribe and nothing else (APPSYNC_JS rejects calls to an exported helper)', () => {
    expect(state.exportNames).toStrictEqual(['onSubscribe']);
  });

  it('allows exactly /<namespace>/<own sub>', () => {
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
  });

  it('refuses segments that are not an array', () => {
    const ctx = { info: { channel: { path: `/jobs/${SUB}`, segments: `jobs/${SUB}` } }, identity: { sub: SUB } };
    expect(() => state.onSubscribe(ctx)).toThrow(Unauthorized);
  });
});
