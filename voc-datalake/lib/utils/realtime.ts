/**
 * Push notifications over AWS AppSync Events (docs/realtime.md): the single source of the channel
 * namespaces, the namespace subscribe handler and the publisher wiring (`grantRealtimePublish`). The
 * Event API lives in VocCoreStack (core-realtime.ts), deployed before every publisher's stack.
 *
 * Pay per use (operations + connection minutes), no fixed monthly cost: nothing here belongs in
 * `OPT_IN_FIXED_COSTS` (lib/test-support/fixed-cost-rules.ts, TENETS.md tenet 7).
 *
 * Channels are `/<namespace>/<cognito sub>`. A browser may subscribe only to its own sub's channels
 * (the handler below, run by AppSync on every subscribe), and only IAM may publish (each namespace's
 * publish auth mode), so a browser can never publish and never read another person's notices.
 */
import type * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';

/** The namespaces and who publishes to each (docs/realtime.md → Channels). */
export const REALTIME_NAMESPACES = {
  /**
   * Job ends (shared/assist_jobs.py, shared/job_notices.py): the projects, settings and scrapers APIs and their
   * assist twins, the project job Lambdas, and the job workers of VocProcessingStack / VocIngestionStack.
   */
  jobs: 'jobs',
  /** The assistant's server-side session (voc-chat-stream): a run ended. */
  chat: 'chat',
  /** Agent runs and approved plans (voc-agent-conductor): a status changed. */
  runs: 'runs',
} as const;

export type RealtimeNamespace = keyof typeof REALTIME_NAMESPACES;

/** Base physical name of the Event API (before `uniqueName()`); AppSync caps API names at 50 characters. */
export const REALTIME_API_BASE_NAME = 'voc-events';

/** The one env var of a Python or Node publisher: the Event API's HTTP host (`<id>.appsync-api.<region>.amazonaws.com`). */
export const REALTIME_HTTP_DNS_ENV = 'REALTIME_HTTP_DNS';

/**
 * The namespace subscribe handler (APPSYNC_JS). A subscription is allowed only to exactly
 * `/<namespace>/<the caller's own sub>`: no wildcard, no deeper path, no other person's sub.
 * `ownChannel` is the whole decision; lib/utils/realtime-subscribe.test.ts runs it through `onSubscribe`.
 * `onSubscribe` must stay the module's only export: APPSYNC_JS refuses to call an exported function from
 * inside the module ("Invalid function: … INVALID_FUNCTION_INVOCATION"), which failed the 6.04.00 deploy.
 */
export const REALTIME_SUBSCRIBE_HANDLER_CODE = `import { util } from '@aws-appsync/utils';

function ownChannel(segments, sub) {
  if (typeof sub !== 'string' || sub.length === 0) return false;
  if (!Array.isArray(segments) || segments.length !== 2) return false;
  return segments[1] === sub;
}

export function onSubscribe(ctx) {
  const identity = ctx.identity || {};
  if (!ownChannel(ctx.info.channel.segments, identity.sub)) {
    util.unauthorized();
  }
}
`;

/**
 * What a publisher in ANY stack needs from VocCoreStack's Event API: its HTTP host and, per namespace, the
 * customer-managed policy allowing exactly `appsync:EventPublish` on that namespace (core-realtime.ts).
 */
export interface RealtimePublishing {
  httpDns: string;
  publishPolicies: Readonly<Record<RealtimeNamespace, iam.IManagedPolicy>>;
}

/**
 * Let `functions` publish to exactly `namespace`: each one's role carries the namespace's managed policy (attached
 * in the function's own stack, so no inline statement and no resource in VocCoreStack per role), and its
 * environment names the Event API's host.
 */
export function grantRealtimePublish(realtime: RealtimePublishing, namespace: RealtimeNamespace,
  functions: readonly lambda.Function[]): void {
  for (const fn of functions) {
    const { role } = fn;
    if (role === undefined) throw new Error(`${fn.node.path} has no role to grant the realtime publish`);
    role.addManagedPolicy(realtime.publishPolicies[namespace]);
    fn.addEnvironment(REALTIME_HTTP_DNS_ENV, realtime.httpDns);
  }
}
