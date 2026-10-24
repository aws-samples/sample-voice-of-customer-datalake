/**
 * voc-design-capture (lib/stacks/design-capture.ts): the live-website design worker in
 * VocIngestionStack, its least-privilege role, and the settings API's way to start it.
 */
import { beforeAll, describe, expect, it } from 'vitest';
import type { Template } from 'aws-cdk-lib/assertions';
import { z } from 'zod';

import { synthIngestionTemplate } from '../test-support/ingestion-stack-fixture';
import { apiTemplate, apiTemplatePrefixed, policyStatementsOf, serviceEnvironment } from '../test-support/api-stack-template';
import { itemAt } from '../test-support/guards';
import { SYNTH_REGION, SYNTH_TIMEOUT_MS } from '../test-support/synth-app';
import { PY_LAMBDA_ASSET_EXCLUDES, rootPluginAssetExcludes } from '../utils/lambda-asset-excludes';
import {
  DESIGN_CAPTURE_MEMORY_MB, DESIGN_CAPTURE_TIMEOUT, DESIGN_SYSTEM_PARTITION, LOGO_PREVIEW_PREFIX,
  MODEL_SETTINGS_PARTITION,
} from './design-capture';
import { BROWSER_SESSION_ACTIONS, BROWSER_STREAM_ACTION } from './ingestion-roles';

const FunctionSchema = z.object({
  Properties: z.object({
    FunctionName: z.unknown(),
    Handler: z.string(),
    Timeout: z.number(),
    MemorySize: z.number(),
    Layers: z.array(z.unknown()),
    Environment: z.object({ Variables: z.record(z.string(), z.unknown()) }),
  }),
});
const InvokeConfigSchema = z.object({
  Properties: z.object({ MaximumRetryAttempts: z.number(), MaximumEventAgeInSeconds: z.number() }),
});

function captureFunction(template: Template): z.infer<typeof FunctionSchema>['Properties'] {
  const found = Object.entries(template.findResources('AWS::Lambda::Function'))
    .filter(([id]) => id.startsWith('DesignCapture'))
    .map(([, resource]) => FunctionSchema.parse(resource).Properties);
  expect(found, 'exactly one design-capture function').toHaveLength(1);
  return itemAt(found, 0);
}

function serviceEnvironmentOf(template: Template): Record<string, unknown> {
  return captureFunction(template).Environment.Variables;
}

describe('voc-design-capture in VocIngestionStack', () => {
  let template: Template;
  beforeAll(() => {
    template = synthIngestionTemplate();
  }, SYNTH_TIMEOUT_MS);

  it('is created even with no plugin enabled, named and handled as the settings API expects', () => {
    const fn = captureFunction(template);
    expect(fn.Handler).toBe('capture_handler.lambda_handler');
    expect(JSON.stringify(fn.FunctionName)).toContain('voc-design-capture-');
    expect(JSON.stringify(fn.Layers)).toContain('IngestionDepsLayer');
  });

  it('runs at most five minutes with its memory', () => {
    const fn = captureFunction(template);
    expect([fn.Timeout, fn.MemorySize]).toStrictEqual([DESIGN_CAPTURE_TIMEOUT.toSeconds(), DESIGN_CAPTURE_MEMORY_MB]);
    expect(fn.Timeout).toBeLessThanOrEqual(300);
  });

  it('is never retried by Lambda (a retry would open another billed browser session)', () => {
    const configs = Object.values(template.findResources('AWS::Lambda::EventInvokeConfig'))
      .map((resource) => InvokeConfigSchema.parse(resource).Properties);
    expect(configs).toContainEqual({ MaximumRetryAttempts: 0, MaximumEventAgeInSeconds: 3600 });
  });

  const statements = () => policyStatementsOf(template, 'DesignCaptureRole');

  it('may drive only the AWS-managed browser of the region', () => {
    const agentcore = statements().filter((s) => s.actions.some((a) => a.startsWith('bedrock-agentcore:')));
    expect(agentcore.map((s) => [s.actions, s.resource])).toStrictEqual([
      [BROWSER_SESSION_ACTIONS, JSON.stringify(`arn:aws:bedrock-agentcore:${SYNTH_REGION}:aws:browser/aws.browser.v1`)],
      [[BROWSER_STREAM_ACTION], '"*"'],
    ]);
  });

  it('reads and writes only the design-system rows (plus a read of the model settings)', () => {
    const dynamo = statements().filter((s) => s.actions.some((a) => a.startsWith('dynamodb:')));
    expect(dynamo.map((s) => [s.actions, s.condition])).toStrictEqual([
      [['dynamodb:GetItem'], { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [DESIGN_SYSTEM_PARTITION, MODEL_SETTINGS_PARTITION] } }],
      [['dynamodb:UpdateItem'], { 'ForAllValues:StringEquals': { 'dynamodb:LeadingKeys': [DESIGN_SYSTEM_PARTITION] } }],
    ]);
  });

  it('invokes allowlisted models only and touches no secret, queue or other function', () => {
    const actions = statements().flatMap((s) => s.actions);
    expect(actions).toContain('bedrock:InvokeModel');
    expect(statements().filter((s) => s.actions.includes('bedrock:InvokeModel')).map((s) => s.resource).join())
      .not.toContain('"*"');
    expect(actions.filter((a) => /^(secretsmanager|sqs|lambda):/.test(a))).toStrictEqual([]);
  });

  it('may only PUT the logo-candidate preview objects in S3 (no read, no delete, no other prefix)', () => {
    const s3Statements = statements().filter((s) => s.actions.some((a) => a.startsWith('s3:')));
    expect(s3Statements.map((s) => s.actions)).toStrictEqual([['s3:PutObject']]);
    expect(itemAt(s3Statements, 0).resource).toContain(`/${LOGO_PREVIEW_PREFIX}*`);
    expect(serviceEnvironmentOf(template).RAW_DATA_BUCKET).toBeDefined();
  });

  it('keeps its tree out of every other Lambda bundle', () => {
    expect(PY_LAMBDA_ASSET_EXCLUDES).toContain('/design_capture/');
    expect(rootPluginAssetExcludes('webscraper', ['webscraper'])).toContain('/lambda/design_capture/');
  });
});

describe('the settings API starts voc-design-capture', () => {
  it('names it in DESIGN_CAPTURE_FUNCTION, prefix-aware like the ingestion stack', () => {
    expect(JSON.stringify(serviceEnvironment(apiTemplate(), 'voc-settings-api').DESIGN_CAPTURE_FUNCTION))
      .toContain('voc-design-capture-');
    expect(JSON.stringify(serviceEnvironment(apiTemplatePrefixed(), 'voc-settings-api').DESIGN_CAPTURE_FUNCTION))
      .toContain('b-voc-design-capture-');
  }, SYNTH_TIMEOUT_MS);
});
