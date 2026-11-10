/**
 * The AppSync Events API in VocCoreStack (core-realtime.ts, docs/realtime.md): Cognito (the SPA's client only) to
 * connect and subscribe, IAM to publish, every namespace guarded by the own-channel subscribe handler, one managed
 * publish policy per namespace on exactly that namespace, errors-only logs in a stack-owned group, and no
 * fixed-cost resource (TENETS.md tenet 7). VocApiStack's publishers carry exactly their namespace's policy and the
 * host; the stack itself creates no Event API resource.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';
import { IamPolicySchema, statementActions } from '../test-support/iam-statements';

import { apiTemplate, buildApiStack } from '../test-support/api-stack-template';
import { synthCoreTemplate } from '../test-support/core-stack-fixture';
import { fixedCostFindings } from '../test-support/fixed-cost-rules';
import { FIXTURE_REALTIME_HTTP_DNS } from '../test-support/fixture-resources';
import { realtimeNamespacesOfRole } from '../test-support/realtime-assertions';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { REALTIME_HTTP_DNS_ENV, REALTIME_SUBSCRIBE_HANDLER_CODE } from '../utils/realtime';

let core: Template;
beforeAll(() => {
  core = synthCoreTemplate();
  apiTemplate();
}, SYNTH_TIMEOUT_MS);

const AuthModes = z.array(z.object({ AuthType: z.string() }));
const ApiSchema = z.object({
  Properties: z.object({
    EventConfig: z.object({
      AuthProviders: z.array(z.object({
        AuthType: z.string(),
        CognitoConfig: z.object({ AppIdClientRegex: z.unknown(), UserPoolId: z.unknown() }).optional(),
      })),
      ConnectionAuthModes: AuthModes,
      DefaultPublishAuthModes: AuthModes,
      DefaultSubscribeAuthModes: AuthModes,
      LogConfig: z.object({ LogLevel: z.string(), CloudWatchLogsRoleArn: z.unknown() }),
    }),
  }),
});
const NamespaceSchema = z.object({
  Properties: z.object({
    Name: z.string(),
    CodeHandlers: z.string(),
    PublishAuthModes: AuthModes,
    SubscribeAuthModes: AuthModes,
  }),
});

const types = (modes: z.infer<typeof AuthModes>) => modes.map((m) => m.AuthType).sort(byCodeUnit);

function onlyApi() {
  const apis = Object.values(core.findResources('AWS::AppSync::Api'));
  expect(apis).toHaveLength(1);
  return ApiSchema.parse(apis[0]).Properties.EventConfig;
}

/** Core's managed policy id → the one namespace its statements publish on (every statement must be EventPublish). */
function corePublishPolicies(): Record<string, string> {
  const found: Record<string, string> = {};
  for (const [id, resource] of Object.entries(core.findResources('AWS::IAM::ManagedPolicy'))) {
    const { Statement } = IamPolicySchema.parse(resource).Properties.PolicyDocument;
    if (!JSON.stringify(Statement).includes('appsync:')) continue;
    expect(Statement.map((statement) => statementActions(statement)), id).toStrictEqual([['appsync:EventPublish']]);
    const namespaces = [...JSON.stringify(Statement).matchAll(/channelNamespace\/(\w+)/g)].map((m) => m[1]);
    expect(namespaces, id).toHaveLength(1);
    found[id.replace(/[0-9A-F]{8}$/, '')] = namespaces[0] ?? '?';
  }
  return found;
}

/** namespace → VocApiStack's roles carrying its publish policy. */
function apiPublishersByNamespace(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const roleId of Object.keys(apiTemplate().findResources('AWS::IAM::Role'))) {
    for (const namespace of realtimeNamespacesOfRole(apiTemplate(), roleId)) {
      found.set(namespace, [...found.get(namespace) ?? [], roleId].sort(byCodeUnit));
    }
  }
  return found;
}

/** VocApiStack's roles that publish on `jobs` (a fragment of their logical id); the other stacks' publishers are
 * checked by agent-runtime-realtime.test.ts and ingestion-job-notices.test.ts. */
const API_JOBS_PUBLISHERS = [
  'ProjectsLambdaRole', 'SettingsLambdaRole', 'ScrapersLambdaRole',
  'PersonaGeneratorRole', 'DocumentGeneratorRole', 'DocumentMergerRole', 'PersonaImporterRole',
  'ManualImportProcessorRole',
];

describe('the Event API', () => {
  it('connects and subscribes with the app pool (the SPA client only) and publishes with IAM only', () => {
    const config = onlyApi();
    expect(config.AuthProviders.map((p) => p.AuthType).sort(byCodeUnit)).toStrictEqual(['AMAZON_COGNITO_USER_POOLS', 'AWS_IAM']);
    expect({
      publish: types(config.DefaultPublishAuthModes),
      subscribe: types(config.DefaultSubscribeAuthModes),
      connect: types(config.ConnectionAuthModes),
    }).toStrictEqual({
      publish: ['AWS_IAM'], subscribe: ['AMAZON_COGNITO_USER_POOLS'], connect: ['AMAZON_COGNITO_USER_POOLS', 'AWS_IAM'],
    });
  });

  it('admits only the SPA\'s own app client (an anchored client-id regex)', () => {
    const cognito = onlyApi().AuthProviders.find((p) => p.AuthType === 'AMAZON_COGNITO_USER_POOLS')?.CognitoConfig;
    const regex = JSON.stringify(cognito?.AppIdClientRegex);
    expect(regex.startsWith('{"Fn::Join":["",["^",')).toBe(true);
    expect(regex.endsWith(',"$"]]}')).toBe(true);
  });

  it('has the jobs, chat and runs namespaces, each IAM-publish, Cognito-subscribe, behind the own-channel handler', () => {
    const namespaces = Object.values(core.findResources('AWS::AppSync::ChannelNamespace'))
      .map((n) => NamespaceSchema.parse(n).Properties);
    expect(namespaces.map((n) => n.Name).sort(byCodeUnit)).toStrictEqual(['chat', 'jobs', 'runs']);
    for (const namespace of namespaces) {
      expect({
        publish: types(namespace.PublishAuthModes), subscribe: types(namespace.SubscribeAuthModes), code: namespace.CodeHandlers,
      }, namespace.Name).toStrictEqual({
        publish: ['AWS_IAM'], subscribe: ['AMAZON_COGNITO_USER_POOLS'], code: REALTIME_SUBSCRIBE_HANDLER_CODE,
      });
    }
    expect(REALTIME_SUBSCRIBE_HANDLER_CODE).toContain('util.unauthorized()');
  });

  it('has one managed publish policy per namespace, each on exactly that namespace', () => {
    expect(corePublishPolicies()).toStrictEqual({
      RealtimeChatPublishPolicy: 'chat', RealtimeJobsPublishPolicy: 'jobs', RealtimeRunsPublishPolicy: 'runs',
    });
  });

  it('attaches each VocApiStack publisher\'s namespace policy to its role, and nothing else in that stack', () => {
    const publishers = apiPublishersByNamespace();
    expect([...publishers.keys()].sort(byCodeUnit)).toStrictEqual(['chat', 'jobs']);
    // projects / settings / scrapers roles (each shared with its assist twin, so one attachment per role), the
    // project job Lambdas' roles and the manual import processor's.
    const jobs = publishers.get('jobs') ?? [];
    const named = (roles: string[] | undefined, fragment: string) => roles?.some((role) => role.includes(fragment)) === true;
    expect(jobs).toHaveLength(API_JOBS_PUBLISHERS.length);
    expect(API_JOBS_PUBLISHERS.filter((f) => !named(jobs, f))).toStrictEqual([]);
    expect([publishers.get('chat')?.length, named(publishers.get('chat'), 'ChatStream')]).toStrictEqual([1, true]);
  });

  it('leaves VocApiStack without an appsync statement or an Event API resource of its own', () => {
    const api = apiTemplate();
    expect(JSON.stringify(api.findResources('AWS::IAM::Policy'))).not.toContain('appsync:');
    expect(Object.keys({ ...api.findResources('AWS::AppSync::Api'), ...api.findResources('AWS::AppSync::ChannelNamespace'),
      ...api.findResources('AWS::SSM::Parameter') })).toStrictEqual([]);
  });

  it('tells each publisher where to publish', () => {
    const functions = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter(([, fn]) => JSON.stringify(fn).includes(`"${REALTIME_HTTP_DNS_ENV}":"${FIXTURE_REALTIME_HTTP_DNS}"`))
      .map(([id]) => id.replace(/[0-9A-F]{8}$/, ''))
      .sort(byCodeUnit);
    expect(functions).toStrictEqual([
      'ChatStreamApi', 'DocumentGeneratorJob', 'DocumentMergerJob', 'ManualImportProcessor', 'PersonaGeneratorJob',
      'PersonaImporterJob',
      'ProjectsApi', 'ProjectsAssistWorker', 'ScrapersApi', 'ScrapersAssistWorker', 'SettingsApi', 'SettingsAssistWorker',
    ]);
  });

  it('logs errors only, to a log group with the platform retention, through a role that writes only it', () => {
    expect(onlyApi().LogConfig.LogLevel).toBe('ERROR');
    const groups = Object.values(core.findResources('AWS::Logs::LogGroup'))
      .filter((g) => JSON.stringify(g).includes('/aws/appsync/apis/'));
    expect(groups).toHaveLength(1);
    expect(JSON.stringify(groups[0])).toContain('"RetentionInDays":30');
    expect(Object.keys(core.findResources('Custom::LogRetention'))).toStrictEqual([]);
  });

  it('declares the outputs the frontend deploy reads, and writes no SSM parameter', () => {
    expect(['RealtimeHttpDns', 'RealtimeDns'].filter((key) => !(key in core.findOutputs('*')))).toStrictEqual([]);
    expect(Object.keys(core.findResources('AWS::SSM::Parameter')).filter((id) => id.startsWith('Realtime'))).toStrictEqual([]);
  });

  it('carries no fixed monthly cost (TENETS.md tenet 7)', () => {
    expect(fixedCostFindings('VocCoreStack', core.toJSON())).toStrictEqual([]);
  });

  it('puts both hosts in the runtime config', () => {
    const realtime = z.object({ realtime: z.object({ httpDns: z.unknown(), realtimeDns: z.unknown() }) })
      .safeParse(buildApiStack().runtimeConfig);
    expect(realtime.success).toBe(true);
  }, SYNTH_TIMEOUT_MS);
});
