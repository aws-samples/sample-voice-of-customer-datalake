/**
 * Push notifications over AWS AppSync Events (docs/realtime.md): the single source of the channel
 * namespaces, the namespace subscribe handler and the SSM parameter that tells VocProcessingStack's
 * conductor where the Event API is.
 *
 * Pay per use (operations + connection minutes), no fixed monthly cost: nothing here belongs in
 * `OPT_IN_FIXED_COSTS` (lib/test-support/fixed-cost-rules.ts, TENETS.md tenet 7).
 *
 * Channels are `/<namespace>/<cognito sub>`. A browser may subscribe only to its own sub's channels
 * (the handler below, run by AppSync on every subscribe), and only IAM may publish (each namespace's
 * publish auth mode), so a browser can never publish and never read another person's notices.
 */
import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';

/** The namespaces and who publishes to each (docs/realtime.md → Channels). */
export const REALTIME_NAMESPACES = {
  /** Assist jobs (shared/assist_jobs.py): the projects, settings and scrapers APIs and their assist twins. */
  jobs: 'jobs',
  /** The assistant's server-side session (voc-chat-stream): a run ended. */
  chat: 'chat',
  /** Agent runs and approved plans (voc-agent-conductor): a status changed. */
  runs: 'runs',
} as const;

export type RealtimeNamespace = keyof typeof REALTIME_NAMESPACES;

/** Base physical name of the Event API (before `uniqueName()`); AppSync caps API names at 50 characters. */
export const REALTIME_API_BASE_NAME = 'voc-events';

/** Env var of a Python or Node publisher: the Event API's HTTP host (`<id>.appsync-api.<region>.amazonaws.com`). */
export const REALTIME_HTTP_DNS_ENV = 'REALTIME_HTTP_DNS';
/** Env var of a publisher OUTSIDE VocApiStack: the SSM parameter holding that host (read once per container). */
export const REALTIME_HTTP_DNS_PARAMETER_ENV = 'REALTIME_HTTP_DNS_PARAMETER';

/**
 * The namespace subscribe handler (APPSYNC_JS). A subscription is allowed only to exactly
 * `/<namespace>/<the caller's own sub>`: no wildcard, no deeper path, no other person's sub.
 * `ownChannel` is the whole decision; lib/utils/realtime-subscribe.test.ts runs it.
 */
export const REALTIME_SUBSCRIBE_HANDLER_CODE = `import { util } from '@aws-appsync/utils';

export function ownChannel(segments, sub) {
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

const REALTIME_PARAMETER_PATH = 'voc/realtime/event-api-http-dns';

/**
 * `/[<prefix>-]voc/realtime/event-api-http-dns`: a standard-tier String parameter (no monthly cost)
 * VocApiStack writes and the agent conductor (VocProcessingStack, deployed BEFORE VocApiStack, so it
 * cannot take the host as a stack reference) reads at run time. The prefix sits on the `voc` segment,
 * as `DeploymentNaming.prefixed` places it (lib/utils/radar-exa-parameter.ts is the precedent).
 */
export function realtimeParameterName(deploymentPrefix: string | undefined): string {
  return deploymentPrefix ? `/${deploymentPrefix}-${REALTIME_PARAMETER_PATH}` : `/${REALTIME_PARAMETER_PATH}`;
}

/** Exactly `ssm:GetParameter` on that parameter in `stack`'s account and region. */
export function realtimeParameterReadStatement(stack: cdk.Stack, deploymentPrefix: string | undefined): iam.PolicyStatement {
  return new iam.PolicyStatement({
    sid: 'RealtimeEndpointParameter',
    actions: ['ssm:GetParameter'],
    resources: [stack.formatArn({
      service: 'ssm', resource: 'parameter', resourceName: realtimeParameterName(deploymentPrefix).slice(1),
      arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
    })],
  });
}
