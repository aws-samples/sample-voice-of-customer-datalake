/**
 * The AppSync Events API (api-realtime.ts, docs/realtime.md): Cognito (the SPA's client only) to connect and
 * subscribe, IAM to publish, every namespace guarded by the own-channel subscribe handler, publish granted per
 * namespace to exactly the Lambdas that publish there, errors-only logs in a stack-owned group, and no
 * fixed-cost resource (TENETS.md tenet 7).
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';

import { apiTemplate, buildApiStack } from '../test-support/api-stack-template';
import { fixedCostFindings } from '../test-support/fixed-cost-rules';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';
import { REALTIME_HTTP_DNS_ENV, REALTIME_SUBSCRIBE_HANDLER_CODE, realtimeParameterName } from '../utils/realtime';

beforeAll(() => {
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
const PolicySchema = z.object({
  Properties: z.object({
    Roles: z.array(z.unknown()),
    PolicyDocument: z.object({
      Statement: z.array(z.object({ Action: z.union([z.string(), z.array(z.string())]), Resource: z.unknown() })),
    }),
  }),
});

const types = (modes: z.infer<typeof AuthModes>) => modes.map((m) => m.AuthType).sort(byCodeUnit);

function onlyApi() {
  const apis = Object.values(apiTemplate().findResources('AWS::AppSync::Api'));
  expect(apis).toHaveLength(1);
  return ApiSchema.parse(apis[0]).Properties.EventConfig;
}

/** namespace name → the role references of every policy that grants appsync:EventPublish on it. */
function publishersByNamespace(): Map<string, string[]> {
  const found = new Map<string, string[]>();
  for (const policy of Object.values(apiTemplate().findResources('AWS::IAM::Policy'))) {
    const { Roles, PolicyDocument } = PolicySchema.parse(policy).Properties;
    for (const statement of PolicyDocument.Statement) {
      const actions = Array.isArray(statement.Action) ? statement.Action : [statement.Action];
      if (!actions.some((a) => a.startsWith('appsync:'))) continue;
      expect(actions).toStrictEqual(['appsync:EventPublish']);
      const namespace = /channelNamespace\/(\w+)/.exec(JSON.stringify(statement.Resource))?.[1] ?? '?';
      found.set(namespace, [...found.get(namespace) ?? [], ...Roles.map((r) => JSON.stringify(r))].sort(byCodeUnit));
    }
  }
  return found;
}

/** Every role that may publish on `jobs` (a fragment of its reference): one grant each. */
const JOBS_PUBLISHERS = [
  'ProjectsLambdaRole', 'SettingsLambdaRole', 'ScrapersLambdaRole',
  'PersonaGeneratorRole', 'DocumentGeneratorRole', 'DocumentMergerRole', 'PersonaImporterRole',
  'voc-research-step-role', 'voc-category-reprocess-role',
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
    const namespaces = Object.values(apiTemplate().findResources('AWS::AppSync::ChannelNamespace'))
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

  it('grants publish per namespace to exactly its publishers', () => {
    const publishers = publishersByNamespace();
    expect([...publishers.keys()].sort(byCodeUnit)).toStrictEqual(['chat', 'jobs', 'runs']);
    // projects / settings / scrapers roles (each shared with its assist twin, so one grant per role is enough), the
    // project job Lambdas' roles, and the earlier stacks' job workers, referenced by name and granted here.
    const jobs = publishers.get('jobs') ?? [];
    expect(new Set(jobs).size).toBe(JOBS_PUBLISHERS.length);
    const named = (roles: string[] | undefined, fragment: string) => roles?.some((role) => role.includes(fragment)) === true;
    expect(JOBS_PUBLISHERS.filter((f) => !named(jobs, f))).toStrictEqual([]);
    // chat: the stream's role only; runs: the conductor's role, VocProcessingStack's, referenced by name and granted here.
    expect([publishers.get('chat')?.length, named(publishers.get('chat'), 'ChatStream')]).toStrictEqual([1, true]);
    expect([publishers.get('runs')?.length, named(publishers.get('runs'), 'voc-agent-conductor-role')]).toStrictEqual([1, true]);
  });

  it('tells each publisher where to publish', () => {
    const functions = Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
      .filter(([, fn]) => JSON.stringify(fn).includes(`"${REALTIME_HTTP_DNS_ENV}"`))
      .map(([id]) => id.replace(/[0-9A-F]{8}$/, ''))
      .sort(byCodeUnit);
    expect(functions).toStrictEqual([
      'ChatStreamApi', 'DocumentGeneratorJob', 'DocumentMergerJob', 'PersonaGeneratorJob', 'PersonaImporterJob',
      'ProjectsApi', 'ProjectsAssistWorker', 'ScrapersApi', 'ScrapersAssistWorker', 'SettingsApi', 'SettingsAssistWorker',
    ]);
  });

  it('logs errors only, to a log group with the platform retention, through a role that writes only it', () => {
    expect(onlyApi().LogConfig.LogLevel).toBe('ERROR');
    const groups = Object.values(apiTemplate().findResources('AWS::Logs::LogGroup'))
      .filter((g) => JSON.stringify(g).includes('/aws/appsync/apis/'));
    expect(groups).toHaveLength(1);
    expect(JSON.stringify(groups[0])).toContain('"RetentionInDays":30');
    expect(Object.keys(apiTemplate().findResources('Custom::LogRetention'))).toStrictEqual([]);
  });

  it('writes the endpoint parameter the conductor reads, and the outputs the frontend deploy reads', () => {
    const template = apiTemplate();
    template.hasResourceProperties('AWS::SSM::Parameter', { Name: realtimeParameterName(undefined), Type: 'String' });
    expect(['RealtimeHttpDns', 'RealtimeDns'].filter((key) => !(key in template.findOutputs('*')))).toStrictEqual([]);
  });

  it('carries no fixed monthly cost (TENETS.md tenet 7)', () => {
    expect(fixedCostFindings('VocApiStack', apiTemplate().toJSON())).toStrictEqual([]);
  });

  it('puts both hosts in the runtime config', () => {
    const realtime = z.object({ realtime: z.object({ httpDns: z.unknown(), realtimeDns: z.unknown() }) })
      .safeParse(buildApiStack().runtimeConfig);
    expect(realtime.success).toBe(true);
  }, SYNTH_TIMEOUT_MS);
});
