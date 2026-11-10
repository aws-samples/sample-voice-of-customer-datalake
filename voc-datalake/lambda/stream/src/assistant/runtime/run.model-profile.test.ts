/**
 * The e2e model profile in the streaming assistant (bedrock/model-profile.ts): a caller whose
 * VERIFIED `cognito:groups` holds `e2e` runs on Haiku 5.5 whatever the admin picked, the capacity
 * fallback stays on Haiku, and nothing in the request body can switch it on.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cooldownUntil, fallbackChain } from '../../bedrock/model-fallback.js';
import { PROFILE_MODELS, applyModelProfile, profileForGroups, profiledModelId } from '../../bedrock/model-profile.js';
import { failingStream, runBody } from './__fixtures__/fakes.js';
import { firstCall, harness, run, silenceConsole } from './__fixtures__/harness.js';

silenceConsole();
afterEach(() => cooldownUntil.clear());

const OPUS55 = 'global.anthropic.claude-opus-5-5';
const SONNET55 = 'global.anthropic.claude-sonnet-5-5';
const HAIKU55 = 'global.anthropic.claude-haiku-5-5';
const HAIKU45 = 'global.anthropic.claude-haiku-4-5-20251001-v1:0';

const claimsWith = (groups: string) => ({ sub: 'user-sub-1', 'cognito:groups': groups, email: 'a@example.com' });

function adminPinnedOpus() {
  const h = harness([{ text: 'hi' }]);
  h.deps.resolveModel = () => Promise.resolve(OPUS55);
  return h;
}

describe('profileForGroups', () => {
  it.each(['e2e', '[users e2e]', 'admins,e2e', '[admins, e2e]'])('reads e2e from the claim shape %s', (groups) => {
    expect(profileForGroups(groups)).toBe('e2e');
  });

  it.each([undefined, '', 'users', 'admins,users', 'e2e-admins', 'E2E'])('gives no profile for %s', (groups) => {
    expect(profileForGroups(groups)).toBeUndefined();
  });
});

describe('the profile model', () => {
  it('is Haiku 5.5, and an unprofiled caller keeps the configured model', () => {
    expect(PROFILE_MODELS).toStrictEqual({ e2e: HAIKU55 });
    expect(applyModelProfile(OPUS55, undefined)).toBe(OPUS55);
    expect(applyModelProfile(OPUS55, 'e2e')).toBe(HAIKU55);
  });

  it('keeps the capacity fallback on Haiku', () => {
    expect(fallbackChain(OPUS55, 'e2e')).toStrictEqual([HAIKU55, HAIKU45]);
    expect(fallbackChain(OPUS55)).toContain(SONNET55);
  });

  it('logs one structured line only when a profile applies', () => {
    vi.mocked(console.log).mockClear();
    expect(profiledModelId(OPUS55, 'users', 'chat')).toBe(OPUS55);
    expect(console.log).not.toHaveBeenCalled();
    expect(profiledModelId(OPUS55, 'e2e', 'chat')).toBe(HAIKU55);
    expect(console.log).toHaveBeenCalledWith(expect.stringContaining('"model_profile":"e2e"'));
  });
});

describe('a run', () => {
  it('of an e2e test user sends every turn to Haiku 5.5, not the admin\'s model', async () => {
    const h = adminPinnedOpus();
    await run(runBody(), h, claimsWith('users,e2e'));
    expect(firstCall(h).modelId).toBe(HAIKU55);
  });

  it('of any other user keeps the admin\'s model', async () => {
    const h = adminPinnedOpus();
    await run(runBody(), h, claimsWith('users'));
    expect(firstCall(h).modelId).toBe(OPUS55);
  });

  it('ignores a profile or group sent in the request body', async () => {
    const h = adminPinnedOpus();
    // AG-UI's free-form fields (forwardedProps is strict and refuses unknown keys outright).
    const body = runBody({
      state: { model_profile: 'e2e', 'cognito:groups': 'e2e' },
      context: [{ description: 'model_profile', value: 'e2e' }],
    });
    await run(body, h, claimsWith('users'));
    expect(firstCall(h).modelId).toBe(OPUS55);
  });

  it('of an e2e test user falls back to Haiku 4.5, never to a Sonnet or Opus', async () => {
    const h = adminPinnedOpus();
    const tried: string[] = [];
    h.deps.converse = (params) => {
      tried.push(params.modelId ?? '');
      return failingStream(Object.assign(new Error('Too many tokens'), { name: 'ThrottlingException' }));
    };
    await run(runBody(), h, claimsWith('e2e'));
    expect(tried).toStrictEqual([HAIKU55, HAIKU45]);
  });
});
