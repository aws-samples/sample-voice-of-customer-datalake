/**
 * Avatar URL signing for consult_personas (ported from the removed
 * project-context avatar test, now against `resolveAvatarUrl` directly).
 */
import {
  afterAll, afterEach, beforeEach, describe, expect, it, vi,
} from 'vitest';

const { mockSignCloudFrontUrl, previousAvatarsCdnUrl } = vi.hoisted(() => {
  const previous = process.env.AVATARS_CDN_URL;
  process.env.AVATARS_CDN_URL = 'https://cdn.example.com/avatars';
  return {
    mockSignCloudFrontUrl: vi.fn<(url: string) => Promise<string>>(),
    previousAvatarsCdnUrl: previous,
  };
});

vi.mock('../lib/cloudfront-signing.js', () => ({
  signCloudFrontUrl: mockSignCloudFrontUrl,
}));

import { resolveAvatarUrl } from './avatar-url.js';

function expectOneAuthParameterSet(url: string): void {
  const parsed = new URL(url);
  expect(parsed.searchParams.getAll('Expires')).toHaveLength(1);
  expect(parsed.searchParams.getAll('Signature')).toHaveLength(1);
  expect(parsed.searchParams.getAll('Key-Pair-Id')).toHaveLength(1);
}

afterAll(() => {
  if (previousAvatarsCdnUrl === undefined) delete process.env.AVATARS_CDN_URL;
  else process.env.AVATARS_CDN_URL = previousAvatarsCdnUrl;
});

describe('resolveAvatarUrl', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignCloudFrontUrl.mockImplementation((url: string) => {
      const separator = url.includes('?') ? '&' : '?';
      const expires = Math.floor(Date.now() / 1000) + 3600;
      return Promise.resolve(`${url}${separator}Expires=${expires}&Signature=stream&Key-Pair-Id=KSTREAM`);
    });
  });

  it('preserves a current Projects API signature without signing again', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const canonical = `https://cdn.example.com/avatars/avatar.jpeg?v=2&Expires=${expires}&Signature=python&Key-Pair-Id=KPYTHON`;

    expect(await resolveAvatarUrl(canonical)).toBe(canonical);
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });

  it('removes expired auth parameters before signing a legacy URL once', async () => {
    const expired = Math.floor(Date.now() / 1000) - 1;
    const stale = `https://cdn.example.com/avatars/avatar.jpeg?v=2&Expires=${expired}&Signature=old&Key-Pair-Id=KOLD`;

    const resolved = await resolveAvatarUrl(stale);

    // The legacy query survives; every stale auth parameter is gone before re-signing.
    expect(mockSignCloudFrontUrl).toHaveBeenCalledExactlyOnceWith('https://cdn.example.com/avatars/avatar.jpeg?v=2');
    expectOneAuthParameterSet(resolved ?? '');
  });

  it('signs an S3 avatar reference as a CDN URL under the configured path', async () => {
    const resolved = await resolveAvatarUrl('s3://bucket/avatars/p1.png');

    expect(mockSignCloudFrontUrl).toHaveBeenCalledWith('https://cdn.example.com/avatars/p1.png');
    expectOneAuthParameterSet(resolved ?? '');
  });

  // QA s3 F3: each regenerated avatar has its own key under the persona's prefix,
  // so the CDN path must keep it — the bare file name 404s (and names no persona).
  it('keeps the per-persona path of a versioned avatar key', async () => {
    await resolveAvatarUrl('s3://bucket/avatars/persona_1/0123abcd.jpeg');

    expect(mockSignCloudFrontUrl).toHaveBeenCalledWith('https://cdn.example.com/avatars/persona_1/0123abcd.jpeg');
  });

  it.each([
    'https://tracker.example.net/avatars/avatar.jpeg',
    'https://cdn.example.com/prototypes/avatar.jpeg',
    'not a url',
    '',
  ])('refuses an avatar outside the configured CDN path: %j', async (untrusted) => {
    expect(await resolveAvatarUrl(untrusted)).toBeUndefined();
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });

  it('resolves no reference to no URL', async () => {
    expect(await resolveAvatarUrl(undefined)).toBeUndefined();
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });

  it('keeps only the last segment of an S3 key outside the avatars/ prefix', async () => {
    await resolveAvatarUrl('s3://bucket/legacy/flat/p9.png');

    expect(mockSignCloudFrontUrl).toHaveBeenCalledExactlyOnceWith('https://cdn.example.com/avatars/p9.png');
  });

  it.each(['s3://bucket/', 's3://bucket/avatars/'])('refuses an S3 reference naming no file: %s', async (empty) => {
    expect(await resolveAvatarUrl(empty)).toBeUndefined();
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });
});

describe('which existing signature counts as current', () => {
  const NOW_S = 1_700_000_000;
  const base = 'https://cdn.example.com/avatars/avatar.jpeg';

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(NOW_S * 1000);
    mockSignCloudFrontUrl.mockResolvedValue('signed-again');
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('keeps a signature that expires one second from now', async () => {
    const current = `${base}?Expires=${NOW_S + 1}&Signature=s&Key-Pair-Id=K`;

    expect(await resolveAvatarUrl(current)).toBe(current);
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });

  it.each([
    ['expiring this very second', `?Expires=${NOW_S}&Signature=s&Key-Pair-Id=K`],
    ['with a duplicated Signature', `?Expires=${NOW_S + 60}&Signature=s&Signature=t&Key-Pair-Id=K`],
    ['with no Key-Pair-Id', `?Expires=${NOW_S + 60}&Signature=s`],
    ['with an empty Signature', `?Expires=${NOW_S + 60}&Signature=&Key-Pair-Id=K`],
    ['with an empty Key-Pair-Id', `?Expires=${NOW_S + 60}&Signature=s&Key-Pair-Id=`],
    ['with a non-numeric Expires', '?Expires=soon&Signature=s&Key-Pair-Id=K'],
  ])('re-signs a URL %s, stripped of every auth parameter', async (_label, query) => {
    expect(await resolveAvatarUrl(`${base}${query}`)).toBe('signed-again');
    expect(mockSignCloudFrontUrl).toHaveBeenCalledExactlyOnceWith(base);
  });
});

describe('the configured CDN base', () => {
  async function resolveWithBase(cdnUrl: string, ref: string): Promise<string | undefined> {
    vi.resetModules();
    vi.stubEnv('AVATARS_CDN_URL', cdnUrl);
    try {
      const fresh = await import('./avatar-url.js');
      return await fresh.resolveAvatarUrl(ref);
    } finally {
      vi.unstubAllEnvs();
    }
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockSignCloudFrontUrl.mockImplementation((url: string) => Promise.resolve(`${url}?signed`));
  });

  it('ignores trailing slashes on the configured base', async () => {
    expect(await resolveWithBase('https://cdn.example.com/avatars//', 's3://bucket/avatars/p1.png'))
      .toBe('https://cdn.example.com/avatars/p1.png?signed');
    expect(await resolveWithBase('https://cdn.example.com/avatars//', 'https://cdn.example.com/avatars/p2.png'))
      .toBe('https://cdn.example.com/avatars/p2.png?signed');
  });

  it.each(['', 'cdn.example.com/avatars'])('trusts nothing when the base is not an absolute URL: %j', async (cdnUrl) => {
    expect(await resolveWithBase(cdnUrl, 's3://bucket/avatars/p1.png')).toBeUndefined();
    expect(await resolveWithBase(cdnUrl, 'https://cdn.example.com/avatars/p1.png')).toBeUndefined();
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });
});
