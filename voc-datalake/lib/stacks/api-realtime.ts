/**
 * The AppSync Events API that pushes notifications to the SPA (docs/realtime.md).
 *
 * - Auth: the app user pool (only the SPA's client, as the REST handlers allow) to connect and subscribe,
 *   IAM to publish. Each namespace pins those modes, and its onSubscribe handler refuses every channel but
 *   `/<namespace>/<the caller's own sub>` (lib/utils/realtime.ts).
 * - Publishers: `appsync:EventPublish` on exactly the namespace each one publishes to (grantPublish), and
 *   the Event API's HTTP host in its environment (`REALTIME_HTTP_DNS`). The agent conductor lives in
 *   VocProcessingStack, deployed first: its grant is a policy created HERE on its role, and it reads the
 *   host from an SSM parameter written here.
 * - Logs: errors only, to a stack-owned log group with the platform's retention (`LOG_RETENTION`), written
 *   by a role that may write only that group (no managed policy, no LogRetention custom resource).
 *
 * Pay per use, no fixed monthly cost (TENETS.md tenet 7). Resources are created on the stack itself
 * (api-context.ts): new logical ids only.
 */
import * as cdk from 'aws-cdk-lib';
import * as appsync from 'aws-cdk-lib/aws-appsync';
import * as iam from 'aws-cdk-lib/aws-iam';
import type * as lambda from 'aws-cdk-lib/aws-lambda';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import { LOG_RETENTION } from '../utils/log-retention';
import {
  REALTIME_API_BASE_NAME, REALTIME_HTTP_DNS_ENV, REALTIME_NAMESPACES, REALTIME_SUBSCRIBE_HANDLER_CODE,
  realtimeParameterName, type RealtimeNamespace,
} from '../utils/realtime';
import type { ApiStackContext } from './api-context';

export interface RealtimeApi {
  api: appsync.EventApi;
  namespaces: Record<RealtimeNamespace, appsync.ChannelNamespace>;
}

const { USER_POOL, IAM } = appsync.AppSyncAuthorizationType;

function createLogging(ctx: ApiStackContext, api: appsync.EventApi): void {
  const logGroup = new logs.LogGroup(ctx.stack, 'RealtimeEventApiLogs', {
    logGroupName: `/aws/appsync/apis/${api.apiId}`,
    retention: LOG_RETENTION,
    removalPolicy: cdk.RemovalPolicy.DESTROY,
  });
  const role = new iam.Role(ctx.stack, 'RealtimeEventApiLogsRole', {
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

/** The Event API, its three namespaces, the endpoint parameter and the outputs the frontend deploy reads. */
export function createRealtimeApi(ctx: ApiStackContext): RealtimeApi {
  const { stack, props } = ctx;
  const api = new appsync.EventApi(stack, 'RealtimeEventApi', {
    apiName: ctx.uniqueName(REALTIME_API_BASE_NAME),
    authorizationConfig: {
      authProviders: [
        {
          authorizationType: USER_POOL,
          // Only the SPA's own client (an MCP OAuth client's token of the same pool is refused, like the REST API).
          cognitoConfig: { userPool: props.userPool, appIdClientRegex: `^${props.userPoolClient.userPoolClientId}$` },
        },
        { authorizationType: IAM },
      ],
      connectionAuthModeTypes: [USER_POOL, IAM],
      defaultPublishAuthModeTypes: [IAM],
      defaultSubscribeAuthModeTypes: [USER_POOL],
    },
  });
  createLogging(ctx, api);
  const namespace = (key: RealtimeNamespace): appsync.ChannelNamespace => new appsync.ChannelNamespace(
    stack, `Realtime${key.charAt(0).toUpperCase()}${key.slice(1)}Namespace`, {
      api,
      channelNamespaceName: REALTIME_NAMESPACES[key],
      code: appsync.Code.fromInline(REALTIME_SUBSCRIBE_HANDLER_CODE),
      authorizationConfig: { publishAuthModeTypes: [IAM], subscribeAuthModeTypes: [USER_POOL] },
    },
  );
  const namespaces = { jobs: namespace('jobs'), chat: namespace('chat'), runs: namespace('runs') };

  new ssm.StringParameter(stack, 'RealtimeEndpointParameter', {
    parameterName: realtimeParameterName(ctx.deploymentPrefix),
    stringValue: api.httpDns,
    description: 'AppSync Events HTTP host the agent conductor publishes run notices to (docs/realtime.md)',
  });
  new cdk.CfnOutput(stack, 'RealtimeHttpDns', { value: api.httpDns, description: 'AppSync Events HTTP host (docs/realtime.md)' });
  new cdk.CfnOutput(stack, 'RealtimeDns', { value: api.realtimeDns, description: 'AppSync Events WebSocket host (docs/realtime.md)' });
  return { api, namespaces };
}

/** Let `functions` publish to exactly `namespace`, and tell them where the Event API is. */
export function grantRealtimePublish(realtime: RealtimeApi, namespace: RealtimeNamespace,
  functions: readonly lambda.Function[]): void {
  for (const fn of functions) {
    realtime.namespaces[namespace].grantPublish(fn);
    fn.addEnvironment(REALTIME_HTTP_DNS_ENV, realtime.api.httpDns);
  }
}

/**
 * The agent conductor's publish grant on `runs`: a policy created in THIS stack on its role (the role is
 * VocProcessingStack's, which cannot reference this stack). It reads the host from the SSM parameter.
 */
export function grantConductorRunsPublish(ctx: ApiStackContext, realtime: RealtimeApi, conductorRoleArn: string): void {
  const role = iam.Role.fromRoleArn(ctx.stack, 'AgentConductorRoleRef', conductorRoleArn, { mutable: true });
  realtime.namespaces.runs.grantPublish(role);
}

/**
 * Publish grants for Lambdas of the stacks deployed BEFORE this one (their roles by ARN, keyed by a stable
 * name that becomes the role reference's construct id): a policy created HERE on each role, on exactly
 * `namespace`. They read the host from the SSM parameter (lib/utils/realtime.ts `wireRealtimeEndpointParameter`).
 */
export function grantRealtimePublishToRoles(ctx: ApiStackContext, realtime: RealtimeApi, namespace: RealtimeNamespace,
  roleArns: Readonly<Record<string, string>>): void {
  for (const [name, roleArn] of Object.entries(roleArns)) {
    const role = iam.Role.fromRoleArn(ctx.stack, `Realtime${name}RoleRef`, roleArn, { mutable: true });
    realtime.namespaces[namespace].grantPublish(role);
  }
}

/** The SPA's runtime config block: where to connect (both hosts, no scheme). */
export function realtimeRuntimeConfig(realtime: RealtimeApi): Record<string, unknown> {
  return { realtime: { httpDns: realtime.api.httpDns, realtimeDns: realtime.api.realtimeDns } };
}
