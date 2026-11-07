/**
 * The AppSync Events API that pushes notifications to the SPA (docs/realtime.md), in VocCoreStack: it deploys
 * before every publisher's stack and holds the user pool the API authorizes against.
 *
 * - Auth: the app user pool (only the SPA's client, as the REST handlers allow) to connect and subscribe,
 *   IAM to publish. Each namespace pins those modes, and its onSubscribe handler refuses every channel but
 *   `/<namespace>/<the caller's own sub>` (lib/utils/realtime.ts).
 * - Publishers: one customer-managed policy per namespace, `appsync:EventPublish` on exactly that namespace.
 *   Each publisher's stack attaches it to the publisher's role and puts the Event API's HTTP host in its
 *   environment (`REALTIME_HTTP_DNS`) as a plain stack reference (lib/utils/realtime.ts `grantRealtimePublish`).
 * - Logs: errors only, to a stack-owned log group with the platform's retention (`LOG_RETENTION`), written
 *   by a role that may write only that group (no managed policy, no LogRetention custom resource).
 *
 * Pay per use, no fixed monthly cost (TENETS.md tenet 7).
 */
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import type * as cognito from 'aws-cdk-lib/aws-cognito';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as logs from 'aws-cdk-lib/aws-logs';
import { LOG_RETENTION } from '../utils/log-retention';
import {
  REALTIME_API_BASE_NAME, REALTIME_NAMESPACES, REALTIME_SUBSCRIBE_HANDLER_CODE,
  type RealtimeNamespace, type RealtimePublishing,
} from '../utils/realtime';
import type { CoreBuildContext } from './core-cdn';

export interface CoreRealtime extends RealtimePublishing {
  /** The WebSocket host the SPA connects to (no scheme). */
  realtimeDns: string;
}

const { USER_POOL, IAM } = appsync.AppSyncAuthorizationType;

const capitalized = (key: string): string => `${key.charAt(0).toUpperCase()}${key.slice(1)}`;

function createLogging(stack: cdk.Stack, api: appsync.EventApi): void {
  const logGroup = new logs.LogGroup(stack, 'RealtimeEventApiLogs', {
    logGroupName: `/aws/appsync/apis/${api.apiId}`,
    retention: LOG_RETENTION,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const role = new iam.Role(stack, 'RealtimeEventApiLogsRole', {
    assumedBy: new iam.ServicePrincipal('appsync.amazonaws.com'),
  });
  role.addToPolicy(new iam.PolicyStatement({
    actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
    resources: [logGroup.logGroupArn],
  }));
  const cfn = api.node.defaultChild;
  if (!(cfn instanceof appsync.CfnApi)) throw new Error('EventApi has no CfnApi default child');
  cfn.addPropertyOverride('EventConfig.LogConfig', { CloudWatchLogsRoleArn: role.roleArn, LogLevel: 'ERROR' });
}

/** `appsync:EventPublish` on exactly `namespace`, as a managed policy the publishers' stacks attach. */
function publishPolicy(stack: cdk.Stack, api: appsync.EventApi, key: RealtimeNamespace): iam.ManagedPolicy {
  return new iam.ManagedPolicy(stack, `Realtime${capitalized(key)}PublishPolicy`, {
    description: `Publish notices to the AppSync Events namespace ${REALTIME_NAMESPACES[key]} (docs/realtime.md)`,
    statements: [new iam.PolicyStatement({
      actions: ['appsync:EventPublish'],
      resources: appsync.AppSyncEventResource.ofChannelNamespace(REALTIME_NAMESPACES[key]).resourceArns(api),
    })],
  });
}

/** The Event API, its three namespaces, one publish policy each, and the outputs the frontend deploy reads. */
export function createCoreRealtime(ctx: CoreBuildContext, userPool: cognito.IUserPool,
  userPoolClient: cognito.IUserPoolClient): CoreRealtime {
  const { stack } = ctx;
  const api = new appsync.EventApi(stack, 'RealtimeEventApi', {
    apiName: ctx.uniqueName(REALTIME_API_BASE_NAME),
    authorizationConfig: {
      authProviders: [
        {
          authorizationType: USER_POOL,
          // Only the SPA's own client (an MCP OAuth client's token of the same pool is refused, like the REST API).
          cognitoConfig: { userPool, appIdClientRegex: `^${userPoolClient.userPoolClientId}$` },
        },
        { authorizationType: IAM },
      ],
      connectionAuthModeTypes: [USER_POOL, IAM],
      defaultPublishAuthModeTypes: [IAM],
      defaultSubscribeAuthModeTypes: [USER_POOL],
    },
  });
  createLogging(stack, api);
  // Each namespace with its publish policy (the policy names the namespace by its name, under this API).
  const namespaceWithPolicy = (key: RealtimeNamespace): iam.ManagedPolicy => {
    new appsync.ChannelNamespace(stack, `Realtime${capitalized(key)}Namespace`, {
      api,
      channelNamespaceName: REALTIME_NAMESPACES[key],
      code: appsync.Code.fromInline(REALTIME_SUBSCRIBE_HANDLER_CODE),
      authorizationConfig: { publishAuthModeTypes: [IAM], subscribeAuthModeTypes: [USER_POOL] },
    });
    return publishPolicy(stack, api, key);
  };
  const publishPolicies = { jobs: namespaceWithPolicy('jobs'), chat: namespaceWithPolicy('chat'), runs: namespaceWithPolicy('runs') };

  new cdk.CfnOutput(stack, 'RealtimeHttpDns', { value: api.httpDns, description: 'AppSync Events HTTP host (docs/realtime.md)' });
  new cdk.CfnOutput(stack, 'RealtimeDns', { value: api.realtimeDns, description: 'AppSync Events WebSocket host (docs/realtime.md)' });
  return { httpDns: api.httpDns, realtimeDns: api.realtimeDns, publishPolicies };
}

/** The SPA's runtime config block: where to connect (both hosts, no scheme). */
export function realtimeRuntimeConfig(realtime: Pick<CoreRealtime, 'httpDns' | 'realtimeDns'>): Record<string, unknown> {
  return { realtime: { httpDns: realtime.httpDns, realtimeDns: realtime.realtimeDns } };
}
