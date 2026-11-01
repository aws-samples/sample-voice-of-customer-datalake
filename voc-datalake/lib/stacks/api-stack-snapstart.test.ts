/**
 * SnapStart on the four cold-start-bound API Lambdas (lib/utils/snapstart.ts,
 * docs/lambda-sizing.md "SnapStart: off by default"), and the resource budget it spends.
 *
 * SnapStart is a fixed monthly cost, so it is OFF by default (TENETS.md, tenet 7) and opt-in
 * with `-c snapStart=true`. Pinned:
 *  - default synth: no function carries `SnapStart`, the stack has no AWS::Lambda::Version or
 *    AWS::Lambda::Alias, and API Gateway integrates (and is granted invoke on) the four plain
 *    functions exactly like every other API Lambda;
 *  - `-c snapStart=true`: exactly SNAPSTART_FUNCTION_IDS carry `SnapStart: PublishedVersions`,
 *    each with one version that CloudFormation DELETES when superseded (a retained version keeps
 *    paying the snapshot cache charge) and one `live` alias on it; every API Gateway method that
 *    integrates one of them invokes the ALIAS — an unqualified invoke runs `$LATEST`, which is never
 *    snapshotted — and the invoke permissions name the alias too;
 *  - VocApiStack in its largest shape (every plugin enabled AND SnapStart on, +8 resources) stays
 *    at least RESOURCE_HEADROOM under CloudFormation's 500-resource ceiling.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import type { Template } from 'aws-cdk-lib/assertions';

import {
  SNAPSTART_ALIAS_NAME,
  SNAPSTART_CONTEXT_KEY,
  SNAPSTART_FUNCTION_IDS,
  snapStartEnabled,
  snapStartInvokeTarget,
} from '../utils/snapstart';
import {
  aliasFunctionIds,
  apiMethods,
  apiTemplate,
  discoverPluginIds,
  synthApiTemplate,
} from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

/** CloudFormation's per-stack ceiling, and the room this stack must keep under it. */
const CLOUDFORMATION_RESOURCE_LIMIT = 500;
// 384 resources (all plugins, SnapStart on; 376 with it off) once every route Lambda took ONE
// RestApi-scoped invoke permission (api-routes.ts frugalIntegration); per-method permissions
// put it at 475. 75 keeps room for growth while failing if they come back.
const RESOURCE_HEADROOM = 75;

const SNAPSTART_ON = { [SNAPSTART_CONTEXT_KEY]: 'true' };
let snapStartTemplate: Template | undefined;
let snapStartAllPluginsTemplate: Template | undefined;
/** No plugins, `-c snapStart=true`. */
const snapStartOn = (): Template => (snapStartTemplate ??= synthApiTemplate(SNAPSTART_ON));
/** Every plugin AND `-c snapStart=true`: the stack's largest shape. */
const snapStartOnAllPlugins = (): Template => (
  snapStartAllPluginsTemplate ??= synthApiTemplate(SNAPSTART_ON, discoverPluginIds()));

beforeAll(() => {
  apiTemplate();
  snapStartOn();
  snapStartOnAllPlugins();
}, SYNTH_TIMEOUT_MS * 3);

const FunctionSchema = z.object({
  Properties: z.object({ SnapStart: z.object({ ApplyOn: z.string() }).optional() }),
});
const VersionSchema = z.object({
  DeletionPolicy: z.string().optional(),
  Properties: z.object({ FunctionName: z.object({ Ref: z.string() }) }),
});
const AliasSchema = z.object({
  Properties: z.object({
    Name: z.string(),
    FunctionName: z.object({ Ref: z.string() }),
    FunctionVersion: z.object({ 'Fn::GetAtt': z.tuple([z.string(), z.literal('Version')]) }),
  }),
});
const PermissionSchema = z.object({ Properties: z.object({ FunctionName: z.unknown(), Principal: z.string() }) });
/** A Version or Alias: both name their function as `{ Ref: <function id> }`. */
const OwnedByFunctionSchema = z.object({ Properties: z.object({ FunctionName: z.object({ Ref: z.string() }) }) });

/** Logical ids of the functions with SnapStart on, sorted. */
function snapStartFunctionIds(template: Template): string[] {
  return Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => FunctionSchema.parse(resource).Properties.SnapStart?.ApplyOn === 'PublishedVersions')
    .map(([id]) => id)
    .sort(byCodeUnit);
}

/** The logical id of the function created with `constructId`. */
function functionIdOf(template: Template, constructId: string): string {
  const ids = Object.keys(template.findResources('AWS::Lambda::Function'))
    .filter((id) => new RegExp(`^(GlobalMcp)?${constructId}[0-9A-F]{8}$`).test(id));
  expect(ids, `expected exactly one function for ${constructId}`).toHaveLength(1);
  return ids[0] ?? '';
}

/** Logical ids of the four SnapStart-listed functions in `template`, sorted. */
const listedFunctionIds = (template: Template): string[] => SNAPSTART_FUNCTION_IDS
  .map((constructId) => functionIdOf(template, constructId)).sort(byCodeUnit);

/** API Gateway invoke permissions of `template`. */
const gatewayPermissions = (template: Template) => Object.values(template.findResources('AWS::Lambda::Permission'))
  .map((resource) => PermissionSchema.parse(resource).Properties)
  .filter((permission) => permission.Principal === 'apigateway.amazonaws.com');

const bareArn = (fnId: string) => JSON.stringify({ 'Fn::GetAtt': [fnId, 'Arn'] });

describe('SnapStart is off by default (a fixed monthly cost, TENETS.md tenet 7)', () => {
  it('no function carries SnapStart, and the stack has no Lambda version or alias', () => {
    const template = apiTemplate();
    expect(snapStartFunctionIds(template)).toStrictEqual([]);
    expect(Object.keys(template.findResources('AWS::Lambda::Version'))).toStrictEqual([]);
    expect(Object.keys(template.findResources('AWS::Lambda::Alias'))).toStrictEqual([]);
  });

  it('API Gateway integrates the four plain functions, like every other API Lambda', () => {
    const template = apiTemplate();
    const listed = listedFunctionIds(template);
    const routed = new Set(apiMethods(template).map((method) => method.integrationFunctionId));
    const directUris = Object.values(template.findResources('AWS::ApiGateway::Method'))
      .map((method) => JSON.stringify(method));
    expect(listed.filter((fnId) => !routed.has(fnId))).toStrictEqual([]);
    expect(listed.filter((fnId) => !directUris.some((json) => json.includes(bareArn(fnId))))).toStrictEqual([]);
  });

  it('API Gateway invoke permissions name the plain functions', () => {
    const template = apiTemplate();
    const permitted = new Set(gatewayPermissions(template).map((permission) => JSON.stringify(permission.FunctionName)));
    expect(listedFunctionIds(template).filter((fnId) => !permitted.has(bareArn(fnId)))).toStrictEqual([]);
  });
});

describe('-c snapStart=true: SnapStart functions', () => {
  it('are exactly the four cold-start-bound API Lambdas', () => {
    const template = snapStartOn();
    expect(snapStartFunctionIds(template)).toStrictEqual(listedFunctionIds(template));
  });

  it.each(SNAPSTART_FUNCTION_IDS)('%s has one deletable version and one `live` alias on it', (constructId) => {
    const template = snapStartOn();
    const fnId = functionIdOf(template, constructId);
    const versions = Object.entries(template.findResources('AWS::Lambda::Version'))
      .map(([id, resource]) => ({ id, ...VersionSchema.parse(resource) }))
      .filter((version) => version.Properties.FunctionName.Ref === fnId);
    expect(versions.map((version) => version.DeletionPolicy)).toStrictEqual(['Delete']);

    const aliases = Object.values(template.findResources('AWS::Lambda::Alias'))
      .map((resource) => AliasSchema.parse(resource).Properties)
      .filter((alias) => alias.FunctionName.Ref === fnId);
    expect(aliases).toStrictEqual([{
      Name: SNAPSTART_ALIAS_NAME,
      FunctionName: { Ref: fnId },
      FunctionVersion: { 'Fn::GetAtt': [versions[0]?.id, 'Version'] },
    }]);
  });

  it('only SnapStart functions get versions or aliases (each costs two resources)', () => {
    const template = snapStartOn();
    const owners = (type: string) => Object.values(template.findResources(type))
      .map((resource) => OwnedByFunctionSchema.parse(resource).Properties.FunctionName.Ref)
      .sort(byCodeUnit);
    expect(owners('AWS::Lambda::Version')).toStrictEqual(snapStartFunctionIds(template));
    expect(owners('AWS::Lambda::Alias')).toStrictEqual(snapStartFunctionIds(template));
  });
});

describe('-c snapStart=true: API Gateway reaches the SnapStart functions through the alias', () => {
  it('every method integrating one of them targets its alias, never the function', () => {
    const template = snapStartOn();
    const aliasedFunctions = new Set(aliasFunctionIds(template).values());
    const snapStart = new Set(snapStartFunctionIds(template));
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    const routed = apiMethods(template).filter((method) => snapStart.has(method.integrationFunctionId ?? ''));

    // apiMethods resolves an alias back to its function, so check the raw URIs too.
    const directUris = methods.map((method) => JSON.stringify(method)).filter((json) => (
      [...snapStart].some((fnId) => json.includes(bareArn(fnId)))
    ));
    expect(directUris).toStrictEqual([]);
    expect(new Set(routed.map((method) => method.integrationFunctionId))).toStrictEqual(snapStart);
    expect(aliasedFunctions).toStrictEqual(snapStart);
  });

  it('API Gateway invoke permissions name the alias, not the bare function', () => {
    const template = snapStartOn();
    const snapStart = snapStartFunctionIds(template);
    const aliasIds = new Set(aliasFunctionIds(template).keys());
    const permissions = gatewayPermissions(template);

    const onBareFunction = permissions.filter((permission) => snapStart.some((fnId) => (
      JSON.stringify(permission.FunctionName) === bareArn(fnId)
    )));
    expect(onBareFunction).toStrictEqual([]);
    const onAlias = permissions.filter((permission) => {
      const ref = z.object({ Ref: z.string() }).safeParse(permission.FunctionName);
      return ref.success && aliasIds.has(ref.data.Ref);
    });
    expect(onAlias.length).toBeGreaterThan(0);
  });
});

describe('the snapStart context flag', () => {
  const appWith = (context: Record<string, unknown>) => new cdk.App({ context });

  it('is off when absent or false, on when true (CLI strings included)', () => {
    expect(snapStartEnabled(appWith({}))).toBe(false);
    expect(snapStartEnabled(appWith({ snapStart: 'false' }))).toBe(false);
    expect(snapStartEnabled(appWith({ snapStart: 'true' }))).toBe(true);
    expect(snapStartEnabled(appWith({ snapStart: true }))).toBe(true);
  });

  it('refuses a typo rather than deploying the opposite', () => {
    expect(() => snapStartEnabled(appWith({ snapStart: 'ture' }))).toThrow(/Unrecognized snapStart context value/);
    expect(() => snapStartEnabled(appWith({ performanceTier: 'yes' }))).toThrow(/Unrecognized performanceTier context value/);
  });

  it('is on with the performance tier, which turns on every fixed-cost performance feature', () => {
    expect(snapStartEnabled(appWith({ performanceTier: 'true' }))).toBe(true);
    expect(snapStartEnabled(appWith({ performanceTier: 'false', snapStart: 'true' }))).toBe(true);
    expect(snapStartEnabled(appWith({ performanceTier: 'false' }))).toBe(false);
  });
});

describe('snapStartInvokeTarget', () => {
  it.each([false, true])('refuses a function that is not on the budgeted list (snapStart=%s)', (enabled) => {
    const stack = new cdk.Stack(new cdk.App({ context: { snapStart: enabled } }), 'Probe');
    const fn = new lambda.Function(stack, 'SomeOtherApi', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return None\n'),
    });
    expect(() => snapStartInvokeTarget(fn)).toThrow(/SomeOtherApi is not in SNAPSTART_FUNCTION_IDS/);
  });
});

describe('VocApiStack resource budget', () => {
  it(`keeps at least ${RESOURCE_HEADROOM} resources of headroom under the ${CLOUDFORMATION_RESOURCE_LIMIT} ceiling, SnapStart on`, () => {
    const count = Object.keys(snapStartOnAllPlugins().toJSON().Resources ?? {}).length;
    expect(count, `VocApiStack (all plugins, snapStart=true) has ${count} resources`)
      .toBeLessThanOrEqual(CLOUDFORMATION_RESOURCE_LIMIT - RESOURCE_HEADROOM);
  });
});
