/**
 * Frugal API Gateway invoke permissions. VocApiStack sits near CloudFormation's
 * 500-resource ceiling: with every plugin enabled the real synth reached 502 and
 * failed until MetricsApi and the plugin webhook receivers moved to ONE
 * permission each, scoped to this RestApi; every other route Lambda followed
 * (FeedbackFormApi alone held 20 per-method permissions). These cases keep that
 * headroom from being given back silently, and pin that the wider permission is
 * still bounded to this API and to API Gateway as the caller.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import type { Template } from 'aws-cdk-lib/assertions';

import {
  aliasFunctionIds,
  apiMethods,
  apiTemplateAllPlugins,
  functionIdForHandler,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

beforeAll(() => {
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS);

const PermissionSchema = z.object({
  Properties: z.object({
    Action: z.string(),
    Principal: z.string(),
    FunctionName: z.unknown(),
    SourceArn: z.unknown(),
  }),
});
type Permission = z.infer<typeof PermissionSchema>['Properties'];

const GetAttArnSchema = z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Arn')]) });
const RefSchema = z.object({ Ref: z.string() });

function allPermissions(template: Template): Permission[] {
  return Object.values(template.findResources('AWS::Lambda::Permission'))
    .map((resource) => PermissionSchema.parse(resource).Properties);
}

/** The function a permission targets: a bare function, or a SnapStart alias resolved to its function. */
function permissionFunctionId(permission: Permission, aliasFunctions: ReadonlyMap<string, string>): string | undefined {
  const getAtt = GetAttArnSchema.safeParse(permission.FunctionName);
  if (getAtt.success) return getAtt.data['Fn::GetAtt'][0];
  const ref = RefSchema.safeParse(permission.FunctionName);
  return ref.success ? aliasFunctions.get(ref.data.Ref) : undefined;
}

function onlyRestApiId(template: Template): string {
  const [restApiId, ...others] = Object.keys(template.findResources('AWS::ApiGateway::RestApi'));
  expect(others, 'expected exactly one RestApi').toStrictEqual([]);
  return restApiId ?? '';
}

/** `arn:<partition>:execute-api:<region>:<account>:<this RestApi>/*\/*\/*` — any stage, method, path of THIS API. */
function restApiScopedArn(restApiId: string) {
  return executeApiArn(restApiId, ['/*/*/*']);
}

/** The synthesized execute-api ARN of this RestApi followed by `suffix` (the fixture's region and account). */
function executeApiArn(restApiId: string, suffix: unknown[]) {
  return {
    'Fn::Join': ['', [
      'arn:', { Ref: 'AWS::Partition' }, ':execute-api:us-east-1:111111111111:', { Ref: restApiId }, ...suffix,
    ]],
  };
}

/** Every function some API Gateway method integrates (aliases resolved to their function). */
function integratedFunctionIds(template: Template): string[] {
  const ids = apiMethods(template).map((method) => method.integrationFunctionId);
  return [...new Set(ids.filter((id): id is string => id !== undefined))].sort(byCodeUnit);
}

function gatewayPermissionsFor(template: Template, functionId: string): Permission[] {
  const aliasFunctions = aliasFunctionIds(template);
  return allPermissions(template)
    .filter((permission) => permission.Principal === 'apigateway.amazonaws.com')
    .filter((permission) => permissionFunctionId(permission, aliasFunctions) === functionId);
}

describe('every Lambda behind an API Gateway method', () => {
  it('has exactly one invoke permission, granted to API Gateway and scoped to this RestApi', () => {
    const template = apiTemplateAllPlugins();
    const expected = restApiScopedArn(onlyRestApiId(template));
    const functionIds = integratedFunctionIds(template);
    expect(functionIds.length, 'expected the route Lambdas to be discovered').toBeGreaterThan(15);

    const isScopedInvoke = (permission: Permission) => permission.Action === 'lambda:InvokeFunction'
      && JSON.stringify(permission.SourceArn) === JSON.stringify(expected);
    const offenders = functionIds
      .map((functionId) => ({ functionId, permissions: gatewayPermissionsFor(template, functionId) }))
      .filter(({ permissions }) => permissions.length !== 1 || !permissions.every(isScopedInvoke))
      .map(({ functionId, permissions }) => `${functionId}: ${permissions.length} permission(s)`);
    expect(offenders).toStrictEqual([]);
  });

  it('no API Gateway permission reaches beyond this RestApi (the MCP authorizer is scoped to its own authorizer)', () => {
    const template = apiTemplateAllPlugins();
    const restApiId = onlyRestApiId(template);
    const routeScoped = JSON.stringify(restApiScopedArn(restApiId));
    const authorizerIds = Object.keys(template.findResources('AWS::ApiGateway::Authorizer'));
    const authorizerScoped = authorizerIds.map((authorizerId) => JSON.stringify(
      executeApiArn(restApiId, ['/authorizers/', { Ref: authorizerId }]),
    ));

    const unscoped = allPermissions(template)
      .filter((permission) => permission.Principal === 'apigateway.amazonaws.com')
      .map((permission) => JSON.stringify(permission.SourceArn))
      .filter((arn) => arn !== routeScoped && !authorizerScoped.includes(arn));
    expect(unscoped).toStrictEqual([]);
  });
});

/** The functions whose per-method permissions were the biggest consumers, named so a regression reads plainly. */
const FRUGAL_FUNCTIONS: [string, string][] = [
  ['the metrics API', 'metrics_handler.py'],
  ['the feedback edit API', 'feedback_edit_handler.py'],
  ['the feedback form API (public widget routes included)', 'feedback_form_handler.py'],
  ['the data explorer API', 'data_explorer_handler.py'],
  ['the agents API', 'agents_handler.py'],
  ['the manual import API', 'manual_import_handler.py'],
  ['the ballots API', 'ballots_handler.py'],
  ['the integrations API', 'integrations_handler.py'],
  ['the Radar API', 'radar_handler.py'],
];

describe.each(FRUGAL_FUNCTIONS)('%s', (_label, handlerFile) => {
  it('has exactly one API Gateway invoke permission', () => {
    const template = apiTemplateAllPlugins();
    expect(gatewayPermissionsFor(template, functionIdForHandler(template, handlerFile))).toStrictEqual([
      expect.objectContaining({ Action: 'lambda:InvokeFunction', Principal: 'apigateway.amazonaws.com' }),
    ]);
  });
});

describe('the github_issues webhook receiver', () => {
  it('has exactly one API Gateway invoke permission', () => {
    const template = apiTemplateAllPlugins();
    const ids = Object.keys(template.findResources('AWS::Lambda::Function'))
      .filter((id) => id.startsWith('GithubIssuesWebhook'));
    expect(ids).toHaveLength(1);
    expect(gatewayPermissionsFor(template, ids[0] ?? '')).toHaveLength(1);
  });
});
