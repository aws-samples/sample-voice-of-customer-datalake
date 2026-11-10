import { describe, expect, it, vi } from 'vitest';
import type { ApiCall, ApiInvoker } from '../tools/internal-api.js';
import { fakeContext } from '../tools/test-fixtures.js';
import { runBody } from './__fixtures__/fakes.js';
import { firstCall, harness, run, silenceConsole } from './__fixtures__/harness.js';
import { createCategoryRestrictionLoader, restrictionForRun } from './category-restriction.js';
import { RESTRICTED_SCOPE_RULE } from './system-prompt.js';

silenceConsole();

const RESTRICTED = {
  all: false, categories: ['technical_support'], sources_all: true, sources: [], source_rule: 'all', sources_denied: [],
};
const OPEN = { ...RESTRICTED, all: true, categories: [] };
const SOURCES_ONLY = { ...OPEN, sources_all: false, sources: ['web'], source_rule: 'allow' };

function accessFake(body: unknown): ApiInvoker & { mock: { calls: Array<[ApiCall]> } } {
  return vi.fn((_call: ApiCall) => Promise.resolve(body));
}

describe('createCategoryRestrictionLoader', () => {
  it('reads GET /feedback/access as the caller and is restricted only by the category rule', async () => {
    const invoke = accessFake(RESTRICTED);
    const restricted = await createCategoryRestrictionLoader(invoke)(fakeContext());
    const answers = await Promise.all([OPEN, SOURCES_ONLY].map((body) => createCategoryRestrictionLoader(accessFake(body))(fakeContext())));
    expect([restricted, ...answers, invoke.mock.calls[0]?.[0].path]).toStrictEqual([true, false, false, '/feedback/access']);
  });
});

describe('restrictionForRun (fails open: the tools fail closed on their own)', () => {
  it('is false for an admin without reading, without a loader, on a throw and on a timeout', async () => {
    const load = vi.fn(() => Promise.resolve(true));
    const answers = await Promise.all([
      restrictionForRun(load, fakeContext('home', {}, { isAdmin: true })),
      restrictionForRun(undefined, fakeContext()),
      restrictionForRun(() => Promise.reject(new Error('down')), fakeContext()),
      restrictionForRun(() => new Promise<boolean>(() => {}), fakeContext(), 5),
    ]);
    expect([...answers, load.mock.calls.length]).toStrictEqual([false, false, false, false, 0]);
  });
});

describe('runAssistant for a restricted caller', () => {
  async function systemFor(body: unknown, groups = 'users'): Promise<string> {
    const h = harness([{ text: 'ok' }]);
    h.deps.loadCategoryRestriction = createCategoryRestrictionLoader(accessFake(body));
    await run(runBody(), h, { sub: 'viewer-sub', 'cognito:groups': groups, email: 'viewer@example.com' });
    const call = firstCall(h);
    return `${call.systemPrompt}${call.systemSuffix}`;
  }

  it('tells the model to name and count only the categories the user can see', async () => {
    const system = await systemFor(RESTRICTED);
    expect([system.includes(RESTRICTED_SCOPE_RULE), system.includes('how many categories the workspace has')])
      .toStrictEqual([true, true]);
  });

  it('adds nothing for an unrestricted user or an admin', async () => {
    const systems = await Promise.all([systemFor(OPEN), systemFor(RESTRICTED, 'admins')]);
    expect(systems.map((system) => system.includes(RESTRICTED_SCOPE_RULE))).toStrictEqual([false, false]);
  });
});
