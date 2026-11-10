/** lib/realtime-publish.ts: the signed AppSync Events publish, best effort, and off without an endpoint. */
import { describe, expect, it, vi } from 'vitest';
import { createRealtimePublisher } from './realtime-publish.js';
import type { SignedPost } from './sigv4.js';

const HOST = 'abc123.appsync-api.us-east-1.amazonaws.com';
const SUB = '0a1b2c3d-1111-4222-8333-444455556666';

function fakePost(response: Response | Error) {
  return vi.fn<(request: SignedPost) => Promise<Response>>(() => (
    response instanceof Error ? Promise.reject(response) : Promise.resolve(response)));
}

describe('createRealtimePublisher', () => {
  it('is off without a well-formed host or a region', () => {
    expect(createRealtimePublisher({ host: undefined, region: 'us-east-1' })).toBeUndefined();
    expect(createRealtimePublisher({ host: 'https://evil.example/x', region: 'us-east-1' })).toBeUndefined();
    expect(createRealtimePublisher({ host: HOST, region: '' })).toBeUndefined();
  });

  it('posts one event to /<namespace>/<sub>, signed for appsync in the region', async () => {
    const post = fakePost(new Response('{}', { status: 200 }));
    const publish = createRealtimePublisher({ host: HOST, region: 'eu-west-1', post });
    await expect(publish?.('chat', SUB, { type: 'session', revision: 3 })).resolves.toBe(true);
    const request = post.mock.calls[0]?.[0];
    expect(request).toMatchObject({ url: `https://${HOST}/event`, service: 'appsync', region: 'eu-west-1' });
    const body: unknown = JSON.parse(request?.body ?? '{}');
    expect(body).toStrictEqual({ channel: `/chat/${SUB}`, events: [JSON.stringify({ type: 'session', revision: 3 })] });
  });

  it('refuses a value that is not a sub, without sending', async () => {
    const post = fakePost(new Response('{}', { status: 200 }));
    const publish = createRealtimePublisher({ host: HOST, region: 'us-east-1', post });
    await expect(publish?.('chat', '*', {})).resolves.toBe(false);
    await expect(publish?.('chat', `${SUB}/x`, {})).resolves.toBe(false);
    expect(post).not.toHaveBeenCalled();
  });

  it('resolves false, never rejects, on a refusal or a network failure', async () => {
    vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const refused = createRealtimePublisher({ host: HOST, region: 'us-east-1', post: fakePost(new Response('', { status: 403 })) });
    await expect(refused?.('chat', SUB, {})).resolves.toBe(false);
    const down = createRealtimePublisher({ host: HOST, region: 'us-east-1', post: fakePost(new TypeError('fetch failed')) });
    await expect(down?.('chat', SUB, {})).resolves.toBe(false);
  });
});
