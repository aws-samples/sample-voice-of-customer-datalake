/**
 * Push notifications over AWS AppSync Events (docs/realtime.md): the stream Lambda's publisher, the Node
 * twin of lambda/shared/realtime.py.
 *
 * `POST https://<REALTIME_HTTP_DNS>/event` `{channel: '/<namespace>/<sub>', events: ['<json>']}`, SigV4 for
 * `appsync` with the role's credentials (`appsync:EventPublish` on exactly the `chat` namespace,
 * lib/stacks/api-realtime.ts). Best effort: a failure is logged by name and resolves false, never
 * rejects, so a run never fails because a notice was lost (the SPA's polling is the fallback).
 */
import { signedPost, type SignedPost } from './sigv4.js';
import { errorName } from './error-name.js';

export type RealtimeNamespace = 'jobs' | 'chat' | 'runs';

/** Send one notice to `sub`'s channel; resolves true when AppSync accepted it. Never rejects. */
export type PublishNotice = (namespace: RealtimeNamespace, sub: string, event: Record<string, unknown>) => Promise<boolean>;

const TIMEOUT_MS = 3000;
const DNS_LABEL = /^[a-z0-9-]{1,63}$/;

/** A bare DNS host (`<id>.appsync-api.<region>.amazonaws.com`): no scheme, port or path. */
function isHost(value: string): boolean {
  const labels = value.split('.');
  return labels.length >= 2 && labels.every((label) => DNS_LABEL.test(label));
}
/** A Cognito sub (a UUID); anything else cannot name a channel segment. */
const SUB = /^[A-Za-z0-9-]{1,128}$/;

export interface PublisherConfig {
  host: string | undefined;
  region: string | undefined;
  post?: (request: SignedPost) => Promise<Response>;
}

/** The publisher, or undefined when the Event API is not configured here (then nothing is sent). */
export function createRealtimePublisher({ host, region, post = signedPost }: PublisherConfig): PublishNotice | undefined {
  if (host === undefined || !isHost(host) || region === undefined || region === '') return undefined;
  return async (namespace, sub, event) => {
    if (!SUB.test(sub)) return false;
    const body = JSON.stringify({ channel: `/${namespace}/${sub}`, events: [JSON.stringify(event)] });
    try {
      const response = await post({ url: `https://${host}/event`, body, service: 'appsync', region, timeoutMs: TIMEOUT_MS });
      if (!response.ok) console.warn(`Realtime notice refused: ${response.status}`);
      return response.ok;
    } catch (error) {
      console.warn(`Realtime notice not sent: ${errorName(error)}`);
      return false;
    }
  };
}
