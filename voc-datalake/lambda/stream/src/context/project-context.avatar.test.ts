import { DynamoDBClient } from '@aws-sdk/client-dynamodb';
import { DynamoDBDocumentClient } from '@aws-sdk/lib-dynamodb';
import {
  afterAll, beforeEach, describe, expect, it, vi,
} from 'vitest';

const { mockSignCloudFrontUrl, previousAvatarsCdnUrl } = vi.hoisted(() => {
  const previous = process.env.AVATARS_CDN_URL;
  process.env.AVATARS_CDN_URL = 'https://cdn.example.com/avatars';
  return {
    mockSignCloudFrontUrl: vi.fn(),
    previousAvatarsCdnUrl: previous,
  };
});

vi.mock('../lib/cloudfront-signing.js', () => ({
  signCloudFrontUrl: mockSignCloudFrontUrl,
}));

import { buildRoundtableContext } from './project-context.js';

const docClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const project = {
  pk: 'PROJECT#p1',
  sk: 'META',
  project_id: 'p1',
  name: 'Project',
};
const selectedDocument = {
  pk: 'PROJECT#p1',
  sk: 'PRD#d1',
  document_id: 'd1',
  document_type: 'prd',
  base_title: 'Launch',
  version: 1,
  title: 'Launch (v1)',
  content: '# Launch',
};

function persona(avatarUrl: string) {
  return {
    pk: 'PROJECT#p1',
    sk: 'PERSONA#one',
    persona_id: 'one',
    name: 'One',
    avatar_url: avatarUrl,
  };
}

async function roundtableFor(avatarUrl: string) {
  const loadProject = vi.fn().mockResolvedValue([
    project,
    persona(avatarUrl),
    selectedDocument,
  ]);
  return buildRoundtableContext(
    docClient,
    loadProject,
    '',
    'p1',
    'Discuss',
    ['one'],
    ['d1'],
  );
}

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

describe('roundtable canonical avatar URLs', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockSignCloudFrontUrl.mockImplementation((url: string) => {
      const separator = url.includes('?') ? '&' : '?';
      const expires = Math.floor(Date.now() / 1000) + 3600;
      return Promise.resolve(
        `${url}${separator}Expires=${expires}&Signature=stream&Key-Pair-Id=KSTREAM`,
      );
    });
  });

  it('preserves a current Projects API signature without signing again', async () => {
    const expires = Math.floor(Date.now() / 1000) + 3600;
    const canonical = `https://cdn.example.com/avatars/avatar.jpeg?v=2&Expires=${expires}&Signature=python&Key-Pair-Id=KPYTHON`;

    const context = await roundtableFor(canonical);

    expect(context.personas[0].avatar_url).toBe(canonical);
    expectOneAuthParameterSet(context.personas[0].avatar_url ?? '');
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });

  it('removes expired auth parameters before signing a legacy URL once', async () => {
    const expired = Math.floor(Date.now() / 1000) - 1;
    const stale = `https://cdn.example.com/avatars/avatar.jpeg?v=2&Expires=${expired}&Signature=old&Key-Pair-Id=KOLD`;

    const context = await roundtableFor(stale);

    expect(mockSignCloudFrontUrl).toHaveBeenCalledOnce();
    const unsignedUrl = mockSignCloudFrontUrl.mock.calls[0][0];
    const parsedUnsigned = new URL(unsignedUrl);
    expect(parsedUnsigned.searchParams.get('v')).toBe('2');
    expect(parsedUnsigned.searchParams.has('Expires')).toBe(false);
    expect(parsedUnsigned.searchParams.has('Signature')).toBe(false);
    expect(parsedUnsigned.searchParams.has('Key-Pair-Id')).toBe(false);
    expectOneAuthParameterSet(context.personas[0].avatar_url ?? '');
  });

  it.each([
    'https://tracker.example.net/avatars/avatar.jpeg',
    'https://cdn.example.com/prototypes/avatar.jpeg',
  ])('refuses an avatar outside the configured CDN path: %s', async (untrusted) => {
    const context = await roundtableFor(untrusted);

    expect(context.personas[0].avatar_url).toBeUndefined();
    expect(mockSignCloudFrontUrl).not.toHaveBeenCalled();
  });
});
