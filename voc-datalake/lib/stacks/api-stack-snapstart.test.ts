/**
 * SnapStart on the four cold-start-bound API Lambdas (lib/utils/snapstart.ts,
 * docs/lambda-sizing.md "Cold starts"), and the resource budget it spends.
 *
 * Pinned:
 *  - exactly SNAPSTART_FUNCTION_IDS carry `SnapStart: PublishedVersions`, each
 *    with one version that CloudFormation DELETES when superseded (a retained
 *    version keeps paying the snapshot cache charge) and one `live` alias on it;
 *  - every API Gateway method that integrates one of them invokes the ALIAS — an
 *    unqualified invoke runs `$LATEST`, which is never snapshotted — and the
 *    invoke permissions name the alias too;
 *  - VocApiStack (every plugin enabled, its largest shape) stays at least
 *    RESOURCE_HEADROOM under CloudFormation's 500-resource ceiling.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import { z } from 'zod';
import * as cdk from 'aws-cdk-lib';
import * as lambda from 'aws-cdk-lib/aws-lambda';

import { SNAPSTART_ALIAS_NAME, SNAPSTART_FUNCTION_IDS, snapStartAlias } from '../utils/snapstart';
import { aliasFunctionIds, apiMethods, apiTemplate, apiTemplateAllPlugins } from '../test-support/api-stack-template';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { byCodeUnit } from '../utils/compare';

/** CloudFormation's per-stack ceiling, and the room this stack must keep under it. */
const CLOUDFORMATION_RESOURCE_LIMIT = 500;
const RESOURCE_HEADROOM = 10;

beforeAll(() => {
  apiTemplate();
  apiTemplateAllPlugins();
}, SYNTH_TIMEOUT_MS * 2);

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
function snapStartFunctionIds(): string[] {
  return Object.entries(apiTemplate().findResources('AWS::Lambda::Function'))
    .filter(([, resource]) => FunctionSchema.parse(resource).Properties.SnapStart?.ApplyOn === 'PublishedVersions')
    .map(([id]) => id)
    .sort(byCodeUnit);
}

/** The logical id of the function created with `constructId`. */
function functionIdOf(constructId: string): string {
  const ids = Object.keys(apiTemplate().findResources('AWS::Lambda::Function'))
    .filter((id) => new RegExp(`^(GlobalMcp)?${constructId}[0-9A-F]{8}$`).test(id));
  expect(ids, `expected exactly one function for ${constructId}`).toHaveLength(1);
  return ids[0] ?? '';
}

describe('SnapStart functions', () => {
  it('are exactly the four cold-start-bound API Lambdas', () => {
    expect(snapStartFunctionIds()).toStrictEqual(SNAPSTART_FUNCTION_IDS.map(functionIdOf).sort(byCodeUnit));
  });

  it.each(SNAPSTART_FUNCTION_IDS)('%s has one deletable version and one `live` alias on it', (constructId) => {
    const template = apiTemplate();
    const fnId = functionIdOf(constructId);
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
    const template = apiTemplate();
    const owners = (type: string) => Object.values(template.findResources(type))
      .map((resource) => OwnedByFunctionSchema.parse(resource).Properties.FunctionName.Ref)
      .sort(byCodeUnit);
    expect(owners('AWS::Lambda::Version')).toStrictEqual(snapStartFunctionIds());
    expect(owners('AWS::Lambda::Alias')).toStrictEqual(snapStartFunctionIds());
  });
});

describe('API Gateway reaches the SnapStart functions through the alias', () => {
  it('every method integrating one of them targets its alias, never the function', () => {
    const template = apiTemplate();
    const aliasedFunctions = new Set(aliasFunctionIds(template).values());
    const snapStart = new Set(snapStartFunctionIds());
    const methods = Object.values(template.findResources('AWS::ApiGateway::Method'));
    const routed = apiMethods(template).filter((method) => snapStart.has(method.integrationFunctionId ?? ''));

    // apiMethods resolves an alias back to its function, so check the raw URIs too.
    const directUris = methods.map((method) => JSON.stringify(method)).filter((json) => (
      [...snapStart].some((fnId) => json.includes(JSON.stringify({ 'Fn::GetAtt': [fnId, 'Arn'] })))
    ));
    expect(directUris).toStrictEqual([]);
    expect(new Set(routed.map((method) => method.integrationFunctionId))).toStrictEqual(snapStart);
    expect(aliasedFunctions).toStrictEqual(snapStart);
  });

  it('API Gateway invoke permissions name the alias, not the bare function', () => {
    const template = apiTemplate();
    const snapStart = snapStartFunctionIds();
    const aliasIds = new Set(aliasFunctionIds(template).keys());
    const permissions = Object.values(template.findResources('AWS::Lambda::Permission'))
      .map((resource) => PermissionSchema.parse(resource).Properties)
      .filter((permission) => permission.Principal === 'apigateway.amazonaws.com');

    const onBareFunction = permissions.filter((permission) => snapStart.some((fnId) => (
      JSON.stringify(permission.FunctionName) === JSON.stringify({ 'Fn::GetAtt': [fnId, 'Arn'] })
    )));
    expect(onBareFunction).toStrictEqual([]);
    const onAlias = permissions.filter((permission) => {
      const ref = z.object({ Ref: z.string() }).safeParse(permission.FunctionName);
      return ref.success && aliasIds.has(ref.data.Ref);
    });
    expect(onAlias.length).toBeGreaterThan(0);
  });
});

describe('snapStartAlias', () => {
  it('refuses a function that is not on the budgeted list', () => {
    const stack = new cdk.Stack(new cdk.App(), 'Probe');
    const fn = new lambda.Function(stack, 'SomeOtherApi', {
      runtime: lambda.Runtime.PYTHON_3_14,
      handler: 'index.handler',
      code: lambda.Code.fromInline('def handler(event, context):\n    return None\n'),
    });
    expect(() => snapStartAlias(fn)).toThrow(/SomeOtherApi is not in SNAPSTART_FUNCTION_IDS/);
  });
});

describe('VocApiStack resource budget', () => {
  it(`keeps at least ${RESOURCE_HEADROOM} resources of headroom under the ${CLOUDFORMATION_RESOURCE_LIMIT} ceiling`, () => {
    const count = Object.keys(apiTemplateAllPlugins().toJSON().Resources ?? {}).length;
    expect(count, `VocApiStack (all plugins) has ${count} resources`)
      .toBeLessThanOrEqual(CLOUDFORMATION_RESOURCE_LIMIT - RESOURCE_HEADROOM);
  });
});
