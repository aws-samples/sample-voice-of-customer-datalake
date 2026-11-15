import { readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import * as cdk from 'aws-cdk-lib';
import { Match, type Template } from 'aws-cdk-lib/assertions';
import * as dynamodb from 'aws-cdk-lib/aws-dynamodb';
import * as kms from 'aws-cdk-lib/aws-kms';
import { beforeAll, describe, expect, it } from 'vitest';

import { functionRoleId } from '../test-support/engineering-template';
import { count, functionEnv, runtimeStack } from '../test-support/engineering-runtime-fixture';
import { fixtureBucket } from '../test-support/fixture-resources';
import { synthProcessingTemplate } from '../test-support/processing-stack-fixture';
import { SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { ENGINEERING_CACHE_WRITER_ROLE_BASE_NAME } from './core-buckets';
import { CACHE_TIMEOUT_SECONDS, createEngineeringCache } from './engineering-cache';

const NAME = 'voc-engineering-cache';
const KEY = { 'Fn::GetAtt': [Match.stringLikeRegexp('^Key'), 'Arn'] };
const RAW_ARN = { 'Fn::GetAtt': [Match.stringLikeRegexp('^Raw'), 'Arn'] };
const objects = (keys: string): unknown => ({ 'Fn::Join': ['', [RAW_ARN, `/${keys}`]] });

function cacheFunctionId(template: Template): string {
  const [id] = Object.keys(template.findResources('AWS::Lambda::Function', { Properties: { FunctionName: NAME } }));
  return id ?? '';
}

/** The files a synth stages for the image's build context, relative to it. */
function stagedContext(): string[] {
  const app = new cdk.App({ context: { 'aws:cdk:bundling-stacks': [] } });
  const stack = new cdk.Stack(app, 'CacheContext', { env: { account: '111111111111', region: 'us-east-1' } });
  createEngineeringCache(stack, {
    uniqueName: (name) => name, kmsKey: new kms.Key(stack, 'Key'), rawDataBucket: fixtureBucket(stack, 'Raw'),
    engineeringTable: new dynamodb.Table(stack, 'Engineering', { partitionKey: { name: 'pk', type: dynamodb.AttributeType.STRING } }),
    connectionParameters: { prefix: '/voc/engineering/', arns: 'arn:aws:ssm:us-east-1:111111111111:parameter/voc/engineering/*' },
  });
  const outdir = app.synth().directory;
  const [asset] = readdirSync(outdir).filter((name) => name.startsWith('asset.') && statSync(join(outdir, name)).isDirectory());
  const files: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name);
      if (statSync(full).isDirectory()) walk(full); else files.push(relative(join(outdir, asset ?? ''), full));
    }
  };
  walk(join(outdir, asset ?? ''));
  return files;
}

describe('the checkout cache\'s writer is off by default', () => {
  it('is not in the default processing stack', () => {
    expect(JSON.stringify(synthProcessingTemplate().toJSON())).not.toContain(NAME);
  }, SYNTH_TIMEOUT_MS);

  it('is not added without engineeringAgents=true', () => {
    expect(JSON.stringify(runtimeStack({}).template.toJSON())).not.toContain(NAME);
  });
});

describe('voc-engineering-cache with -c engineeringAgents=true', () => {
  let template: Template;
  beforeAll(() => {
    template = runtimeStack({ engineeringAgents: 'true' }).template;
  }, SYNTH_TIMEOUT_MS);

  it('is a container image for arm64, bounded in time and storage, never retried', () => {
    expect(count(template, 'AWS::Lambda::Function', {
      FunctionName: NAME, PackageType: 'Image', Architectures: ['arm64'], Timeout: CACHE_TIMEOUT_SECONDS,
      MemorySize: 2048, EphemeralStorage: { Size: 3072 },
    })).toBe(1);
    expect(count(template, 'AWS::Lambda::EventInvokeConfig', {
      FunctionName: { Ref: cacheFunctionId(template) }, MaximumRetryAttempts: 0,
    })).toBe(1);
  });

  it('runs as the role of the fixed name the raw bucket\'s deny exempts (core-buckets.ts)', () => {
    expect(ENGINEERING_CACHE_WRITER_ROLE_BASE_NAME).toBe(NAME);
    const roles = template.findResources('AWS::IAM::Role', { Properties: { RoleName: NAME } });
    expect(Object.keys(roles)).toStrictEqual([functionRoleId(template, cacheFunctionId(template))]);
  });

  it('names its bucket, its table and the connections\' parameters, nothing else', () => {
    expect(Object.keys(functionEnv(template, NAME)).sort((a, b) => a.localeCompare(b, 'en'))).toStrictEqual([
      'ENGINEERING_PARAMETER_PREFIX', 'ENGINEERING_TABLE', 'LOG_LEVEL', 'POWERTOOLS_SERVICE_NAME', 'RAW_DATA_BUCKET',
    ]);
    expect(functionEnv(template, NAME).ENGINEERING_PARAMETER_PREFIX).toBe('/voc/engineering/');
  });

  it('holds exactly its entries\' writes, READY\'s read, the credentials\' read and its claim rows', () => {
    const role = [{ Ref: functionRoleId(template, cacheFunctionId(template)) }];
    expect(count(template, 'AWS::IAM::Policy', { Roles: role })).toBe(1);
    expect(count(template, 'AWS::IAM::Policy', { Roles: role, PolicyDocument: { Version: '2012-10-17', Statement: [
      { Sid: 'CacheEntryWrites', Effect: 'Allow', Action: 's3:PutObject', Resource: objects('engineering/cache/*') },
      {
        Sid: 'CacheReadyCreateOnly', Effect: 'Deny', Action: 's3:PutObject', Resource: objects('engineering/cache/*/*/*/READY'),
        Condition: { Null: { 's3:if-none-match': 'true' } },
      },
      { Sid: 'CacheEntryReady', Effect: 'Allow', Action: 's3:GetObject', Resource: objects('engineering/cache/*/*/*/READY') },
      {
        Sid: 'CacheEntryKey', Effect: 'Allow', Action: 'kms:GenerateDataKey', Resource: KEY,
        Condition: {
          StringEquals: { 'kms:ViaService': 's3.us-east-1.amazonaws.com' },
          StringLike: { 'kms:EncryptionContext:aws:s3:arn': objects('engineering/cache/*') },
        },
      },
      {
        Sid: 'EngineeringConnectionCredentials', Effect: 'Allow', Action: 'ssm:GetParameter',
        Resource: 'arn:aws:ssm:us-east-1:111111111111:parameter/voc/engineering/*',
      },
      {
        Sid: 'EngineeringConnectionCredentialsKey', Effect: 'Allow', Action: 'kms:Decrypt', Resource: KEY,
        Condition: {
          StringEquals: { 'kms:ViaService': 'ssm.us-east-1.amazonaws.com' },
          StringLike: { 'kms:EncryptionContext:PARAMETER_ARN': 'arn:aws:ssm:us-east-1:111111111111:parameter/voc/engineering/*' },
        },
      },
      {
        Sid: 'CacheClaims', Effect: 'Allow', Action: ['dynamodb:GetItem', 'dynamodb:PutItem', 'dynamodb:UpdateItem'],
        Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Engineering'), 'Arn'] },
        Condition: {
          'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#CACHE#*'] },
          'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'holder', 'expires_at'] },
          StringEqualsIfExists: { 'dynamodb:ReturnValues': 'NONE', 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
        },
      },
      {
        Sid: 'CacheClaimsKey', Effect: 'Allow', Action: ['kms:Decrypt', 'kms:GenerateDataKey'], Resource: KEY,
        Condition: {
          StringEquals: {
            'kms:ViaService': 'dynamodb.us-east-1.amazonaws.com',
            'kms:EncryptionContext:aws:dynamodb:tableName': { Ref: Match.stringLikeRegexp('^Engineering') },
          },
        },
      },
    ].map((statement) => Match.objectEquals(statement)) } })).toBe(1);
  });

  const invoke = (): Record<string, unknown> => ({ Sid: 'FillTheCheckoutCache', Effect: 'Allow',
    Action: 'lambda:InvokeFunction', Resource: { 'Fn::GetAtt': [cacheFunctionId(template), 'Arn'] } });
  const ready = { Sid: 'CheckoutCacheReady', Effect: 'Allow', Action: 's3:GetObject',
    Resource: objects('engineering/cache/*/*/*/READY') };
  const holding = (statement: Record<string, unknown>, role?: string): number => count(template, 'AWS::IAM::Policy', {
    ...(role ? { Roles: [{ Ref: Match.stringLikeRegexp(role) }] } : {}),
    PolicyDocument: Match.objectLike({ Statement: Match.arrayWith([Match.objectEquals(statement)]) }),
  });

  it('lets the supervisor, and no other role, invoke it', () => {
    expect(holding(invoke())).toBe(1);
    expect(holding(invoke(), 'EngineeringSupervisorRole')).toBe(1);
  });

  it('lets the supervisor alone read a fill\'s claim, its lease\'s end only', () => {
    const claims = { Sid: 'CheckoutCacheClaims', Effect: 'Allow', Action: 'dynamodb:GetItem',
      Resource: { 'Fn::GetAtt': [Match.stringLikeRegexp('^Engineering'), 'Arn'] },
      Condition: {
        'ForAllValues:StringLike': { 'dynamodb:LeadingKeys': ['WS#*#CACHE#*'] },
        'ForAllValues:StringEquals': { 'dynamodb:Attributes': ['pk', 'sk', 'expires_at'] },
        StringEqualsIfExists: { 'dynamodb:Select': 'SPECIFIC_ATTRIBUTES' },
      } };
    expect(holding(claims)).toBe(1);
    expect(holding(claims, 'EngineeringSupervisorRole')).toBe(1);
  });

  it('lets the supervisor and the delivery function (a wake\'s continuation), and no other role, read READY', () => {
    expect(holding(ready)).toBe(2);
    expect(holding(ready, 'EngineeringSupervisorRole') + holding(ready, 'EngineeringDeliveryRole')).toBe(2);
  });

  it('tells the supervisor its name, and neither the start nor the delivery function', () => {
    expect(functionEnv(template, 'voc-engineering-runtime').ENGINEERING_CACHE_FUNCTION).toStrictEqual(
      { Ref: cacheFunctionId(template) });
    for (const name of ['voc-engineering-start', 'voc-engineering-delivery']) {
      expect(functionEnv(template, name)).not.toHaveProperty('ENGINEERING_CACHE_FUNCTION');
    }
  });
});

describe('the image\'s build context', () => {
  it('stages the Dockerfile and the filler\'s code, never a test or anything else of the app', () => {
    const files = stagedContext();
    expect(files).toContain('engineering-cache/Dockerfile');
    expect(files).toContain('lambda/engineering/connectors/cache.py');
    expect(files.filter((file) => /(^|\/)(test|__pycache__)\//.test(file) || file.endsWith('.md'))).toStrictEqual([]);
    expect(files.filter((file) => !/^(engineering-cache\/(Dockerfile|requirements\.txt)|lambda\/(engineering|shared)\/)/.test(file)))
      .toStrictEqual([]);
  }, SYNTH_TIMEOUT_MS);
});
